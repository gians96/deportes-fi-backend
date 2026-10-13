import {
  CURRENT_SCRYPT_PARAMS,
  hashPassword,
  needsRehash,
  verifyAgainstDummy,
  verifyPassword,
} from './password';

/** Parámetros baratos: solo para pruebas que no verifican el costo real. */
const CHEAP = { N: 1024, r: 8, p: 1 };

describe('password', () => {
  it('genera un hash con el formato scrypt$N$r$p$sal$hash y sin la contraseña en claro', async () => {
    const hash = await hashPassword('Clave-de-prueba-1', CHEAP);
    const parts = hash.split('$');
    expect(parts).toHaveLength(6);
    expect(parts.slice(0, 4)).toEqual(['scrypt', '1024', '8', '1']);
    expect(hash).not.toContain('Clave-de-prueba-1');
  });

  it('usa una sal distinta cada vez', async () => {
    const [a, b] = await Promise.all([
      hashPassword('misma-clave-123', CHEAP),
      hashPassword('misma-clave-123', CHEAP),
    ]);
    expect(a).not.toBe(b);
  });

  it('verifica la contraseña correcta y rechaza una incorrecta', async () => {
    const hash = await hashPassword('Clave-de-prueba-1', CHEAP);
    await expect(verifyPassword('Clave-de-prueba-1', hash)).resolves.toBe(true);
    await expect(verifyPassword('Clave-de-prueba-2', hash)).resolves.toBe(
      false,
    );
    await expect(verifyPassword('', hash)).resolves.toBe(false);
  });

  it('normaliza Unicode: la misma contraseña escrita compuesta o descompuesta coincide', async () => {
    const hash = await hashPassword('contraseña-ñandú', CHEAP);
    await expect(
      verifyPassword('contraseña-ñandú'.normalize('NFD'), hash),
    ).resolves.toBe(true);
  });

  it('usa los parámetros vigentes por defecto (y no pide recalcularlos)', async () => {
    const hash = await hashPassword('Clave-de-prueba-1');
    expect(hash.startsWith(`scrypt$${CURRENT_SCRYPT_PARAMS.N}$`)).toBe(true);
    expect(needsRehash(hash)).toBe(false);
    await expect(verifyPassword('Clave-de-prueba-1', hash)).resolves.toBe(true);
  });

  it('pide recalcular un hash guardado con parámetros más débiles', async () => {
    expect(needsRehash(await hashPassword('Clave-de-prueba-1', CHEAP))).toBe(
      true,
    );
  });

  it('un hash ilegible o con parámetros fuera de rango nunca coincide ni agota el servidor', async () => {
    for (const bad of [
      '',
      'texto-cualquiera',
      'bcrypt$10$a$b$c$d',
      'scrypt$1024$8$1$AAAA',
      'scrypt$1000$8$1$AAAA$BBBB', // N no es potencia de 2
      `scrypt$${2 ** 30}$8$1$AAAA$BBBB`, // N desmesurado
      'scrypt$1024$8$1$$BBBB',
    ]) {
      await expect(verifyPassword('lo-que-sea-123', bad)).resolves.toBe(false);
      expect(needsRehash(bad)).toBe(false);
    }
  });

  it('verifyAgainstDummy hace el trabajo de una verificación y siempre devuelve false', async () => {
    await expect(verifyAgainstDummy('cualquier-clave-1')).resolves.toBe(false);
    await expect(verifyAgainstDummy('otra-clave-123')).resolves.toBe(false);
  });
});
