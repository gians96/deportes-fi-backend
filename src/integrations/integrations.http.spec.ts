import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { JwtStrategy } from '../auth/jwt.strategy';
import { EventTokensModule } from '../event-tokens/event-tokens.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { InMemoryPrisma } from '../../test/fakes/in-memory-prisma';
import {
  buildSportsDataset,
  EVENT_A_ID,
  EVENT_B_ID,
  EVENT_B_MARKERS,
  EXPECTED_SUMMARY_A,
  OWNER_USER_ID,
  STUDENT_USER_ID,
} from '../../test/fakes/sports-dataset';
import { IntegrationsModule } from './integrations.module';

const PEPPER = 'pepper-de-prueba-0123456789abcdef0123';
const INVALID_BODY = {
  statusCode: 401,
  message: 'Token de integración inválido',
};
const INTEGRATION_PATHS = [
  '/api/v1/integrations/event',
  '/api/v1/integrations/event/summary',
  '/api/v1/integrations/event/payments',
  '/api/v1/integrations/event/registrations',
];

interface CreatedTokenBody {
  id: number;
  name: string;
  tokenPrefix: string;
  expiresAt: string | null;
  createdAt: string;
  token: string;
}

interface ListResponse {
  data: { id: number }[];
  meta: { page: number; pageSize: number; total: number };
}

describe('Tokens por evento e integraciones (HTTP)', () => {
  let app: INestApplication<App>;
  let prisma: InMemoryPrisma;
  let ownerJwt: string;
  let studentJwt: string;

  beforeEach(async () => {
    prisma = new InMemoryPrisma(buildSportsDataset());
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({ API_TOKEN_PEPPER: PEPPER, JWT_SECRET: 'jwt-de-prueba' }),
          ],
        }),
        PrismaModule,
        PassportModule,
        EventTokensModule,
        IntegrationsModule,
      ],
      providers: [JwtStrategy],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication();
    // Igual que main.ts.
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    const jwt = new JwtService({
      secret: app.get(ConfigService).get<string>('JWT_SECRET') ?? 'change-me',
    });
    ownerJwt = jwt.sign({
      sub: OWNER_USER_ID,
      email: 'owner.local@example.test',
      role: Role.OWNER_SYSTEM,
    });
    studentJwt = jwt.sign({
      sub: STUDENT_USER_ID,
      email: '2020100001@undc.edu.pe',
      role: Role.STUDENT,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function createToken(
    eventId: number,
    body: Record<string, unknown> = { name: 'Congreso CIISIC 2026' },
  ): Promise<CreatedTokenBody> {
    const res = await http()
      .post(`/api/v1/events/${eventId}/api-tokens`)
      .set('Authorization', `Bearer ${ownerJwt}`)
      .send(body)
      .expect(201);
    return res.body as CreatedTokenBody;
  }

  function integration(path: string, key: string) {
    return http().get(path).set('X-Api-Key', key);
  }

  describe('admin /events/:eventId/api-tokens', () => {
    it('exige JWT (401) y rol OWNER/ADMIN (403)', async () => {
      await http()
        .post(`/api/v1/events/${EVENT_A_ID}/api-tokens`)
        .send({ name: 'x' })
        .expect(401);
      await http()
        .get(`/api/v1/events/${EVENT_A_ID}/api-tokens`)
        .set('Authorization', `Bearer ${studentJwt}`)
        .expect(403);
      expect(prisma.data.tokens).toHaveLength(0);
    });

    it('crea el token (una sola vez en claro, no-store) y lo lista sin secreto', async () => {
      const res = await http()
        .post(`/api/v1/events/${EVENT_A_ID}/api-tokens`)
        .set('Authorization', `Bearer ${ownerJwt}`)
        .send({ name: 'Congreso CIISIC 2026' })
        .expect(201);
      const created = res.body as CreatedTokenBody;

      expect(res.headers['cache-control']).toBe('no-store');
      expect(Object.keys(created).sort()).toEqual(
        ['createdAt', 'expiresAt', 'id', 'name', 'token', 'tokenPrefix'].sort(),
      );
      expect(created.token).toMatch(/^dfi_[A-Za-z0-9_-]{43}$/);

      const list = await http()
        .get(`/api/v1/events/${EVENT_A_ID}/api-tokens`)
        .set('Authorization', `Bearer ${ownerJwt}`)
        .expect(200);
      const text = JSON.stringify(list.body);
      expect(text).not.toContain(created.token);
      expect(text).not.toContain('tokenHash');
      expect(list.body).toEqual([
        expect.objectContaining({
          id: created.id,
          eventId: EVENT_A_ID,
          tokenPrefix: created.tokenPrefix,
          status: 'ACTIVE',
          lastUsedAt: null,
          revokedAt: null,
        }),
      ]);
    });

    it('valida el body y el evento', async () => {
      const post = (eventId: number, body: object) =>
        http()
          .post(`/api/v1/events/${eventId}/api-tokens`)
          .set('Authorization', `Bearer ${ownerJwt}`)
          .send(body);

      await post(EVENT_A_ID, { name: '   ' }).expect(400);
      await post(EVENT_A_ID, { name: 'x'.repeat(101) }).expect(400);
      await post(EVENT_A_ID, { name: 'x', expiresAt: 'mañana' }).expect(400);
      const past = await post(EVENT_A_ID, {
        name: 'x',
        expiresAt: '2020-01-01T00:00:00.000Z',
      }).expect(400);
      expect((past.body as { message: string }).message).toBe(
        'La fecha de expiración debe ser futura',
      );
      await post(999, { name: 'x' }).expect(404);
      expect(prisma.data.tokens).toHaveLength(0);
    });

    it('no revoca un token desde la ruta de otro evento (404)', async () => {
      const tokenB = await createToken(EVENT_B_ID);

      await http()
        .delete(`/api/v1/events/${EVENT_A_ID}/api-tokens/${tokenB.id}`)
        .set('Authorization', `Bearer ${ownerJwt}`)
        .expect(404);
      await integration('/api/v1/integrations/event', tokenB.token).expect(200);
    });
  });

  describe('integraciones /integrations/event/*', () => {
    it('los cuatro endpoints responden solo el evento del token', async () => {
      const tokenA = await createToken(EVENT_A_ID);
      const tokenB = await createToken(EVENT_B_ID);

      const event = await integration(
        '/api/v1/integrations/event',
        tokenA.token,
      ).expect(200);
      expect(event.body).toEqual({
        id: EVENT_A_ID,
        name: 'Juegos Semana Sistémica 2026',
        description: '<p>Juegos de la semana</p>',
        startDate: '2026-10-19T00:00:00.000Z',
        endDate: '2026-10-24T00:00:00.000Z',
        isOpen: true,
      });

      const summary = await integration(
        '/api/v1/integrations/event/summary',
        tokenA.token,
      ).expect(200);
      expect(summary.body).toMatchObject({
        event: { id: EVENT_A_ID },
        currency: 'PEN',
        teams: EXPECTED_SUMMARY_A.teams,
        participants: EXPECTED_SUMMARY_A.participants,
        payments: EXPECTED_SUMMARY_A.payments,
        byDiscipline: EXPECTED_SUMMARY_A.byDiscipline,
        byParticipantType: EXPECTED_SUMMARY_A.byParticipantType,
      });

      const payments = await integration(
        '/api/v1/integrations/event/payments?pageSize=100',
        tokenA.token,
      ).expect(200);
      expect((payments.body as ListResponse).meta.total).toBe(9);

      const registrations = await integration(
        '/api/v1/integrations/event/registrations?pageSize=100',
        tokenA.token,
      ).expect(200);
      expect((registrations.body as ListResponse).meta.total).toBe(11);

      for (const res of [event, summary, payments, registrations]) {
        const text = JSON.stringify(res.body);
        for (const marker of EVENT_B_MARKERS) {
          expect(text).not.toContain(marker);
        }
      }

      const eventB = await integration(
        '/api/v1/integrations/event/summary',
        tokenB.token,
      ).expect(200);
      expect(eventB.body).toMatchObject({
        event: { id: EVENT_B_ID },
        teams: { total: 2 },
      });
    });

    it('ignora cualquier intento de elegir otro evento por parámetros', async () => {
      const tokenA = await createToken(EVENT_A_ID);

      const event = await integration(
        `/api/v1/integrations/event?eventId=${EVENT_B_ID}&id=${EVENT_B_ID}`,
        tokenA.token,
      ).expect(200);
      expect((event.body as { id: number }).id).toBe(EVENT_A_ID);

      const summary = await integration(
        `/api/v1/integrations/event/summary?eventId=${EVENT_B_ID}`,
        tokenA.token,
      ).expect(200);
      expect((summary.body as { event: { id: number } }).event.id).toBe(
        EVENT_A_ID,
      );

      const payments = await integration(
        `/api/v1/integrations/event/payments?eventId=${EVENT_B_ID}&pageSize=100`,
        tokenA.token,
      ).expect(200);
      const paymentIds = (payments.body as ListResponse).data.map((p) => p.id);
      expect(paymentIds).not.toContain(2000);
      expect(paymentIds).not.toContain(2001);

      const registrations = await integration(
        `/api/v1/integrations/event/registrations?eventId=${EVENT_B_ID}&pageSize=100`,
        tokenA.token,
      ).expect(200);
      const teamIds = (registrations.body as ListResponse).data.map(
        (t) => t.id,
      );
      expect(teamIds.every((id) => id < 200)).toBe(true);

      await integration(
        `/api/v1/integrations/event/${EVENT_B_ID}`,
        tokenA.token,
      ).expect(404);
    });

    it('responde el 401 exacto del contrato sin token, con token inválido o con JWT', async () => {
      const unknown = 'dfi_' + 'A'.repeat(43);
      for (const path of INTEGRATION_PATHS) {
        const missing = await http().get(path).expect(401);
        expect(missing.body).toEqual(INVALID_BODY);

        const malformed = await integration(path, 'dfi_corto').expect(401);
        expect(malformed.body).toEqual(INVALID_BODY);

        const notFound = await integration(path, unknown).expect(401);
        expect(notFound.body).toEqual(INVALID_BODY);

        const withJwt = await http()
          .get(path)
          .set('Authorization', `Bearer ${ownerJwt}`)
          .expect(401);
        expect(withJwt.body).toEqual(INVALID_BODY);
      }
    });

    it('un token revocado deja de funcionar de inmediato', async () => {
      const tokenA = await createToken(EVENT_A_ID);
      await integration('/api/v1/integrations/event', tokenA.token).expect(200);

      const revoked = await http()
        .delete(`/api/v1/events/${EVENT_A_ID}/api-tokens/${tokenA.id}`)
        .set('Authorization', `Bearer ${ownerJwt}`)
        .expect(200);
      expect(revoked.body).toMatchObject({ id: tokenA.id, status: 'REVOKED' });

      for (const path of INTEGRATION_PATHS) {
        const res = await integration(path, tokenA.token).expect(401);
        expect(res.body).toEqual(INVALID_BODY);
      }
    });

    it('un token expirado responde 401', async () => {
      const tokenA = await createToken(EVENT_A_ID, {
        name: 'Temporal',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await integration('/api/v1/integrations/event', tokenA.token).expect(200);

      const row = prisma.data.tokens.find((t) => t.id === tokenA.id);
      if (!row) throw new Error('token no encontrado en el fake');
      row.expiresAt = new Date(Date.now() - 1_000);

      const res = await integration(
        '/api/v1/integrations/event',
        tokenA.token,
      ).expect(401);
      expect(res.body).toEqual(INVALID_BODY);
    });

    it('registra lastUsedAt al usar el token', async () => {
      const tokenA = await createToken(EVENT_A_ID);
      expect(prisma.data.tokens[0].lastUsedAt).toBeNull();

      await integration('/api/v1/integrations/event', tokenA.token).expect(200);
      await new Promise((resolve) => setImmediate(resolve));

      expect(prisma.data.tokens[0].lastUsedAt).toBeInstanceOf(Date);
    });

    it('valida status y paginación (400)', async () => {
      const { token } = await createToken(EVENT_A_ID);
      const invalid = [
        '/api/v1/integrations/event/payments?status=APPROVED',
        '/api/v1/integrations/event/payments?status=validated',
        '/api/v1/integrations/event/registrations?status=VALIDATED',
        '/api/v1/integrations/event/payments?pageSize=101',
        '/api/v1/integrations/event/payments?pageSize=0',
        '/api/v1/integrations/event/registrations?page=0',
        '/api/v1/integrations/event/registrations?page=abc',
        '/api/v1/integrations/event/registrations?pageSize=1.5',
      ];
      for (const path of invalid) {
        await integration(path, token).expect(400);
      }

      const page = await integration(
        '/api/v1/integrations/event/payments?status=PENDING&page=1&pageSize=2',
        token,
      ).expect(200);
      expect((page.body as ListResponse).meta).toEqual({
        page: 1,
        pageSize: 2,
        total: 3,
      });

      const max = await integration(
        '/api/v1/integrations/event/registrations?status=APPROVED&pageSize=100',
        token,
      ).expect(200);
      expect((max.body as ListResponse).meta).toEqual({
        page: 1,
        pageSize: 100,
        total: 6,
      });
    });
  });
});
