import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Prefijo fijo de los tokens de integración de deportes-fi. */
export const API_TOKEN_PREFIX = 'dfi_';

/** Bytes aleatorios del token (256 bits de entropía). */
export const API_TOKEN_RANDOM_BYTES = 32;

/** Caracteres iniciales que se guardan como prefijo visible: `dfi_` + 8. */
export const API_TOKEN_DISPLAY_PREFIX_LENGTH = 12;

/** `dfi_` + base64url sin relleno de 32 bytes (43 caracteres). */
const API_TOKEN_PATTERN = /^dfi_[A-Za-z0-9_-]{43}$/;

export type EventApiTokenStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

export interface GeneratedApiToken {
  /** Valor en claro: se entrega una sola vez y nunca se persiste. */
  token: string;
  /** Prefijo visible (no secreto) para identificar el token. */
  tokenPrefix: string;
}

export type PepperResolution =
  | { source: 'env' | 'derived'; pepper: string }
  | { source: 'missing'; pepper: null };

export function generateApiToken(): GeneratedApiToken {
  const token =
    API_TOKEN_PREFIX +
    randomBytes(API_TOKEN_RANDOM_BYTES).toString('base64url');
  return {
    token,
    tokenPrefix: token.slice(0, API_TOKEN_DISPLAY_PREFIX_LENGTH),
  };
}

/** Valida el formato antes de tocar la base de datos. */
export function isWellFormedApiToken(value: unknown): value is string {
  return typeof value === 'string' && API_TOKEN_PATTERN.test(value);
}

/** HMAC-SHA256 del token con el pepper, en hexadecimal (64 caracteres). */
export function hashApiToken(token: string, pepper: string): string {
  return createHmac('sha256', pepper).update(token, 'utf8').digest('hex');
}

/** Comparación en tiempo constante de dos hashes hexadecimales. */
export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return (
    left.length > 0 &&
    left.length === right.length &&
    timingSafeEqual(left, right)
  );
}

/** Verifica un token en claro contra un hash almacenado. */
export function verifyApiToken(
  token: string,
  storedHash: string,
  pepper: string,
): boolean {
  return hashesMatch(hashApiToken(token, pepper), storedHash);
}

/**
 * Estado derivado de un token. `REVOKED` prevalece sobre `EXPIRED`; solo un
 * token `ACTIVE` autentica.
 */
export function eventApiTokenStatus(
  token: { revokedAt: Date | null; expiresAt: Date | null },
  now: Date = new Date(),
): EventApiTokenStatus {
  if (token.revokedAt) return 'REVOKED';
  if (token.expiresAt && token.expiresAt.getTime() <= now.getTime()) {
    return 'EXPIRED';
  }
  return 'ACTIVE';
}

/**
 * Resuelve el pepper del HMAC:
 * - `API_TOKEN_PEPPER` si está definido;
 * - en producción sin él: `missing` (los tokens quedan deshabilitados);
 * - fuera de producción: derivado de `JWT_SECRET` (solo desarrollo/pruebas).
 */
export function resolveApiTokenPepper(env: {
  pepper?: string;
  jwtSecret?: string;
  nodeEnv?: string;
}): PepperResolution {
  const pepper = env.pepper?.trim();
  if (pepper) {
    return { pepper, source: 'env' };
  }
  if (env.nodeEnv === 'production') {
    return { pepper: null, source: 'missing' };
  }
  const derived = createHash('sha256')
    .update(`deportes-fi:api-token-pepper:${env.jwtSecret ?? 'change-me'}`)
    .digest('hex');
  return { pepper: derived, source: 'derived' };
}
