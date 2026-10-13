import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DniProvider, DniTokenState, RenewalPeriod } from '@prisma/client';
import { FakeDniPrisma } from '../../test/fakes/dni-prisma';
import { DniTokensService } from './dni-tokens.service';

/**
 * Configuración falsa: el `ConfigService` real cae a `process.env`, donde el cliente de Prisma ya
 * cargó el `.env` del backend, y las pruebas dejarían de ser herméticas.
 */
function fakeConfig(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const JWT_SECRET = 'secreto-jwt-de-pruebas-0123456789abcdef';

function setup(config: Record<string, string> = { JWT_SECRET }) {
  const prisma = new FakeDniPrisma();
  const service = new DniTokensService(prisma.asPrisma(), fakeConfig(config));
  return { prisma, service };
}

const NEW_TOKEN = {
  provider: DniProvider.DECOLECTA,
  name: 'Decolecta principal',
  token: 'sk_token-de-prueba-AAAA',
};

describe('DniTokensService.create y vistas', () => {
  it('guarda el token cifrado y devuelve solo una máscara', async () => {
    const { prisma, service } = setup();
    const view = await service.create(NEW_TOKEN, 1);

    expect(view).toMatchObject({
      provider: DniProvider.DECOLECTA,
      providerLabel: 'Decolecta (RENIEC)',
      name: 'Decolecta principal',
      tokenMask: '••••AAAA',
      state: DniTokenState.ACTIVE,
      available: true,
      enabled: true,
      customUrl: false,
      apiUrl: 'https://api.decolecta.com/v1/reniec/dni',
    });
    expect(JSON.stringify(view)).not.toContain('sk_token-de-prueba');
    const stored = prisma.tokens[0];
    expect(JSON.stringify(stored)).not.toContain('sk_token-de-prueba');
    expect(stored.tokenCipher).not.toBe('');
    expect(Object.keys(view)).not.toEqual(
      expect.arrayContaining(['tokenCipher', 'tokenIv', 'tokenTag']),
    );
  });

  it('asigna prioridades de 10 en 10 al final de la lista', async () => {
    const { service } = setup();
    const first = await service.create(NEW_TOKEN, 1);
    const second = await service.create({ ...NEW_TOKEN, name: 'Segundo' }, 1);
    const explicit = await service.create(
      { ...NEW_TOKEN, name: 'Urgente', priority: 1 },
      1,
    );
    const last = await service.create({ ...NEW_TOKEN, name: 'Último' }, 1);
    expect([
      first.priority,
      second.priority,
      explicit.priority,
      last.priority,
    ]).toEqual([10, 20, 1, 30]);
  });

  it('acepta varios tokens del mismo proveedor y los lista por prioridad', async () => {
    const { service } = setup();
    await service.create({ ...NEW_TOKEN, name: 'B', priority: 20 }, 1);
    await service.create({ ...NEW_TOKEN, name: 'A', priority: 5 }, 1);
    await service.create(
      {
        provider: DniProvider.APIPERU,
        name: 'C',
        token: 'apiperu-token-12345',
        priority: 12,
      },
      1,
    );
    expect((await service.list()).map((token) => token.name)).toEqual([
      'A',
      'C',
      'B',
    ]);
  });

  it('quita el prefijo Bearer y los espacios, y normaliza el alias', async () => {
    const { service } = setup();
    const view = await service.create(
      {
        ...NEW_TOKEN,
        name: '  Con espacios  ',
        token: '  Bearer abcdefgh-ZZZZ ',
      },
      1,
    );
    expect(view.name).toBe('Con espacios');
    expect(view.tokenMask).toBe('••••ZZZZ');
  });

  it('rechaza tokens cortos, alias vacíos y URLs inválidas', async () => {
    const { service } = setup();
    await expect(
      service.create({ ...NEW_TOKEN, token: 'corto' }, 1),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create({ ...NEW_TOKEN, name: '   ' }, 1),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create({ ...NEW_TOKEN, apiUrl: 'ftp://otro.test' }, 1),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create({ ...NEW_TOKEN, apiUrl: 'no es una url' }, 1),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sin ninguna clave de cifrado no guarda nada (503)', async () => {
    const { prisma, service } = setup({});
    await expect(service.create(NEW_TOKEN, 1)).rejects.toMatchObject({
      status: 503,
    });
    expect(prisma.tokens).toHaveLength(0);
    expect(service.encryptionKeySource()).toBe('none');
  });

  it('informa de dónde sale la clave: dedicada o derivada de JWT_SECRET', () => {
    expect(setup({ JWT_SECRET }).service.encryptionKeySource()).toBe('derived');
    expect(
      setup({
        INTEGRATION_SECRET_KEY: 'a'.repeat(64),
      }).service.encryptionKeySource(),
    ).toBe('dedicated');
  });

  it('un token que ya alcanzó su límite nace agotado', async () => {
    const { service } = setup();
    const view = await service.create(
      { ...NEW_TOKEN, queryLimit: 100, queriesUsed: 100 },
      1,
    );
    expect(view).toMatchObject({
      state: DniTokenState.EXHAUSTED,
      available: false,
      queriesRemaining: 0,
      usagePercent: 100,
    });
  });

  it('calcula consultas restantes y porcentaje de uso', async () => {
    const { service } = setup();
    const view = await service.create(
      { ...NEW_TOKEN, queryLimit: 200, queriesUsed: 50 },
      1,
    );
    expect(view).toMatchObject({ queriesRemaining: 150, usagePercent: 25 });
    const unlimited = await service.create(
      { ...NEW_TOKEN, name: 'Sin límite' },
      1,
    );
    expect(unlimited).toMatchObject({
      queriesRemaining: null,
      usagePercent: null,
    });
  });
});

describe('DniTokensService.update, reset y remove', () => {
  it('reemplazar el token lo devuelve a ACTIVE y limpia el error', async () => {
    const { prisma, service } = setup();
    const { id } = await service.create(NEW_TOKEN, 1);
    await service.markFailure(id, DniTokenState.INVALID, 'Token rechazado');
    expect(prisma.tokens[0].state).toBe(DniTokenState.INVALID);

    const view = await service.update(id, { token: 'sk_nuevo-valor-BBBB' });
    expect(view).toMatchObject({
      state: DniTokenState.ACTIVE,
      lastError: null,
      tokenMask: '••••BBBB',
      available: true,
    });
  });

  it('no cambia el token si se omite, y cambiar la prioridad no lo toca', async () => {
    const { prisma, service } = setup();
    const { id } = await service.create(NEW_TOKEN, 1);
    const cipherBefore = prisma.tokens[0].tokenCipher;
    await service.update(id, { priority: 3, name: 'Renombrado' });
    expect(prisma.tokens[0].tokenCipher).toBe(cipherBefore);
    expect(prisma.tokens[0]).toMatchObject({ priority: 3, name: 'Renombrado' });
  });

  it('bajar el límite por debajo de lo usado lo agota; subirlo lo reactiva', async () => {
    const { service } = setup();
    const { id } = await service.create(
      { ...NEW_TOKEN, queryLimit: 100, queriesUsed: 60 },
      1,
    );
    expect(await service.update(id, { queryLimit: 50 })).toMatchObject({
      state: DniTokenState.EXHAUSTED,
      available: false,
    });
    expect(await service.update(id, { queryLimit: 500 })).toMatchObject({
      state: DniTokenState.ACTIVE,
      available: true,
    });
    expect(await service.update(id, { queryLimit: null })).toMatchObject({
      state: DniTokenState.ACTIVE,
      queriesRemaining: null,
    });
  });

  it('un token INVALID no se reactiva solo por ampliar el límite', async () => {
    const { service } = setup();
    const { id } = await service.create({ ...NEW_TOKEN, queryLimit: 10 }, 1);
    await service.markFailure(id, DniTokenState.INVALID, 'Token rechazado');
    expect(await service.update(id, { queryLimit: 1000 })).toMatchObject({
      state: DniTokenState.INVALID,
    });
  });

  it('una URL vacía o nula vuelve a la oficial; una válida se guarda', async () => {
    const { service } = setup();
    const { id } = await service.create(
      { ...NEW_TOKEN, apiUrl: 'https://proxy.test/dni' },
      1,
    );
    expect(await service.view(id)).toMatchObject({
      customUrl: true,
      apiUrl: 'https://proxy.test/dni',
    });
    expect(await service.update(id, { apiUrl: '' })).toMatchObject({
      customUrl: false,
      apiUrl: 'https://api.decolecta.com/v1/reniec/dni',
    });
    expect(await service.update(id, { apiUrl: null })).toMatchObject({
      customUrl: false,
    });
  });

  it('reiniciar pone el contador en 0 y el token en ACTIVE', async () => {
    const { service } = setup();
    const { id } = await service.create(
      { ...NEW_TOKEN, queryLimit: 5, queriesUsed: 5 },
      1,
    );
    await service.markFailure(id, DniTokenState.EXHAUSTED, 'Cupo agotado');
    expect(await service.reset(id)).toMatchObject({
      queriesUsed: 0,
      state: DniTokenState.ACTIVE,
      lastError: null,
      exhaustedAt: null,
      available: true,
    });
  });

  it('un token inexistente responde 404 en cada operación', async () => {
    const { service } = setup();
    await expect(service.update(99, { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.reset(99)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(99)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.view(99)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('eliminar quita el token', async () => {
    const { prisma, service } = setup();
    const { id } = await service.create(NEW_TOKEN, 1);
    await service.remove(id);
    expect(prisma.tokens).toHaveLength(0);
    expect(await service.hasAny()).toBe(false);
  });
});

describe('DniTokensService.available y renovación', () => {
  const NOW = new Date('2026-10-13T12:00:00Z');

  it('devuelve solo los tokens activos y con cupo, por prioridad y luego por id', async () => {
    const { prisma, service } = setup();
    const a = await service.create(
      { ...NEW_TOKEN, name: 'A', priority: 20 },
      1,
    );
    const b = await service.create(
      { ...NEW_TOKEN, name: 'B', priority: 10 },
      1,
    );
    const c = await service.create(
      { ...NEW_TOKEN, name: 'C', priority: 10 },
      1,
    );
    await service.create(
      { ...NEW_TOKEN, name: 'Pausado', priority: 1, enabled: false },
      1,
    );
    const exhausted = await service.create(
      { ...NEW_TOKEN, name: 'Agotado', priority: 2 },
      1,
    );
    await service.markFailure(
      exhausted.id,
      DniTokenState.EXHAUSTED,
      'Cupo agotado',
    );
    const invalid = await service.create(
      { ...NEW_TOKEN, name: 'Inválido', priority: 3 },
      1,
    );
    await service.markFailure(invalid.id, DniTokenState.INVALID, 'Rechazado');
    // Estado ACTIVE pero con el contador ya en el límite (p. ej. un cambio hecho a mano).
    const full = await service.create(
      { ...NEW_TOKEN, name: 'Lleno', priority: 4, queryLimit: 3 },
      1,
    );
    prisma.tokens.find((row) => row.id === full.id)!.queriesUsed = 3;

    const names = (await service.available(NOW)).map((row) => row.name);
    expect(names).toEqual(['B', 'C', 'A']);
    expect(a.id).toBeLessThan(b.id);
    expect(b.id).toBeLessThan(c.id);
  });

  it('un token agotado vuelve a ACTIVE con el contador en 0 al llegar su fecha de renovación', async () => {
    const { prisma, service } = setup();
    const { id } = await service.create(
      {
        ...NEW_TOKEN,
        queryLimit: 100,
        queriesUsed: 100,
        renewalPeriod: RenewalPeriod.MONTHLY,
        renewsAt: '2026-10-05T00:00:00Z',
      },
      1,
    );
    expect(prisma.tokens[0].state).toBe(DniTokenState.EXHAUSTED);

    const names = (await service.available(NOW)).map((row) => row.name);
    expect(names).toEqual(['Decolecta principal']);
    expect(prisma.tokens[0]).toMatchObject({
      id,
      state: DniTokenState.ACTIVE,
      queriesUsed: 0,
      exhaustedAt: null,
    });
    expect(prisma.tokens[0].renewsAt).toEqual(new Date('2026-11-05T00:00:00Z'));
  });

  it('la renovación no rehabilita un token INVALID, pero sí reinicia su contador y su fecha', async () => {
    const { prisma, service } = setup();
    const { id } = await service.create(
      { ...NEW_TOKEN, queriesUsed: 40, renewsAt: '2026-10-05T00:00:00Z' },
      1,
    );
    await service.markFailure(id, DniTokenState.INVALID, 'Rechazado');
    expect(await service.available(NOW)).toHaveLength(0);
    expect(prisma.tokens[0]).toMatchObject({
      state: DniTokenState.INVALID,
      queriesUsed: 0,
    });
    expect(prisma.tokens[0].renewsAt!.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('no renueva tokens sin periodo, sin fecha, con fecha futura o pausados', async () => {
    const { prisma, service } = setup();
    await service.create(
      {
        ...NEW_TOKEN,
        name: 'Sin periodo',
        renewalPeriod: RenewalPeriod.NONE,
        renewsAt: '2026-10-01T00:00:00Z',
        queriesUsed: 7,
      },
      1,
    );
    await service.create(
      { ...NEW_TOKEN, name: 'Sin fecha', queriesUsed: 7 },
      1,
    );
    await service.create(
      {
        ...NEW_TOKEN,
        name: 'Futuro',
        queriesUsed: 7,
        renewsAt: '2026-12-01T00:00:00Z',
      },
      1,
    );
    await service.create(
      {
        ...NEW_TOKEN,
        name: 'Pausado',
        queriesUsed: 7,
        enabled: false,
        renewsAt: '2026-10-01T00:00:00Z',
      },
      1,
    );
    await service.renewDue(NOW);
    expect(prisma.tokens.map((row) => row.queriesUsed)).toEqual([7, 7, 7, 7]);
  });

  it('dos renovaciones simultáneas no renuevan dos veces (la actualización es condicional)', async () => {
    const { prisma, service } = setup();
    await service.create(
      { ...NEW_TOKEN, queriesUsed: 9, renewsAt: '2026-10-05T00:00:00Z' },
      1,
    );
    await Promise.all([service.renewDue(NOW), service.renewDue(NOW)]);
    expect(prisma.tokens[0].renewsAt).toEqual(new Date('2026-11-05T00:00:00Z'));
    expect(prisma.tokens[0].queriesUsed).toBe(0);
  });
});

describe('DniTokensService.countUse', () => {
  it('suma de forma atómica y agota el token al llegar al límite', async () => {
    const { prisma, service } = setup();
    const { id } = await service.create({ ...NEW_TOKEN, queryLimit: 3 }, 1);
    await Promise.all([service.countUse(id), service.countUse(id)]);
    expect(prisma.tokens[0]).toMatchObject({
      queriesUsed: 2,
      state: DniTokenState.ACTIVE,
    });
    await service.countUse(id);
    expect(prisma.tokens[0]).toMatchObject({
      queriesUsed: 3,
      state: DniTokenState.EXHAUSTED,
    });
    expect(prisma.tokens[0].exhaustedAt).toBeInstanceOf(Date);
    expect(prisma.tokens[0].lastUsedAt).toBeInstanceOf(Date);
  });
});
