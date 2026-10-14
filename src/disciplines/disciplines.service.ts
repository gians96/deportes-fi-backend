import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RegistrationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDisciplineDto } from './dto/create-discipline.dto';
import { UpdateDisciplineDto } from './dto/update-discipline.dto';
import { sanitizeRichText } from '../common/rich-text';

@Injectable()
export class DisciplinesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(filters?: {
    eventId?: number;
    facultyId?: number;
    schoolId?: number;
  }) {
    const eventWhere: Prisma.SportEventWhereInput = {};
    if (filters?.facultyId) eventWhere.facultyId = filters.facultyId;
    if (filters?.schoolId) eventWhere.schoolId = filters.schoolId;

    const where: Prisma.DisciplineWhereInput = {};
    if (filters?.eventId) where.eventId = filters.eventId;
    if (Object.keys(eventWhere).length) where.event = eventWhere;

    const disciplines = await this.prisma.discipline.findMany({
      where,
      include: {
        event: { select: { id: true, name: true } },
        _count: {
          select: {
            teams: { where: { status: RegistrationStatus.APPROVED } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return disciplines.map(({ _count, ...discipline }) => ({
      ...discipline,
      teamsCount: _count.teams,
    }));
  }

  async findOne(id: number) {
    const discipline = await this.prisma.discipline.findUnique({
      where: { id },
      include: {
        event: { select: { id: true, name: true } },
        teams: {
          where: { status: RegistrationStatus.APPROVED },
          select: {
            id: true,
            name: true,
            status: true,
            cycle: true,
            section: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: {
          select: {
            teams: { where: { status: RegistrationStatus.APPROVED } },
          },
        },
      },
    });
    if (!discipline) {
      throw new NotFoundException('Disciplina no encontrada');
    }
    const { _count, ...disciplineData } = discipline;
    return { ...disciplineData, teamsCount: _count.teams };
  }

  create(dto: CreateDisciplineDto) {
    return this.prisma.discipline.create({
      data: {
        eventId: dto.eventId,
        name: dto.name,
        modality: dto.modality,
        genderPolicy: dto.genderPolicy,
        format: dto.format,
        participantType: dto.participantType,
        minPlayers: dto.minPlayers,
        maxPlayers: dto.maxPlayers,
        maxTeams: dto.maxTeams,
        isPaid: dto.isPaid,
        cost: dto.cost !== undefined ? new Prisma.Decimal(dto.cost) : undefined,
        rulesText: sanitizeRichText(dto.rulesText, 'las bases'),
        extraInfo: sanitizeRichText(dto.extraInfo, 'la información adicional'),
        registrationDeadline: new Date(dto.registrationDeadline),
        winPoints: dto.winPoints,
        drawPoints: dto.drawPoints,
        lossPoints: dto.lossPoints,
        allowDraw: dto.allowDraw,
        matchDurationMinutes: dto.matchDurationMinutes,
        courtsCount: dto.courtsCount,
      },
    });
  }

  async update(id: number, dto: UpdateDisciplineDto) {
    await this.findOne(id);
    return this.prisma.discipline.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.modality !== undefined && { modality: dto.modality }),
        ...(dto.genderPolicy !== undefined && {
          genderPolicy: dto.genderPolicy,
        }),
        ...(dto.format !== undefined && { format: dto.format }),
        ...(dto.participantType !== undefined && {
          participantType: dto.participantType,
        }),
        ...(dto.minPlayers !== undefined && { minPlayers: dto.minPlayers }),
        ...(dto.maxPlayers !== undefined && { maxPlayers: dto.maxPlayers }),
        ...(dto.maxTeams !== undefined && { maxTeams: dto.maxTeams }),
        ...(dto.isPaid !== undefined && { isPaid: dto.isPaid }),
        ...(dto.cost !== undefined && { cost: new Prisma.Decimal(dto.cost) }),
        ...(dto.rulesText !== undefined && {
          rulesText: sanitizeRichText(dto.rulesText, 'las bases'),
        }),
        ...(dto.extraInfo !== undefined && {
          extraInfo: sanitizeRichText(
            dto.extraInfo,
            'la información adicional',
          ),
        }),
        ...(dto.registrationDeadline !== undefined && {
          registrationDeadline: new Date(dto.registrationDeadline),
        }),
        ...(dto.winPoints !== undefined && { winPoints: dto.winPoints }),
        ...(dto.drawPoints !== undefined && { drawPoints: dto.drawPoints }),
        ...(dto.lossPoints !== undefined && { lossPoints: dto.lossPoints }),
        ...(dto.allowDraw !== undefined && { allowDraw: dto.allowDraw }),
        ...(dto.matchDurationMinutes !== undefined && {
          matchDurationMinutes: dto.matchDurationMinutes,
        }),
        ...(dto.courtsCount !== undefined && { courtsCount: dto.courtsCount }),
      },
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.discipline.delete({ where: { id } });
    return { success: true };
  }
}
