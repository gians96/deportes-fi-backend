import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Role, type User } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { JwtStrategy } from './jwt.strategy';

function strategyFor(user: Partial<User> | null): JwtStrategy {
  const config = {
    get: (key: string) =>
      key === 'JWT_SECRET' ? 'secreto-de-prueba-0123456789' : undefined,
  } as unknown as ConfigService;
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(user) },
  } as unknown as PrismaService;
  return new JwtStrategy(config, prisma);
}

const ACTIVE = {
  id: 7,
  email: 'a@example.com',
  fullName: 'A',
  role: Role.TREASURER,
  isActive: true,
  tokenVersion: 0,
  studentCode: null,
};

describe('JwtStrategy.validate', () => {
  it('acepta un token anterior a la función (sin tv) mientras la versión de la cuenta sea 0', async () => {
    const user = await strategyFor(ACTIVE).validate({
      sub: 7,
      email: 'a@example.com',
      role: Role.TREASURER,
    });
    expect(user).toMatchObject({ id: 7, role: Role.TREASURER });
  });

  it('acepta un token cuya versión coincide', async () => {
    await expect(
      strategyFor({ ...ACTIVE, tokenVersion: 2 }).validate({
        sub: 7,
        email: 'a@example.com',
        role: Role.TREASURER,
        tv: 2,
      }),
    ).resolves.toMatchObject({ id: 7 });
  });

  it('rechaza el token emitido antes de cambiar o quitar la contraseña', async () => {
    await expect(
      strategyFor({ ...ACTIVE, tokenVersion: 3 }).validate({
        sub: 7,
        email: 'a@example.com',
        role: Role.TREASURER,
        tv: 2,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      strategyFor({ ...ACTIVE, tokenVersion: 1 }).validate({
        sub: 7,
        email: 'a@example.com',
        role: Role.TREASURER,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza cuentas inexistentes o inhabilitadas', async () => {
    await expect(
      strategyFor(null).validate({
        sub: 9,
        email: 'x@example.com',
        role: Role.STUDENT,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      strategyFor({ ...ACTIVE, isActive: false }).validate({
        sub: 7,
        email: 'a@example.com',
        role: Role.TREASURER,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('toma el rol de la base, no del token', async () => {
    const user = await strategyFor({ ...ACTIVE, role: Role.STUDENT }).validate({
      sub: 7,
      email: 'a@example.com',
      role: Role.OWNER_SYSTEM,
    });
    expect(user.role).toBe(Role.STUDENT);
  });
});
