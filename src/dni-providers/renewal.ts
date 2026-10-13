import { RenewalPeriod } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Cota de iteraciones: evita un ciclo larguísimo si la fecha vencida es muy antigua. */
const MAX_STEPS = 5000;

/** Suma meses respetando el fin de mes (31-ene + 1 mes = 28 o 29-feb). */
function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/**
 * Próxima fecha de renovación estrictamente posterior a `now`, partiendo de la fecha vencida. Conserva el
 * día del ciclo del proveedor: cada fecha se calcula desde la original, así 31-ene → 28-feb → 31-mar (y no
 * 28-mar). `null` si el token no se renueva.
 */
export function nextRenewal(
  expired: Date,
  period: RenewalPeriod,
  now: Date,
): Date | null {
  if (period === RenewalPeriod.NONE) return null;
  if (expired > now) return expired;

  if (period === RenewalPeriod.DAILY) {
    const elapsedDays = Math.floor(
      (now.getTime() - expired.getTime()) / DAY_MS,
    );
    return new Date(expired.getTime() + (elapsedDays + 1) * DAY_MS);
  }

  const monthsPerStep = period === RenewalPeriod.MONTHLY ? 1 : 12;
  for (let step = 1; step <= MAX_STEPS; step++) {
    const next = addMonths(expired, step * monthsPerStep);
    if (next > now) return next;
  }
  return addMonths(expired, MAX_STEPS * monthsPerStep);
}

/** El token alcanzó su límite local de consultas. */
export function limitReached(token: {
  queryLimit: number | null;
  queriesUsed: number;
}): boolean {
  return token.queryLimit !== null && token.queriesUsed >= token.queryLimit;
}
