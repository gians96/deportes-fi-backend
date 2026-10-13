import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { Role, type User } from '@prisma/client';
import type { AcademicService } from '../academic/academic.service';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { LoginThrottle } from './login-throttle';
import { hashPassword } from './password';

/** Configuración falsa: el `ConfigService` real cae a `process.env` (donde Prisma carga el `.env`). */
function fakeConfig(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const CHEAP = { N: 1024, r: 8, p: 1 };
const IP = '203.0.113.7';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    email: 'alumno@example.com',
    fullName: 'Alumno de Prueba',
    googleSub: null,
    passwordHash: null,
    tokenVersion: 0,
    avatarUrl: null,
    role: Role.STUDENT,
    isActive: true,
    studentCode: null,
    dni: null,
    facultyId: 1,
    schoolId: 1,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

interface Harness {
  service: AuthService;
  users: Map<string, User>;
  update: jest.Mock;
  upsert: jest.Mock;
  sign: jest.Mock;
}

function setup(
  initial: User[] = [],
  config: Record<string, string> = {},
): Harness {
  const users = new Map(initial.map((user) => [user.email, user]));
  const update = jest.fn(
    ({ where, data }: { where: { id: number }; data: Partial<User> }) => {
      const current = [...users.values()].find((user) => user.id === where.id)!;
      const next = { ...current, ...data };
      users.set(next.email, next);
      return Promise.resolve(next);
    },
  );
  const upsert = jest.fn(
    ({
      where,
      create,
      update: change,
    }: {
      where: { email: string };
      create: Partial<User>;
      update: Partial<User>;
    }) => {
      const current = users.get(where.email);
      const next = current
        ? { ...current, ...change }
        : makeUser({ id: users.size + 1, email: where.email, ...create });
      users.set(next.email, next);
      return Promise.resolve(next);
    },
  );
  const prisma = {
    user: {
      findUnique: jest.fn(
        ({ where }: { where: { email?: string; id?: number } }) =>
          Promise.resolve(
            where.email
              ? (users.get(where.email) ?? null)
              : ([...users.values()].find((user) => user.id === where.id) ??
                  null),
          ),
      ),
      update,
      upsert,
    },
    participant: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  } as unknown as PrismaService;
  const sign = jest.fn((payload: object) => `jwt:${JSON.stringify(payload)}`);
  const service = new AuthService(
    fakeConfig({ GOOGLE_CLIENT_ID: 'cliente', ...config }),
    { sign } as unknown as JwtService,
    prisma,
    {
      findUniqueStudent: jest.fn().mockResolvedValue(null),
    } as unknown as AcademicService,
    new LoginThrottle(),
  );
  return { service, users, update, upsert, sign };
}

async function withPassword(password: string, overrides: Partial<User> = {}) {
  return makeUser({
    passwordHash: await hashPassword(password, CHEAP),
    ...overrides,
  });
}

describe('AuthService.loginWithPassword', () => {
  it('entra con el correo y la contraseña correctos y devuelve la misma forma que Google', async () => {
    const { service, sign } = setup([await withPassword('Clave-correcta-1')]);
    const session = await service.loginWithPassword(
      IP,
      '  Alumno@Example.COM ',
      'Clave-correcta-1',
    );
    expect(session.user).toMatchObject({
      id: 1,
      email: 'alumno@example.com',
      role: Role.STUDENT,
    });
    expect(session.user).not.toHaveProperty('passwordHash');
    expect(sign).toHaveBeenCalledWith({
      sub: 1,
      email: 'alumno@example.com',
      role: Role.STUDENT,
      tv: 0,
    });
    expect(session.token).toContain('jwt:');
  });

  it('el token lleva la versión de credenciales de la cuenta', async () => {
    const { service, sign } = setup([
      await withPassword('Clave-correcta-1', { tokenVersion: 3 }),
    ]);
    await service.loginWithPassword(
      IP,
      'alumno@example.com',
      'Clave-correcta-1',
    );
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ tv: 3 }));
  });

  it('responde igual ante cuenta inexistente, sin contraseña, inactiva o clave errónea', async () => {
    const { service } = setup([
      await withPassword('Clave-correcta-1'),
      makeUser({ id: 2, email: 'google@example.com' }),
      await withPassword('Clave-correcta-1', {
        id: 3,
        email: 'baja@example.com',
        isActive: false,
      }),
    ]);
    const attempts: Array<[string, string]> = [
      ['noexiste@example.com', 'Clave-correcta-1'],
      ['google@example.com', 'Clave-correcta-1'],
      ['baja@example.com', 'Clave-correcta-1'],
      ['alumno@example.com', 'Clave-equivocada-1'],
    ];
    const messages = new Set<string>();
    for (const [email, password] of attempts) {
      const error = await service
        .loginWithPassword(IP, email, password)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedException);
      messages.add((error as UnauthorizedException).message);
    }
    expect([...messages]).toEqual(['Credenciales incorrectas']);
  });

  it('bloquea con 429 tras 5 fallos y un acceso correcto reinicia el contador', async () => {
    const { service } = setup([await withPassword('Clave-correcta-1')]);
    for (let i = 0; i < 4; i++) {
      await expect(
        service.loginWithPassword(IP, 'alumno@example.com', 'mala-clave-123'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(
      service.loginWithPassword(IP, 'alumno@example.com', 'Clave-correcta-1'),
    ).resolves.toBeDefined();
    for (let i = 0; i < 5; i++) {
      await expect(
        service.loginWithPassword(IP, 'alumno@example.com', 'mala-clave-123'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(
      service.loginWithPassword(IP, 'alumno@example.com', 'Clave-correcta-1'),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('recalcula el hash si se guardó con parámetros más débiles', async () => {
    const { service, update } = setup([await withPassword('Clave-correcta-1')]);
    await service.loginWithPassword(
      IP,
      'alumno@example.com',
      'Clave-correcta-1',
    );
    expect(update).toHaveBeenCalledTimes(1);
    const data = (
      update.mock.calls[0] as [{ data: { passwordHash: string } }]
    )[0].data;
    expect(data.passwordHash.startsWith('scrypt$32768$')).toBe(true);
  });
});

describe('AuthService.loginWithGoogle y el rol de las cuentas con contraseña', () => {
  function withGoogle(harness: Harness, email: string) {
    Object.assign(harness.service, {
      oauthClient: {
        verifyIdToken: jest.fn().mockResolvedValue({
          getPayload: () => ({
            email,
            email_verified: true,
            sub: 'sub-1',
            name: 'Nombre Google',
          }),
        }),
      },
    });
  }

  it('un estudiante creado a mano con contraseña y un Gmail conserva su rol al entrar con Google', async () => {
    const harness = setup([
      await withPassword('Clave-correcta-1', { email: 'alumno@gmail.com' }),
    ]);
    withGoogle(harness, 'alumno@gmail.com');
    const session = await harness.service.loginWithGoogle('id-token');
    expect(session.user.role).toBe(Role.STUDENT);
  });

  it('sin contraseña, un STUDENT con un correo que no es institucional se recalcula a OTHER (comportamiento anterior)', async () => {
    const harness = setup([makeUser({ email: 'alumno@gmail.com' })]);
    withGoogle(harness, 'alumno@gmail.com');
    const session = await harness.service.loginWithGoogle('id-token');
    expect(session.user.role).toBe(Role.OTHER);
  });

  it('el rol de Tesorero se conserva al entrar con Google', async () => {
    const harness = setup([
      makeUser({ email: 'tesorero@gmail.com', role: Role.TREASURER }),
    ]);
    withGoogle(harness, 'tesorero@gmail.com');
    const session = await harness.service.loginWithGoogle('id-token');
    expect(session.user.role).toBe(Role.TREASURER);
  });
});
