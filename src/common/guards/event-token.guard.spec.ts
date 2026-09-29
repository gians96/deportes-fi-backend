import {
  ExecutionContext,
  HttpException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service';
import { ApiTokenHasher } from '../../event-tokens/api-token-hasher.service';
import {
  generateApiToken,
  hashApiToken,
} from '../../event-tokens/api-token.util';
import type { RequestWithEventToken } from '../decorators/current-event-token.decorator';
import { EventTokenGuard, LAST_USED_THROTTLE_MS } from './event-token.guard';

const PEPPER = 'pepper-de-prueba-0123456789abcdef0123';
const INVALID_BODY = {
  statusCode: 401,
  message: 'Token de integración inválido',
};

interface StoredToken {
  id: number;
  eventId: number;
  tokenHash: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
}

function configWith(values: Record<string, string | undefined>) {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function contextFor(headers: Record<string, unknown>) {
  const request: RequestWithEventToken & { headers: Record<string, unknown> } =
    { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('EventTokenGuard', () => {
  let stored: StoredToken | null;
  let findUnique: jest.Mock;
  let updateMany: jest.Mock;
  let guard: EventTokenGuard;
  let token: string;

  function buildGuard(config = configWith({ API_TOKEN_PEPPER: PEPPER })) {
    const prisma = {
      eventApiToken: { findUnique, updateMany },
    } as unknown as PrismaService;
    return new EventTokenGuard(prisma, new ApiTokenHasher(config));
  }

  async function expectInvalid(headers: Record<string, unknown>) {
    const { context, request } = contextFor(headers);
    const error = await guard.canActivate(context).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as HttpException).getResponse()).toEqual(INVALID_BODY);
    expect(request.eventToken).toBeUndefined();
  }

  beforeEach(() => {
    token = generateApiToken().token;
    stored = {
      id: 7,
      eventId: 3,
      tokenHash: hashApiToken(token, PEPPER),
      revokedAt: null,
      expiresAt: null,
      lastUsedAt: null,
    };
    findUnique = jest.fn(({ where }: { where: { tokenHash: string } }) =>
      Promise.resolve(
        stored && stored.tokenHash === where.tokenHash ? { ...stored } : null,
      ),
    );
    updateMany = jest.fn(() => Promise.resolve({ count: 1 }));
    guard = buildGuard();
  });

  it('acepta un token válido y adjunta { tokenId, eventId }', async () => {
    const { context, request } = contextFor({ 'x-api-key': token });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(request.eventToken).toEqual({ tokenId: 7, eventId: 3 });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenHash: hashApiToken(token, PEPPER) },
      }),
    );
  });

  it('busca por hash: el token en claro nunca llega a la consulta', async () => {
    const { context } = contextFor({ 'x-api-key': token });
    await guard.canActivate(context);

    expect(JSON.stringify(findUnique.mock.calls)).not.toContain(token);
  });

  it('rechaza sin header X-Api-Key y sin consultar la base', async () => {
    await expectInvalid({});
    await expectInvalid({ 'x-api-key': '' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('no acepta un JWT en Authorization como sustituto', async () => {
    await expectInvalid({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.x.y' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rechaza tokens mal formados sin consultar la base', async () => {
    await expectInvalid({ 'x-api-key': 'undc_' + token.slice(4) });
    await expectInvalid({ 'x-api-key': token.slice(0, -1) });
    await expectInvalid({ 'x-api-key': [token, token] });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rechaza un token desconocido', async () => {
    await expectInvalid({ 'x-api-key': generateApiToken().token });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('rechaza un token revocado', async () => {
    stored = { ...stored!, revokedAt: new Date(Date.now() - 1_000) };
    await expectInvalid({ 'x-api-key': token });
  });

  it('rechaza un token expirado y acepta uno que aún no expira', async () => {
    stored = { ...stored!, expiresAt: new Date(Date.now() - 1_000) };
    await expectInvalid({ 'x-api-key': token });

    stored = { ...stored, expiresAt: new Date(Date.now() + 60_000) };
    const { context } = contextFor({ 'x-api-key': token });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('rechaza si el hash guardado no coincide (defensa ante colaciones)', async () => {
    findUnique.mockResolvedValueOnce({
      ...stored!,
      tokenHash: 'ab'.repeat(32),
    });
    await expectInvalid({ 'x-api-key': token });
  });

  it('no valida tokens de otro pepper', async () => {
    guard = buildGuard(configWith({ API_TOKEN_PEPPER: `${PEPPER}-rotado` }));
    await expectInvalid({ 'x-api-key': token });
  });

  describe('lastUsedAt', () => {
    it('lo actualiza sin bloquear la respuesta', async () => {
      updateMany.mockReturnValue(new Promise(() => undefined));
      const { context } = contextFor({ 'x-api-key': token });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { lastUsedAt: expect.any(Date) as Date },
      });
    });

    it('un fallo al actualizarlo no afecta la solicitud', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      updateMany.mockRejectedValue(new Error('BD caída'));
      const { context } = contextFor({ 'x-api-key': token });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('lastUsedAt'));
      warn.mockRestore();
    });

    it('escribe como máximo una vez por minuto por token', async () => {
      stored = {
        ...stored!,
        lastUsedAt: new Date(Date.now() - LAST_USED_THROTTLE_MS / 2),
      };
      await guard.canActivate(contextFor({ 'x-api-key': token }).context);
      expect(updateMany).not.toHaveBeenCalled();

      stored = {
        ...stored,
        lastUsedAt: new Date(Date.now() - LAST_USED_THROTTLE_MS - 1_000),
      };
      await guard.canActivate(contextFor({ 'x-api-key': token }).context);
      expect(updateMany).toHaveBeenCalledTimes(1);
    });
  });

  it('responde 503 en producción sin API_TOKEN_PEPPER', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    guard = buildGuard(configWith({ NODE_ENV: 'production' }));

    await expect(
      guard.canActivate(contextFor({ 'x-api-key': token }).context),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(findUnique).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
