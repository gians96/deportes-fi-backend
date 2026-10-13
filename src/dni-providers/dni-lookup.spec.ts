import { DniProvider } from '@prisma/client';
import { lookupDni } from './dni-lookup';

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

function fakeFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn, calls };
}

const base = {
  url: 'https://proveedor.test/dni',
  token: 'TOKEN-SECRETO',
  dni: '12345678',
};

describe('lookupDni · Decolecta', () => {
  it('consulta por GET con el token en la cabecera y devuelve el nombre', async () => {
    const { fn, calls } = fakeFetch(() =>
      json({ full_name: 'PEREZ   GOMEZ JUAN', document_number: '12345678' }),
    );

    const outcome = await lookupDni(DniProvider.DECOLECTA, {
      ...base,
      fetchFn: fn,
    });

    expect(outcome).toEqual({
      kind: 'found',
      person: { fullName: 'PEREZ GOMEZ JUAN', dni: '12345678' },
    });
    expect(calls[0].url).toBe('https://proveedor.test/dni?numero=12345678');
    expect(calls[0].init.method).toBe('GET');
    expect(
      (calls[0].init.headers as Record<string, string>).Authorization,
    ).toBe('Bearer TOKEN-SECRETO');
  });

  it('arma el nombre con apellidos y nombres si no viene completo', async () => {
    const { fn } = fakeFetch(() =>
      json({
        first_name: 'JUAN',
        first_last_name: 'PEREZ',
        second_last_name: 'GOMEZ',
      }),
    );
    const outcome = await lookupDni(DniProvider.DECOLECTA, {
      ...base,
      fetchFn: fn,
    });
    expect(outcome).toMatchObject({
      kind: 'found',
      person: { fullName: 'PEREZ GOMEZ JUAN', dni: '12345678' },
    });
  });

  it.each([
    [404, 'not_found'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'limit'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [422, 'unavailable'],
  ])('traduce el HTTP %i como %s', async (status, kind) => {
    const { fn } = fakeFetch(() => json({ error: 'x' }, status));
    await expect(
      lookupDni(DniProvider.DECOLECTA, { ...base, fetchFn: fn }),
    ).resolves.toEqual({ kind });
  });

  it('una respuesta sin nombre es "no disponible"', async () => {
    const { fn } = fakeFetch(() => json({}));
    await expect(
      lookupDni(DniProvider.DECOLECTA, { ...base, fetchFn: fn }),
    ).resolves.toEqual({ kind: 'unavailable' });
  });
});

describe('lookupDni · API Perú', () => {
  it('consulta por POST con el DNI en el cuerpo y devuelve el nombre', async () => {
    const { fn, calls } = fakeFetch(() =>
      json({
        success: true,
        data: { numero: '12345678', nombre_completo: 'JUAN PEREZ GOMEZ' },
      }),
    );

    const outcome = await lookupDni(DniProvider.APIPERU, {
      ...base,
      fetchFn: fn,
    });

    expect(outcome).toEqual({
      kind: 'found',
      person: { fullName: 'JUAN PEREZ GOMEZ', dni: '12345678' },
    });
    expect(calls[0].url).toBe('https://proveedor.test/dni');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      dni: '12345678',
    });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer TOKEN-SECRETO');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it.each([
    [404, 'not_found'],
    [401, 'unauthorized'],
    [429, 'limit'],
    [500, 'unavailable'],
  ])('traduce el HTTP %i como %s', async (status, kind) => {
    const { fn } = fakeFetch(() => json({ success: false }, status));
    await expect(
      lookupDni(DniProvider.APIPERU, { ...base, fetchFn: fn }),
    ).resolves.toEqual({ kind });
  });

  it('un contrato inválido (success=false o sin nombre) es "no disponible"', async () => {
    for (const body of [{ success: false }, { success: true, data: {} }]) {
      const { fn } = fakeFetch(() => json(body));
      await expect(
        lookupDni(DniProvider.APIPERU, { ...base, fetchFn: fn }),
      ).resolves.toEqual({ kind: 'unavailable' });
    }
  });
});

describe('lookupDni · fallas de red', () => {
  it('una excepción de red es "no disponible" y no filtra el token', async () => {
    const { fn } = fakeFetch(() =>
      Promise.reject(new Error('ECONNRESET TOKEN-SECRETO')),
    );
    const outcome = await lookupDni(DniProvider.DECOLECTA, {
      ...base,
      fetchFn: fn,
    });
    expect(outcome).toEqual({ kind: 'unavailable' });
    expect(JSON.stringify(outcome)).not.toContain('TOKEN-SECRETO');
  });

  it('corta la consulta cuando se agota el tiempo', async () => {
    const { fn } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new Error('abortado')),
          );
        }),
    );
    await expect(
      lookupDni(DniProvider.APIPERU, { ...base, fetchFn: fn, timeoutMs: 20 }),
    ).resolves.toEqual({ kind: 'unavailable' });
  });
});
