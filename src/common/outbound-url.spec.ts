import { BadRequestException } from '@nestjs/common';
import {
  assertPublicDestination,
  isInternalAddress,
  validateOutboundUrl,
} from './outbound-url';

const prod = { production: true };
const dev = { production: false };

describe('validateOutboundUrl', () => {
  it('acepta https público y quita la barra final', () => {
    expect(validateOutboundUrl('https://api-jp.episundc.pe/', prod)).toBe(
      'https://api-jp.episundc.pe',
    );
    expect(validateOutboundUrl(' https://api-jp.episundc.pe ', dev)).toBe(
      'https://api-jp.episundc.pe',
    );
  });

  it('rechaza lo que no es una URL, con usuario o contraseña, o sin https', () => {
    for (const bad of ['', 'api-jp', 'ftp://host.pe', 'https://u:p@host.pe']) {
      expect(() => validateOutboundUrl(bad, prod)).toThrow(BadRequestException);
    }
    expect(() =>
      validateOutboundUrl('http://api-jp.episundc.pe', prod),
    ).toThrow(/https/);
    expect(() => validateOutboundUrl('http://api-jp.episundc.pe', dev)).toThrow(
      /https/,
    );
  });

  it('http solo hacia localhost y fuera de producción', () => {
    expect(validateOutboundUrl('http://127.0.0.1:3020', dev)).toBe(
      'http://127.0.0.1:3020',
    );
    expect(validateOutboundUrl('http://localhost:3020/', dev)).toBe(
      'http://localhost:3020',
    );
    expect(() => validateOutboundUrl('http://127.0.0.1:3020', prod)).toThrow(
      /https/,
    );
  });

  it('en producción rechaza destinos internos', () => {
    for (const bad of [
      'https://localhost',
      'https://intranet.local',
      'https://db.internal',
      'https://10.0.0.5',
      'https://192.168.1.10',
      'https://172.16.0.1',
      'https://169.254.169.254',
      'https://100.64.0.1',
      'https://[::1]',
      'https://[fe80::1]',
      'https://[::ffff:127.0.0.1]',
    ]) {
      expect(() => validateOutboundUrl(bad, prod)).toThrow(/interna/);
    }
  });

  it('fuera de producción deja usar direcciones internas con https (pruebas)', () => {
    expect(validateOutboundUrl('https://10.0.0.5', dev)).toBe(
      'https://10.0.0.5',
    );
  });
});

describe('assertPublicDestination', () => {
  const resolver = (addresses: string[]) =>
    jest.fn().mockResolvedValue(addresses.map((address) => ({ address })));

  it('no hace nada fuera de producción', async () => {
    const dns = resolver(['10.0.0.1']);
    await expect(
      assertPublicDestination('https://x.pe', { ...dev, resolver: dns }),
    ).resolves.toBeUndefined();
    expect(dns).not.toHaveBeenCalled();
  });

  it('en producción acepta hosts que resuelven solo a direcciones públicas', async () => {
    await expect(
      assertPublicDestination('https://api-jp.episundc.pe', {
        ...prod,
        resolver: resolver(['190.12.3.4']),
      }),
    ).resolves.toBeUndefined();
  });

  it('rechaza un nombre público que resuelve a una dirección interna (DNS rebinding)', async () => {
    await expect(
      assertPublicDestination('https://evil.example', {
        ...prod,
        resolver: resolver(['190.12.3.4', '127.0.0.1']),
      }),
    ).rejects.toThrow(/interna/);
  });

  it('rechaza lo que no resuelve y las IP literales internas', async () => {
    await expect(
      assertPublicDestination('https://nada.example', {
        ...prod,
        resolver: jest.fn().mockRejectedValue(new Error('ENOTFOUND')),
      }),
    ).rejects.toThrow(/No se pudo resolver/);
    await expect(
      assertPublicDestination('https://10.1.2.3', prod),
    ).rejects.toThrow(/interna/);
  });
});

describe('isInternalAddress', () => {
  it('distingue públicas de internas', () => {
    expect(isInternalAddress('8.8.8.8')).toBe(false);
    expect(isInternalAddress('127.0.0.1')).toBe(true);
    expect(isInternalAddress('2606:4700:4700::1111')).toBe(false);
    expect(isInternalAddress('fc00::1')).toBe(true);
    expect(isInternalAddress('no-es-ip')).toBe(false);
  });
});
