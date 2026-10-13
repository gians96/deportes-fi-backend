import { BadRequestException } from '@nestjs/common';
import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Validación de URLs salientes que configura un administrador (API_UNDC): evita SSRF sin necesitar una
 * lista de hosts permitidos. Mismo criterio que `backend-ciisic/src/core/url-saliente.ts`.
 * - Solo https (http únicamente hacia localhost fuera de producción, para pruebas locales).
 * - En producción se rechazan destinos internos: IP privadas, loopback, link-local, CGNAT, multicast y
 *   nombres como `localhost`, `*.local` o `*.internal`, tanto literales como resueltos por DNS antes de
 *   cada llamada.
 */
const BLOCKED = new net.BlockList();
const V4_NETWORKS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
// Las IPv6 con IPv4 incrustada (::ffff:a.b.c.d) ya se comparan con las reglas IPv4 de BlockList.
const V6_NETWORKS: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];
for (const [network, prefix] of V4_NETWORKS) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of V6_NETWORKS) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

const INTERNAL_NAMES = /^(localhost|.+\.localhost|.+\.local|.+\.internal)$/i;

export interface OutboundUrlOptions {
  /** Por defecto `NODE_ENV === 'production'`; las pruebas lo fijan explícitamente. */
  production?: boolean;
  field?: string;
}

function isProduction(options: OutboundUrlOptions): boolean {
  return options.production ?? process.env.NODE_ENV === 'production';
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

export function isInternalAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return BLOCKED.check(ip, 'ipv4');
  if (kind === 6) return BLOCKED.check(ip, 'ipv6');
  return false;
}

/** Valida la URL y la devuelve sin `/` final; lanza 400 si no es válida o apunta a un destino interno. */
export function validateOutboundUrl(
  value: string,
  options: OutboundUrlOptions = {},
): string {
  const field = options.field ?? 'La URL';
  let url: URL;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new BadRequestException(`${field} no es válida.`);
  }
  if (url.username || url.password) {
    throw new BadRequestException(
      `${field} no debe incluir usuario ni contraseña.`,
    );
  }
  const host = hostOf(url);
  const production = isProduction(options);
  const isLocal =
    host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLocal && !production)
  ) {
    throw new BadRequestException(`${field} debe usar https.`);
  }
  if (production && (INTERNAL_NAMES.test(host) || isInternalAddress(host))) {
    throw new BadRequestException(`${field} apunta a una dirección interna.`);
  }
  return url.toString().replace(/\/+$/, '');
}

type Resolver = (host: string) => Promise<Array<{ address: string }>>;
const defaultResolver: Resolver = (host) => dns.lookup(host, { all: true });

/** En producción, comprueba justo antes de llamar que el host resuelva solo a direcciones públicas. */
export async function assertPublicDestination(
  value: string,
  options: OutboundUrlOptions & { resolver?: Resolver } = {},
): Promise<void> {
  if (!isProduction(options)) return;
  const host = hostOf(new URL(value));
  if (net.isIP(host)) {
    if (isInternalAddress(host)) {
      throw new BadRequestException('La URL apunta a una dirección interna.');
    }
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await (options.resolver ?? defaultResolver)(host);
  } catch {
    throw new BadRequestException(`No se pudo resolver ${host}.`);
  }
  if (
    !addresses.length ||
    addresses.some((entry) => isInternalAddress(entry.address))
  ) {
    throw new BadRequestException('La URL apunta a una dirección interna.');
  }
}
