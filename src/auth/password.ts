import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** Largo permitido de una contraseña (se valida en el DTO y aquí, como defensa en profundidad). */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export interface ScryptParams {
  /** Costo de CPU/memoria (potencia de 2). */
  N: number;
  r: number;
  p: number;
}

/** Parámetros vigentes: ~100 ms y 32 MiB por verificación. */
export const CURRENT_SCRYPT_PARAMS: ScryptParams = { N: 32768, r: 8, p: 1 };

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const PREFIX = 'scrypt';
/** Holgura sobre 128·N·r para que `scrypt` no rechace parámetros válidos. */
const MAX_MEMORY = 128 * 1024 * 1024;
/** Cota a los parámetros leídos de la base, para que un valor alterado no agote el servidor. */
const MAX_N = 1 << 20;

function deriveKey(
  password: string,
  salt: Buffer,
  params: ScryptParams,
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      keyLength,
      { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** `scrypt$N$r$p$sal$hash` (sal y hash en base64). */
export async function hashPassword(
  password: string,
  params: ScryptParams = CURRENT_SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(password, salt, params, KEY_LENGTH);
  return [
    PREFIX,
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const validN =
    Number.isInteger(N) && N >= 2 && N <= MAX_N && (N & (N - 1)) === 0;
  if (!validN || !Number.isInteger(r) || r < 1 || r > 32) return null;
  if (!Number.isInteger(p) || p < 1 || p > 16) return null;
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const key = Buffer.from(parts[5] ?? '', 'base64');
  if (!salt.length || !key.length) return null;
  return { params: { N, r, p }, salt, key };
}

/** Compara en tiempo constante; un hash ilegible o con parámetros fuera de rango nunca coincide. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const key = await deriveKey(
    password,
    parsed.salt,
    parsed.params,
    parsed.key.length,
  );
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

/** El hash se guardó con parámetros más débiles que los vigentes: conviene recalcularlo al entrar. */
export function needsRehash(stored: string): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const current = CURRENT_SCRYPT_PARAMS;
  return (
    parsed.params.N < current.N ||
    parsed.params.r < current.r ||
    parsed.params.p < current.p
  );
}

let dummyHash: Promise<string> | null = null;

/**
 * Hace el mismo trabajo que una verificación real cuando la cuenta no existe o no tiene contraseña,
 * para que el tiempo de respuesta no revele si el correo está registrado. Siempre devuelve `false`.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(32).toString('hex'));
  await verifyPassword(password, await dummyHash);
  return false;
}
