import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { CredentialState, DniProvider } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { DniProvidersService } from './dni-providers.service';

/**
 * Configuración falsa: el `ConfigService` real cae a `process.env`, donde el cliente de Prisma ya
 * cargó el `.env` del backend, y las pruebas dejarían de ser herméticas.
 */
function fakeConfig(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

interface Row {
  id: number;
  provider: DniProvider;
  enabled: boolean;
  priority: number;
  apiUrl: string | null;
  tokenCipher: string | null;
  tokenIv: string | null;
  tokenTag: string | null;
  tokenLast4: string | null;
  state: CredentialState;
  lastError: string | null;
  lastCheckedAt: Date | null;
  updatedById: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fake mínimo de `dniProviderConfig` con la unicidad por proveedor. */
class FakePrisma {
  readonly rows: Row[] = [];
  failUpserts = false;
  private seq = 0;

  readonly dniProviderConfig = {
    findMany: () => Promise.resolve(this.rows.map((row) => ({ ...row }))),
    findUnique: ({ where }: { where: { provider: DniProvider } }) => {
      const row = this.rows.find((item) => item.provider === where.provider);
      return Promise.resolve(row ? { ...row } : null);
    },
    upsert: ({
      where,
      create,
      update,
    }: {
      where: { provider: DniProvider };
      create: Partial<Row> & { provider: DniProvider };
      update: Partial<Row>;
    }) => {
      if (this.failUpserts) return Promise.reject(new Error('BD caída'));
      const existing = this.rows.find(
        (item) => item.provider === where.provider,
      );
      if (existing) {
        Object.assign(existing, update, { updatedAt: new Date() });
        return Promise.resolve({ ...existing });
      }
      const now = new Date();
      const row: Row = {
        id: ++this.seq,
        enabled: true,
        priority: 0,
        apiUrl: null,
        tokenCipher: null,
        tokenIv: null,
        tokenTag: null,
        tokenLast4: null,
        state: CredentialState.UNVERIFIED,
        lastError: null,
        lastCheckedAt: null,
        updatedById: null,
        createdAt: now,
        updatedAt: now,
        ...create,
      };
      this.rows.push(row);
      return Promise.resolve({ ...row });
    },
  };
}

const JWT_SECRET = 'jwt-secret-de-prueba-0123456789abcdef';
const DEDICATED_KEY = randomBytes(32).toString('base64');

/** `key`: qué clave de cifrado tiene el servidor (dedicada, derivada de JWT_SECRET o ninguna). */
function build(
  key: 'dedicated' | 'derived' | 'none' = 'derived',
  prisma = new FakePrisma(),
) {
  const values: Record<string, string> = {
    ...(key === 'dedicated' ? { INTEGRATION_SECRET_KEY: DEDICATED_KEY } : {}),
    ...(key !== 'none' ? { JWT_SECRET } : {}),
  };
  const service = new DniProvidersService(
    prisma as unknown as PrismaService,
    fakeConfig(values),
  );
  return { prisma, service };
}

const rowOf = (prisma: FakePrisma, provider: DniProvider) =>
  prisma.rows.find((row) => row.provider === provider);

afterEach(() => jest.restoreAllMocks());

describe('DniProvidersService.list', () => {
  it('lista ambos proveedores por prioridad, sin configurar y con su URL oficial', async () => {
    const { service } = build();
    const list = await service.list();
    expect(list.map((item) => item.provider)).toEqual(['DECOLECTA', 'APIPERU']);
    expect(
      list.every((item) => !item.configured && item.tokenMask === null),
    ).toBe(true);
    expect(
      list.every((item) => item.enabled && item.state === 'UNVERIFIED'),
    ).toBe(true);
    expect(list.map((item) => item.apiUrl)).toEqual([
      'https://api.decolecta.com/v1/reniec/dni',
      'https://api.apiperu.dev/dni',
    ]);
    expect(list.every((item) => !item.customUrl)).toBe(true);
  });

  it('informa de dónde sale la clave de cifrado', () => {
    expect(build('dedicated').service.encryptionKeySource()).toBe('dedicated');
    expect(build('derived').service.encryptionKeySource()).toBe('derived');
    expect(build('none').service.encryptionKeySource()).toBe('none');
    const weak = new DniProvidersService(
      new FakePrisma() as unknown as PrismaService,
      fakeConfig({ INTEGRATION_SECRET_KEY: 'corta', JWT_SECRET: 'corto' }),
    );
    expect(weak.encryptionKeySource()).toBe('none');
  });

  it('ya no usa tokens del entorno: solo cuenta lo guardado en la base', async () => {
    const prisma = new FakePrisma();
    const service = new DniProvidersService(
      prisma as unknown as PrismaService,
      fakeConfig({
        JWT_SECRET,
        DECOLECTA_TOKEN: 'token-del-env-que-se-ignora',
        APIPERU_TOKEN: 'otro-token-del-env-que-se-ignora',
      }),
    );
    expect((await service.list()).every((item) => !item.configured)).toBe(true);
    expect(await service.resolveChain()).toEqual([]);
  });
});

describe('DniProvidersService.update', () => {
  it('guarda el token cifrado y devuelve solo una máscara', async () => {
    const { prisma, service } = build();

    const view = await service.update(
      'apiperu',
      { token: 'apiperu-token-ABCD' },
      7,
    );

    expect(view).toMatchObject({
      provider: 'APIPERU',
      configured: true,
      tokenMask: '••••ABCD',
      state: 'UNVERIFIED',
    });
    expect(JSON.stringify(view)).not.toContain('apiperu-token');
    const row = rowOf(prisma, DniProvider.APIPERU)!;
    expect(row.updatedById).toBe(7);
    expect(row.tokenCipher).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain('apiperu-token');
  });

  it('acepta el nombre del proveedor sin importar mayúsculas y rechaza uno desconocido', async () => {
    const { service } = build();
    await expect(
      service.update('ApiPeru', { enabled: false }, 1),
    ).resolves.toMatchObject({
      provider: 'APIPERU',
      enabled: false,
    });
    await expect(service.update('otro', { enabled: false }, 1)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('quita un prefijo "Bearer " y los espacios del token pegado', async () => {
    const { service } = build();
    await service.update(
      'APIPERU',
      { token: '  Bearer   mi-token-pegado-9999  ' },
      1,
    );
    expect((await service.resolveChain())[0]).toMatchObject({
      provider: 'APIPERU',
      token: 'mi-token-pegado-9999',
    });
  });

  it('rechaza un token demasiado corto sin guardar nada', async () => {
    const { prisma, service } = build();
    await expect(
      service.update('APIPERU', { token: 'corto' }, 1),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.rows).toHaveLength(0);
  });

  it('responde 503 si el servidor no tiene ninguna clave para cifrar y no guarda nada', async () => {
    const { prisma, service } = build('none');
    const error = await service
      .update('APIPERU', { token: 'un-token-valido-123' }, 1)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect(prisma.rows).toHaveLength(0);
  });

  it('con una clave dedicada también cifra y recupera el token', async () => {
    const { service } = build('dedicated');
    await service.update('DECOLECTA', { token: 'token-con-clave-dedicada' }, 1);
    expect((await service.resolveChain())[0]).toMatchObject({
      token: 'token-con-clave-dedicada',
    });
  });

  it('si cambia la clave, el token guardado deja de usarse y hay que volver a ingresarlo', async () => {
    const first = build('derived');
    await first.service.update(
      'APIPERU',
      { token: 'token-con-clave-vieja' },
      1,
    );

    const { service } = build('dedicated', first.prisma);
    expect(
      (await service.list()).find((i) => i.provider === 'APIPERU')?.configured,
    ).toBe(true);
    expect(await service.resolveChain()).toEqual([]);

    await service.update('APIPERU', { token: 'token-con-clave-nueva' }, 1);
    expect((await service.resolveChain())[0]).toMatchObject({
      token: 'token-con-clave-nueva',
    });
  });

  it('sin clave se puede cambiar prioridad, URL y activación (no toca tokens)', async () => {
    const { service } = build('none');
    await expect(
      service.update(
        'DECOLECTA',
        { priority: 5, enabled: false, apiUrl: 'https://proxy.test/dni' },
        1,
      ),
    ).resolves.toMatchObject({
      priority: 5,
      enabled: false,
      apiUrl: 'https://proxy.test/dni',
    });
  });

  it('permite una URL propia y vuelve a la oficial al vaciarla', async () => {
    const { service } = build();
    const custom = await service.update(
      'APIPERU',
      { apiUrl: ' https://mi-proxy.test/api/dni ' },
      1,
    );
    expect(custom).toMatchObject({
      apiUrl: 'https://mi-proxy.test/api/dni',
      customUrl: true,
      defaultUrl: 'https://api.apiperu.dev/dni',
    });

    const reset = await service.update('APIPERU', { apiUrl: '' }, 1);
    expect(reset).toMatchObject({
      apiUrl: 'https://api.apiperu.dev/dni',
      customUrl: false,
    });
    await service.update('APIPERU', { apiUrl: 'http://127.0.0.1:9000/dni' }, 1);
    expect(
      (await service.update('APIPERU', { apiUrl: null }, 1)).customUrl,
    ).toBe(false);
  });

  it.each([
    'no es una url',
    'ftp://servidor.test/dni',
    'javascript:alert(1)',
    'file:///etc/passwd',
  ])('rechaza la URL "%s"', async (apiUrl) => {
    const { prisma, service } = build();
    await expect(service.update('APIPERU', { apiUrl }, 1)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.rows).toHaveLength(0);
  });

  it('borrar el token (null o vacío) deja el proveedor sin configurar', async () => {
    const { prisma, service } = build();
    await service.update('APIPERU', { token: 'token-de-plataforma-1' }, 1);
    expect(
      (await service.list()).find((i) => i.provider === 'APIPERU')?.configured,
    ).toBe(true);

    const view = await service.update('APIPERU', { token: null }, 1);
    expect(view).toMatchObject({
      configured: false,
      tokenMask: null,
      state: 'UNVERIFIED',
    });
    expect(rowOf(prisma, DniProvider.APIPERU)).toMatchObject({
      tokenCipher: null,
      tokenIv: null,
      tokenTag: null,
      tokenLast4: null,
    });
    expect(await service.resolveChain()).toEqual([]);

    await service.update('APIPERU', { token: 'otro-token-123456' }, 1);
    await service.update('APIPERU', { token: '' }, 1);
    expect(rowOf(prisma, DniProvider.APIPERU)?.tokenCipher).toBeNull();
  });

  it('cambiar el token reinicia el estado del proveedor', async () => {
    const { service } = build();
    await service.update('APIPERU', { token: 'primer-token-1234' }, 1);
    await service.recordOutcome(DniProvider.APIPERU, { kind: 'unauthorized' });
    expect(
      (await service.list()).find((i) => i.provider === 'APIPERU'),
    ).toMatchObject({
      state: 'INVALID',
      lastError: 'UNAUTHORIZED_OR_LIMIT',
    });

    const view = await service.update(
      'APIPERU',
      { token: 'segundo-token-5678' },
      1,
    );
    expect(view).toMatchObject({
      state: 'UNVERIFIED',
      lastError: null,
      lastCheckedAt: null,
    });
  });

  it('cambiar solo la prioridad conserva el token y el estado', async () => {
    const { service } = build();
    await service.update('APIPERU', { token: 'token-que-se-conserva' }, 1);
    await service.recordOutcome(DniProvider.APIPERU, {
      kind: 'found',
      person: { fullName: 'X', dni: '1' },
    });
    const view = await service.update('APIPERU', { priority: 9 }, 1);
    expect(view).toMatchObject({
      configured: true,
      tokenMask: '••••erva',
      state: 'VALID',
      priority: 9,
    });
  });
});

describe('DniProvidersService.resolveChain', () => {
  async function withTokens(service: DniProvidersService) {
    await service.update('DECOLECTA', { token: 'tok-decolecta-0001' }, 1);
    await service.update('APIPERU', { token: 'tok-apiperu-0001' }, 1);
  }

  it('ordena por prioridad y luego por orden del catálogo', async () => {
    const { service } = build();
    await withTokens(service);
    expect((await service.resolveChain()).map((p) => p.provider)).toEqual([
      'DECOLECTA',
      'APIPERU',
    ]);

    await service.update('APIPERU', { priority: 0 }, 1);
    expect((await service.resolveChain()).map((p) => p.provider)).toEqual([
      'DECOLECTA',
      'APIPERU',
    ]);

    await service.update('DECOLECTA', { priority: 3 }, 1);
    expect((await service.resolveChain()).map((p) => p.provider)).toEqual([
      'APIPERU',
      'DECOLECTA',
    ]);
  });

  it('omite proveedores desactivados o sin token', async () => {
    const { service } = build();
    await service.update('DECOLECTA', { token: 'tok-decolecta-0001' }, 1);
    expect((await service.resolveChain()).map((p) => p.provider)).toEqual([
      'DECOLECTA',
    ]);

    await service.update('DECOLECTA', { enabled: false }, 1);
    expect(await service.resolveChain()).toEqual([]);
  });

  it('usa las URLs oficiales por defecto y la propia cuando se configura', async () => {
    const { service } = build();
    await withTokens(service);
    expect((await service.resolveChain()).map((p) => p.url)).toEqual([
      'https://api.decolecta.com/v1/reniec/dni',
      'https://api.apiperu.dev/dni',
    ]);

    await service.update(
      'DECOLECTA',
      { apiUrl: 'https://mi-proxy.test/dni' },
      1,
    );
    expect((await service.resolveChain())[0].url).toBe(
      'https://mi-proxy.test/dni',
    );
  });

  it('un cambio se aplica en la siguiente consulta, sin reiniciar nada', async () => {
    const { service } = build();
    expect(await service.resolveChain()).toEqual([]);
    await service.update('APIPERU', { token: 'tok-nuevo-desde-la-web' }, 1);
    expect(await service.resolveChain()).toHaveLength(1);
    await service.update('APIPERU', { token: 'tok-reemplazado-web' }, 1);
    expect((await service.resolveChain())[0].token).toBe('tok-reemplazado-web');
    await service.update('APIPERU', { enabled: false }, 1);
    expect(await service.resolveChain()).toEqual([]);
  });

  it('si el token guardado está alterado, se omite ese proveedor', async () => {
    const { prisma, service } = build();
    await withTokens(service);
    rowOf(prisma, DniProvider.DECOLECTA)!.tokenTag =
      randomBytes(16).toString('base64');

    expect((await service.resolveChain()).map((p) => p.provider)).toEqual([
      'APIPERU',
    ]);
  });
});

describe('DniProvidersService.recordOutcome', () => {
  it.each([
    ['found', 'VALID', null],
    ['not_found', 'VALID', null],
    ['unauthorized', 'INVALID', 'UNAUTHORIZED_OR_LIMIT'],
  ] as const)('"%s" deja el estado %s', async (kind, state, lastError) => {
    const { prisma, service } = build();
    await service.recordOutcome(
      DniProvider.DECOLECTA,
      kind === 'found'
        ? { kind, person: { fullName: 'X', dni: '1' } }
        : { kind },
    );
    expect(rowOf(prisma, DniProvider.DECOLECTA)).toMatchObject({
      state,
      lastError,
    });
    expect(rowOf(prisma, DniProvider.DECOLECTA)?.lastCheckedAt).toBeInstanceOf(
      Date,
    );
  });

  it('un límite o una caída no invalidan el token', async () => {
    const { prisma, service } = build();
    await service.recordOutcome(DniProvider.DECOLECTA, {
      kind: 'found',
      person: { fullName: 'X', dni: '1' },
    });
    await service.recordOutcome(DniProvider.DECOLECTA, { kind: 'limit' });
    expect(rowOf(prisma, DniProvider.DECOLECTA)).toMatchObject({
      state: 'VALID',
      lastError: 'RATE_LIMITED',
    });
    await service.recordOutcome(DniProvider.DECOLECTA, { kind: 'unavailable' });
    expect(rowOf(prisma, DniProvider.DECOLECTA)).toMatchObject({
      state: 'VALID',
      lastError: 'UNAVAILABLE',
    });
  });

  it('registrar un resultado no hace que un proveedor sin token entre en la cadena', async () => {
    const { service } = build();
    await service.recordOutcome(DniProvider.APIPERU, { kind: 'unavailable' });
    expect(await service.resolveChain()).toEqual([]);
  });

  it('un error de la base no rompe la consulta', async () => {
    const { prisma, service } = build();
    prisma.failUpserts = true;
    await expect(
      service.recordOutcome(DniProvider.DECOLECTA, { kind: 'unavailable' }),
    ).resolves.toBeUndefined();
  });
});

describe('DniProvidersService.test', () => {
  const okBody = {
    success: true,
    data: { numero: '12345678', nombre_completo: 'NOMBRE PERSONAL' },
  };

  it('prueba con el token y la URL guardados, registra el estado y no devuelve datos personales', async () => {
    const { prisma, service } = build();
    await service.update(
      'APIPERU',
      { token: 'tok-de-plataforma-1', apiUrl: 'https://mi-proxy.test/dni' },
      1,
    );
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(okBody), { status: 200 }));

    const result = await service.test('APIPERU', '12345678');

    expect(result).toEqual({
      ok: true,
      result: 'found',
      message: 'El proveedor respondió correctamente.',
    });
    expect(JSON.stringify(result)).not.toContain('NOMBRE PERSONAL');
    expect(fetchSpy.mock.calls[0][0]).toBe('https://mi-proxy.test/dni');
    expect(
      (fetchSpy.mock.calls[0][1]?.headers as Record<string, string>)
        .Authorization,
    ).toBe('Bearer tok-de-plataforma-1');
    expect(rowOf(prisma, DniProvider.APIPERU)).toMatchObject({
      state: 'VALID',
    });
  });

  it('un token rechazado marca el proveedor como inválido', async () => {
    const { prisma, service } = build();
    await service.update('DECOLECTA', { token: 'tok-de-plataforma-1' }, 1);
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 401 }));

    const result = await service.test('DECOLECTA', '12345678');

    expect(result).toMatchObject({ ok: false, result: 'unauthorized' });
    expect(result.message).toContain('rechazó el token');
    expect(rowOf(prisma, DniProvider.DECOLECTA)).toMatchObject({
      state: 'INVALID',
    });
  });

  it('"no existe" cuenta como proveedor funcionando', async () => {
    const { service } = build();
    await service.update('DECOLECTA', { token: 'tok-de-plataforma-1' }, 1);
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 404 }));
    await expect(service.test('DECOLECTA', '12345678')).resolves.toMatchObject({
      ok: true,
      result: 'not_found',
    });
  });

  it('se puede probar aunque el proveedor esté desactivado', async () => {
    const { service } = build();
    await service.update(
      'APIPERU',
      { token: 'tok-de-plataforma-1', enabled: false },
      1,
    );
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(okBody), { status: 200 }));
    await expect(service.test('APIPERU', '12345678')).resolves.toMatchObject({
      ok: true,
    });
  });

  it('exige un token guardado y un proveedor válido', async () => {
    const { service } = build();
    await expect(service.test('APIPERU', '12345678')).rejects.toThrow(
      'no tiene un token guardado',
    );
    await expect(service.test('nope', '12345678')).rejects.toThrow(
      NotFoundException,
    );
  });
});
