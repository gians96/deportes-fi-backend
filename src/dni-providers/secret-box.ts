import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/**
 * Clave de cifrado de 32 bytes, en base64 o en 64 caracteres hexadecimales. Devuelve `null` si
 * falta o no tiene el formato correcto: sin una clave válida no se guarda ningún secreto.
 */
export function parseSecretKey(raw: string | undefined | null): Buffer | null {
  const value = (raw ?? '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }
  if (/^[A-Za-z0-9+/]{43}=?$/.test(value)) {
    return Buffer.from(value, 'base64');
  }
  return null;
}

/**
 * Clave de cifrado derivada de un secreto que el servidor ya tiene (p. ej. `JWT_SECRET`) con HKDF.
 * Permite guardar tokens en la base sin configurar nada más; una clave dedicada es preferible.
 */
export function deriveSecretKey(
  secret: string | undefined | null,
): Buffer | null {
  const value = (secret ?? '').trim();
  if (value.length < 16) return null;
  return Buffer.from(
    hkdfSync('sha256', value, 'deportes-fi', 'dni-providers-v1', 32),
  );
}

export function encryptSecret(plain: string, key: Buffer): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

/** Descifra y verifica la integridad; lanza un error si la clave o los datos no coinciden. */
export function decryptSecret(secret: EncryptedSecret, key: Buffer): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(secret.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(secret.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
