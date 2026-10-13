import { RegistrationStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { InMemoryPrisma } from '../../test/fakes/in-memory-prisma';
import type { FakeDataset } from '../../test/fakes/in-memory-prisma';
import {
  buildMixedDataset,
  EVENT_A_ID,
  EXPECTED_SUMMARY_A_MIXED,
} from '../../test/fakes/sports-dataset';
import { IntegrationsService } from './integrations.service';

/**
 * Los equipos en borrador (spec 006) no existen para el Contrato 2: ni cuentan, ni cambian los montos,
 * ni aparecen en los listados, y la forma de la respuesta no gana campos.
 */
describe('Contrato 2 y borradores', () => {
  let dataset: FakeDataset;
  let service: IntegrationsService;

  beforeEach(() => {
    dataset = buildMixedDataset();
    const eventDisciplineIds = new Set(
      dataset.disciplines
        .filter((discipline) => discipline.eventId === EVENT_A_ID)
        .map((discipline) => discipline.id),
    );
    const covered = dataset.teams.filter((team) =>
      eventDisciplineIds.has(team.disciplineId),
    );
    const source = covered.find((team) => team.voucherId) ?? covered[0];
    let nextId = Math.max(...dataset.teams.map((team) => team.id)) + 1;
    // Dos borradores: uno comparte el voucher de un equipo ya enviado y otro no tiene voucher.
    for (const voucherId of [source.voucherId ?? null, null]) {
      dataset.teams.push({
        ...source,
        id: nextId++,
        name: `Borrador ${nextId}`,
        status: RegistrationStatus.DRAFT,
        voucherId,
      });
    }
    service = new IntegrationsService(
      new InMemoryPrisma(dataset) as unknown as PrismaService,
    );
  });

  it('el resumen no cuenta los borradores ni reparte el pago con ellos', async () => {
    const summary = await service.getSummary(EVENT_A_ID);
    expect(summary).toMatchObject(EXPECTED_SUMMARY_A_MIXED);
    expect(Object.keys(summary.teams).sort()).toEqual(
      ['approved', 'cancelled', 'pending', 'rejected', 'total'].sort(),
    );
  });

  it('el listado de equipos no incluye borradores', async () => {
    const page = await service.listRegistrations(EVENT_A_ID, {});
    expect(page.data.some((item) => item.name.startsWith('Borrador'))).toBe(
      false,
    );
    expect(page.data.every((item) => item.status !== 'DRAFT')).toBe(true);
  });
});
