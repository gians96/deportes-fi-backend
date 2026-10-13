import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, PricingMode } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PrismaService } from '../prisma/prisma.service';
import { UpdatePricingDto } from './dto/update-pricing.dto';
import { EventPricingService } from './event-pricing.service';

interface EventRow {
  id: number;
  pricingMode: PricingMode;
}
interface PricingRow {
  eventId: number;
  sectionBase: Prisma.Decimal;
  cycleBase: Prisma.Decimal;
  sectionExtra: Prisma.Decimal;
  cycleExtra: Prisma.Decimal;
}

/** Fake mínimo: eventos, tarifas (upsert) y conteo de grupos. */
class PricingPrisma {
  readonly pricing: PricingRow[] = [];
  constructor(
    readonly events: EventRow[],
    private readonly groupsByEvent: Record<number, number> = {},
  ) {}

  readonly sportEvent = {
    findUnique: ({ where }: { where: { id: number } }) => {
      const event = this.events.find((e) => e.id === where.id);
      if (!event) return Promise.resolve(null);
      const pricing = this.pricing.find((p) => p.eventId === event.id) ?? null;
      return Promise.resolve({ ...event, pricing });
    },
    update: ({
      where,
      data,
    }: {
      where: { id: number };
      data: { pricingMode: PricingMode };
    }) => {
      const event = this.events.find((e) => e.id === where.id);
      if (event) event.pricingMode = data.pricingMode;
      return Promise.resolve(event);
    },
  };

  readonly eventPricing = {
    upsert: ({
      where,
      create,
      update,
    }: {
      where: { eventId: number };
      create: Omit<PricingRow, 'sectionBase'> & { sectionBase: number };
      update: Record<string, number>;
    }) => {
      const existing = this.pricing.find((p) => p.eventId === where.eventId);
      const next = (value: number) => new Prisma.Decimal(value);
      if (existing) {
        existing.sectionBase = next(update.sectionBase);
        existing.cycleBase = next(update.cycleBase);
        existing.sectionExtra = next(update.sectionExtra);
        existing.cycleExtra = next(update.cycleExtra);
        return Promise.resolve(existing);
      }
      const row: PricingRow = {
        eventId: create.eventId,
        sectionBase: next(Number(create.sectionBase)),
        cycleBase: next(Number(create.cycleBase)),
        sectionExtra: next(Number(create.sectionExtra)),
        cycleExtra: next(Number(create.cycleExtra)),
      };
      this.pricing.push(row);
      return Promise.resolve(row);
    },
  };

  readonly classGroup = {
    count: ({ where }: { where: { eventId: number } }) =>
      Promise.resolve(this.groupsByEvent[where.eventId] ?? 0),
  };

  $transaction(operations: Promise<unknown>[]) {
    return Promise.all(operations);
  }
}

const FEES = {
  sectionBase: 100,
  cycleBase: 150,
  sectionExtra: 20,
  cycleExtra: 30,
};

function build(events: EventRow[], groupsByEvent: Record<number, number> = {}) {
  const prisma = new PricingPrisma(events, groupsByEvent);
  const service = new EventPricingService(prisma as unknown as PrismaService);
  return { prisma, service };
}

describe('EventPricingService', () => {
  it('un evento sin configurar cobra por disciplina y tiene tarifas en 0', async () => {
    const { service } = build([
      { id: 1, pricingMode: PricingMode.PER_DISCIPLINE },
    ]);
    await expect(service.getPricing(1)).resolves.toEqual({
      eventId: 1,
      pricingMode: 'PER_DISCIPLINE',
      sectionBase: 0,
      cycleBase: 0,
      sectionExtra: 0,
      cycleExtra: 0,
    });
  });

  it('responde 404 si el evento no existe', async () => {
    const { service } = build([]);
    await expect(service.getPricing(9)).rejects.toThrow(NotFoundException);
    await expect(
      service.setPricing(9, { pricingMode: PricingMode.PER_GROUP, ...FEES }),
    ).rejects.toThrow('Evento no encontrado');
  });

  it('guarda el modo y las cuatro tarifas', async () => {
    const { service } = build([
      { id: 1, pricingMode: PricingMode.PER_DISCIPLINE },
    ]);
    const result = await service.setPricing(1, {
      pricingMode: PricingMode.PER_GROUP,
      ...FEES,
    });
    expect(result).toEqual({ eventId: 1, pricingMode: 'PER_GROUP', ...FEES });
    await expect(service.getPricing(1)).resolves.toEqual(result);
  });

  it('permite cambiar las tarifas de un evento que ya tiene grupos', async () => {
    const { service } = build([{ id: 1, pricingMode: PricingMode.PER_GROUP }], {
      1: 3,
    });
    const result = await service.setPricing(1, {
      pricingMode: PricingMode.PER_GROUP,
      ...FEES,
      sectionBase: 120,
    });
    expect(result.sectionBase).toBe(120);
  });

  it('no deja volver a cobro por disciplina si ya hay grupos', async () => {
    const { prisma, service } = build(
      [{ id: 1, pricingMode: PricingMode.PER_GROUP }],
      { 1: 2 },
    );
    await expect(
      service.setPricing(1, {
        pricingMode: PricingMode.PER_DISCIPLINE,
        ...FEES,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.events[0].pricingMode).toBe(PricingMode.PER_GROUP);
    expect(prisma.pricing).toHaveLength(0);
  });

  it('permite volver a cobro por disciplina si aún no hay grupos', async () => {
    const { service } = build([{ id: 1, pricingMode: PricingMode.PER_GROUP }]);
    const result = await service.setPricing(1, {
      pricingMode: PricingMode.PER_DISCIPLINE,
      ...FEES,
    });
    expect(result.pricingMode).toBe('PER_DISCIPLINE');
  });

  it('un segundo PUT actualiza las tarifas en lugar de duplicarlas', async () => {
    const { prisma, service } = build([
      { id: 1, pricingMode: PricingMode.PER_GROUP },
    ]);
    await service.setPricing(1, {
      pricingMode: PricingMode.PER_GROUP,
      ...FEES,
    });
    await service.setPricing(1, {
      pricingMode: PricingMode.PER_GROUP,
      ...FEES,
      cycleExtra: 35,
    });
    expect(prisma.pricing).toHaveLength(1);
    expect((await service.getPricing(1)).cycleExtra).toBe(35);
  });
});

describe('UpdatePricingDto', () => {
  async function errorsFor(payload: Record<string, unknown>) {
    const dto = plainToInstance(UpdatePricingDto, payload, {
      enableImplicitConversion: true,
    });
    return validate(dto, { whitelist: true });
  }

  it('acepta un cuerpo válido', async () => {
    expect(await errorsFor({ pricingMode: 'PER_GROUP', ...FEES })).toHaveLength(
      0,
    );
  });

  it.each([
    ['tarifa negativa', { sectionBase: -1 }],
    ['más de 2 decimales', { cycleBase: 10.123 }],
    ['modo inválido', { pricingMode: 'OTRO' }],
    ['tarifa ausente', { sectionExtra: undefined }],
    ['tarifa no numérica', { cycleExtra: 'abc' }],
  ])('rechaza %s', async (_name, change) => {
    const errors = await errorsFor({
      pricingMode: 'PER_GROUP',
      ...FEES,
      ...change,
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
