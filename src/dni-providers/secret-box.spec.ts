import { randomBytes } from 'node:crypto';
import {
  decryptSecret,
  deriveSecretKey,
  encryptSecret,
  parseSecretKey,
} from './secret-box';

const key = randomBytes(32);

describe('parseSecretKey', () => {
  it('acepta 32 bytes en base64 y en hexadecimal', () => {
    expect(parseSecretKey(key.toString('base64'))?.equals(key)).toBe(true);
    expect(parseSecretKey(key.toString('hex'))?.equals(key)).toBe(true);
    expect(parseSecretKey(`  ${key.toString('hex')}\n`)?.equals(key)).toBe(
      true,
    );
  });

  it.each([
    undefined,
    null,
    '',
    '   ',
    'demasiado-corta',
    randomBytes(16).toString('base64'),
    randomBytes(16).toString('hex'),
    randomBytes(33).toString('base64'),
    `${'z'.repeat(64)}`,
  ])('rechaza la clave %j', (value) => {
    expect(parseSecretKey(value)).toBeNull();
  });
});

describe('deriveSecretKey', () => {
  it('deriva siempre la misma clave de 32 bytes a partir del mismo secreto', () => {
    const a = deriveSecretKey('un-secreto-del-servidor-0123456789');
    const b = deriveSecretKey('un-secreto-del-servidor-0123456789');
    expect(a).toHaveLength(32);
    expect(a?.equals(b as Buffer)).toBe(true);
  });

  it('secretos distintos dan claves distintas y no coincide con el propio secreto', () => {
    const a = deriveSecretKey('un-secreto-del-servidor-0123456789');
    const b = deriveSecretKey('otro-secreto-del-servidor-0123456789');
    expect(a?.equals(b as Buffer)).toBe(false);
    expect(a?.toString('utf8')).not.toContain('un-secreto');
  });

  it('la clave derivada sirve para cifrar y descifrar', () => {
    const derived = deriveSecretKey(
      'un-secreto-del-servidor-0123456789',
    ) as Buffer;
    expect(decryptSecret(encryptSecret('token-123456', derived), derived)).toBe(
      'token-123456',
    );
  });

  it.each([undefined, null, '', '   ', 'corto', 'quince-chars!!!'])(
    'rechaza un secreto ausente o demasiado corto (%j)',
    (secret) => {
      expect(deriveSecretKey(secret)).toBeNull();
    },
  );
});

describe('encryptSecret / decryptSecret', () => {
  it('recupera el texto original', () => {
    const encrypted = encryptSecret('token-secreto-123', key);
    expect(decryptSecret(encrypted, key)).toBe('token-secreto-123');
  });

  it('no deja el texto en claro y usa un IV distinto en cada cifrado', () => {
    const a = encryptSecret('token-secreto-123', key);
    const b = encryptSecret('token-secreto-123', key);
    expect(JSON.stringify(a)).not.toContain('token-secreto-123');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('conserva tildes y símbolos', () => {
    expect(decryptSecret(encryptSecret('clave-ñandú-€-$$', key), key)).toBe(
      'clave-ñandú-€-$$',
    );
  });

  it('detecta una clave equivocada', () => {
    const encrypted = encryptSecret('token-secreto-123', key);
    expect(() => decryptSecret(encrypted, randomBytes(32))).toThrow();
  });

  it('detecta datos alterados', () => {
    const encrypted = encryptSecret('token-secreto-123', key);
    const tampered = Buffer.from(encrypted.ciphertext, 'base64');
    tampered[0] = tampered[0] ^ 0xff;
    expect(() =>
      decryptSecret(
        { ...encrypted, ciphertext: tampered.toString('base64') },
        key,
      ),
    ).toThrow();
    expect(() =>
      decryptSecret(
        { ...encrypted, authTag: randomBytes(16).toString('base64') },
        key,
      ),
    ).toThrow();
  });
});
