import { Prisma } from '@prisma/client';
import {
  allocateCents,
  baseFee,
  extraFee,
  fromCents,
  toCents,
} from './group-pricing';

const pricing = {
  sectionBase: new Prisma.Decimal('100'),
  cycleBase: '150',
  sectionExtra: 20,
  cycleExtra: new Prisma.Decimal('30.00'),
};

describe('tarifas por alcance', () => {
  it('cobra el pago general según salón o ciclo', () => {
    expect(baseFee(pricing, 'SECTION').toString()).toBe('100');
    expect(baseFee(pricing, 'CYCLE').toString()).toBe('150');
  });

  it('cobra el equipo adicional según salón o ciclo', () => {
    expect(extraFee(pricing, 'SECTION').toString()).toBe('20');
    expect(extraFee(pricing, 'CYCLE').toString()).toBe('30');
  });
});

describe('centavos', () => {
  it('convierte soles a centavos y de vuelta', () => {
    expect(toCents(new Prisma.Decimal('20.50'))).toBe(2050);
    expect(toCents('100')).toBe(10000);
    expect(toCents(0)).toBe(0);
    expect(fromCents(2050).toString()).toBe('20.5');
  });
});

describe('allocateCents', () => {
  it('reparte un pago base de S/100 entre 5 disciplinas sin sobrantes', () => {
    expect(allocateCents(10000, 5)).toEqual([2000, 2000, 2000, 2000, 2000]);
  });

  it('entrega el resto a las primeras partes', () => {
    expect(allocateCents(10000, 3)).toEqual([3334, 3333, 3333]);
    expect(allocateCents(1, 3)).toEqual([1, 0, 0]);
  });

  it('un solo equipo recibe todo el monto', () => {
    expect(allocateCents(15000, 1)).toEqual([15000]);
  });

  it('conserva el total exacto para cualquier cantidad de equipos', () => {
    const totals = [0, 1, 99, 100, 3333, 10000, 15000, 2050];
    for (const total of totals) {
      for (let parts = 1; parts <= 7; parts++) {
        const shares = allocateCents(total, parts);
        expect(shares).toHaveLength(parts);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
        expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(
          1,
        );
        expect(shares).toEqual([...shares].sort((a, b) => b - a));
      }
    }
  });

  it.each([
    [-1, 2],
    [10.5, 2],
    [100, 0],
    [100, -1],
    [100, 1.5],
  ])('rechaza total=%s partes=%s', (total, parts) => {
    expect(() => allocateCents(total, parts)).toThrow(RangeError);
  });
});
