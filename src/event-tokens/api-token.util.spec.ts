import { createHmac } from 'node:crypto';
import {
  API_TOKEN_DISPLAY_PREFIX_LENGTH,
  eventApiTokenStatus,
  generateApiToken,
  hashApiToken,
  hashesMatch,
  isWellFormedApiToken,
  resolveApiTokenPepper,
  verifyApiToken,
} from './api-token.util';

describe('api-token.util', () => {
  const pepper = 'pepper-de-prueba-0123456789abcdef0123';

  describe('generateApiToken', () => {
    it('genera dfi_ + base64url de 32 bytes (43 caracteres)', () => {
      const { token } = generateApiToken();

      expect(token).toMatch(/^dfi_[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token.slice(4), 'base64url')).toHaveLength(32);
      expect(isWellFormedApiToken(token)).toBe(true);
    });

    it('usa como prefijo visible los primeros 12 caracteres', () => {
      const { token, tokenPrefix } = generateApiToken();

      expect(tokenPrefix).toHaveLength(API_TOKEN_DISPLAY_PREFIX_LENGTH);
      expect(token.startsWith(tokenPrefix)).toBe(true);
      expect(tokenPrefix.startsWith('dfi_')).toBe(true);
    });

    it('no repite tokens', () => {
      const tokens = new Set(
        Array.from({ length: 500 }, () => generateApiToken().token),
      );
      expect(tokens.size).toBe(500);
    });
  });

  describe('isWellFormedApiToken', () => {
    it.each([
      undefined,
      null,
      42,
      ['dfi_' + 'a'.repeat(43)],
      '',
      'dfi_',
      'dfi_' + 'a'.repeat(42),
      'dfi_' + 'a'.repeat(44),
      'xyz_' + 'a'.repeat(43),
      'DFI_' + 'a'.repeat(43),
      'dfi_' + 'a'.repeat(42) + '=',
      'dfi_' + 'a'.repeat(42) + '/',
      ' dfi_' + 'a'.repeat(43),
    ])('rechaza %p', (value) => {
      expect(isWellFormedApiToken(value)).toBe(false);
    });
  });

  describe('hashApiToken / verifyApiToken', () => {
    it('es HMAC-SHA256 en hexadecimal con el pepper', () => {
      const { token } = generateApiToken();
      const expected = createHmac('sha256', pepper).update(token).digest('hex');

      expect(hashApiToken(token, pepper)).toBe(expected);
      expect(hashApiToken(token, pepper)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('es determinista y depende del pepper', () => {
      const { token } = generateApiToken();

      expect(hashApiToken(token, pepper)).toBe(hashApiToken(token, pepper));
      expect(hashApiToken(token, pepper)).not.toBe(
        hashApiToken(token, `${pepper}-otro`),
      );
    });

    it('el hash no contiene el token en claro', () => {
      const { token } = generateApiToken();
      expect(hashApiToken(token, pepper)).not.toContain(token.slice(4, 16));
    });

    it('verifica el token correcto y rechaza otro token o pepper', () => {
      const { token } = generateApiToken();
      const stored = hashApiToken(token, pepper);

      expect(verifyApiToken(token, stored, pepper)).toBe(true);
      expect(verifyApiToken(generateApiToken().token, stored, pepper)).toBe(
        false,
      );
      expect(verifyApiToken(token, stored, 'pepper-incorrecto')).toBe(false);
    });

    it('hashesMatch no acepta vacíos ni longitudes distintas', () => {
      const hash = hashApiToken(generateApiToken().token, pepper);

      expect(hashesMatch(hash, hash)).toBe(true);
      expect(hashesMatch('', '')).toBe(false);
      expect(hashesMatch(hash, hash.slice(0, 62))).toBe(false);
    });
  });

  describe('eventApiTokenStatus', () => {
    const now = new Date('2026-10-01T12:00:00.000Z');

    it('ACTIVE sin revocación ni expiración vencida', () => {
      expect(
        eventApiTokenStatus({ revokedAt: null, expiresAt: null }, now),
      ).toBe('ACTIVE');
      expect(
        eventApiTokenStatus(
          { revokedAt: null, expiresAt: new Date('2026-10-02T00:00:00Z') },
          now,
        ),
      ).toBe('ACTIVE');
    });

    it('EXPIRED cuando expiresAt ya pasó (incluido el instante exacto)', () => {
      expect(
        eventApiTokenStatus({ revokedAt: null, expiresAt: now }, now),
      ).toBe('EXPIRED');
    });

    it('REVOKED prevalece sobre EXPIRED', () => {
      expect(
        eventApiTokenStatus(
          { revokedAt: now, expiresAt: new Date('2020-01-01T00:00:00Z') },
          now,
        ),
      ).toBe('REVOKED');
    });
  });

  describe('resolveApiTokenPepper', () => {
    it('usa API_TOKEN_PEPPER cuando existe', () => {
      expect(
        resolveApiTokenPepper({ pepper: ` ${pepper} `, nodeEnv: 'production' }),
      ).toEqual({ pepper, source: 'env' });
    });

    it('en producción sin pepper queda deshabilitado (sin derivar de JWT_SECRET)', () => {
      expect(
        resolveApiTokenPepper({ jwtSecret: 'jwt', nodeEnv: 'production' }),
      ).toEqual({ pepper: null, source: 'missing' });
      expect(
        resolveApiTokenPepper({ pepper: '   ', nodeEnv: 'production' }),
      ).toEqual({ pepper: null, source: 'missing' });
    });

    it('fuera de producción deriva un pepper estable de JWT_SECRET', () => {
      const first = resolveApiTokenPepper({
        jwtSecret: 'jwt-a',
        nodeEnv: 'test',
      });
      const again = resolveApiTokenPepper({ jwtSecret: 'jwt-a' });
      const other = resolveApiTokenPepper({ jwtSecret: 'jwt-b' });

      expect(first.source).toBe('derived');
      expect(first.pepper).toMatch(/^[0-9a-f]{64}$/);
      expect(first.pepper).not.toContain('jwt-a');
      expect(again.pepper).toBe(first.pepper);
      expect(other.pepper).not.toBe(first.pepper);
    });
  });
});
