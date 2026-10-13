import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { verifyPassword } from '../auth/password';
import type { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

interface Row {
  id: number;
  email: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  studentCode: string | null;
  dni: string | null;
  facultyId: number | null;
  schoolId: number | null;
  avatarUrl: string | null;
  passwordHash: string | null;
  googleSub: string | null;
  tokenVersion: number;
}

function row(
  overrides: Partial<Row> & Pick<Row, 'id' | 'email' | 'role'>,
): Row {
  return {
    fullName: 'Persona de Prueba',
    isActive: true,
    studentCode: null,
    dni: null,
    facultyId: 1,
    schoolId: 1,
    avatarUrl: null,
    passwordHash: null,
    googleSub: null,
    tokenVersion: 0,
    ...overrides,
  };
}

/** Fake mínimo de `user` que respeta `select`: lo que no se pide no se devuelve. */
class FakePrisma {
  rows: Row[];
  nextId = 100;

  constructor(rows: Row[]) {
    this.rows = rows;
  }

  private pick(found: Row, select?: Record<string, boolean>) {
    if (!select) return { ...found };
    return Object.fromEntries(
      Object.entries(found).filter(([key]) => select[key]),
    ) as Partial<Row>;
  }

  user = {
    findMany: ({ select }: { select?: Record<string, boolean> }) =>
      Promise.resolve(this.rows.map((found) => this.pick(found, select))),
    findUnique: ({ where }: { where: { id?: number; email?: string } }) =>
      Promise.resolve(
        this.rows.find((found) =>
          where.id !== undefined
            ? found.id === where.id
            : found.email === where.email,
        ) ?? null,
      ),
    create: ({
      data,
      select,
    }: {
      data: Partial<Row>;
      select?: Record<string, boolean>;
    }) => {
      const created = row({
        id: this.nextId++,
        email: data.email!,
        role: data.role!,
        ...data,
      });
      this.rows.push(created);
      return Promise.resolve(this.pick(created, select));
    },
    update: ({
      where,
      data,
      select,
    }: {
      where: { id: number };
      data: Omit<Partial<Row>, 'tokenVersion'> & {
        tokenVersion?: number | { increment: number };
      };
      select?: Record<string, boolean>;
    }) => {
      const found = this.rows.find((candidate) => candidate.id === where.id)!;
      const { tokenVersion, ...rest } = data;
      Object.assign(found, rest);
      if (typeof tokenVersion === 'object') {
        found.tokenVersion += tokenVersion.increment;
      } else if (typeof tokenVersion === 'number') {
        found.tokenVersion = tokenVersion;
      }
      return Promise.resolve(this.pick(found, select));
    },
  };
}

const OWNER = { id: 1, role: Role.OWNER_SYSTEM };
const ADMIN = { id: 2, role: Role.ADMIN_SYSTEM };

function setup() {
  const fake = new FakePrisma([
    row({ id: 1, email: 'owner@x.pe', role: Role.OWNER_SYSTEM }),
    row({ id: 2, email: 'admin@x.pe', role: Role.ADMIN_SYSTEM }),
    row({ id: 3, email: 'alumno@x.pe', role: Role.STUDENT }),
    row({
      id: 4,
      email: 'tesorero@x.pe',
      role: Role.TREASURER,
      facultyId: null,
      schoolId: null,
    }),
  ]);
  return { fake, service: new UsersService(fake as unknown as PrismaService) };
}

describe('UsersService: vistas', () => {
  it('el listado nunca trae el hash ni el id de Google, solo si tiene contraseña / Google', async () => {
    const { fake, service } = setup();
    fake.rows[2].passwordHash = 'scrypt$1024$8$1$AAAA$BBBB';
    fake.rows[3].googleSub = 'sub-123';
    const list = await service.findAll();
    for (const user of list) {
      expect(user).not.toHaveProperty('passwordHash');
      expect(user).not.toHaveProperty('googleSub');
      expect(user).not.toHaveProperty('tokenVersion');
    }
    expect(list.find((user) => user.id === 3)).toMatchObject({
      hasPassword: true,
      googleLinked: false,
    });
    expect(list.find((user) => user.id === 4)).toMatchObject({
      hasPassword: false,
      googleLinked: true,
    });
  });
});

describe('UsersService.create', () => {
  it('crea una cuenta con contraseña: guarda un hash scrypt y responde solo hasPassword', async () => {
    const { fake, service } = setup();
    const created = await service.create(ADMIN, {
      email: 'prueba@x.pe',
      fullName: 'Alumno de Prueba',
      role: Role.STUDENT,
      password: 'Clave-de-prueba-1',
    });
    expect(created).toMatchObject({
      role: Role.STUDENT,
      hasPassword: true,
      googleLinked: false,
    });
    expect(created).not.toHaveProperty('passwordHash');
    const stored = fake.rows.find((user) => user.email === 'prueba@x.pe')!;
    expect(stored.passwordHash).toMatch(/^scrypt\$/);
    expect(stored.passwordHash).not.toContain('Clave-de-prueba-1');
    await expect(
      verifyPassword('Clave-de-prueba-1', stored.passwordHash!),
    ).resolves.toBe(true);
  });

  it('sin contraseña la cuenta queda en «Solo Google»', async () => {
    const { service } = setup();
    const created = await service.create(ADMIN, {
      email: 'g@x.pe',
      fullName: 'Solo Google',
      role: Role.OTHER,
    });
    expect(created.hasPassword).toBe(false);
  });

  it('un Administrador puede crear un Tesorero (sin facultad ni código) pero no otro Administrador ni un Owner', async () => {
    const { service } = setup();
    const treasurer = await service.create(ADMIN, {
      email: 't2@x.pe',
      fullName: 'Tesorera',
      role: Role.TREASURER,
      facultyId: 1,
      schoolId: 1,
      studentCode: '123',
    });
    expect(treasurer).toMatchObject({
      role: Role.TREASURER,
      facultyId: null,
      schoolId: null,
      studentCode: null,
    });
    for (const role of [Role.ADMIN_SYSTEM, Role.OWNER_SYSTEM]) {
      await expect(
        service.create(ADMIN, {
          email: `${role}@x.pe`,
          fullName: 'No permitido',
          role,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('el Owner sí puede crear un Administrador', async () => {
    const { service } = setup();
    await expect(
      service.create(OWNER, {
        email: 'a2@x.pe',
        fullName: 'Admin Dos',
        role: Role.ADMIN_SYSTEM,
      }),
    ).resolves.toMatchObject({ role: Role.ADMIN_SYSTEM });
  });

  it('rechaza un correo repetido', async () => {
    const { service } = setup();
    await expect(
      service.create(ADMIN, {
        email: 'alumno@x.pe',
        fullName: 'Repetido',
        role: Role.STUDENT,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('UsersService.setPassword', () => {
  it('cambia la contraseña e invalida las sesiones anteriores (tokenVersion + 1)', async () => {
    const { fake, service } = setup();
    const view = await service.setPassword(ADMIN, 3, 'Nueva-clave-2026');
    expect(view.hasPassword).toBe(true);
    expect(fake.rows[2].tokenVersion).toBe(1);
    await expect(
      verifyPassword('Nueva-clave-2026', fake.rows[2].passwordHash!),
    ).resolves.toBe(true);
    await service.setPassword(ADMIN, 3, 'Otra-clave-2026-x');
    expect(fake.rows[2].tokenVersion).toBe(2);
  });

  it('quitar la contraseña (null) deja la cuenta en «Solo Google» y también invalida sesiones', async () => {
    const { fake, service } = setup();
    fake.rows[2].passwordHash = 'scrypt$1024$8$1$AAAA$BBBB';
    const view = await service.setPassword(ADMIN, 3, null);
    expect(view.hasPassword).toBe(false);
    expect(fake.rows[2].passwordHash).toBeNull();
    expect(fake.rows[2].tokenVersion).toBe(1);
  });

  it('un Administrador no toca la contraseña de otro Administrador ni del Owner; el Owner sí', async () => {
    const { service } = setup();
    await expect(
      service.setPassword(ADMIN, 2, 'Clave-valida-2026'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.setPassword(ADMIN, 1, 'Clave-valida-2026'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.setPassword(OWNER, 2, 'Clave-valida-2026'),
    ).resolves.toMatchObject({ hasPassword: true });
  });

  it('un Administrador sí gestiona la de un Tesorero', async () => {
    const { service } = setup();
    await expect(
      service.setPassword(ADMIN, 4, 'Clave-valida-2026'),
    ).resolves.toMatchObject({
      role: Role.TREASURER,
      hasPassword: true,
    });
  });

  it('responde 404 si la cuenta no existe', async () => {
    const { service } = setup();
    await expect(
      service.setPassword(OWNER, 999, 'Clave-valida-2026'),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('UsersService.updateRole', () => {
  it('un Administrador puede asignar Tesorero, pero no Administrador', async () => {
    const { service } = setup();
    await expect(
      service.updateRole(ADMIN, 3, Role.TREASURER),
    ).resolves.toMatchObject({
      role: Role.TREASURER,
      facultyId: null,
      schoolId: null,
      studentCode: null,
    });
    await expect(
      service.updateRole(ADMIN, 3, Role.ADMIN_SYSTEM),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('nadie cambia el rol del Owner', async () => {
    const { service } = setup();
    await expect(
      service.updateRole(OWNER, 1, Role.STUDENT),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
