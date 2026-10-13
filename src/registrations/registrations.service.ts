import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  GenderPolicy,
  ParticipantType,
  Prisma,
  RegistrationStatus,
  Role,
  VoucherStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateRegistrationDto,
  ParticipantDto,
} from './dto/create-registration.dto';

@Injectable()
export class RegistrationsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(filters?: {
    status?: RegistrationStatus;
    eventId?: number;
    facultyId?: number;
    schoolId?: number;
    disciplineId?: number;
    isPaid?: boolean;
    participantType?: ParticipantType;
  }) {
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
        OR: [{ delegateId: userId }, { participants: { some: { userId } } }],
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
      cycle?: string | null;
      section?: string | null;
    } = { checkCapacity: true },
  ) {
    if (options.checkCapacity !== false && new Date() > discipline.registrationDeadline) {
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
      discipline.participantType === ParticipantType.STUDENT &&
      participants.some((p) => !p.studentCode)
    ) {
      throw new BadRequestException(
        'Las disciplinas para estudiantes requieren codigo de estudiante en todos los integrantes',
      );
    }

    if (discipline.participantType === ParticipantType.STUDENT && (!options.cycle || !options.section)) {
      throw new BadRequestException(
        'Las disciplinas para estudiantes requieren ciclo y seccion del equipo',
      );
    }

    if (
      discipline.participantType === ParticipantType.OTHER &&
      participants.some((p) => !p.dni)
    ) {
      throw new BadRequestException(
        'Las disciplinas para otros participantes requieren DNI en todos los integrantes',
      );
    }

    if (
      countedParticipants < discipline.minPlayers ||
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
        throw new BadRequestException(
          `Integrante duplicado: ${p.fullName}`,
        );
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
    user: { role: Role; email: string; studentCode: string | null; dni?: string | null },
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
      include: { _count: { select: { teams: true } } },
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

    this.validateAgainstDiscipline(
      discipline,
      dto.participants,
      discipline._count.teams,
      { cycle: dto.cycle?.trim() || null, section: dto.section?.trim() || null },
    );

    if (discipline.isPaid && !voucherPath) {
      throw new BadRequestException(
        'Esta disciplina requiere adjuntar el comprobante de pago',
      );
    }

    // Vincula cada integrante con su usuario (si existe) por código de
    // estudiante o por DNI, para que luego vea sus equipos/horarios.
    const codes = dto.participants
      .map((p) => p.studentCode)
      .filter((c): c is string => !!c);
    const dnis = dto.participants
      .map((p) => p.dni)
      .filter((d): d is string => !!d);
    const matchUsers =
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
      matchUsers
        .filter((u) => u.studentCode)
        .map((u) => [u.studentCode as string, u.id]),
    );
    const byDni = new Map(
      matchUsers.filter((u) => u.dni).map((u) => [u.dni as string, u.id]),
    );

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
            create: dto.participants.map((p) => {
              let userId: number | null = null;
              if (p.studentCode && byCode.has(p.studentCode)) {
                userId = byCode.get(p.studentCode) ?? null;
              } else if (p.dni && byDni.has(p.dni)) {
                userId = byDni.get(p.dni) ?? null;
              }
              return {
                fullName: p.fullName,
                studentCode: p.studentCode ?? null,
                dni: p.dni ?? null,
                gender: p.gender ?? 'O',
                isDelegate: false,
                countsAsPlayer: true,
                userId,
              };
            }),
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

  async approve(id: number) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: { participants: true, discipline: true, voucher: true },
    });
    if (!team) throw new NotFoundException('Equipo no encontrado');
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
    return this.prisma.team.update({
      where: { id },
      data: { status: RegistrationStatus.REJECTED, rejectionReason: reason },
    });
  }
}
