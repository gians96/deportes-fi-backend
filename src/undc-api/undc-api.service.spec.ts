import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { UndcApiStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { UndcApiService } from './undc-api.service';

/**
 * Configuración falsa: el `ConfigService` real cae a `process.env`, donde el cliente de Prisma ya
 * cargó el `.env` del backend, y las pruebas dejarían de ser herméticas.
 */
const KEY_HEX = 'a'.repeat(64);
function fakeConfig(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

interface Row {
  id: number;
  baseUrl: string;
  keyCipher: string;
  keyIv: string;
  keyTag: string;
  keyLast4: string;
  timeoutMs: number;
  enabled: boolean;
  lastStatus: UndcApiStatus | null;
  lastError: string | null;
  lastCheckedAt: Date | null;
  updatedById: number | null;
  createdAt: Date;
  updatedAt: Date;
}

function fakePrisma() {
  const state: { row: Row | null; updates: Array<Record<string, unknown>> } = {
    row: null,
    updates: [],
  };
  const prisma = {
    undcApiConfig: {
      findUnique: jest.fn(() =>
        Promise.resolve(state.row ? { ...state.row } : null),
      ),
      create: jest.fn(({ data }: { data: Partial<Row> }) => {
        state.row = {
          lastStatus: null,
          lastError: null,
          lastCheckedAt: null,
          updatedById: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        } as Row;
        return Promise.resolve({ ...state.row });
      }),
      update: jest.fn(({ data }: { data: Partial<Row> }) => {
        state.updates.push(data);
        state.row = { ...(state.row as Row), ...data, updatedAt: new Date() };
        return Promise.resolve({ ...state.row });
      }),
      deleteMany: jest.fn(() => {
        state.row = null;
        return Promise.resolve({ count: 1 });
      }),
    },
  };
  return { prisma, state };
}

function build(
  config: Record<string, string> = { INTEGRATION_SECRET_KEY: KEY_HEX },
) {
  const { prisma, state } = fakePrisma();
  const service = new UndcApiService(
    prisma as unknown as PrismaService,
    fakeConfig(config),
  );
  return { service, prisma, state };
}

const API_KEY = 'undc_clave-de-prueba-0123456789abcdef';
const SAVE = { baseUrl: 'http://127.0.0.1:3020/', apiKey: API_KEY };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const FOUND = {
  msg: 'OK',
  data: {
    encontrado: true,
    codigo_estudiante: '2401010001',
    nombre_completo: 'PRUEBA  UNO PERSONA',
    dni: '70000001',
    egresado: false,
    carrera: null,
    fuente: 'CACHE',
  },
};

let fetchMock: jest.SpyInstance;
beforeEach(() => {
  fetchMock = jest.spyOn(global, 'fetch');
});
afterEach(() => {
  fetchMock.mockRestore();
});

describe('UndcApiService: configuración', () => {
  it('sin configurar no hay conexión ni máscara', async () => {
    const { service } = build();
    await expect(service.get()).resolves.toMatchObject({
      configured: false,
      baseUrl: null,
      keyMask: null,
      enabled: false,
      encryptionKey: 'dedicated',
    });
  });

  it('la primera vez exige la API key', async () => {
    const { service } = build();
    await expect(
      service.save({ baseUrl: 'https://api-jp.episundc.pe' }, 1),
    ).rejects.toThrow('Escribe la API key de API_UNDC.');
    await expect(
      service.save(
        { baseUrl: 'https://api-jp.episundc.pe', apiKey: 'corta' },
        1,
      ),
    ).rejects.toThrow(/demasiado corta/);
  });

  it('guarda la key cifrada y nunca la devuelve', async () => {
    const { service, state } = build();
    const view = await service.save(SAVE, 7);

    expect(view).toMatchObject({
      configured: true,
      baseUrl: 'http://127.0.0.1:3020',
      keyMask: `••••${API_KEY.slice(-4)}`,
      enabled: true,
      timeoutMs: 8000,
    });
    expect(JSON.stringify(view)).not.toContain(API_KEY);
    expect(state.row?.keyCipher).not.toContain(API_KEY);
    expect(state.row?.updatedById).toBe(7);
  });

  it('actualizar sin key conserva la guardada; una URL nueva reinicia el último resultado', async () => {
    const { service, state } = build();
    await service.save(SAVE, 1);
    const cipher = state.row?.keyCipher;
    state.row = {
      ...state.row!,
      lastStatus: UndcApiStatus.OK,
      lastCheckedAt: new Date(),
    };

    await service.save(
      { baseUrl: 'http://localhost:3020', timeoutMs: 5000, enabled: false },
      1,
    );

    expect(state.row?.keyCipher).toBe(cipher);
    expect(state.row).toMatchObject({
      baseUrl: 'http://localhost:3020',
      timeoutMs: 5000,
      enabled: false,
      lastStatus: null,
    });
  });

  it('valida la URL contra SSRF y el formato', async () => {
    const { service } = build();
    await expect(
      service.save(
        { baseUrl: 'https://u:p@api-jp.episundc.pe', apiKey: API_KEY },
        1,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.save(
        { baseUrl: 'http://api-jp.episundc.pe', apiKey: API_KEY },
        1,
      ),
    ).rejects.toThrow(/https/);
  });

  it('sin clave de cifrado en el servidor no guarda nada (503)', async () => {
    const { service, state } = build({});
    await expect(service.save(SAVE, 1)).rejects.toMatchObject({ status: 503 });
    expect(state.row).toBeNull();
  });

  it('usa una clave derivada de JWT_SECRET si falta la dedicada', async () => {
    const { service } = build({
      JWT_SECRET: 'un-secreto-largo-de-prueba-0123456789',
    });
    const view = await service.save(SAVE, 1);
    expect(view.encryptionKey).toBe('derived');
  });

  it('eliminar borra la conexión', async () => {
    const { service, state } = build();
    await service.save(SAVE, 1);
    await service.remove();
    expect(state.row).toBeNull();
    await expect(service.get()).resolves.toMatchObject({ configured: false });
  });
});

describe('UndcApiService: consulta de estudiantes', () => {
  it('sin configurar o desactivada no llama a nadie', async () => {
    const { service } = build();
    await expect(service.lookupStudent('2401010001')).resolves.toBeNull();
    await service.save({ ...SAVE, enabled: false }, 1);
    await expect(service.lookupStudent('2401010001')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('envía la key descifrada y el código, y devuelve nombre, código y DNI', async () => {
    const { service } = build();
    await service.save(SAVE, 1);
    fetchMock.mockResolvedValue(jsonResponse(FOUND));

    const student = await service.lookupStudent('2401010001');

    expect(student).toEqual({
      fullName: 'PRUEBA UNO PERSONA',
      studentCode: '2401010001',
      dni: '70000001',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3020/externo/estudiantes/consultar');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe(API_KEY);
    expect(JSON.parse(init.body as string)).toEqual({ codigo: '2401010001' });
    expect(init.redirect).toBe('error');
  });

  it('un DNI que no tiene 8 dígitos se descarta; el nombre y el código se conservan', async () => {
    const { service } = build();
    await service.save(SAVE, 1);
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { ...FOUND.data, dni: 'CE12345678' } }),
    );
    await expect(service.lookupStudent('2401010001')).resolves.toMatchObject({
      dni: null,
      studentCode: '2401010001',
    });
  });

  it('si API_UNDC no conoce el código o no tiene DNI, devuelve null o dni null sin fallar', async () => {
    const { service, state } = build();
    await service.save(SAVE, 1);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { encontrado: false, dni: null } }),
    );
    await expect(service.lookupStudent('2401010001')).resolves.toBeNull();
    expect(state.row?.lastStatus).toBe(UndcApiStatus.OK);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { ...FOUND.data, dni: null } }),
    );
    await expect(service.lookupStudent('2401010001')).resolves.toMatchObject({
      dni: null,
    });
  });

  it.each([
    [401, /rechazó la API key/],
    [403, /permiso estudiantes:consultar/],
    [429, /limitó/],
    [500, /HTTP 500/],
  ])(
    'la respuesta %s devuelve null y deja el motivo en la conexión',
    async (status, message) => {
      const { service, state } = build();
      await service.save(SAVE, 1);
      fetchMock.mockResolvedValue(jsonResponse({ msg: 'x' }, status));

      await expect(service.lookupStudent('2401010001')).resolves.toBeNull();

      expect(state.row?.lastStatus).toBe(UndcApiStatus.FAILED);
      expect(state.row?.lastError).toMatch(message);
    },
  );

  it('un cuerpo irreconocible, demasiado grande o una caída de red devuelven null', async () => {
    const { service, state } = build();
    await service.save(SAVE, 1);

    fetchMock.mockResolvedValueOnce(new Response('<html>no es json</html>'));
    await expect(service.lookupStudent('2401010001')).resolves.toBeNull();
    expect(state.row?.lastError).toMatch(/no reconocida/);

    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(70 * 1024)));
    await expect(service.lookupStudent('2401010001')).resolves.toBeNull();
    expect(state.row?.lastError).toMatch(/demasiado grande/);

    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(service.lookupStudent('2401010001')).resolves.toBeNull();
    expect(state.row?.lastError).toMatch(/No se pudo conectar/);

    const timeout = Object.assign(new Error('timeout'), {
      name: 'TimeoutError',
    });
    fetchMock.mockRejectedValueOnce(timeout);
    await expect(service.lookupStudent('2401010001')).resolves.toBeNull();
    expect(state.row?.lastError).toMatch(/a tiempo/);
  });

  it('solo escribe en la base cuando cambia el resultado, no en cada búsqueda', async () => {
    const { service, state } = build();
    await service.save(SAVE, 1);
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(FOUND)));

    await service.lookupStudent('2401010001');
    await service.lookupStudent('2401010001');
    await service.lookupStudent('2401010001');

    expect(state.updates).toHaveLength(1);
  });

  it('el DNI de la respuesta nunca queda en el último error', async () => {
    const { service, state } = build();
    await service.save(SAVE, 1);
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { encontrado: true, dni: '70000001' } }),
    );
    await service.lookupStudent('2401010001');
    expect(state.row?.lastError ?? '').not.toContain('70000001');
  });

  it('si cambió la clave de cifrado del servidor lo explica y no llama', async () => {
    const { service, state, prisma } = build();
    await service.save(SAVE, 1);
    const other = new UndcApiService(
      prisma as unknown as PrismaService,
      fakeConfig({ INTEGRATION_SECRET_KEY: 'b'.repeat(64) }),
    );
    await expect(other.lookupStudent('2401010001')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.row?.lastError).toMatch(/descifrar/);
  });
});

describe('UndcApiService: probar', () => {
  it('sin configuración responde 404', async () => {
    const { service } = build();
    await expect(service.test()).rejects.toThrow(NotFoundException);
  });

  it('usa un código inexistente y deja OK cuando la conexión funciona', async () => {
    const { service, state } = build();
    await service.save(SAVE, 1);
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { encontrado: false, dni: null } }),
    );

    await expect(service.test()).resolves.toEqual({
      ok: true,
      message: 'API_UNDC respondió correctamente.',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as unknown;
    expect(body).toEqual({ codigo: '00000000' });
    expect(state.row).toMatchObject({
      lastStatus: UndcApiStatus.OK,
      lastError: null,
    });
    expect(state.row?.lastCheckedAt).toBeInstanceOf(Date);
  });

  it('informa el motivo cuando falla y lo guarda', async () => {
    const { service, state } = build();
    await service.save(SAVE, 1);
    fetchMock.mockResolvedValue(jsonResponse({}, 401));

    const result = await service.test();

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rechazó la API key/);
    expect(state.row?.lastStatus).toBe(UndcApiStatus.FAILED);
  });
});
