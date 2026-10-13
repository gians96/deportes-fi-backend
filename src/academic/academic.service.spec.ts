import { HttpException, HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DniProvider } from '@prisma/client';
import type { LookupOutcome } from '../dni-providers/dni-lookup';
import type {
  DniProvidersService,
  ResolvedDniProvider,
} from '../dni-providers/dni-providers.service';
import { AcademicService } from './academic.service';

/**
 * Configuración falsa: el `ConfigService` real cae a `process.env`, donde el cliente de Prisma ya
 * cargó el `.env` del backend, y las pruebas dejarían de ser herméticas.
 */
function fakeConfig(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const decolecta: ResolvedDniProvider = {
  provider: DniProvider.DECOLECTA,
  token: 'TOKEN-DECOLECTA',
  url: 'https://decolecta.test/dni',
  priority: 0,
};
const apiperu: ResolvedDniProvider = {
  provider: DniProvider.APIPERU,
  token: 'TOKEN-APIPERU',
  url: 'https://apiperu.test/dni',
  priority: 1,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** Responde según la URL: cada proveedor tiene su propio guion. */
function mockFetch(
  handlers: Record<string, () => Response | Promise<Response>>,
) {
  return jest.spyOn(global, 'fetch').mockImplementation((input) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const key = Object.keys(handlers).find((prefix) => url.startsWith(prefix));
    if (!key) return Promise.reject(new Error(`URL inesperada: ${url}`));
    return Promise.resolve(handlers[key]());
  });
}

function build(chain: ResolvedDniProvider[]) {
  const providers = {
    resolveChain: jest.fn().mockResolvedValue(chain),
    recordOutcome: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AcademicService(
    fakeConfig(),
    providers as unknown as DniProvidersService,
  );
  return { service, providers };
}

const outcomesRecorded = (providers: { recordOutcome: jest.Mock }) =>
  providers.recordOutcome.mock.calls.map(
    ([provider, outcome]: [DniProvider, LookupOutcome]) =>
      `${provider}:${outcome.kind}`,
  );

afterEach(() => jest.restoreAllMocks());

describe('AcademicService.findByDni', () => {
  it('no llama a ningún proveedor si el DNI no tiene 8 dígitos', async () => {
    const fetchSpy = mockFetch({});
    const { service, providers } = build([decolecta]);

    await expect(service.findByDni('1234')).resolves.toBeNull();
    await expect(service.findByDni('abcdefgh')).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(providers.resolveChain).not.toHaveBeenCalled();
  });

  it('responde 503 si no hay ningún proveedor configurado', async () => {
    const { service } = build([]);
    const error = await service.findByDni('12345678').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect((error as HttpException).message).toBe(
      'El servicio de consulta por DNI no está configurado',
    );
  });

  it('usa el primer proveedor cuando responde', async () => {
    mockFetch({
      'https://decolecta.test': () => jsonResponse({ full_name: 'PEREZ JUAN' }),
    });
    const { service, providers } = build([decolecta, apiperu]);

    await expect(service.findByDni('12345678')).resolves.toEqual({
      fullName: 'PEREZ JUAN',
      studentCode: null,
      dni: '12345678',
    });
    expect(outcomesRecorded(providers)).toEqual(['DECOLECTA:found']);
  });

  it('si Decolecta rechaza el token (401), responde con API Perú', async () => {
    const fetchSpy = mockFetch({
      'https://decolecta.test': () =>
        jsonResponse({ error: 'Apikey Required / Limit Exceeded' }, 401),
      'https://apiperu.test': () =>
        jsonResponse({
          success: true,
          data: { numero: '12345678', nombre_completo: 'JUAN PEREZ' },
        }),
    });
    const { service, providers } = build([decolecta, apiperu]);

    await expect(service.findByDni('12345678')).resolves.toEqual({
      fullName: 'JUAN PEREZ',
      studentCode: null,
      dni: '12345678',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(outcomesRecorded(providers)).toEqual([
      'DECOLECTA:unauthorized',
      'APIPERU:found',
    ]);
  });

  it('respeta el orden de la cadena (API Perú primero si tiene prioridad)', async () => {
    const fetchSpy = mockFetch({
      'https://apiperu.test': () =>
        jsonResponse({
          success: true,
          data: { numero: '12345678', nombre_completo: 'JUAN' },
        }),
    });
    const { service } = build([apiperu, decolecta]);

    await service.findByDni('12345678');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0] as string)).toContain(
      'apiperu.test',
    );
  });

  it('"no existe" es definitivo: no consulta a los demás', async () => {
    const fetchSpy = mockFetch({
      'https://decolecta.test': () => jsonResponse({ error: 'not found' }, 404),
    });
    const { service, providers } = build([decolecta, apiperu]);

    await expect(service.findByDni('12345678')).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(outcomesRecorded(providers)).toEqual(['DECOLECTA:not_found']);
  });

  it('si todos rechazan, responde 502 "No se pudo consultar el DNI"', async () => {
    mockFetch({
      'https://decolecta.test': () => jsonResponse({}, 401),
      'https://apiperu.test': () => jsonResponse({}, 401),
    });
    const { service } = build([decolecta, apiperu]);

    const error = await service.findByDni('12345678').catch((e: unknown) => e);
    expect((error as HttpException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect((error as HttpException).message).toBe(
      'No se pudo consultar el DNI',
    );
  });

  it('si ninguno responde (red), dice que el servicio no está disponible', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const { service } = build([decolecta, apiperu]);

    const error = await service.findByDni('12345678').catch((e: unknown) => e);
    expect((error as HttpException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect((error as HttpException).message).toBe(
      'Servicio de consulta por DNI no disponible',
    );
  });

  it('una caída seguida de un rechazo se reporta como rechazo', async () => {
    mockFetch({
      'https://decolecta.test': () => jsonResponse({}, 500),
      'https://apiperu.test': () => jsonResponse({}, 401),
    });
    const { service } = build([decolecta, apiperu]);

    await expect(service.findByDni('12345678')).rejects.toThrow(
      'No se pudo consultar el DNI',
    );
  });

  it('nunca expone el token en los errores', async () => {
    mockFetch({
      'https://decolecta.test': () => jsonResponse({}, 401),
      'https://apiperu.test': () => jsonResponse({}, 429),
    });
    const { service } = build([decolecta, apiperu]);
    const error = await service.findByDni('12345678').catch((e: unknown) => e);
    expect(JSON.stringify((error as HttpException).getResponse())).not.toMatch(
      /TOKEN-/,
    );
  });
});
