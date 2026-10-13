import { VoucherStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { InMemoryPrisma } from '../../test/fakes/in-memory-prisma';
import type { FakeDataset } from '../../test/fakes/in-memory-prisma';
import {
  buildMixedDataset,
  EVENT_A_ID,
  EVENT_B_ID,
  EVENT_B_MARKERS,
  EXPECTED_SUMMARY_A_MIXED,
  sensitiveValues,
} from '../../test/fakes/sports-dataset';
import { IntegrationsService } from './integrations.service';

const cents = (amount: number) => Math.round(amount * 100);

describe('IntegrationsService con pagos compartidos (spec 002)', () => {
  let dataset: FakeDataset;
  let prisma: InMemoryPrisma;
  let service: IntegrationsService;

  beforeEach(() => {
    dataset = buildMixedDataset();
    prisma = new InMemoryPrisma(dataset);
    service = new IntegrationsService(prisma as unknown as PrismaService);
  });

  describe('summary', () => {
    it('cuenta cada voucher una sola vez y reparte el pago base en centavos exactos', async () => {
      const summary = await service.getSummary(EVENT_A_ID);
      expect(summary).toMatchObject(EXPECTED_SUMMARY_A_MIXED);
    });

    it('lo recaudado coincide exactamente con la suma del desglose por disciplina y por tipo', async () => {
      const summary = await service.getSummary(EVENT_A_ID);
      const byDiscipline = summary.byDiscipline.reduce(
        (sum, item) => sum + cents(item.validatedAmount),
        0,
      );
      const byType = summary.byParticipantType.reduce(
        (sum, item) => sum + cents(item.validatedAmount),
        0,
      );
      expect(byDiscipline).toBe(cents(summary.payments.validated.amount));
      expect(byType).toBe(cents(summary.payments.validated.amount));
      expect(
        summary.byParticipantType.reduce((sum, item) => sum + item.teams, 0),
      ).toBe(summary.teams.total);
    });

    it('un pago base pendiente sin equipos cuenta como pago pendiente, no en el desglose', async () => {
      const summary = await service.getSummary(EVENT_A_ID);
      const pendingByDiscipline = summary.byDiscipline.reduce(
        (sum, item) => sum + cents(item.pendingAmount),
        0,
      );
      // 245 pendientes en total: 150 del ciclo sin equipos todavía + 95 con equipos.
      expect(cents(summary.payments.pending.amount)).toBe(24500);
      expect(pendingByDiscipline).toBe(9500);
    });

    it('un pago compartido no se duplica por cada equipo que cubre', async () => {
      const summary = await service.getSummary(EVENT_A_ID);
      // El BASE de S/100 cubre 3 equipos: si se contara por equipo serían S/300.
      expect(summary.payments.validated.count).toBe(6);
      expect(summary.payments.validated.amount).toBe(232.8);
    });

    it('el evento B cuenta su propio pago base y no se mezcla con el A', async () => {
      const summary = await service.getSummary(EVENT_B_ID);
      expect(summary.payments).toEqual({
        validated: { count: 2, amount: 1999.98 },
        pending: { count: 1, amount: 999.99 },
        rejected: { count: 0, amount: 0 },
      });
      expect(summary.teams.total).toBe(3);
    });

    it('todas las consultas del resumen filtran por el evento pedido', async () => {
      await service.getSummary(EVENT_A_ID);
      const scoped = prisma.calls.filter((call) =>
        ['team', 'voucher', 'discipline'].includes(call.model),
      );
      expect(scoped.length).toBeGreaterThan(0);
      for (const call of scoped) {
        const where = JSON.stringify((call.args as { where: unknown }).where);
        expect(where).toContain(`"eventId":${EVENT_A_ID}`);
        expect(where).not.toContain(`"eventId":${EVENT_B_ID}`);
      }
    });
  });

  describe('payments', () => {
    it('devuelve una fila por voucher con las etiquetas del grupo, en la forma de siempre', async () => {
      const page = await service.listPayments(EVENT_A_ID, {});

      expect(page.meta).toEqual({ page: 1, pageSize: 50, total: 12 });
      expect(page.data.slice(0, 4)).toEqual([
        expect.objectContaining({
          id: 3002,
          amount: 150,
          status: 'PENDING',
          operationNumber: 'OP-3002',
          teamName: 'Ingeniería de Sistemas · VI · Ciclo completo',
          disciplineName: 'Pago base (ciclo)',
          participantType: 'STUDENT',
        }),
        expect.objectContaining({
          id: 3001,
          amount: 20,
          status: 'PENDING',
          teamName: 'Ingeniería de Sistemas · V · A1',
          disciplineName: 'Adicional · Fútbol 7 varones',
          participantType: 'STUDENT',
        }),
        expect.objectContaining({
          id: 3000,
          amount: 100,
          status: 'VALIDATED',
          teamName: 'Ingeniería de Sistemas · V · A1',
          disciplineName: 'Pago base (salón)',
          participantType: 'STUDENT',
        }),
        expect.objectContaining({
          id: 1008,
          amount: 10.2,
          teamName: 'Raquetas 2',
          disciplineName: 'Tenis de mesa',
          participantType: 'OTHER',
        }),
      ]);
    });

    it('cada fila conserva exactamente las claves del contrato', async () => {
      const page = await service.listPayments(EVENT_A_ID, {});
      for (const row of page.data) {
        expect(Object.keys(row).sort()).toEqual([
          'amount',
          'disciplineName',
          'id',
          'operationNumber',
          'participantType',
          'status',
          'teamName',
          'updatedAt',
          'uploadedAt',
        ]);
      }
    });

    it('filtra por estado y pagina por voucher distinto', async () => {
      const validated = await service.listPayments(EVENT_A_ID, {
        status: VoucherStatus.VALIDATED,
      });
      expect(validated.data.map((row) => row.id)).toEqual([
        3000, 1008, 1007, 1004, 1001, 1000,
      ]);
      expect(validated.meta.total).toBe(6);

      const second = await service.listPayments(EVENT_A_ID, {
        page: 2,
        pageSize: 5,
      });
      expect(second.data).toHaveLength(5);
      expect(second.meta).toEqual({ page: 2, pageSize: 5, total: 12 });
    });

    it('no mezcla vouchers de otro evento ni expone datos personales o URLs', async () => {
      const page = await service.listPayments(EVENT_A_ID, {});
      const json = JSON.stringify(page);

      for (const marker of EVENT_B_MARKERS) {
        expect(json).not.toContain(marker);
      }
      expect(json).not.toContain('Ambiental');
      for (const value of sensitiveValues(dataset)) {
        expect(json).not.toContain(value);
      }
      expect(page.data.some((row) => row.id === 4000)).toBe(false);
    });

    it('el evento B ve su propio pago de grupo', async () => {
      const page = await service.listPayments(EVENT_B_ID, {});
      expect(page.data.map((row) => row.id).sort()).toEqual([2000, 2001, 4000]);
      expect(page.data.find((row) => row.id === 4000)).toMatchObject({
        teamName: 'Ingeniería Ambiental · II · B2',
        disciplineName: 'Pago base (salón)',
      });
    });
  });
});
