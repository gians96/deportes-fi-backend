import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Gender,
  GenderPolicy,
  GroupScope,
  ParticipantType,
  Prisma,
  PricingMode,
  RegistrationStatus,
  Role,
  VoucherKind,
  VoucherStatus,
} from '@prisma/client';
import { prismaErrorCode } from '../common/prisma-errors';
import { CYCLE_FULL_SECTION } from '../groups/group-normalize';
import { extraFee } from '../groups/group-pricing';
import type { PricingValues } from '../groups/group-pricing';
import { assertDraftRoster, assertGroupRoster } from '../groups/group-roster';
import { isStaffRole } from '../common/roles';
import type { RequestUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateRegistrationDto,
  ParticipantDto,
  UpdateRegistrationDto,
} from './dto/create-registration.dto';

const disciplineInclude = {
  _count: { select: { teams: true } },
  event: {
    select: { id: true, pricingMode: true, isOpen: true, pricing: true },
  },
} satisfies Prisma.DisciplineInclude;

/** Reintentos cuando otra solicitud toma el mismo cupo al mismo tiempo. */
const SLOT_ATTEMPTS = 3;

type DisciplineWithEvent = Prisma.DisciplineGetPayload<{
  include: typeof disciplineInclude;
}>;

type TeamForApproval = Prisma.TeamGetPayload<{
  include: { participants: true; discipline: true; voucher: true };
}>;

@Injectable()
export class RegistrationsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(
    filters?: {
      status?: RegistrationStatus;
      eventId?: number;
      facultyId?: number;
      schoolId?: number;
      disciplineId?: number;
      isPaid?: boolean;
      participantType?: ParticipantType;
    },
    viewerRole?: Role,
  ) {
    const disciplineWhere: Prisma.DisciplineWhereInput = {};
    if (filters?.eventId) disciplineWhere.eventId = filters.eventId;
    if (filters?.isPaid !== undefined) disciplineWhere.isPaid = filters.isPaid;
    if (filters?.participantType) {
      disciplineWhere.participantType = filters.participantType;
    }

    const eventWhere: Prisma.SportEventWhereInput = {};
    if (filters?.facultyId) eventWhere.facultyId = filters.facultyId;
    if (filters?.schoolId) eventWhere.schoolId = filters.schoolId;
    if (Object.keys(eventWhere).length) disciplineWhere.event = eventWhere;

    const where: Prisma.TeamWhereInput = {};
    if (filters?.status) where.status = filters.status;
    // El tesorero no ve los borradores: el equipo todavía no se envió.
    if (viewerRole === Role.TREASURER) {
      where.status =
        filters?.status === RegistrationStatus.DRAFT
          ? { in: [] }
          : (filters?.status ?? { not: RegistrationStatus.DRAFT });
    }
    if (filters?.disciplineId) where.disciplineId = filters.disciplineId;
    if (Object.keys(disciplineWhere).length) where.discipline = disciplineWhere;

    return this.prisma.team.findMany({
      where,
      include: {
        participants: true,
        delegate: {
          select: {
            id: true,
            fullName: true,
            email: true,
            studentCode: true,
            dni: true,
          },
        },
        discipline: {
          select: {
            id: true,
            name: true,
            isPaid: true,
            cost: true,
            participantType: true,
            minPlayers: true,
            maxPlayers: true,
            genderPolicy: true,
            event: {
              select: {
                id: true,
                name: true,
                faculty: { select: { id: true, name: true } },
                school: { select: { id: true, name: true } },
              },
            },
          },
        },
        voucher: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findMine(userId: number) {
    return this.prisma.team.findMany({
      where: {
        OR: [
          { delegateId: userId },
          {
            participants: { some: { userId } },
            status: { not: RegistrationStatus.DRAFT },
          },
        ],
      },
      include: {
        participants: true,
        delegate: {
          select: {
            id: true,
            fullName: true,
            email: true,
            studentCode: true,
            dni: true,
          },
        },
        discipline: {
          select: {
            id: true,
            name: true,
            isPaid: true,
            cost: true,
            participantType: true,
            minPlayers: true,
            maxPlayers: true,
            genderPolicy: true,
            event: {
              select: {
                id: true,
                name: true,
                faculty: { select: { id: true, name: true } },
                school: { select: { id: true, name: true } },
              },
            },
          },
        },
        voucher: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private validateAgainstDiscipline(
    discipline: {
      participantType: ParticipantType;
      minPlayers: number;
      maxPlayers: number;
      genderPolicy: GenderPolicy;
      registrationDeadline: Date;
      maxTeams: number;
    },
    participants: ParticipantDto[],
    currentTeamCount: number,
    options: {
      checkCapacity?: boolean;
      /** Por defecto sigue a `checkCapacity`; el delegado que edita no ocupa un cupo nuevo, pero sí respeta el plazo. */
      checkDeadline?: boolean;
      /** Borrador: no exige mínimo de jugadores, códigos, DNI ni ciclo/sección hasta enviarlo. */
      draft?: boolean;
      cycle?: string | null;
      section?: string | null;
    } = { checkCapacity: true },
  ) {
    if (
      (options.checkDeadline ?? options.checkCapacity !== false) &&
      new Date() > discipline.registrationDeadline
    ) {
      throw new BadRequestException(
        'El plazo de inscripción para esta disciplina ya cerró',
      );
    }

    if (
      options.checkCapacity !== false &&
      discipline.maxTeams > 0 &&
      currentTeamCount >= discipline.maxTeams
    ) {
      throw new BadRequestException(
        'Se alcanzó el número máximo de equipos para esta disciplina',
      );
    }

    const countedParticipants = this.countedParticipants(
      discipline.participantType,
      participants,
    );

    if (
      !options.draft &&
      discipline.participantType === ParticipantType.STUDENT &&
      participants.some((p) => !p.studentCode)
    ) {
      throw new BadRequestException(
        'Las disciplinas para estudiantes requieren codigo de estudiante en todos los integrantes',
      );
    }

    if (
      !options.draft &&
      discipline.participantType === ParticipantType.STUDENT &&
      (!options.cycle || !options.section)
    ) {
      throw new BadRequestException(
        'Las disciplinas para estudiantes requieren ciclo y seccion del equipo',
      );
    }

    if (
      !options.draft &&
      discipline.participantType === ParticipantType.OTHER &&
      participants.some((p) => !p.dni)
    ) {
      throw new BadRequestException(
        'Las disciplinas para otros participantes requieren DNI en todos los integrantes',
      );
    }

    if (
      (!options.draft && countedParticipants < discipline.minPlayers) ||
      countedParticipants > discipline.maxPlayers
    ) {
      throw new BadRequestException(
        `El equipo debe tener entre ${discipline.minPlayers} y ${discipline.maxPlayers} jugadores. Tiene ${countedParticipants}.`,
      );
    }

    // Validación de duplicados por DNI/código dentro del mismo equipo
    const identifiers = new Set<string>();
    for (const p of participants) {
      const id = (p.studentCode || p.dni || '').toLowerCase();
      if (id && identifiers.has(id)) {
        throw new BadRequestException(`Integrante duplicado: ${p.fullName}`);
      }
      if (id) identifiers.add(id);
    }

    // Validación de política de género
    if (discipline.genderPolicy === GenderPolicy.MALE) {
      if (participants.some((p) => p.gender === 'F')) {
        throw new BadRequestException('Esta disciplina es solo masculina');
      }
    } else if (discipline.genderPolicy === GenderPolicy.FEMALE) {
      if (participants.some((p) => p.gender === 'M')) {
        throw new BadRequestException('Esta disciplina es solo femenina');
      }
    }
  }

  private countedParticipants(
    _participantType: ParticipantType,
    participants: Pick<ParticipantDto, 'countsAsPlayer'>[],
  ) {
    return participants.length;
  }

  private validateParticipantAccess(
    discipline: { participantType: ParticipantType },
    user: {
      role: Role;
      email: string;
      studentCode: string | null;
      dni?: string | null;
    },
  ) {
    if (user.role === Role.OWNER_SYSTEM || user.role === Role.ADMIN_SYSTEM) {
      return;
    }

    if (user.role === Role.OTHER) {
      if (!user.dni) {
        throw new BadRequestException(
          'Completa tu perfil validando tu DNI antes de inscribirte.',
        );
      }
      return;
    }

    const userType =
      user.role === Role.STUDENT || user.studentCode || /^\d+@/.test(user.email)
        ? ParticipantType.STUDENT
        : ParticipantType.OTHER;

    if (discipline.participantType !== userType) {
      throw new BadRequestException(
        discipline.participantType === ParticipantType.STUDENT
          ? 'Esta disciplina es solo para estudiantes con codigo institucional.'
          : 'Esta disciplina es solo para otros participantes institucionales.',
      );
    }
  }

  async create(
    userId: number,
    dto: CreateRegistrationDto,
    voucherPath?: string,
    delegateId?: number,
  ) {
    const discipline = await this.prisma.discipline.findUnique({
      where: { id: Number(dto.disciplineId) },
      include: disciplineInclude,
    });
    if (!discipline) {
      throw new NotFoundException('Disciplina no encontrada');
    }

    const finalDelegateId = delegateId ?? userId;
    const requester = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, email: true, studentCode: true, dni: true },
    });
    if (!requester) {
      throw new NotFoundException('Usuario no encontrado');
    }
    this.validateParticipantAccess(discipline, requester);

    if (delegateId) {
      const delegate = await this.prisma.user.findUnique({
        where: { id: delegateId },
      });
      if (!delegate) {
        throw new NotFoundException('Delegado no encontrado');
      }
    }

    if (this.usesGroupPricing(discipline)) {
      return this.createForGroup({
        userId,
        requesterRole: requester.role,
        discipline,
        dto,
        voucherPath,
        delegateId,
      });
    }

    if (dto.draft) {
      throw new BadRequestException(
        'Los borradores solo existen en eventos que cobran por salón o ciclo',
      );
    }

    this.validateAgainstDiscipline(
      discipline,
      dto.participants,
      discipline._count.teams,
      {
        cycle: dto.cycle?.trim() || null,
        section: dto.section?.trim() || null,
      },
    );

    if (discipline.isPaid && !voucherPath) {
      throw new BadRequestException(
        'Esta disciplina requiere adjuntar el comprobante de pago',
      );
    }

    const { byCode, byDni } = await this.matchUsers(dto.participants);

    return this.prisma.$transaction(async (tx) => {
      const team = await tx.team.create({
        data: {
          name: dto.teamName,
          disciplineId: discipline.id,
          delegateId: finalDelegateId,
          cycle: dto.cycle?.trim() || null,
          section: dto.section?.trim() || null,
          phone: dto.phone,
          status: RegistrationStatus.PENDING,
          participants: {
            create: this.participantRows(dto.participants, byCode, byDni),
          },
        },
      });

      if (discipline.isPaid && voucherPath) {
        const voucher = await tx.voucher.create({
          data: {
            teamId: team.id,
            operationNumber: dto.operationNumber ?? null,
            amount: new Prisma.Decimal(discipline.cost),
            imageUrl: voucherPath,
            status: VoucherStatus.PENDING,
          },
        });
        // Doble escritura de transición (spec 002): el equipo apunta a su voucher.
        await tx.team.update({
          where: { id: team.id },
          data: { voucherId: voucher.id },
        });
      }

      return tx.team.findUnique({
        where: { id: team.id },
        include: { participants: true, voucher: true },
      });
    });
  }

  private usesGroupPricing(discipline: DisciplineWithEvent): boolean {
    return (
      discipline.event.pricingMode === PricingMode.PER_GROUP &&
      discipline.participantType === ParticipantType.STUDENT
    );
  }

  /**
   * Vincula cada integrante con su usuario (si existe) por código de estudiante o por DNI,
   * para que luego vea sus equipos/horarios.
   */
  private async matchUsers(participants: ParticipantDto[]) {
    const codes = participants
      .map((p) => p.studentCode)
      .filter((c): c is string => !!c);
    const dnis = participants.map((p) => p.dni).filter((d): d is string => !!d);
    const matches =
      codes.length || dnis.length
        ? await this.prisma.user.findMany({
            where: {
              OR: [
                ...(codes.length ? [{ studentCode: { in: codes } }] : []),
                ...(dnis.length ? [{ dni: { in: dnis } }] : []),
              ],
            },
            select: { id: true, studentCode: true, dni: true },
          })
        : [];
    const byCode = new Map(
      matches
        .filter((u) => u.studentCode)
        .map((u) => [u.studentCode as string, u.id]),
    );
    const byDni = new Map(
      matches.filter((u) => u.dni).map((u) => [u.dni as string, u.id]),
    );
    return { byCode, byDni };
  }

  private participantRows(
    participants: ParticipantDto[],
    byCode: Map<string, number>,
    byDni: Map<string, number>,
  ) {
    return participants.map((p) => {
      let linkedUserId: number | null = null;
      if (p.studentCode && byCode.has(p.studentCode)) {
        linkedUserId = byCode.get(p.studentCode) ?? null;
      } else if (p.dni && byDni.has(p.dni)) {
        linkedUserId = byDni.get(p.dni) ?? null;
      }
      return {
        fullName: p.fullName,
        studentCode: p.studentCode ?? null,
        dni: p.dni ?? null,
        gender: p.gender ?? Gender.O,
        isDelegate: false,
        countsAsPlayer: true,
        isCaptain: p.isCaptain === true,
        userId: linkedUserId,
      };
    });
  }

  /**
   * Equipo de un salón o ciclo (eventos PER_GROUP): el primer equipo de cada disciplina queda
   * cubierto por el pago general del grupo; los siguientes son adicionales y exigen su propio
   * comprobante. El cupo lo fija la base de datos (UNIQUE groupId + disciplineId + slot).
   */
  private async createForGroup(args: {
    userId: number;
    requesterRole: Role;
    discipline: DisciplineWithEvent;
    dto: CreateRegistrationDto;
    voucherPath?: string;
    delegateId?: number;
  }) {
    const { userId, requesterRole, discipline, dto, voucherPath } = args;
    const event = discipline.event;
    if (!event.isOpen) {
      throw new BadRequestException(
        'El evento no está abierto a inscripciones',
      );
    }
    if (!dto.groupId) {
      throw new BadRequestException(
        'Este evento se inscribe por salón o ciclo: primero registra tu salón o ciclo',
      );
    }
    const group = await this.prisma.classGroup.findUnique({
      where: { id: dto.groupId },
    });
    if (!group || group.eventId !== event.id) {
      throw new NotFoundException('Salón o ciclo no encontrado');
    }
    const isStaff =
      requesterRole === Role.OWNER_SYSTEM ||
      requesterRole === Role.ADMIN_SYSTEM;
    if (!isStaff && group.delegateId !== userId) {
      throw new ForbiddenException('No eres el delegado de este salón o ciclo');
    }
    const baseVoucherId = group.baseVoucherId;
    if (!baseVoucherId) {
      throw new BadRequestException(
        'El salón o ciclo no tiene registrado el pago general',
      );
    }

    const cycle = group.cycle;
    const section =
      group.scope === GroupScope.CYCLE ? CYCLE_FULL_SECTION : group.section;
    const draft = dto.draft === true;
    this.validateAgainstDiscipline(
      discipline,
      dto.participants,
      discipline._count.teams,
      { cycle, section, draft },
    );
    if (draft) assertDraftRoster(dto.participants);
    else assertGroupRoster(dto.participants);

    const teamDelegateId = isStaff
      ? (args.delegateId ?? group.delegateId)
      : userId;
    const { byCode, byDni } = await this.matchUsers(dto.participants);

    for (let attempt = 1; attempt <= SLOT_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const taken = await tx.team.findMany({
            where: { groupId: group.id, disciplineId: discipline.id },
            select: { slot: true },
          });
          const used = new Set(taken.map((t) => t.slot));
          let slot = 1;
          while (used.has(slot)) slot += 1;

          let voucherId = baseVoucherId;
          if (slot === 1) {
            if (voucherPath || dto.extraVoucherId) {
              throw new BadRequestException(
                'El primer equipo de cada disciplina ya está cubierto por el pago general: no adjuntes otro comprobante',
              );
            }
          } else {
            voucherId = await this.resolveExtraVoucher(tx, {
              group,
              pricing: event.pricing,
              dto,
              voucherPath,
            });
          }

          const team = await tx.team.create({
            data: {
              name: dto.teamName,
              disciplineId: discipline.id,
              delegateId: teamDelegateId,
              cycle,
              section,
              phone: dto.phone,
              status: draft
                ? RegistrationStatus.DRAFT
                : RegistrationStatus.PENDING,
              groupId: group.id,
              slot,
              voucherId,
              participants: {
                create: this.participantRows(dto.participants, byCode, byDni),
              },
            },
            select: { id: true },
          });

          return tx.team.findUnique({
            where: { id: team.id },
            include: { participants: true, voucher: true },
          });
        });
      } catch (error) {
        // P2002: otro equipo tomó el mismo cupo al mismo tiempo; se reintenta.
        if (prismaErrorCode(error) === 'P2002' && attempt < SLOT_ATTEMPTS) {
          continue;
        }
        if (prismaErrorCode(error) === 'P2002') {
          throw new ConflictException(
            'Otro equipo se registró al mismo tiempo; intenta nuevamente',
          );
        }
        throw error;
      }
    }
    throw new ConflictException(
      'Otro equipo se registró al mismo tiempo; intenta nuevamente',
    );
  }

  /** Comprobante EXTRA de un equipo adicional: uno nuevo o uno pendiente del mismo grupo. */
  private async resolveExtraVoucher(
    tx: Prisma.TransactionClient,
    args: {
      group: { id: number; scope: GroupScope };
      pricing: PricingValues | null;
      dto: CreateRegistrationDto;
      voucherPath?: string;
    },
  ): Promise<number> {
    const { group, pricing, dto, voucherPath } = args;
    if (!pricing) {
      throw new BadRequestException('El evento no tiene tarifas configuradas');
    }
    const fee = extraFee(pricing, group.scope);

    if (dto.extraVoucherId) {
      if (voucherPath) {
        throw new BadRequestException(
          'Envía un comprobante nuevo o suma el equipo a un comprobante adicional existente, no ambos',
        );
      }
      const existing = await tx.voucher.findUnique({
        where: { id: dto.extraVoucherId },
        select: {
          id: true,
          kind: true,
          groupId: true,
          status: true,
          _count: { select: { teams: { where: { slot: { not: null } } } } },
        },
      });
      if (
        !existing ||
        existing.kind !== VoucherKind.EXTRA ||
        existing.groupId !== group.id
      ) {
        throw new BadRequestException(
          'El comprobante adicional no corresponde a este salón o ciclo',
        );
      }
      if (existing.status !== VoucherStatus.PENDING) {
        throw new BadRequestException(
          'El comprobante adicional ya fue revisado: adjunta uno nuevo',
        );
      }
      await tx.voucher.update({
        where: { id: existing.id },
        data: { amount: fee.mul(existing._count.teams + 1) },
      });
      return existing.id;
    }

    if (!voucherPath) {
      throw new BadRequestException(
        `El equipo adicional requiere su comprobante de pago (S/ ${fee.toFixed(2)})`,
      );
    }
    const created = await tx.voucher.create({
      data: {
        kind: VoucherKind.EXTRA,
        groupId: group.id,
        operationNumber: dto.operationNumber?.trim() || null,
        amount: fee,
        imageUrl: voucherPath,
        status: VoucherStatus.PENDING,
      },
      select: { id: true },
    });
    return created.id;
  }

  /** Aprobación de un equipo de grupo: su comprobante (base o extra) debe estar validado. */
  private async approveGroupTeam(team: TeamForApproval) {
    if (
      team.status === RegistrationStatus.REJECTED ||
      team.status === RegistrationStatus.CANCELLED
    ) {
      throw new BadRequestException(
        'Un equipo rechazado o cancelado no se puede aprobar: debe registrarse de nuevo',
      );
    }
    this.validateAgainstDiscipline(team.discipline, team.participants, 0, {
      checkCapacity: false,
      cycle: team.cycle,
      section: team.section,
    });
    assertGroupRoster(team.participants);
    if (team.voucher?.status !== VoucherStatus.VALIDATED) {
      throw new BadRequestException(
        'Primero valida el comprobante que cubre al equipo',
      );
    }
    return this.prisma.team.update({
      where: { id: team.id },
      data: { status: RegistrationStatus.APPROVED, rejectionReason: null },
    });
  }

  /** Equipo con lo necesario para editarlo, enviarlo o quitarlo. */
  private async loadManageable(id: number) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: {
        participants: true,
        group: { select: { id: true, delegateId: true, scope: true } },
        voucher: { select: { id: true, kind: true, status: true } },
        discipline: { include: disciplineInclude },
      },
    });
    if (!team) throw new NotFoundException('Equipo no encontrado');
    return team;
  }

  /**
   * El staff gestiona cualquier equipo; el delegado (del equipo o de su salón) solo mientras es un
   * borrador. El tesorero y el resto reciben 403.
   */
  private assertCanManage(
    actor: RequestUser,
    team: {
      status: RegistrationStatus;
      delegateId: number;
      group: { delegateId: number } | null;
    },
  ) {
    if (isStaffRole(actor.role)) return;
    const owns =
      team.delegateId === actor.id || team.group?.delegateId === actor.id;
    if (!owns) {
      throw new ForbiddenException('No puedes modificar este equipo');
    }
    if (team.status !== RegistrationStatus.DRAFT) {
      throw new ForbiddenException(
        'El equipo ya fue enviado: solo un administrador puede modificarlo',
      );
    }
  }

  private toParticipantDtos(
    rows: Array<{
      fullName: string;
      studentCode: string | null;
      dni: string | null;
      gender: Gender;
      isDelegate: boolean;
      countsAsPlayer: boolean;
      isCaptain: boolean;
    }>,
  ): ParticipantDto[] {
    return rows.map((row) => ({
      fullName: row.fullName,
      studentCode: row.studentCode,
      dni: row.dni,
      gender: row.gender,
      isDelegate: row.isDelegate,
      countsAsPlayer: row.countsAsPlayer,
      isCaptain: row.isCaptain,
    }));
  }

  /**
   * Edita nombre, celular y nómina de un equipo. El delegado solo edita sus borradores (antes del
   * cierre y con el evento abierto); owner y administrador editan cualquier equipo no cancelado y se
   * aplican las reglas completas: un equipo aprobado sigue aprobado si las cumple.
   */
  async update(actor: RequestUser, id: number, dto: UpdateRegistrationDto) {
    const team = await this.loadManageable(id);
    this.assertCanManage(actor, team);
    if (team.status === RegistrationStatus.CANCELLED) {
      throw new BadRequestException('Un equipo cancelado no se puede editar');
    }
    const staff = isStaffRole(actor.role);
    if (!staff && !team.discipline.event.isOpen) {
      throw new BadRequestException(
        'El evento no está abierto a inscripciones',
      );
    }
    const name = dto.teamName?.trim();
    if (dto.teamName !== undefined && !name) {
      throw new BadRequestException('El nombre del equipo es obligatorio');
    }

    const draft = team.status === RegistrationStatus.DRAFT;
    const participants =
      dto.participants ?? this.toParticipantDtos(team.participants);
    this.validateAgainstDiscipline(team.discipline, participants, 0, {
      checkCapacity: false,
      checkDeadline: !staff,
      draft,
      cycle: team.cycle,
      section: team.section,
    });
    if (team.groupId !== null) {
      if (draft) assertDraftRoster(participants);
      else assertGroupRoster(participants);
    }

    const replacement = dto.participants
      ? await this.matchUsers(dto.participants)
      : null;
    return this.prisma.$transaction(async (tx) => {
      await tx.team.update({
        where: { id },
        data: {
          ...(name !== undefined && { name }),
          ...(dto.phone !== undefined && { phone: dto.phone }),
        },
      });
      if (dto.participants && replacement) {
        await tx.participant.deleteMany({ where: { teamId: id } });
        await tx.participant.createMany({
          data: this.participantRows(
            dto.participants,
            replacement.byCode,
            replacement.byDni,
          ).map((row) => ({ ...row, teamId: id })),
        });
      }
      return tx.team.findUnique({
        where: { id },
        include: { participants: true, voucher: true },
      });
    });
  }

  /** «Enviar»: el borrador pasa a PENDING con las reglas completas del equipo. */
  async submit(actor: RequestUser, id: number) {
    const team = await this.loadManageable(id);
    this.assertCanManage(actor, team);
    if (team.status !== RegistrationStatus.DRAFT) {
      throw new BadRequestException('El equipo ya fue enviado');
    }
    const staff = isStaffRole(actor.role);
    if (!staff && !team.discipline.event.isOpen) {
      throw new BadRequestException(
        'El evento no está abierto a inscripciones',
      );
    }
    const participants = this.toParticipantDtos(team.participants);
    this.validateAgainstDiscipline(team.discipline, participants, 0, {
      checkCapacity: false,
      checkDeadline: !staff,
      cycle: team.cycle,
      section: team.section,
    });
    assertGroupRoster(participants);
    return this.prisma.team.update({
      where: { id },
      data: { status: RegistrationStatus.PENDING, rejectionReason: null },
      include: { participants: true, voucher: true },
    });
  }

  /**
   * Quita un borrador y libera su cupo. Si era el último equipo de un comprobante adicional todavía
   * pendiente, ese comprobante se elimina; si comparte comprobante, su monto se recalcula.
   */
  async remove(actor: RequestUser, id: number) {
    const team = await this.loadManageable(id);
    this.assertCanManage(actor, team);
    if (team.status !== RegistrationStatus.DRAFT) {
      throw new BadRequestException(
        'Solo se puede quitar un equipo en borrador',
      );
    }
    const pricing = team.discipline.event.pricing;
    await this.prisma.$transaction(async (tx) => {
      await tx.team.delete({ where: { id } });
      const voucher = team.voucher;
      if (
        voucher?.kind !== VoucherKind.EXTRA ||
        voucher.status !== VoucherStatus.PENDING
      ) {
        return;
      }
      const covered = await tx.team.count({ where: { voucherId: voucher.id } });
      if (covered === 0) {
        await tx.voucher.delete({ where: { id: voucher.id } });
        return;
      }
      if (pricing && team.group) {
        const withSlot = await tx.team.count({
          where: { voucherId: voucher.id, slot: { not: null } },
        });
        await tx.voucher.update({
          where: { id: voucher.id },
          data: { amount: extraFee(pricing, team.group.scope).mul(withSlot) },
        });
      }
    });
    return { id, deleted: true };
  }

  async approve(id: number) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: { participants: true, discipline: true, voucher: true },
    });
    if (!team) throw new NotFoundException('Equipo no encontrado');
    if (team.status === RegistrationStatus.DRAFT) {
      throw new BadRequestException(
        'El equipo es un borrador: el delegado debe enviarlo antes de aprobarlo',
      );
    }
    if (team.groupId !== null) {
      return this.approveGroupTeam(team);
    }
    this.validateAgainstDiscipline(team.discipline, team.participants, 0, {
      checkCapacity: false,
      cycle: team.cycle,
      section: team.section,
    });
    if (
      team.discipline.isPaid &&
      team.voucher?.status !== VoucherStatus.VALIDATED
    ) {
      throw new BadRequestException(
        'Primero valida el voucher del equipo pagado',
      );
    }
    return this.prisma.team.update({
      where: { id },
      data: { status: RegistrationStatus.APPROVED, rejectionReason: null },
    });
  }

  async reject(id: number, reason: string) {
    const team = await this.prisma.team.findUnique({ where: { id } });
    if (!team) throw new NotFoundException('Equipo no encontrado');
    if (team.status === RegistrationStatus.DRAFT) {
      throw new BadRequestException(
        'El equipo es un borrador: aún no fue enviado, no se puede rechazar',
      );
    }
    return this.prisma.team.update({
      where: { id },
      data: {
        status: RegistrationStatus.REJECTED,
        rejectionReason: reason,
        // Libera el cupo del grupo: un reemplazo no se cobra como equipo adicional.
        ...(team.groupId !== null ? { slot: null } : {}),
      },
    });
  }
}
