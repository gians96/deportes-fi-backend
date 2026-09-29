import {
  BadRequestException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../common/decorators/current-user.decorator';
import { InMemoryPrisma } from '../../test/fakes/in-memory-prisma';
import {
  buildSportsDataset,
  EVENT_A_ID,
  EVENT_B_ID,
  OWNER_USER_ID,
} from '../../test/fakes/sports-dataset';
import { ApiTokenHasher } from './api-token-hasher.service';
import { hashApiToken, isWellFormedApiToken } from './api-token.util';
import { EventTokensService } from './event-tokens.service';

const PEPPER = 'pepper-de-prueba-0123456789abcdef0123';

function configWith(values: Record<string, string | undefined>) {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('EventTokensService', () => {
  const actor: RequestUser = {
    id: OWNER_USER_ID,
    email: 'owner.local@example.test',
    fullName: 'OWNER LOCAL',
    role: Role.OWNER_SYSTEM,
  };
  let prisma: InMemoryPrisma;
  let service: EventTokensService;

  beforeEach(() => {
    prisma = new InMemoryPrisma(buildSportsDataset());
    const hasher = new ApiTokenHasher(
      configWith({ API_TOKEN_PEPPER: PEPPER, NODE_ENV: 'test' }),
    );
    service = new EventTokensService(
      prisma as unknown as PrismaService,
      hasher,
    );
  });

  describe('create', () => {
    it('devuelve el token en claro una sola vez y persiste solo su hash', async () => {
      const created = await service.create(
        EVENT_A_ID,
        { name: '  Congreso CIISIC 2026  ' },
        actor,
      );

      expect(Object.keys(created).sort()).toEqual(
        ['createdAt', 'expiresAt', 'id', 'name', 'token', 'tokenPrefix'].sort(),
      );
      expect(isWellFormedApiToken(created.token)).toBe(true);
      expect(created.name).toBe('Congreso CIISIC 2026');
      expect(created.tokenPrefix).toBe(created.token.slice(0, 12));
      expect(created.expiresAt).toBeNull();

      const [stored] = prisma.data.tokens;
      expect(stored.eventId).toBe(EVENT_A_ID);
      expect(stored.createdById).toBe(OWNER_USER_ID);
      expect(stored.tokenHash).toBe(hashApiToken(created.token, PEPPER));
      expect(JSON.stringify(stored)).not.toContain(created.token);
    });

    it('guarda la expiración futura', async () => {
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      const created = await service.create(
        EVENT_A_ID,
        { name: 'Con expiración', expiresAt },
        actor,
      );

      expect(created.expiresAt?.toISOString()).toBe(expiresAt);
    });

    it('rechaza una expiración pasada con 400', async () => {
      await expect(
        service.create(
          EVENT_A_ID,
          { name: 'Vencido', expiresAt: '2020-01-01T00:00:00.000Z' },
          actor,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.data.tokens).toHaveLength(0);
    });

    it('responde 404 si el evento no existe', async () => {
      await expect(
        service.create(999, { name: 'Sin evento' }, actor),
      ).rejects.toThrow(new NotFoundException('Evento no encontrado'));
    });

    it('reintenta ante una colisión de prefijo o hash', async () => {
      const first = await service.create(EVENT_A_ID, { name: 'Uno' }, actor);
      const hasher = new ApiTokenHasher(
        configWith({ API_TOKEN_PEPPER: PEPPER }),
      );
      const collision = {
        token: first.token,
        tokenPrefix: first.tokenPrefix,
        tokenHash: hashApiToken(first.token, PEPPER),
      };
      const generate = jest
        .spyOn(hasher, 'generate')
        .mockReturnValueOnce(collision);
      const retrying = new EventTokensService(
        prisma as unknown as PrismaService,
        hasher,
      );

      const second = await retrying.create(EVENT_A_ID, { name: 'Dos' }, actor);

      expect(generate).toHaveBeenCalledTimes(2);
      expect(second.token).not.toBe(first.token);
      expect(prisma.data.tokens).toHaveLength(2);
    });

    it('responde 503 en producción sin API_TOKEN_PEPPER y lo registra como error', async () => {
      const logError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const disabled = new EventTokensService(
        prisma as unknown as PrismaService,
        new ApiTokenHasher(configWith({ NODE_ENV: 'production' })),
      );

      await expect(
        disabled.create(EVENT_A_ID, { name: 'X' }, actor),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('API_TOKEN_PEPPER'),
      );
      expect(prisma.data.tokens).toHaveLength(0);
      logError.mockRestore();
    });
  });

  describe('list', () => {
    it('lista solo los tokens del evento, sin token ni hash, con estado', async () => {
      await service.create(EVENT_A_ID, { name: 'Activo' }, actor);
      const revoked = await service.create(
        EVENT_A_ID,
        { name: 'Revocado' },
        actor,
      );
      const expired = await service.create(
        EVENT_A_ID,
        { name: 'Expirado' },
        actor,
      );
      await service.create(EVENT_B_ID, { name: 'De B' }, actor);
      await service.revoke(EVENT_A_ID, revoked.id);
      const expiredRow = prisma.data.tokens.find((t) => t.id === expired.id);
      if (!expiredRow) throw new Error('dataset incompleto');
      expiredRow.expiresAt = new Date(Date.now() - 1_000);

      const list = await service.list(EVENT_A_ID);

      expect(list.map((t) => t.name).sort()).toEqual(
        ['Activo', 'Expirado', 'Revocado'].sort(),
      );
      expect(Object.fromEntries(list.map((t) => [t.name, t.status]))).toEqual({
        Activo: 'ACTIVE',
        Revocado: 'REVOKED',
        Expirado: 'EXPIRED',
      });
      for (const item of list) {
        expect(item).not.toHaveProperty('token');
        expect(item).not.toHaveProperty('tokenHash');
        expect(item.eventId).toBe(EVENT_A_ID);
      }
    });

    it('responde 404 si el evento no existe', async () => {
      await expect(service.list(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('revoke', () => {
    it('marca revokedAt, conserva el registro y es idempotente', async () => {
      const created = await service.create(
        EVENT_A_ID,
        { name: 'A revocar' },
        actor,
      );

      const first = await service.revoke(EVENT_A_ID, created.id);
      const second = await service.revoke(EVENT_A_ID, created.id);

      expect(first.status).toBe('REVOKED');
      expect(first.revokedAt).toBeInstanceOf(Date);
      expect(second.revokedAt?.getTime()).toBe(first.revokedAt?.getTime());
      expect(prisma.data.tokens).toHaveLength(1);
      expect(first).not.toHaveProperty('tokenHash');
    });

    it('responde 404 si el token pertenece a otro evento y no lo modifica', async () => {
      const created = await service.create(EVENT_B_ID, { name: 'De B' }, actor);

      await expect(service.revoke(EVENT_A_ID, created.id)).rejects.toThrow(
        new NotFoundException('Token no encontrado'),
      );
      expect(prisma.data.tokens[0].revokedAt).toBeNull();
    });
  });
});
