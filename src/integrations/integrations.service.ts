import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ParticipantType,
  Prisma,
  RegistrationStatus,
  VoucherKind,
  VoucherStatus,
} from '@prisma/client';
import { groupLabel } from '../groups/group-normalize';
import { allocateCents, fromCents, toCents } from '../groups/group-pricing';
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
    const [event, disciplines, teams, vouchers] =
      await this.prisma.$transaction([
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
          where: {
            discipline: { eventId },
            status: { not: RegistrationStatus.DRAFT },
          },
          select: {
            status: true,
            disciplineId: true,
            _count: { select: { participants: true } },
          },
        }),
        // Cada voucher se lee una sola vez, aunque cubra varios equipos (pago de un salón o ciclo).
        this.prisma.voucher.findMany({
          where: eventVouchersWhere(eventId),
          select: {
            id: true,
            amount: true,
            status: true,
            team: { select: { id: true, disciplineId: true } },
            teams: {
              where: { status: { not: RegistrationStatus.DRAFT } },
              select: { id: true, disciplineId: true },
              orderBy: { id: 'asc' },
            },
          },
        }),
      ]);
    if (!event) {
      throw new NotFoundException('Evento no encontrado');
    }

    const teamsByStatus: Record<
      Exclude<RegistrationStatus, typeof RegistrationStatus.DRAFT>,
      number
    > = {
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
      // Los borradores se excluyen en la consulta; esto solo estrecha el tipo.
      if (team.status === RegistrationStatus.DRAFT) continue;
      teamsByStatus[team.status] += 1;
      participantsTotal += team._count.participants;

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
    }

    for (const voucher of vouchers) {
      const bucket = payments[voucher.status];
      bucket.count += 1;
      bucket.amount = bucket.amount.plus(voucher.amount);

      if (
        voucher.status !== VoucherStatus.VALIDATED &&
        voucher.status !== VoucherStatus.PENDING
      ) {
        continue;
      }
      // El monto se reparte en centavos exactos entre los equipos que cubre el voucher
      // (un voucher de un solo equipo conserva su monto completo).
      const covered = voucher.teams.length
        ? voucher.teams
        : voucher.team
          ? [voucher.team]
          : [];
      if (!covered.length) {
        continue;
      }
      const shares = allocateCents(toCents(voucher.amount), covered.length);
      covered.forEach((team, index) => {
        const disciplineStats = byDiscipline.get(team.disciplineId);
        const participantType = typeOfDiscipline.get(team.disciplineId);
        const typeStats = participantType ? byType.get(participantType) : null;
        if (!disciplineStats || !typeStats) {
          return;
        }
        const share = fromCents(shares[index]);
        if (voucher.status === VoucherStatus.VALIDATED) {
          disciplineStats.validatedAmount =
            disciplineStats.validatedAmount.plus(share);
          typeStats.validatedAmount = typeStats.validatedAmount.plus(share);
        } else {
          disciplineStats.pendingAmount =
            disciplineStats.pendingAmount.plus(share);
          typeStats.pendingAmount = typeStats.pendingAmount.plus(share);
        }
      });
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
      ...eventVouchersWhere(eventId),
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
          kind: true,
          team: {
            select: {
              name: true,
              discipline: { select: { name: true, participantType: true } },
            },
          },
          group: {
            select: {
              scope: true,
              cycle: true,
              section: true,
              school: { select: { name: true } },
            },
          },
          teams: {
            select: {
              name: true,
              discipline: { select: { name: true, participantType: true } },
            },
            orderBy: { id: 'asc' },
            take: 1,
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
        ...paymentLabels(voucher),
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
      status: query.status ?? { not: RegistrationStatus.DRAFT },
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

/**
 * Vouchers de un evento: los de sus equipos (por la relación nueva o la histórica) y los de sus
 * grupos aunque todavía no cubran ningún equipo. Siempre acotados por el `eventId` del token.
 */
function eventVouchersWhere(eventId: number): Prisma.VoucherWhereInput {
  return {
    OR: [
      { team: { discipline: { eventId } } },
      { teams: { some: { discipline: { eventId } } } },
      { group: { eventId } },
    ],
  };
}

interface PaymentLabelSource {
  kind: VoucherKind;
  team: {
    name: string;
    discipline: { name: string; participantType: ParticipantType };
  } | null;
  group: {
    scope: 'SECTION' | 'CYCLE';
    cycle: string;
    section: string;
    school: { name: string };
  } | null;
  teams: {
    name: string;
    discipline: { name: string; participantType: ParticipantType };
  }[];
}

/**
 * Misma forma que siempre (teamName, disciplineName, participantType). Para el pago de un salón
 * o ciclo, teamName es la etiqueta del grupo y disciplineName describe el pago.
 */
function paymentLabels(voucher: PaymentLabelSource) {
  if (voucher.kind !== VoucherKind.TEAM && voucher.group) {
    const { scope, cycle, section, school } = voucher.group;
    const firstDiscipline = voucher.teams[0]?.discipline.name;
    let disciplineName: string;
    if (voucher.kind === VoucherKind.BASE) {
      disciplineName =
        scope === 'CYCLE' ? 'Pago base (ciclo)' : 'Pago base (salón)';
    } else {
      disciplineName = firstDiscipline
        ? `Adicional · ${firstDiscipline}`
        : 'Adicional';
    }
    return {
      teamName: groupLabel(school.name, scope, cycle, section),
      disciplineName,
      participantType: ParticipantType.STUDENT,
    };
  }
  const team = voucher.team ?? voucher.teams[0] ?? null;
  return {
    teamName: team?.name ?? '',
    disciplineName: team?.discipline.name ?? '',
    participantType:
      team?.discipline.participantType ?? ParticipantType.STUDENT,
  };
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
