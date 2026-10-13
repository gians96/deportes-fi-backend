import type { ConfigService } from '@nestjs/config';
import {
  DniLookupOrigin,
  DniLookupResult,
  DniProvider,
  DniTokenState,
  RenewalPeriod,
} from '@prisma/client';
import { FakeDniPrisma } from '../../test/fakes/dni-prisma';
import {
  DNI_CACHE_DAYS,
  DniLookupService,
  aggregateUsage,
  limaDate,
  maskDni,
} from './dni-lookup.service';
import { DniTokensService } from './dni-tokens.service';

/**
 * Configuración falsa: el `ConfigService` real cae a `process.env`, donde el cliente de Prisma ya
 * cargó el `.env` del backend, y las pruebas dejarían de ser herméticas.
 */
function fakeConfig(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const JWT_SECRET = 'secreto-jwt-de-pruebas-0123456789abcdef';
const APIPERU_URL = 'https://api.apiperu.dev/dni';
const DNI = '76251607';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

interface Call {
  provider: DniProvider;
  token: string;
  dni: string;
}

/** Respuesta correcta de cada proveedor, con su propio contrato. */
function found(call: Call, name = 'PEREZ GOMEZ JUAN'): Response {
  return call.provider === DniProvider.APIPERU
    ? json({ success: true, data: { numero: call.dni, nombre_completo: name } })
    : json({ full_name: name, document_number: call.dni });
}

/** Sustituye `fetch`: cada llamada se reparte entre proveedores y se anota con el token que la hizo. */
function providers(
  handler: (call: Call) => Response | Promise<Response>,
): Call[] {
  const calls: Call[] = [];
  jest.spyOn(global, 'fetch').mockImplementation((input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const provider = url.startsWith(APIPERU_URL)
      ? DniProvider.APIPERU
      : DniProvider.DECOLECTA;
    const token = (
      new Headers(init?.headers).get('authorization') ?? ''
    ).replace('Bearer ', '');
    const dni =
      provider === DniProvider.APIPERU
        ? (JSON.parse(init?.body as string) as { dni: string }).dni
        : (new URL(url).searchParams.get('numero') ?? '');
    const call = { provider, token, dni };
    calls.push(call);
    return Promise.resolve(handler(call));
  });
  return calls;
}

function setup() {
  const prisma = new FakeDniPrisma();
  const tokens = new DniTokensService(
    prisma.asPrisma(),
    fakeConfig({ JWT_SECRET }),
  );
  const service = new DniLookupService(prisma.asPrisma(), tokens);
  const add = (
    token: string,
    extra: Partial<{
      provider: DniProvider;
      priority: number;
      name: string;
      queryLimit: number | null;
      queriesUsed: number;
      enabled: boolean;
      renewsAt: string;
      renewalPeriod: RenewalPeriod;
    }> = {},
  ) =>
    tokens.create(
      {
        provider: DniProvider.DECOLECTA,
        name: extra.name ?? token,
        token,
        ...extra,
      },
      1,
    );
  return { prisma, tokens, service, add };
}

const ROSTER = DniLookupOrigin.ROSTER;
const row = (prisma: FakeDniPrisma, name: string) =>
  prisma.tokens.find((token) => token.name === name)!;

afterEach(() => jest.restoreAllMocks());

describe('DniLookupService.lookup · un token', () => {
  it('consulta, suma el uso, llena la caché y deja la bitácora con el DNI enmascarado', async () => {
    const { prisma, service, add } = setup();
    await add('tk-principal-AAAA', { name: 'Principal' });
    const calls = providers((call) => found(call));

    const result = await service.lookup(DNI, ROSTER);

    expect(result).toEqual({
      person: { dni: DNI, fullName: 'PEREZ GOMEZ JUAN' },
      source: 'PROVIDER',
      provider: DniProvider.DECOLECTA,
    });
    expect(calls).toEqual([
      { provider: DniProvider.DECOLECTA, token: 'tk-principal-AAAA', dni: DNI },
    ]);
    expect(row(prisma, 'Principal')).toMatchObject({
      queriesUsed: 1,
      state: DniTokenState.ACTIVE,
    });
    expect(prisma.cache.get(DNI)).toMatchObject({
      fullName: 'PEREZ GOMEZ JUAN',
      provider: DniProvider.DECOLECTA,
    });
    expect(prisma.logs).toHaveLength(1);
    expect(prisma.logs[0]).toMatchObject({
      dniMask: '76****07',
      result: DniLookupResult.SUCCESS,
      origin: ROSTER,
      httpStatus: 200,
      provider: DniProvider.DECOLECTA,
    });
    expect(JSON.stringify(prisma.logs)).not.toContain(DNI);
  });

  it('la segunda consulta del mismo DNI sale de la caché y no gasta cupo', async () => {
    const { prisma, service, add } = setup();
    await add('tk-principal-AAAA', { name: 'Principal' });
    const calls = providers((call) => found(call));

    await service.lookup(DNI, ROSTER);
    const again = await service.lookup(DNI, DniLookupOrigin.PROFILE);

    expect(again).toMatchObject({
      source: 'CACHE',
      person: { fullName: 'PEREZ GOMEZ JUAN' },
    });
    expect(calls).toHaveLength(1);
    expect(row(prisma, 'Principal').queriesUsed).toBe(1);
    expect(prisma.logs.map((log) => log.result)).toEqual([
      DniLookupResult.SUCCESS,
      DniLookupResult.CACHE,
    ]);
    expect(prisma.logs[1]).toMatchObject({
      origin: DniLookupOrigin.PROFILE,
      tokenId: null,
    });
  });

  it('una entrada de caché vencida (más de 30 días) se vuelve a consultar y se renueva', async () => {
    const { prisma, service, add } = setup();
    await add('tk-principal-AAAA');
    const calls = providers((call) => found(call, 'NOMBRE NUEVO'));
    prisma.cache.set(DNI, {
      dni: DNI,
      fullName: 'NOMBRE VIEJO',
      provider: DniProvider.DECOLECTA,
      fetchedAt: new Date(
        Date.now() - (DNI_CACHE_DAYS + 1) * 24 * 60 * 60 * 1000,
      ),
    });

    const result = await service.lookup(DNI, ROSTER);

    expect(result).toMatchObject({
      source: 'PROVIDER',
      person: { fullName: 'NOMBRE NUEVO' },
    });
    expect(calls).toHaveLength(1);
    expect(prisma.cache.get(DNI)!.fullName).toBe('NOMBRE NUEVO');
  });

  it('una entrada de caché de hace 29 días todavía vale', async () => {
    const { prisma, service, add } = setup();
    await add('tk-principal-AAAA');
    const calls = providers((call) => found(call));
    prisma.cache.set(DNI, {
      dni: DNI,
      fullName: 'EN CACHE',
      provider: DniProvider.APIPERU,
      fetchedAt: new Date(Date.now() - 29 * 24 * 60 * 60 * 1000),
    });
    expect(await service.lookup(DNI, ROSTER)).toMatchObject({
      source: 'CACHE',
      provider: DniProvider.APIPERU,
    });
    expect(calls).toHaveLength(0);
  });

  it('la caché guarda solo el DNI y el nombre', async () => {
    const { prisma, service, add } = setup();
    await add('tk-principal-AAAA');
    providers((call) => found(call));
    await service.lookup(DNI, ROSTER);
    expect(Object.keys(prisma.cache.get(DNI)!).sort()).toEqual([
      'dni',
      'fetchedAt',
      'fullName',
      'provider',
    ]);
  });

  it('API Perú se consulta por POST con el DNI en el cuerpo', async () => {
    const { service, add } = setup();
    await add('apiperu-token-1111', { provider: DniProvider.APIPERU });
    const calls = providers((call) => found(call, 'QUISPE MAMANI ANA'));
    const result = await service.lookup(DNI, ROSTER);
    expect(result).toMatchObject({
      provider: DniProvider.APIPERU,
      person: { fullName: 'QUISPE MAMANI ANA' },
    });
    expect(calls[0]).toMatchObject({ provider: DniProvider.APIPERU, dni: DNI });
  });
});

describe('DniLookupService.lookup · respaldo entre tokens', () => {
  it('un token rechazado (401) pasa a INVALID y la consulta sigue con el siguiente del mismo proveedor', async () => {
    const { prisma, service, add } = setup();
    await add('tk-malo-0001', { name: 'Malo', priority: 10 });
    await add('tk-bueno-0002', { name: 'Bueno', priority: 20 });
    const calls = providers((call) =>
      call.token === 'tk-malo-0001'
        ? json({ message: 'Apikey Required' }, 401)
        : found(call),
    );

    const result = await service.lookup(DNI, ROSTER);

    expect(result).toMatchObject({ source: 'PROVIDER' });
    expect(calls.map((call) => call.token)).toEqual([
      'tk-malo-0001',
      'tk-bueno-0002',
    ]);
    expect(row(prisma, 'Malo')).toMatchObject({
      state: DniTokenState.INVALID,
      queriesUsed: 0,
    });
    expect(row(prisma, 'Malo').lastError).toContain('401');
    expect(row(prisma, 'Bueno')).toMatchObject({
      state: DniTokenState.ACTIVE,
      queriesUsed: 1,
    });
    expect(prisma.logs.map((log) => log.result)).toEqual([
      DniLookupResult.INVALID_TOKEN,
      DniLookupResult.SUCCESS,
    ]);
  });

  it('el token rechazado no se vuelve a consultar en las siguientes consultas', async () => {
    const { service, add } = setup();
    await add('tk-malo-0001', { priority: 10 });
    await add('tk-bueno-0002', { priority: 20 });
    const calls = providers((call) =>
      call.token === 'tk-malo-0001' ? json({}, 401) : found(call),
    );
    await service.lookup('11111111', ROSTER);
    await service.lookup('22222222', ROSTER);
    expect(calls.map((call) => call.token)).toEqual([
      'tk-malo-0001',
      'tk-bueno-0002',
      'tk-bueno-0002',
    ]);
  });

  it('si el proveedor responde 429 el token queda AGOTADO aunque no tenga límite local', async () => {
    const { prisma, service, add } = setup();
    await add('tk-lleno-0001', { name: 'Lleno', priority: 10 });
    await add('tk-libre-0002', { name: 'Libre', priority: 20 });
    providers((call) =>
      call.token === 'tk-lleno-0001' ? json({}, 429) : found(call),
    );

    await service.lookup(DNI, ROSTER);

    expect(row(prisma, 'Lleno')).toMatchObject({
      state: DniTokenState.EXHAUSTED,
    });
    expect(row(prisma, 'Lleno').exhaustedAt).toBeInstanceOf(Date);
    expect(prisma.logs[0]).toMatchObject({
      result: DniLookupResult.EXHAUSTED,
      httpStatus: 429,
    });
  });

  it('el código 402 (pago requerido) también cuenta como cupo agotado', async () => {
    const { prisma, service, add } = setup();
    await add('tk-plan-0001', { name: 'Plan' });
    await add('tk-otro-0002', { name: 'Otro', priority: 500 });
    providers((call) =>
      call.token === 'tk-plan-0001' ? json({}, 402) : found(call),
    );
    await service.lookup(DNI, ROSTER);
    expect(row(prisma, 'Plan').state).toBe(DniTokenState.EXHAUSTED);
  });

  it('al llegar al límite local el token se agota y las siguientes consultas usan el próximo', async () => {
    const { prisma, service, add } = setup();
    await add('tk-limitado-0001', {
      name: 'Limitado',
      priority: 10,
      queryLimit: 2,
    });
    await add('tk-respaldo-0002', { name: 'Respaldo', priority: 20 });
    const calls = providers((call) => found(call));

    await service.lookup('10000001', ROSTER);
    await service.lookup('10000002', ROSTER);
    expect(row(prisma, 'Limitado')).toMatchObject({
      queriesUsed: 2,
      state: DniTokenState.EXHAUSTED,
    });
    await service.lookup('10000003', ROSTER);

    expect(calls.map((call) => call.token)).toEqual([
      'tk-limitado-0001',
      'tk-limitado-0001',
      'tk-respaldo-0002',
    ]);
  });

  it('una falla transitoria (5xx) no cambia el estado del token y se prueba el siguiente', async () => {
    const { prisma, service, add } = setup();
    await add('tk-caido-0001', { name: 'Caído', priority: 10 });
    await add('tk-sano-0002', { name: 'Sano', priority: 20 });
    providers((call) =>
      call.token === 'tk-caido-0001' ? json({}, 503) : found(call),
    );

    await service.lookup(DNI, ROSTER);

    expect(row(prisma, 'Caído')).toMatchObject({
      state: DniTokenState.ACTIVE,
      queriesUsed: 0,
    });
    expect(row(prisma, 'Caído').lastError).toBe(
      'El proveedor no respondió correctamente',
    );
    expect(prisma.logs[0]).toMatchObject({
      result: DniLookupResult.ERROR,
      httpStatus: 503,
    });
  });

  it('una caída de red tampoco lo marca y queda registrada sin código HTTP', async () => {
    const { prisma, service, add } = setup();
    await add('tk-red-0001', { name: 'Red', priority: 10 });
    await add('tk-ok-0002', { name: 'Ok', priority: 20 });
    jest.spyOn(global, 'fetch').mockImplementation((_input, init) => {
      const token = (
        new Headers(init?.headers).get('authorization') ?? ''
      ).replace('Bearer ', '');
      return token === 'tk-red-0001'
        ? Promise.reject(new Error('ECONNRESET'))
        : Promise.resolve(
            found({ provider: DniProvider.DECOLECTA, token, dni: DNI }),
          );
    });
    await service.lookup(DNI, ROSTER);
    expect(row(prisma, 'Red').state).toBe(DniTokenState.ACTIVE);
    expect(prisma.logs[0]).toMatchObject({
      result: DniLookupResult.ERROR,
      httpStatus: null,
    });
  });

  it('respeta la prioridad aunque el token de menor prioridad se haya creado después', async () => {
    const { service, add } = setup();
    await add('tk-segundo-0001', { priority: 50 });
    await add('tk-primero-0002', { priority: 5 });
    const calls = providers((call) => found(call));
    await service.lookup(DNI, ROSTER);
    expect(calls[0].token).toBe('tk-primero-0002');
  });

  it('no consulta tokens pausados', async () => {
    const { service, add } = setup();
    await add('tk-pausado-0001', { priority: 1, enabled: false });
    await add('tk-activo-0002', { priority: 99 });
    const calls = providers((call) => found(call));
    await service.lookup(DNI, ROSTER);
    expect(calls.map((call) => call.token)).toEqual(['tk-activo-0002']);
  });

  it('mezcla de proveedores: Decolecta sin cupo y API Perú responde', async () => {
    const { service, add } = setup();
    await add('tk-decolecta-0001', { priority: 10 });
    await add('apiperu-tok-0002', {
      provider: DniProvider.APIPERU,
      priority: 20,
    });
    providers((call) =>
      call.provider === DniProvider.DECOLECTA
        ? json({}, 429)
        : found(call, 'DESDE API PERU'),
    );
    expect(await service.lookup(DNI, ROSTER)).toMatchObject({
      provider: DniProvider.APIPERU,
      person: { fullName: 'DESDE API PERU' },
    });
  });
});

describe('DniLookupService.lookup · el DNI no existe', () => {
  it('si un proveedor no lo encuentra se prueba un token del otro antes de rendirse', async () => {
    const { prisma, service, add } = setup();
    await add('tk-decolecta-0001', { priority: 10, name: 'Decolecta' });
    await add('apiperu-tok-0002', {
      provider: DniProvider.APIPERU,
      priority: 20,
      name: 'API Perú',
    });
    const calls = providers((call) =>
      call.provider === DniProvider.DECOLECTA
        ? json({}, 404)
        : found(call, 'SOLO EN API PERU'),
    );

    expect(await service.lookup(DNI, ROSTER)).toMatchObject({
      provider: DniProvider.APIPERU,
      person: { fullName: 'SOLO EN API PERU' },
    });
    expect(calls.map((call) => call.provider)).toEqual([
      DniProvider.DECOLECTA,
      DniProvider.APIPERU,
    ]);
    // Un 404 también gasta una consulta del plan.
    expect(row(prisma, 'Decolecta')).toMatchObject({
      queriesUsed: 1,
      state: DniTokenState.ACTIVE,
    });
  });

  it('si ningún proveedor lo encuentra responde null y no repite el proveedor con otro token', async () => {
    const { service, add } = setup();
    await add('tk-decolecta-0001', { priority: 10 });
    await add('tk-decolecta-0002', { priority: 20 });
    await add('apiperu-tok-0003', {
      provider: DniProvider.APIPERU,
      priority: 30,
    });
    const calls = providers(() => json({}, 404));

    expect(await service.lookup(DNI, ROSTER)).toBeNull();
    expect(calls.map((call) => call.token)).toEqual([
      'tk-decolecta-0001',
      'apiperu-tok-0003',
    ]);
  });

  it('un 404 de un proveedor seguido de una falla del otro sigue siendo "no existe"', async () => {
    const { service, add } = setup();
    await add('tk-decolecta-0001', { priority: 10 });
    await add('apiperu-tok-0002', {
      provider: DniProvider.APIPERU,
      priority: 20,
    });
    providers((call) =>
      call.provider === DniProvider.DECOLECTA ? json({}, 404) : json({}, 500),
    );
    expect(await service.lookup(DNI, ROSTER)).toBeNull();
  });

  it('un DNI que no existe no se guarda en la caché', async () => {
    const { prisma, service, add } = setup();
    await add('tk-decolecta-0001');
    providers(() => json({}, 404));
    await service.lookup(DNI, ROSTER);
    expect(prisma.cache.size).toBe(0);
    expect(prisma.logs[0]).toMatchObject({ result: DniLookupResult.NOT_FOUND });
  });
});

describe('DniLookupService.lookup · sin respuesta útil', () => {
  it('sin ningún token configurado responde 503 "no está configurado"', async () => {
    const { prisma, service } = setup();
    const calls = providers(() => json({}));
    await expect(service.lookup(DNI, ROSTER)).rejects.toMatchObject({
      status: 503,
      message: 'El servicio de consulta por DNI no está configurado',
    });
    expect(calls).toHaveLength(0);
    expect(prisma.logs[0]).toMatchObject({ result: DniLookupResult.NO_TOKENS });
  });

  it('con tokens pero ninguno disponible responde 503 "no está disponible por el momento"', async () => {
    const { service, add } = setup();
    await add('tk-pausado-0001', { enabled: false });
    await add('tk-limite-0002', { queryLimit: 1, queriesUsed: 1 });
    await expect(service.lookup(DNI, ROSTER)).rejects.toMatchObject({
      status: 503,
      message:
        'El servicio de consulta por DNI no está disponible por el momento',
    });
  });

  it('si todos los tokens son rechazados responde 502 "No se pudo consultar el DNI"', async () => {
    const { service, add } = setup();
    await add('tk-uno-0001', { priority: 10 });
    await add('tk-dos-0002', { priority: 20 });
    providers(() => json({}, 401));
    await expect(service.lookup(DNI, ROSTER)).rejects.toMatchObject({
      status: 502,
      message: 'No se pudo consultar el DNI',
    });
  });

  it('si solo hubo fallas transitorias responde 502 "Servicio de consulta por DNI no disponible"', async () => {
    const { service, add } = setup();
    await add('tk-uno-0001');
    providers(() => json({}, 500));
    await expect(service.lookup(DNI, ROSTER)).rejects.toMatchObject({
      status: 502,
      message: 'Servicio de consulta por DNI no disponible',
    });
  });

  it('una caída seguida de un rechazo se reporta como rechazo', async () => {
    const { service, add } = setup();
    await add('tk-uno-0001', { priority: 10 });
    await add('tk-dos-0002', { priority: 20 });
    providers((call) =>
      call.token === 'tk-uno-0001' ? json({}, 500) : json({}, 401),
    );
    await expect(service.lookup(DNI, ROSTER)).rejects.toMatchObject({
      message: 'No se pudo consultar el DNI',
    });
  });

  it('nunca expone el token en errores, bitácora ni último error', async () => {
    const { prisma, service, add } = setup();
    await add('tk-SECRETO-ultra-9999', { priority: 10 });
    providers(() => json({ message: 'tk-SECRETO-ultra-9999 inválido' }, 401));
    const error = await service
      .lookup(DNI, ROSTER)
      .catch((e: unknown) => e as Error);
    expect((error as Error).message).not.toContain('SECRETO');
    expect(JSON.stringify(prisma.logs)).not.toContain('SECRETO');
    expect(
      JSON.stringify(prisma.tokens.map((token) => token.lastError)),
    ).not.toContain('SECRETO');
  });
});

describe('DniLookupService.lookup · renovación y resiliencia', () => {
  it('un token agotado con fecha de renovación vencida vuelve a consultarse', async () => {
    const { prisma, service, add } = setup();
    await add('tk-mensual-0001', {
      name: 'Mensual',
      queryLimit: 100,
      queriesUsed: 100,
      renewalPeriod: RenewalPeriod.MONTHLY,
      renewsAt: '2020-01-15T00:00:00Z',
    });
    const calls = providers((call) => found(call));
    expect(await service.lookup(DNI, ROSTER)).toMatchObject({
      source: 'PROVIDER',
    });
    expect(calls).toHaveLength(1);
    expect(row(prisma, 'Mensual')).toMatchObject({
      queriesUsed: 1,
      state: DniTokenState.ACTIVE,
    });
    expect(row(prisma, 'Mensual').renewsAt!.getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('si falla el registro de la bitácora la consulta sigue funcionando', async () => {
    const { prisma, service, add } = setup();
    await add('tk-uno-0001');
    providers((call) => found(call));
    prisma.failLogWrites = true;
    expect(await service.lookup(DNI, ROSTER)).toMatchObject({
      source: 'PROVIDER',
    });
  });

  it('un token que no se puede descifrar (cambió la clave) se marca INVALID y se pasa al siguiente', async () => {
    const { prisma, service, add } = setup();
    await add('tk-roto-0001', { name: 'Roto', priority: 10 });
    await add('tk-sano-0002', { name: 'Sano', priority: 20 });
    // Corrompe el cifrado del primero: equivale a haber cambiado JWT_SECRET después de guardarlo.
    row(prisma, 'Roto').tokenTag = 'AAAAAAAAAAAAAAAAAAAAAA==';
    const calls = providers((call) => found(call));

    expect(await service.lookup(DNI, ROSTER)).toMatchObject({
      source: 'PROVIDER',
    });
    expect(calls.map((call) => call.token)).toEqual(['tk-sano-0002']);
    expect(row(prisma, 'Roto')).toMatchObject({ state: DniTokenState.INVALID });
    expect(row(prisma, 'Roto').lastError).toContain('descifrar');
  });

  it('consultas simultáneas suman cada una su uso', async () => {
    const { prisma, service, add } = setup();
    await add('tk-uno-0001', { name: 'Uno', queryLimit: 1000 });
    providers((call) => found(call));
    await Promise.all(
      ['10000001', '10000002', '10000003', '10000004'].map((dni) =>
        service.lookup(dni, ROSTER),
      ),
    );
    expect(row(prisma, 'Uno').queriesUsed).toBe(4);
  });
});

describe('DniLookupService.testToken', () => {
  it('prueba un token pausado, consume una consulta y no devuelve datos personales', async () => {
    const { prisma, service, add } = setup();
    const { id } = await add('tk-pausado-0001', {
      name: 'Pausado',
      enabled: false,
    });
    const calls = providers((call) => found(call, 'NOMBRE PRIVADO'));

    const result = await service.testToken(id, DNI);

    expect(result).toMatchObject({
      ok: true,
      result: 'found',
      message: 'El proveedor respondió correctamente.',
    });
    expect(JSON.stringify(result)).not.toContain('NOMBRE PRIVADO');
    expect(result.token).toMatchObject({ id, queriesUsed: 1, enabled: false });
    expect(calls).toHaveLength(1);
    expect(prisma.logs[0]).toMatchObject({
      origin: DniLookupOrigin.PANEL,
      result: DniLookupResult.SUCCESS,
    });
  });

  it('un token rechazado se refleja en la respuesta y en su estado', async () => {
    const { service, add } = setup();
    const { id } = await add('tk-malo-0001');
    providers(() => json({}, 401));
    const result = await service.testToken(id, DNI);
    expect(result).toMatchObject({ ok: false, result: 'unauthorized' });
    expect(result.token.state).toBe(DniTokenState.INVALID);
  });

  it('un DNI que no existe cuenta como proveedor funcionando', async () => {
    const { service, add } = setup();
    const { id } = await add('tk-ok-0001');
    providers(() => json({}, 404));
    expect(await service.testToken(id, DNI)).toMatchObject({
      ok: true,
      result: 'not_found',
    });
  });
});

describe('DniLookupService: uso, bitácora y caché', () => {
  it('maskDni deja solo los extremos', () => {
    expect(maskDni('76251607')).toBe('76****07');
    expect(maskDni('1234')).toBe('****');
  });

  it('limaDate usa UTC-5 (las 21:00 de Lima ya son el día siguiente en UTC)', () => {
    expect(limaDate(new Date('2026-10-14T02:30:00Z'))).toBe('2026-10-13');
    expect(limaDate(new Date('2026-10-14T05:00:00Z'))).toBe('2026-10-14');
  });

  it('aggregateUsage agrupa por día y por token, incluidos los tokens eliminados y la caché', () => {
    const usage = aggregateUsage(
      [
        {
          createdAt: new Date('2026-10-13T15:00:00Z'),
          result: DniLookupResult.SUCCESS,
          tokenId: 1,
        },
        {
          createdAt: new Date('2026-10-13T16:00:00Z'),
          result: DniLookupResult.SUCCESS,
          tokenId: 1,
        },
        {
          createdAt: new Date('2026-10-13T17:00:00Z'),
          result: DniLookupResult.CACHE,
          tokenId: null,
        },
        {
          createdAt: new Date('2026-10-12T17:00:00Z'),
          result: DniLookupResult.EXHAUSTED,
          tokenId: 2,
        },
        {
          createdAt: new Date('2026-10-12T18:00:00Z'),
          result: DniLookupResult.ERROR,
          tokenId: 9,
        },
      ],
      [
        { id: 1, name: 'Principal', provider: DniProvider.DECOLECTA },
        { id: 2, name: 'Respaldo', provider: DniProvider.APIPERU },
      ],
    );
    expect(usage.byDay).toEqual([
      { date: '2026-10-12', EXHAUSTED: 1, ERROR: 1 },
      { date: '2026-10-13', SUCCESS: 2, CACHE: 1 },
    ]);
    expect(usage.byToken).toEqual([
      {
        tokenId: 1,
        name: 'Principal',
        provider: DniProvider.DECOLECTA,
        results: { SUCCESS: 2 },
      },
      {
        tokenId: null,
        name: 'Caché / sin token',
        provider: null,
        results: { CACHE: 1 },
      },
      {
        tokenId: 2,
        name: 'Respaldo',
        provider: DniProvider.APIPERU,
        results: { EXHAUSTED: 1 },
      },
      {
        tokenId: 9,
        name: 'Token eliminado',
        provider: null,
        results: { ERROR: 1 },
      },
    ]);
  });

  it('usage() lee la bitácora de la ventana pedida', async () => {
    const { prisma, service, add } = setup();
    await add('tk-uno-0001');
    providers((call) => found(call));
    await service.lookup(DNI, ROSTER);
    prisma.logs.push({
      id: 999,
      tokenId: null,
      provider: null,
      dniMask: '11****11',
      result: DniLookupResult.SUCCESS,
      httpStatus: 200,
      durationMs: 1,
      origin: ROSTER,
      detail: null,
      createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });
    const usage = await service.usage(30);
    expect(usage.days).toBe(30);
    expect(usage.byDay.reduce((sum, day) => sum + (day.SUCCESS ?? 0), 0)).toBe(
      1,
    );
    expect(
      (await service.usage(90)).byDay.reduce(
        (sum, day) => sum + (day.SUCCESS ?? 0),
        0,
      ),
    ).toBe(2);
  });

  it('logs() pagina de 20 en 20, la más reciente primero, con el nombre del token y sin nombres de personas', async () => {
    const { prisma, service, add } = setup();
    await add('tk-uno-0001', { name: 'Principal' });
    providers((call) => found(call));
    for (let i = 0; i < 25; i++)
      await service.lookup(String(10000000 + i), ROSTER);

    const first = await service.logs(1);
    expect(first.meta).toEqual({
      page: 1,
      pageSize: 20,
      total: 25,
      totalPages: 2,
    });
    expect(first.data).toHaveLength(20);
    expect(first.data[0].id).toBeGreaterThan(first.data[19].id);
    expect(first.data[0]).toMatchObject({
      token: 'Principal',
      dni: '10****24',
    });
    expect((await service.logs(2)).data).toHaveLength(5);
    expect(JSON.stringify(first)).not.toContain('PEREZ');
    expect(prisma.logs).toHaveLength(25);
  });

  it('al eliminar un token su historial se conserva sin el token', async () => {
    const { prisma, service, tokens, add } = setup();
    const { id } = await add('tk-uno-0001', { name: 'Principal' });
    providers((call) => found(call));
    await service.lookup(DNI, ROSTER);
    await tokens.remove(id);
    const logs = await service.logs(1);
    expect(logs.data).toHaveLength(1);
    expect(logs.data[0]).toMatchObject({
      token: null,
      result: DniLookupResult.SUCCESS,
    });
    expect(prisma.logs[0].tokenId).toBeNull();
  });

  it('clearCache() vacía la caché y la siguiente consulta vuelve al proveedor', async () => {
    const { prisma, service, add } = setup();
    await add('tk-uno-0001');
    const calls = providers((call) => found(call));
    await service.lookup(DNI, ROSTER);
    expect(await service.clearCache()).toEqual({ deleted: 1 });
    expect(prisma.cache.size).toBe(0);
    await service.lookup(DNI, ROSTER);
    expect(calls).toHaveLength(2);
  });
});
