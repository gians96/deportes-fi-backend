import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ParticipantType,
  Prisma,
  RegistrationStatus,
  VoucherStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_PAGE_SIZE,
  IntegrationPaginationQueryDto,
  IntegrationPaymentsQueryDto,
  IntegrationRegistrationsQueryDto,
} from './dto/integration-list-query.dto';
import {
  IntegrationDisciplineSummary,
  IntegrationEvent,
  IntegrationParticipantTypeSummary,
  IntegrationPayment,
  IntegrationRegistration,
  IntegrationSummary,
  Paginated,
} from './integrations.types';

const ZERO = new Prisma.Decimal(0);

/** Orden estable de `byParticipantType` (siempre ambos tipos). */
const PARTICIPANT_TYPES: ParticipantType[] = [
  ParticipantType.STUDENT,
  ParticipantType.OTHER,
];

interface DisciplineAccumulator {
  total: number;
  approved: number;
  pending: number;
  validatedAmount: Prisma.Decimal;
  pendingAmount: Prisma.Decimal;
}

interface ParticipantTypeAccumulator {
  teams: number;
  validatedAmount: Prisma.Decimal;
  pendingAmount: Prisma.Decimal;
}

interface PaymentAccumulator {
  count: number;
  amount: Prisma.Decimal;
}

/**
 * Consultas de solo lectura para sistemas externos. Todas reciben el `eventId`
 * del token (nunca de la solicitud) y lo aplican en cada filtro.
 */
@Injectable()
export class IntegrationsService {
  constructor(private readonly prisma: PrismaService) {}

  async getEvent(eventId: number): Promise<IntegrationEvent> {
    const event = await this.prisma.sportEvent.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        name: true,
        description: true,
        startDate: true,
        endDate: true,
        isOpen: true,
      },
    });
    if (!event) {
      throw new NotFoundException('Evento no encontrado');
    }
    return {
      id: event.id,
      name: event.name,
      description: event.description,
      startDate: event.startDate,
      endDate: event.endDate,
      isOpen: event.isOpen,
    };
  }

  async getSummary(eventId: number): Promise<IntegrationSummary> {
    // Una transacción para que disciplinas y equipos salgan de la misma foto.
    const [event, disciplines, teams] = await this.prisma.$transaction([
      this.prisma.sportEvent.findUnique({
        where: { id: eventId },
        select: { id: true, name: true, startDate: true, endDate: true },
      }),
      this.prisma.discipline.findMany({
        where: { eventId },
        select: {
          id: true,
          name: true,
          participantType: true,
          isPaid: true,
          cost: true,
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.team.findMany({
        where: { discipline: { eventId } },
        select: {
          status: true,
          disciplineId: true,
          _count: { select: { participants: true } },
          voucher: { select: { amount: true, status: true } },
        },
      }),
    ]);
    if (!event) {
      throw new NotFoundException('Evento no encontrado');
    }

    const teamsByStatus: Record<RegistrationStatus, number> = {
      PENDING: 0,
      APPROVED: 0,
      REJECTED: 0,
      CANCELLED: 0,
    };
    const payments: Record<VoucherStatus, PaymentAccumulator> = {
      VALIDATED: { count: 0, amount: ZERO },
      PENDING: { count: 0, amount: ZERO },
      REJECTED: { count: 0, amount: ZERO },
    };
    const byType = new Map<ParticipantType, ParticipantTypeAccumulator>(
      PARTICIPANT_TYPES.map((type) => [
        type,
        { teams: 0, validatedAmount: ZERO, pendingAmount: ZERO },
      ]),
    );
    const byDiscipline = new Map<number, DisciplineAccumulator>(
      disciplines.map((discipline) => [
        discipline.id,
        {
          total: 0,
          approved: 0,
          pending: 0,
          validatedAmount: ZERO,
          pendingAmount: ZERO,
        },
      ]),
    );
    const typeOfDiscipline = new Map<number, ParticipantType>(
      disciplines.map((discipline) => [
        discipline.id,
        discipline.participantType,
      ]),
    );

    let participantsTotal = 0;
    for (const team of teams) {
      teamsByStatus[team.status] += 1;
      participantsTotal += team._count.participants;

      const voucher = team.voucher;
      if (voucher) {
        const bucket = payments[voucher.status];
        bucket.count += 1;
        bucket.amount = bucket.amount.plus(voucher.amount);
      }

      const disciplineStats = byDiscipline.get(team.disciplineId);
      const participantType = typeOfDiscipline.get(team.disciplineId);
      const typeStats = participantType ? byType.get(participantType) : null;
      if (!disciplineStats || !typeStats) {
        continue;
      }

      disciplineStats.total += 1;
      typeStats.teams += 1;
      if (team.status === RegistrationStatus.APPROVED) {
        disciplineStats.approved += 1;
      } else if (team.status === RegistrationStatus.PENDING) {
        disciplineStats.pending += 1;
      }

      if (voucher?.status === VoucherStatus.VALIDATED) {
        disciplineStats.validatedAmount = disciplineStats.validatedAmount.plus(
          voucher.amount,
        );
        typeStats.validatedAmount = typeStats.validatedAmount.plus(
          voucher.amount,
        );
      } else if (voucher?.status === VoucherStatus.PENDING) {
        disciplineStats.pendingAmount = disciplineStats.pendingAmount.plus(
          voucher.amount,
        );
        typeStats.pendingAmount = typeStats.pendingAmount.plus(voucher.amount);
      }
    }

    const disciplineSummaries: IntegrationDisciplineSummary[] = disciplines.map(
      (discipline) => {
        const stats = byDiscipline.get(discipline.id);
        return {
          disciplineId: discipline.id,
          name: discipline.name,
          participantType: discipline.participantType,
          isPaid: discipline.isPaid,
          cost: toMoney(discipline.cost),
          teams: {
            total: stats?.total ?? 0,
            approved: stats?.approved ?? 0,
            pending: stats?.pending ?? 0,
          },
          validatedAmount: toMoney(stats?.validatedAmount ?? ZERO),
          pendingAmount: toMoney(stats?.pendingAmount ?? ZERO),
        };
      },
    );

    const participantTypeSummaries: IntegrationParticipantTypeSummary[] =
      PARTICIPANT_TYPES.map((participantType) => {
        const stats = byType.get(participantType);
        return {
          participantType,
          teams: stats?.teams ?? 0,
          validatedAmount: toMoney(stats?.validatedAmount ?? ZERO),
          pendingAmount: toMoney(stats?.pendingAmount ?? ZERO),
        };
      });

    return {
      event: {
        id: event.id,
        name: event.name,
        startDate: event.startDate,
        endDate: event.endDate,
      },
      currency: 'PEN',
      teams: {
        total: teams.length,
        pending: teamsByStatus.PENDING,
        approved: teamsByStatus.APPROVED,
        rejected: teamsByStatus.REJECTED,
        cancelled: teamsByStatus.CANCELLED,
      },
      participants: { total: participantsTotal },
      payments: {
        validated: toBucket(payments.VALIDATED),
        pending: toBucket(payments.PENDING),
        rejected: toBucket(payments.REJECTED),
      },
      byDiscipline: disciplineSummaries,
      byParticipantType: participantTypeSummaries,
      generatedAt: new Date(),
    };
  }

  async listPayments(
    eventId: number,
    query: IntegrationPaymentsQueryDto,
  ): Promise<Paginated<IntegrationPayment>> {
    const { page, pageSize, skip } = resolvePagination(query);
    const where: Prisma.VoucherWhereInput = {
      team: { discipline: { eventId } },
      ...(query.status ? { status: query.status } : {}),
    };

    const [vouchers, total] = await this.prisma.$transaction([
      this.prisma.voucher.findMany({
        where,
        select: {
          id: true,
          amount: true,
          status: true,
          operationNumber: true,
          uploadedAt: true,
          updatedAt: true,
          team: {
            select: {
              name: true,
              discipline: { select: { name: true, participantType: true } },
            },
          },
        },
        orderBy: [{ uploadedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.voucher.count({ where }),
    ]);

    return {
      data: vouchers.map((voucher) => ({
        id: voucher.id,
        amount: toMoney(voucher.amount),
        status: voucher.status,
        operationNumber: voucher.operationNumber,
        uploadedAt: voucher.uploadedAt,
        updatedAt: voucher.updatedAt,
        teamName: voucher.team.name,
        disciplineName: voucher.team.discipline.name,
        participantType: voucher.team.discipline.participantType,
      })),
      meta: { page, pageSize, total },
    };
  }

  async listRegistrations(
    eventId: number,
    query: IntegrationRegistrationsQueryDto,
  ): Promise<Paginated<IntegrationRegistration>> {
    const { page, pageSize, skip } = resolvePagination(query);
    const where: Prisma.TeamWhereInput = {
      discipline: { eventId },
      ...(query.status ? { status: query.status } : {}),
    };

    const [teams, total] = await this.prisma.$transaction([
      this.prisma.team.findMany({
        where,
        select: {
          id: true,
          name: true,
          status: true,
          createdAt: true,
          discipline: { select: { name: true, participantType: true } },
          _count: { select: { participants: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.team.count({ where }),
    ]);

    return {
      data: teams.map((team) => ({
        id: team.id,
        name: team.name,
        status: team.status,
        disciplineName: team.discipline.name,
        participantType: team.discipline.participantType,
        participantsCount: team._count.participants,
        createdAt: team.createdAt,
      })),
      meta: { page, pageSize, total },
    };
  }
}

/** Soles como número con hasta 2 decimales, sin errores de coma flotante. */
export function toMoney(value: Prisma.Decimal): number {
  return Number(new Prisma.Decimal(value).toFixed(2));
}

function toBucket(bucket: PaymentAccumulator) {
  return { count: bucket.count, amount: toMoney(bucket.amount) };
}

function resolvePagination(query: IntegrationPaginationQueryDto) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  return { page, pageSize, skip: (page - 1) * pageSize };
}
