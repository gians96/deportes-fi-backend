import {
  Prisma,
  RegistrationStatus,
  VoucherKind,
  VoucherStatus,
} from '@prisma/client';
import { groupLabel } from './group-normalize';
import { toMoneyNumber } from './group-pricing';

/** Datos que se leen de un grupo para armar su detalle (`GroupDetail`). */
export const groupDetailInclude = {
  school: { select: { id: true, name: true } },
  delegate: { select: { id: true, fullName: true } },
  baseVoucher: true,
  vouchers: {
    where: { kind: VoucherKind.EXTRA },
    include: { teams: { select: { id: true } } },
    orderBy: { id: 'asc' },
  },
  teams: {
    select: {
      id: true,
      name: true,
      slot: true,
      status: true,
      voucherId: true,
      disciplineId: true,
    },
    orderBy: [{ disciplineId: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.ClassGroupInclude;

export type GroupWithDetail = Prisma.ClassGroupGetPayload<{
  include: typeof groupDetailInclude;
}>;

export interface DisciplineRef {
  id: number;
  name: string;
}

export interface VoucherView {
  id: number;
  kind: VoucherKind;
  status: VoucherStatus;
  amount: number;
  operationNumber: string | null;
  imageUrl: string;
  rejectionReason: string | null;
}

export interface GroupDetail {
  id: number;
  eventId: number;
  scope: 'SECTION' | 'CYCLE';
  label: string;
  school: { id: number; name: string };
  cycle: string;
  section: string;
  delegate: { id: number; fullName: string };
  baseVoucher: VoucherView | null;
  disciplines: {
    disciplineId: number;
    name: string;
    teams: {
      id: number;
      name: string;
      slot: number | null;
      status: RegistrationStatus;
      voucherId: number | null;
    }[];
  }[];
  extraVouchers: (VoucherView & { teamIds: number[] })[];
}

function toVoucherView(voucher: {
  id: number;
  kind: VoucherKind;
  status: VoucherStatus;
  amount: Prisma.Decimal;
  operationNumber: string | null;
  imageUrl: string;
  rejectionReason: string | null;
}): VoucherView {
  return {
    id: voucher.id,
    kind: voucher.kind,
    status: voucher.status,
    amount: toMoneyNumber(voucher.amount),
    operationNumber: voucher.operationNumber,
    imageUrl: voucher.imageUrl,
    rejectionReason: voucher.rejectionReason,
  };
}

/**
 * Un grupo está activo si su voucher base no fue rechazado o si todavía tiene equipos
 * `PENDING`/`APPROVED` (el grupo no tiene un estado propio). Solo los grupos activos
 * bloquean la exclusión ciclo/sección.
 */
export function isActiveGroup(group: {
  baseVoucher: { status: VoucherStatus } | null;
  teams: { status: RegistrationStatus }[];
}): boolean {
  if (group.baseVoucher?.status !== VoucherStatus.REJECTED) {
    return true;
  }
  return group.teams.some(
    (team) =>
      team.status === RegistrationStatus.PENDING ||
      team.status === RegistrationStatus.APPROVED,
  );
}

export function toGroupDetail(
  group: GroupWithDetail,
  disciplines: DisciplineRef[],
): GroupDetail {
  const teamsByDiscipline = new Map<
    number,
    GroupDetail['disciplines'][number]['teams']
  >();
  for (const team of group.teams) {
    const list = teamsByDiscipline.get(team.disciplineId) ?? [];
    list.push({
      id: team.id,
      name: team.name,
      slot: team.slot,
      status: team.status,
      voucherId: team.voucherId,
    });
    teamsByDiscipline.set(team.disciplineId, list);
  }

  return {
    id: group.id,
    eventId: group.eventId,
    scope: group.scope,
    label: groupLabel(
      group.school.name,
      group.scope,
      group.cycle,
      group.section,
    ),
    school: group.school,
    cycle: group.cycle,
    section: group.section,
    delegate: group.delegate,
    baseVoucher: group.baseVoucher ? toVoucherView(group.baseVoucher) : null,
    disciplines: disciplines.map((discipline) => ({
      disciplineId: discipline.id,
      name: discipline.name,
      teams: teamsByDiscipline.get(discipline.id) ?? [],
    })),
    extraVouchers: group.vouchers.map((voucher) => ({
      ...toVoucherView(voucher),
      teamIds: voucher.teams.map((team) => team.id),
    })),
  };
}
