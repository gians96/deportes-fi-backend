import { NotFoundException } from '@nestjs/common';
import { RegistrationStatus, VoucherStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { InMemoryPrisma } from '../../test/fakes/in-memory-prisma';
import type { FakeDataset } from '../../test/fakes/in-memory-prisma';
import {
  buildSportsDataset,
  EVENT_A_ID,
  EVENT_B_ID,
  EVENT_B_MARKERS,
  EXPECTED_SUMMARY_A,
  sensitiveValues,
} from '../../test/fakes/sports-dataset';
import { IntegrationsService } from './integrations.service';

function expectNoneOf(value: unknown, forbidden: string[]) {
  const json = JSON.stringify(value);
  for (const item of forbidden) {
    expect(json).not.toContain(item);
  }
}

/** Todas las consultas de datos deben filtrar por el evento indicado. */
function expectScopedTo(prisma: InMemoryPrisma, eventId: number) {
  const scoped = prisma.calls.filter((call) =>
    ['team', 'voucher', 'discipline'].includes(call.model),
  );
  expect(scoped.length).toBeGreaterThan(0);
  for (const call of scoped) {
    const where = JSON.stringify((call.args as { where: unknown }).where);
    expect(where).toContain(`"eventId":${eventId}`);
  }
}

describe('IntegrationsService', () => {
  let dataset: FakeDataset;
  let prisma: InMemoryPrisma;
  let service: IntegrationsService;

  beforeEach(() => {
    dataset = buildSportsDataset();
    prisma = new InMemoryPrisma(dataset);
    service = new IntegrationsService(prisma as unknown as PrismaService);
  });

  describe('getEvent', () => {
    it('devuelve exactamente los campos del contrato', async () => {
      const event = await service.getEvent(EVENT_A_ID);

      expect(event).toEqual({
        id: EVENT_A_ID,
        name: 'Juegos Semana Sistémica 2026',
        description: '<p>Juegos de la semana</p>',
        startDate: new Date('2026-10-19T00:00:00.000Z'),
        endDate: new Date('2026-10-24T00:00:00.000Z'),
        isOpen: true,
      });
    });

    it('404 si el evento ya no existe', async () => {
      await expect(service.getEvent(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getSummary', () => {
    it('calcula conteos y montos del evento A', async () => {
      const summary = await service.getSummary(EVENT_A_ID);

      expect(Object.keys(summary)).toEqual([
        'event',
        'currency',
        'teams',
        'participants',
        'payments',
        'byDiscipline',
        'byParticipantType',
        'generatedAt',
      ]);
      expect(summary.event).toEqual({
        id: EVENT_A_ID,
        name: 'Juegos Semana Sistémica 2026',
        startDate: new Date('2026-10-19T00:00:00.000Z'),
        endDate: new Date('2026-10-24T00:00:00.000Z'),
      });
      expect(summary.currency).toBe('PEN');
      expect(summary.teams).toEqual(EXPECTED_SUMMARY_A.teams);
      expect(summary.participants).toEqual(EXPECTED_SUMMARY_A.participants);
      expect(summary.payments).toEqual(EXPECTED_SUMMARY_A.payments);
      expect(summary.byDiscipline).toEqual(EXPECTED_SUMMARY_A.byDiscipline);
      expect(summary.byParticipantType).toEqual(
        EXPECTED_SUMMARY_A.byParticipantType,
      );
      expect(summary.generatedAt).toBeInstanceOf(Date);
    });

    it('suma decimales sin errores de coma flotante', async () => {
      const summary = await service.getSummary(EVENT_A_ID);

      // 50 + 50 + 12.50 + 10.10 + 10.20 en coma flotante daría 132.79999…
      expect(summary.payments.validated.amount).toBe(132.8);
      const other = summary.byParticipantType.find(
        (item) => item.participantType === 'OTHER',
      );
      expect(other?.validatedAmount).toBe(32.8);
    });

    it('mantiene los invariantes entre totales y desgloses', async () => {
      const summary = await service.getSummary(EVENT_A_ID);
      const sum = (values: number[]) =>
        Math.round(values.reduce((acc, value) => acc + value, 0) * 100) / 100;

      expect(
        sum(summary.byDiscipline.map((item) => item.validatedAmount)),
      ).toBe(summary.payments.validated.amount);
      expect(sum(summary.byDiscipline.map((item) => item.pendingAmount))).toBe(
        summary.payments.pending.amount,
      );
      expect(sum(summary.byParticipantType.map((item) => item.teams))).toBe(
        summary.teams.total,
      );
      expect(sum(summary.byDiscipline.map((item) => item.teams.total))).toBe(
        summary.teams.total,
      );
    });

    it('incluye disciplinas sin equipos y siempre ambos tipos de participante', async () => {
      dataset.teams = dataset.teams.filter((team) => team.disciplineId !== 11);
      dataset.teams = dataset.teams.filter((team) => team.disciplineId !== 14);
      dataset.vouchers = dataset.vouchers.filter((voucher) =>
        dataset.teams.some((team) => team.id === voucher.teamId),
      );

      const summary = await service.getSummary(EVENT_A_ID);

      expect(summary.byDiscipline).toHaveLength(5);
      expect(summary.byParticipantType).toEqual([
        expect.objectContaining({ participantType: 'STUDENT' }),
        {
          participantType: 'OTHER',
          teams: 0,
          validatedAmount: 0,
          pendingAmount: 0,
        },
      ]);
    });

    it('un token del evento B solo ve datos de B', async () => {
      const summary = await service.getSummary(EVENT_B_ID);

      expect(summary.event.id).toBe(EVENT_B_ID);
      expect(summary.teams).toEqual({
        total: 2,
        pending: 1,
        approved: 1,
        rejected: 0,
        cancelled: 0,
      });
      expect(summary.participants.total).toBe(6);
      expect(summary.payments.validated).toEqual({ count: 1, amount: 999.99 });
      expect(summary.byDiscipline.map((item) => item.disciplineId)).toEqual([
        20,
      ]);
      expectScopedTo(prisma, EVENT_B_ID);
    });

    it('404 si el evento no existe', async () => {
      await expect(service.getSummary(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('listPayments', () => {
    it('lista los pagos del evento, recientes primero, con la forma del contrato', async () => {
      const result = await service.listPayments(EVENT_A_ID, {});

      expect(result.meta).toEqual({ page: 1, pageSize: 50, total: 9 });
      expect(result.data.map((item) => item.id)).toEqual([
        1008, 1007, 1006, 1005, 1004, 1003, 1002, 1001, 1000,
      ]);
      expect(result.data[0]).toEqual({
        id: 1008,
        amount: 10.2,
        status: 'VALIDATED',
        operationNumber: 'OP-1008',
        uploadedAt: expect.any(Date) as Date,
        updatedAt: expect.any(Date) as Date,
        teamName: 'Raquetas 2',
        disciplineName: 'Tenis de mesa',
        participantType: 'OTHER',
      });
    });

    it('filtra por estado y pagina', async () => {
      const validated = await service.listPayments(EVENT_A_ID, {
        status: VoucherStatus.VALIDATED,
      });
      expect(validated.meta.total).toBe(5);
      expect(validated.data.every((item) => item.status === 'VALIDATED')).toBe(
        true,
      );

      const page2 = await service.listPayments(EVENT_A_ID, {
        page: 2,
        pageSize: 2,
      });
      expect(page2.meta).toEqual({ page: 2, pageSize: 2, total: 9 });
      expect(page2.data.map((item) => item.id)).toEqual([1006, 1005]);

      const beyond = await service.listPayments(EVENT_A_ID, {
        page: 10,
        pageSize: 50,
      });
      expect(beyond).toEqual({
        data: [],
        meta: { page: 10, pageSize: 50, total: 9 },
      });
    });

    it('no expone URLs de vouchers ni datos personales', async () => {
      const result = await service.listPayments(EVENT_A_ID, {});
      expectNoneOf(result, sensitiveValues(dataset));
      for (const item of result.data) {
        expect(item).not.toHaveProperty('imageUrl');
      }
    });
  });

  describe('listRegistrations', () => {
    it('lista los equipos del evento con la forma del contrato', async () => {
      const result = await service.listRegistrations(EVENT_A_ID, {});

      expect(result.meta).toEqual({ page: 1, pageSize: 50, total: 11 });
      expect(result.data.map((item) => item.id)).toEqual([
        110, 109, 108, 107, 106, 105, 104, 103, 102, 101, 100,
      ]);
      expect(result.data.find((item) => item.id === 100)).toEqual({
        id: 100,
        name: 'Los Bits',
        status: 'APPROVED',
        disciplineName: 'Fútbol 7 varones',
        participantType: 'STUDENT',
        participantsCount: 3,
        createdAt: expect.any(Date) as Date,
      });
    });

    it('filtra por estado', async () => {
      const approved = await service.listRegistrations(EVENT_A_ID, {
        status: RegistrationStatus.APPROVED,
      });
      expect(approved.meta.total).toBe(6);
      expect(approved.data.every((item) => item.status === 'APPROVED')).toBe(
        true,
      );
    });

    it('no expone correos, DNI, códigos ni teléfonos', async () => {
      const result = await service.listRegistrations(EVENT_A_ID, {});
      expectNoneOf(result, sensitiveValues(dataset));
    });
  });

  describe('aislamiento entre eventos', () => {
    it('con el evento A ninguna respuesta contiene datos del evento B', async () => {
      const responses = [
        await service.getEvent(EVENT_A_ID),
        await service.getSummary(EVENT_A_ID),
        await service.listPayments(EVENT_A_ID, { pageSize: 100 }),
        await service.listRegistrations(EVENT_A_ID, { pageSize: 100 }),
      ];

      for (const response of responses) {
        expectNoneOf(response, EVENT_B_MARKERS);
      }
      const payments = responses[2] as { data: { id: number }[] };
      expect(payments.data.every((item) => item.id < 2000)).toBe(true);
      const registrations = responses[3] as { data: { id: number }[] };
      expect(registrations.data.every((item) => item.id < 200)).toBe(true);
      expectScopedTo(prisma, EVENT_A_ID);
    });
  });
});
