import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  GenderPolicy,
  ParticipantType,
  Prisma,
  RegistrationStatus,
  VoucherKind,
  VoucherStatus,
} from '@prisma/client';
import type { RequestUser } from '../common/decorators/current-user.decorator';
import { STAFF_ROLES } from '../common/roles';
import { groupLabel } from '../groups/group-normalize';
import { assertGroupRoster } from '../groups/group-roster';
import { PrismaService } from '../prisma/prisma.service';

const nameRef = { select: { id: true, name: true } } as const;

/** Datos para listar un voucher; un voucher compartido trae todos los equipos que cubre. */
const listInclude = {
  group: {
    include: {
      school: nameRef,
      event: {
        select: { id: true, name: true, faculty: nameRef, school: nameRef },
      },
    },
  },
  teams: {
    orderBy: { id: 'asc' },
    select: {
      id: true,
      name: true,
      cycle: true,
      section: true,
      phone: true,
      slot: true,
      status: true,
      discipline: {
        select: {
          id: true,
          name: true,
          participantType: true,
          minPlayers: true,
          maxPlayers: true,
          genderPolicy: true,
          event: {
            select: { id: true, name: true, faculty: nameRef, school: nameRef },
          },
        },
      },
    },
  },
} satisfies Prisma.VoucherInclude;

const validateInclude = {
  team: { include: { participants: true, discipline: true } },
  teams: {
    orderBy: { id: 'asc' },
    include: { participants: true, discipline: true },
  },
} satisfies Prisma.VoucherInclude;

type VoucherToValidate = Prisma.VoucherGetPayload<{
  include: typeof validateInclude;
}>;

export interface SkippedTeam {
  teamId: number;
  reason: string;
}

@Injectable()
export class VouchersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(filters?: {
    status?: VoucherStatus;
    eventId?: number;
    facultyId?: number;
    schoolId?: number;
    disciplineId?: number;
  }) {
    const disciplineWhere: Prisma.DisciplineWhereInput = {};
    if (filters?.eventId) disciplineWhere.eventId = filters.eventId;

    const eventWhere: Prisma.SportEventWhereInput = {};
    if (filters?.facultyId) eventWhere.facultyId = filters.facultyId;
    if (filters?.schoolId) eventWhere.schoolId = filters.schoolId;
    if (Object.keys(eventWhere).length) disciplineWhere.event = eventWhere;

    const teamWhere: Prisma.TeamWhereInput = {};
    if (filters?.disciplineId) teamWhere.disciplineId = filters.disciplineId;
    if (Object.keys(disciplineWhere).length)
      teamWhere.discipline = disciplineWhere;

    const where: Prisma.VoucherWhereInput = {};
    if (filters?.status) where.status = filters.status;
    if (Object.keys(teamWhere).length) {
      // Un voucher se ubica por los equipos que cubre; uno que todavía no cubre ninguno
      // (pago base recién enviado), por su grupo.
      const scopes: Prisma.VoucherWhereInput[] = [
        { teams: { some: teamWhere } },
      ];
      if (!filters?.disciplineId) {
        const groupWhere: Prisma.ClassGroupWhereInput = {};
        if (filters?.eventId) groupWhere.eventId = filters.eventId;
        if (Object.keys(eventWhere).length) groupWhere.event = eventWhere;
        scopes.push({ group: groupWhere });
      }
      where.OR = scopes;
    }

    const vouchers = await this.prisma.voucher.findMany({
      where,
      include: listInclude,
      orderBy: { uploadedAt: 'desc' },
    });

    // Los integrantes se leen solo del equipo principal de cada voucher (forma histórica).
    const primaryTeamIds = vouchers.flatMap((v) =>
      v.teams[0] ? [v.teams[0].id] : [],
    );
    const participants = primaryTeamIds.length
      ? await this.prisma.participant.findMany({
          where: { teamId: { in: primaryTeamIds } },
          select: {
            id: true,
            teamId: true,
            fullName: true,
            studentCode: true,
            dni: true,
            gender: true,
            isDelegate: true,
            countsAsPlayer: true,
            userId: true,
          },
        })
      : [];

    return vouchers.map((v) => {
      const team = v.teams[0] ?? null;
      const event = team?.discipline.event ?? v.group?.event ?? null;
      const teamParticipants = team
        ? participants
            .filter((p) => p.teamId === team.id)
            .map((p) => ({
              id: p.id,
              fullName: p.fullName,
              studentCode: p.studentCode,
              dni: p.dni,
              gender: p.gender,
              isDelegate: p.isDelegate,
              countsAsPlayer: p.countsAsPlayer,
              userId: p.userId,
            }))
        : [];
      return {
        id: v.id,
        kind: v.kind,
        groupId: v.groupId,
        groupLabel: v.group
          ? groupLabel(
              v.group.school.name,
              v.group.scope,
              v.group.cycle,
              v.group.section,
            )
          : null,
        teamId: team?.id ?? null,
        teamName: team?.name ?? '',
        cycle: team ? team.cycle : (v.group?.cycle ?? null),
        section: team ? team.section : (v.group?.section ?? null),
        phone: team?.phone ?? null,
        operationNumber: v.operationNumber ?? '',
        amount: Number(v.amount),
        imageUrl: v.imageUrl,
        status: v.status,
        rejectionReason: v.rejectionReason,
        uploadedAt: v.uploadedAt,
        disciplineName: team?.discipline.name ?? '',
        participantType:
          team?.discipline.participantType ?? ParticipantType.STUDENT,
        minPlayers: team?.discipline.minPlayers ?? null,
        maxPlayers: team?.discipline.maxPlayers ?? null,
        genderPolicy: team?.discipline.genderPolicy ?? null,
        eventName: event?.name ?? '',
        facultyName: event?.faculty?.name ?? '',
        schoolName: event?.school?.name ?? '',
        participantsCount: teamParticipants.length,
        participants: teamParticipants,
        teams: v.teams.map((t) => ({
          id: t.id,
          name: t.name,
          disciplineName: t.discipline.name,
          slot: t.slot,
          status: t.status,
        })),
      };
    });
  }

  private countedParticipants(participants: { countsAsPlayer: boolean }[]) {
    return participants.length;
  }

  private validateTeamRules(team: {
    participants: {
      gender: string;
      isDelegate: boolean;
      countsAsPlayer: boolean;
      studentCode: string | null;
      dni: string | null;
    }[];
    cycle: string | null;
    section: string | null;
    discipline: {
      participantType: ParticipantType;
      minPlayers: number;
      maxPlayers: number;
      genderPolicy: GenderPolicy;
    };
  }) {
    const count = this.countedParticipants(team.participants);

    if (
      team.discipline.participantType === ParticipantType.STUDENT &&
      team.participants.some((p) => !p.studentCode)
    ) {
      throw new BadRequestException(
        'Las disciplinas para estudiantes requieren codigo de estudiante en todos los integrantes',
      );
    }

    if (
      team.discipline.participantType === ParticipantType.STUDENT &&
      (!team.cycle || !team.section)
    ) {
      throw new BadRequestException(
        'Las disciplinas para estudiantes requieren ciclo y seccion del equipo',
      );
    }

    if (
      team.discipline.participantType === ParticipantType.OTHER &&
      team.participants.some((p) => !p.dni)
    ) {
      throw new BadRequestException(
        'Las disciplinas para otros participantes requieren DNI en todos los integrantes',
      );
    }

    if (
      count < team.discipline.minPlayers ||
      count > team.discipline.maxPlayers
    ) {
      throw new BadRequestException(
        `El equipo debe tener entre ${team.discipline.minPlayers} y ${team.discipline.maxPlayers} jugadores. Tiene ${count}.`,
      );
    }

    if (
      team.discipline.genderPolicy === GenderPolicy.MALE &&
      team.participants.some((p) => p.gender === 'F')
    ) {
      throw new BadRequestException('Esta disciplina es solo masculina');
    }

    if (
      team.discipline.genderPolicy === GenderPolicy.FEMALE &&
      team.participants.some((p) => p.gender === 'M')
    ) {
      throw new BadRequestException('Esta disciplina es solo femenina');
    }
  }

  async validate(id: number, validatedById: number) {
    const voucher = await this.prisma.voucher.findUnique({
      where: { id },
      include: validateInclude,
    });
    if (!voucher) throw new NotFoundException('Comprobante no encontrado');

    return voucher.kind === VoucherKind.TEAM
      ? this.validateTeamVoucher(voucher, validatedById)
      : this.validateGroupVoucher(voucher, validatedById);
  }

  /** Voucher de un solo equipo (flujo por disciplina): comportamiento histórico. */
  private async validateTeamVoucher(
    voucher: VoucherToValidate,
    validatedById: number,
  ) {
    const team = voucher.team;
    if (!team) {
      throw new BadRequestException(
        'Este comprobante no corresponde a un solo equipo',
      );
    }
    this.validateTeamRules(team);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.voucher.update({
        where: { id: voucher.id },
        data: { status: VoucherStatus.VALIDATED, validatedById },
      });
      await tx.team.update({
        where: { id: team.id },
        data: { status: RegistrationStatus.APPROVED },
      });
      return updated;
    });
  }

  /**
   * Voucher BASE o EXTRA: valida el pago una sola vez y aprueba los equipos que cubre y que
   * cumplen las reglas; los demás quedan PENDING y se informan en `skipped`. Validar de nuevo
   * un comprobante ya validado aprueba los equipos pendientes que ahora sí cumplan.
   */
  private async validateGroupVoucher(
    voucher: VoucherToValidate,
    validatedById: number,
  ) {
    if (
      voucher.teams.every((team) => team.status === RegistrationStatus.DRAFT)
    ) {
      throw new BadRequestException(
        voucher.kind === VoucherKind.BASE
          ? 'El salón aún no envió ningún equipo'
          : 'El comprobante adicional aún no cubre ningún equipo enviado',
      );
    }

    const approvedTeamIds: number[] = [];
    const skipped: SkippedTeam[] = [];
    for (const team of voucher.teams) {
      if (team.status !== RegistrationStatus.PENDING) continue;
      try {
        this.validateTeamRules(team);
        assertGroupRoster(team.participants);
        approvedTeamIds.push(team.id);
      } catch (error) {
        skipped.push({
          teamId: team.id,
          reason:
            error instanceof Error
              ? error.message
              : 'El equipo no cumple las reglas',
        });
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.voucher.update({
        where: { id: voucher.id },
        data: {
          status: VoucherStatus.VALIDATED,
          validatedById,
          rejectionReason: null,
        },
      });
      if (approvedTeamIds.length) {
        await tx.team.updateMany({
          where: {
            id: { in: approvedTeamIds },
            status: RegistrationStatus.PENDING,
          },
          data: { status: RegistrationStatus.APPROVED, rejectionReason: null },
        });
      }
      return result;
    });

    return { ...updated, approvedTeamIds, skipped };
  }

  async reject(id: number, reason: string, validatedById: number) {
    const voucher = await this.prisma.voucher.findUnique({ where: { id } });
    if (!voucher) throw new NotFoundException('Comprobante no encontrado');

    const data = {
      status: VoucherStatus.REJECTED,
      rejectionReason: reason,
      validatedById,
    };
    if (voucher.kind === VoucherKind.TEAM) {
      return this.prisma.voucher.update({ where: { id }, data });
    }

    // BASE/EXTRA: los equipos aprobados gracias a este pago vuelven a PENDING.
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.voucher.update({ where: { id }, data });
      await tx.team.updateMany({
        where: { voucherId: id, status: RegistrationStatus.APPROVED },
        data: { status: RegistrationStatus.PENDING },
      });
      return updated;
    });
  }

  /**
   * Reemplaza el comprobante rechazado (nueva imagen y N.º de operación) sin recrear el grupo ni
   * los equipos: el voucher conserva su `id` y los equipos que cubre. Lo puede hacer el delegado
   * del grupo (o del equipo, en el flujo por disciplina) o el staff.
   */
  async replace(
    actor: RequestUser,
    id: number,
    voucherPath: string | undefined,
    operationNumber?: string,
  ) {
    if (!voucherPath) {
      throw new BadRequestException('Adjunta la nueva imagen del comprobante');
    }
    const voucher = await this.prisma.voucher.findUnique({
      where: { id },
      include: {
        team: { select: { delegateId: true } },
        group: { select: { delegateId: true } },
      },
    });
    if (!voucher) throw new NotFoundException('Comprobante no encontrado');

    const isStaff = STAFF_ROLES.includes(actor.role);
    const ownerId =
      voucher.kind === VoucherKind.TEAM
        ? voucher.team?.delegateId
        : voucher.group?.delegateId;
    if (!isStaff && ownerId !== actor.id) {
      throw new ForbiddenException('No puedes reemplazar este comprobante');
    }
    if (voucher.status !== VoucherStatus.REJECTED) {
      throw new BadRequestException(
        'Solo se puede reemplazar un comprobante rechazado',
      );
    }

    return this.prisma.voucher.update({
      where: { id },
      data: {
        imageUrl: voucherPath,
        operationNumber: operationNumber?.trim() || null,
        status: VoucherStatus.PENDING,
        rejectionReason: null,
        validatedById: null,
      },
    });
  }
}
