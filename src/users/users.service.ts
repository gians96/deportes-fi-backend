import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { hashPassword } from '../auth/password';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

interface RoleActor {
  id: number;
  role: Role;
}

/** Columnas que se leen; `passwordHash` y `googleSub` solo sirven para calcular las banderas de la vista. */
const userSelect = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  isActive: true,
  studentCode: true,
  dni: true,
  facultyId: true,
  schoolId: true,
  avatarUrl: true,
  passwordHash: true,
  googleSub: true,
} as const;

interface UserRow {
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
}

/** Usuario tal como lo ve el panel: sin hash ni identificador de Google, solo si tiene contraseña / Google. */
export type UserView = Omit<UserRow, 'passwordHash' | 'googleSub'> & {
  hasPassword: boolean;
  googleLinked: boolean;
};

function toView(row: UserRow): UserView {
  const { passwordHash, googleSub, ...rest } = row;
  return {
    ...rest,
    hasPassword: passwordHash !== null,
    googleLinked: googleSub !== null,
  };
}

/** Roles que un Administrador puede crear y gestionar; solo el Owner toca a administradores y owners. */
function isDelegableRole(role: Role) {
  return (
    role === Role.STUDENT ||
    role === Role.OTHER ||
    role === Role.REFEREE ||
    role === Role.TREASURER
  );
}

function isNonAcademicRole(role: Role) {
  return (
    role === Role.OTHER || role === Role.REFEREE || role === Role.TREASURER
  );
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<UserView[]> {
    const rows = await this.prisma.user.findMany({
      select: userSelect,
      orderBy: { fullName: 'asc' },
    });
    return rows.map(toView);
  }

  async create(actor: RoleActor, dto: CreateUserDto): Promise<UserView> {
    if (actor.role === Role.ADMIN_SYSTEM && !isDelegableRole(dto.role)) {
      throw new ForbiddenException(
        'Un administrador solo puede crear estudiantes, otros usuarios, árbitros o tesoreros',
      );
    }

    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new BadRequestException('Ya existe un usuario con ese correo');
    }

    const row = await this.prisma.user.create({
      data: {
        email: dto.email,
        fullName: dto.fullName,
        role: dto.role,
        facultyId: isNonAcademicRole(dto.role) ? null : (dto.facultyId ?? null),
        schoolId: isNonAcademicRole(dto.role) ? null : (dto.schoolId ?? null),
        dni: dto.dni ?? null,
        studentCode: isNonAcademicRole(dto.role)
          ? null
          : (dto.studentCode ?? null),
        passwordHash: dto.password ? await hashPassword(dto.password) : null,
      },
      select: userSelect,
    });
    return toView(row);
  }

  async update(
    actor: RoleActor,
    id: number,
    dto: UpdateUserDto,
  ): Promise<UserView> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    this.assertCanManage(actor, user.role);

    if (dto.email && dto.email !== user.email) {
      const existing = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });
      if (existing) {
        throw new BadRequestException('Ya existe un usuario con ese correo');
      }
    }

    const row = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.fullName !== undefined && { fullName: dto.fullName }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(isNonAcademicRole(user.role)
          ? { facultyId: null, schoolId: null }
          : {
              ...(dto.facultyId !== undefined && { facultyId: dto.facultyId }),
              ...(dto.schoolId !== undefined && { schoolId: dto.schoolId }),
            }),
        ...(dto.dni !== undefined && { dni: dto.dni }),
        ...(isNonAcademicRole(user.role)
          ? { studentCode: null }
          : dto.studentCode !== undefined
            ? { studentCode: dto.studentCode }
            : {}),
      },
      select: userSelect,
    });
    return toView(row);
  }

  async setActive(
    actor: RoleActor,
    id: number,
    isActive: boolean,
  ): Promise<UserView> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    if (user.id === actor.id) {
      throw new BadRequestException('No puedes inhabilitarte a ti mismo');
    }
    if (user.role === Role.OWNER_SYSTEM) {
      throw new BadRequestException('No se puede inhabilitar al owner');
    }
    this.assertCanManage(actor, user.role);

    const row = await this.prisma.user.update({
      where: { id },
      data: { isActive },
      select: userSelect,
    });
    return toView(row);
  }

  /**
   * Define, cambia o quita (`null`) la contraseña de una cuenta. Al quitarla la cuenta vuelve a «Solo
   * Google». Siempre incrementa `tokenVersion`: las sesiones emitidas antes dejan de valer.
   */
  async setPassword(
    actor: RoleActor,
    id: number,
    password: string | null,
  ): Promise<UserView> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    this.assertCanManage(actor, user.role);

    const row = await this.prisma.user.update({
      where: { id },
      data: {
        passwordHash: password === null ? null : await hashPassword(password),
        tokenVersion: { increment: 1 },
      },
      select: userSelect,
    });
    return toView(row);
  }

  private assertCanManage(actor: RoleActor, targetRole: Role) {
    if (actor.role === Role.ADMIN_SYSTEM && !isDelegableRole(targetRole)) {
      throw new ForbiddenException(
        'Un administrador solo puede gestionar estudiantes, otros usuarios, árbitros o tesoreros',
      );
    }
  }

  async updateRole(
    actor: RoleActor,
    id: number,
    role: Role,
  ): Promise<UserView> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    if (user.role === Role.OWNER_SYSTEM) {
      throw new BadRequestException('No se puede modificar el rol del owner');
    }

    // Un administrador no puede asignar roles elevados ni tocar a otros
    // administradores; solo el owner tiene ese poder.
    if (actor.role === Role.ADMIN_SYSTEM) {
      if (!isDelegableRole(role)) {
        throw new ForbiddenException(
          'Un administrador solo puede asignar roles de estudiante, otro, árbitro o tesorero',
        );
      }
      if (user.role === Role.ADMIN_SYSTEM) {
        throw new ForbiddenException(
          'Un administrador no puede modificar a otro administrador',
        );
      }
    }

    const row = await this.prisma.user.update({
      where: { id },
      data: {
        role,
        ...(isNonAcademicRole(role)
          ? { facultyId: null, schoolId: null, studentCode: null }
          : {}),
      },
      select: userSelect,
    });
    return toView(row);
  }
}
