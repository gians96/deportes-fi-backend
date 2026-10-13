import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  GenderPolicy,
  ParticipantType,
  Prisma,
  RegistrationStatus,
  VoucherStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
    if (Object.keys(teamWhere).length) where.team = teamWhere;

    const vouchers = await this.prisma.voucher.findMany({
      where,
      include: {
        team: {
          select: {
            id: true,
            name: true,
            cycle: true,
            section: true,
            phone: true,
            participants: {
              select: {
                id: true,
                fullName: true,
                studentCode: true,
                dni: true,
                gender: true,
                isDelegate: true,
                countsAsPlayer: true,
                userId: true,
              },
            },
            discipline: {
              select: {
                id: true,
                name: true,
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
          },
        },
      },
      orderBy: { uploadedAt: 'desc' },
    });
    // BASE/EXTRA no tienen un equipo propio: los muestra el panel por grupo (spec 002, US4).
    const withTeam = vouchers.filter(
      (v): v is typeof v & { team: NonNullable<typeof v.team> } =>
        v.team !== null,
    );
    return withTeam.map((v) => ({
      id: v.id,
      teamId: v.teamId,
      teamName: v.team.name,
      cycle: v.team.cycle,
      section: v.team.section,
      phone: v.team.phone,
      operationNumber: v.operationNumber ?? '',
      amount: Number(v.amount),
      imageUrl: v.imageUrl,
      status: v.status,
      rejectionReason: v.rejectionReason,
      uploadedAt: v.uploadedAt,
      disciplineName: v.team.discipline.name,
      participantType: v.team.discipline.participantType,
      minPlayers: v.team.discipline.minPlayers,
      maxPlayers: v.team.discipline.maxPlayers,
      genderPolicy: v.team.discipline.genderPolicy,
      eventName: v.team.discipline.event.name,
      facultyName: v.team.discipline.event.faculty?.name ?? '',
      schoolName: v.team.discipline.event.school?.name ?? '',
      participantsCount: v.team.participants.length,
      participants: v.team.participants,
    }));
  }

  private countedParticipants(
    participants: { countsAsPlayer: boolean }[],
  ) {
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

    if (count < team.discipline.minPlayers || count > team.discipline.maxPlayers) {
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
      include: {
        team: {
          include: {
            participants: true,
            discipline: true,
          },
        },
      },
    });
    if (!voucher) throw new NotFoundException('Comprobante no encontrado');
    const team = voucher.team;
    if (!team) {
      // BASE/EXTRA: la validación en bloque llega con la spec 002 (US4).
      throw new BadRequestException(
        'Este comprobante no corresponde a un solo equipo',
      );
    }
    this.validateTeamRules(team);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.voucher.update({
        where: { id },
        data: { status: VoucherStatus.VALIDATED, validatedById },
      });
      await tx.team.update({
        where: { id: team.id },
        data: { status: RegistrationStatus.APPROVED },
      });
      return updated;
    });
  }

  async reject(id: number, reason: string, validatedById: number) {
    const voucher = await this.prisma.voucher.findUnique({ where: { id } });
    if (!voucher) throw new NotFoundException('Comprobante no encontrado');

    return this.prisma.voucher.update({
      where: { id },
      data: {
        status: VoucherStatus.REJECTED,
        rejectionReason: reason,
        validatedById,
      },
    });
  }
}
