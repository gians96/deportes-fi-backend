import { Prisma } from '@prisma/client';
import type { GroupScopeValue } from './group-normalize';

type Money = Prisma.Decimal | number | string;

/** Tarifas del evento (`EventPricing`), en soles. */
export interface PricingValues {
  sectionBase: Money;
  cycleBase: Money;
  sectionExtra: Money;
  cycleExtra: Money;
}

/** Pago general del grupo: 1 equipo por disciplina. */
export function baseFee(
  pricing: PricingValues,
  scope: GroupScopeValue,
): Prisma.Decimal {
  return new Prisma.Decimal(
    scope === 'CYCLE' ? pricing.cycleBase : pricing.sectionBase,
  );
}

/** Pago de cada equipo adicional en una misma disciplina. */
export function extraFee(
  pricing: PricingValues,
  scope: GroupScopeValue,
): Prisma.Decimal {
  return new Prisma.Decimal(
    scope === 'CYCLE' ? pricing.cycleExtra : pricing.sectionExtra,
  );
}

export function toCents(amount: Money): number {
  return new Prisma.Decimal(amount).mul(100).toDecimalPlaces(0).toNumber();
}

export function fromCents(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).div(100);
}

/**
 * Reparte `totalCents` entre `parts` equipos sin perder centavos: la suma de las partes es
 * exactamente `totalCents`. El resto se entrega de uno en uno a las primeras partes (el llamador
 * las ordena por `Team.id`).
 */
export function allocateCents(totalCents: number, parts: number): number[] {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new RangeError('totalCents debe ser un entero mayor o igual a 0');
  }
  if (!Number.isInteger(parts) || parts < 1) {
    throw new RangeError('parts debe ser un entero mayor o igual a 1');
  }
  const share = Math.floor(totalCents / parts);
  const remainder = totalCents - share * parts;
  return Array.from(
    { length: parts },
    (_, i) => share + (i < remainder ? 1 : 0),
  );
}
