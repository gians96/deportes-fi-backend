import { DniProvider } from '@prisma/client';

export interface LookedUpPerson {
  fullName: string;
  dni: string;
}

/**
 * Resultado de consultar un DNI a un proveedor con un token. Solo `not_found` dice algo del DNI; el resto
 * habla del token o del proveedor y permite probar el siguiente.
 */
export type LookupOutcome =
  | { kind: 'found'; person: LookedUpPerson }
  | { kind: 'not_found' }
  /** 401/403: token inválido, ausente o sin permisos. */
  | { kind: 'unauthorized' }
  /** 429/402: el proveedor dice que el cupo del token se agotó. */
  | { kind: 'limit' }
  /** 5xx, red caída, tiempo agotado o respuesta con un contrato inesperado. */
  | { kind: 'unavailable' };

export interface LookupResponse {
  outcome: LookupOutcome;
  /** Código HTTP del proveedor; `null` si no hubo respuesta (red caída, tiempo agotado). */
  httpStatus: number | null;
}

export interface LookupRequest {
  url: string;
  token: string;
  dni: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function classifyFailure(status: number): LookupOutcome {
  if (status === 404) return { kind: 'not_found' };
  if (status === 401 || status === 403) return { kind: 'unauthorized' };
  if (status === 429 || status === 402) return { kind: 'limit' };
  return { kind: 'unavailable' };
}

function cleanName(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

interface DecolectaPerson {
  first_name?: string;
  first_last_name?: string;
  second_last_name?: string;
  full_name?: string;
  document_number?: string;
}

interface ApiPeruResponse {
  success?: boolean;
  data?: { numero?: string; nombre_completo?: string };
}

async function lookupDecolecta(
  request: LookupRequest,
  response: Response,
): Promise<LookupOutcome> {
  const data = (await response.json()) as DecolectaPerson;
  const fullName = cleanName(
    data.full_name ??
      [data.first_last_name, data.second_last_name, data.first_name]
        .filter(Boolean)
        .join(' '),
  );
  if (!fullName) return { kind: 'unavailable' };
  return {
    kind: 'found',
    person: { fullName, dni: data.document_number ?? request.dni },
  };
}

async function lookupApiPeru(
  request: LookupRequest,
  response: Response,
): Promise<LookupOutcome> {
  const data = (await response.json()) as ApiPeruResponse;
  const fullName = cleanName(data.data?.nombre_completo ?? '');
  if (!data.success || !fullName) return { kind: 'unavailable' };
  return {
    kind: 'found',
    person: { fullName, dni: data.data?.numero ?? request.dni },
  };
}

/**
 * Consulta un DNI a un proveedor, clasifica la respuesta y devuelve también el código HTTP. Nunca lanza
 * ni registra el token.
 */
export async function lookupDniDetailed(
  provider: DniProvider,
  request: LookupRequest,
): Promise<LookupResponse> {
  const fetchFn = request.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const headers = {
      Authorization: `Bearer ${request.token}`,
      Accept: 'application/json',
    };
    const response =
      provider === DniProvider.APIPERU
        ? await fetchFn(request.url, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ dni: request.dni }),
            signal: controller.signal,
          })
        : await fetchFn(
            `${request.url}?numero=${encodeURIComponent(request.dni)}`,
            { method: 'GET', headers, signal: controller.signal },
          );

    if (!response.ok) {
      return {
        outcome: classifyFailure(response.status),
        httpStatus: response.status,
      };
    }
    const outcome =
      provider === DniProvider.APIPERU
        ? await lookupApiPeru(request, response)
        : await lookupDecolecta(request, response);
    return { outcome, httpStatus: response.status };
  } catch {
    return { outcome: { kind: 'unavailable' }, httpStatus: null };
  } finally {
    clearTimeout(timeout);
  }
}

/** Igual que `lookupDniDetailed`, solo con la clasificación. */
export async function lookupDni(
  provider: DniProvider,
  request: LookupRequest,
): Promise<LookupOutcome> {
  return (await lookupDniDetailed(provider, request)).outcome;
}
