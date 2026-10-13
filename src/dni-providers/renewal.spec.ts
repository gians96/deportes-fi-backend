import { RenewalPeriod } from '@prisma/client';
import { limitReached, nextRenewal } from './renewal';

const utc = (iso: string) => new Date(iso);

describe('nextRenewal', () => {
  it('un token que no se renueva no tiene siguiente fecha', () => {
    expect(
      nextRenewal(
        utc('2026-01-01T00:00:00Z'),
        RenewalPeriod.NONE,
        utc('2026-02-01T00:00:00Z'),
      ),
    ).toBeNull();
  });

  it('diaria: avanza de a un día hasta superar la fecha actual', () => {
    expect(
      nextRenewal(
        utc('2026-10-10T05:00:00Z'),
        RenewalPeriod.DAILY,
        utc('2026-10-13T12:00:00Z'),
      ),
    ).toEqual(utc('2026-10-14T05:00:00Z'));
  });

  it('mensual: conserva el día del ciclo del proveedor', () => {
    expect(
      nextRenewal(
        utc('2026-08-15T00:00:00Z'),
        RenewalPeriod.MONTHLY,
        utc('2026-10-13T00:00:00Z'),
      ),
    ).toEqual(utc('2026-10-15T00:00:00Z'));
  });

  it('mensual: el 31 pasa al último día de un mes más corto y vuelve al 31 cuando se puede', () => {
    expect(
      nextRenewal(
        utc('2026-01-31T00:00:00Z'),
        RenewalPeriod.MONTHLY,
        utc('2026-01-31T12:00:00Z'),
      ),
    ).toEqual(utc('2026-02-28T00:00:00Z'));
    expect(
      nextRenewal(
        utc('2026-01-31T00:00:00Z'),
        RenewalPeriod.MONTHLY,
        utc('2026-03-01T00:00:00Z'),
      ),
    ).toEqual(utc('2026-03-31T00:00:00Z'));
  });

  it('mensual: febrero bisiesto', () => {
    expect(
      nextRenewal(
        utc('2028-01-31T00:00:00Z'),
        RenewalPeriod.MONTHLY,
        utc('2028-01-31T12:00:00Z'),
      ),
    ).toEqual(utc('2028-02-29T00:00:00Z'));
  });

  it('anual: suma doce meses', () => {
    expect(
      nextRenewal(
        utc('2025-06-10T00:00:00Z'),
        RenewalPeriod.YEARLY,
        utc('2026-10-13T00:00:00Z'),
      ),
    ).toEqual(utc('2027-06-10T00:00:00Z'));
  });

  it('la siguiente fecha es estrictamente posterior a ahora', () => {
    const now = utc('2026-10-15T00:00:00Z');
    expect(nextRenewal(now, RenewalPeriod.DAILY, now)).toEqual(
      utc('2026-10-16T00:00:00Z'),
    );
  });
});

describe('limitReached', () => {
  it('sin límite nunca se alcanza', () => {
    expect(limitReached({ queryLimit: null, queriesUsed: 1_000_000 })).toBe(
      false,
    );
  });

  it('se alcanza al llegar al límite, no antes', () => {
    expect(limitReached({ queryLimit: 5, queriesUsed: 4 })).toBe(false);
    expect(limitReached({ queryLimit: 5, queriesUsed: 5 })).toBe(true);
    expect(limitReached({ queryLimit: 5, queriesUsed: 9 })).toBe(true);
  });
});
