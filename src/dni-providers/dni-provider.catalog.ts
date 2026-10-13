import { DniProvider } from '@prisma/client';

export interface DniProviderInfo {
  provider: DniProvider;
  label: string;
  /** URL oficial; cada token puede reemplazarla (p. ej. un proxy o un entorno de pruebas). */
  defaultUrl: string;
  /** Dónde se genera el token, para la ayuda de la pantalla. */
  tokenHelpUrl: string;
}

/**
 * Proveedores que el sistema sabe consultar. Para sumar uno nuevo: un valor en el enum `DniProvider`,
 * su entrada aquí y su cliente en `dni-lookup.ts` (con pruebas).
 */
export const DNI_PROVIDER_CATALOG: DniProviderInfo[] = [
  {
    provider: DniProvider.DECOLECTA,
    label: 'Decolecta (RENIEC)',
    defaultUrl: 'https://api.decolecta.com/v1/reniec/dni',
    tokenHelpUrl: 'https://decolecta.com/profile',
  },
  {
    provider: DniProvider.APIPERU,
    label: 'API Perú',
    defaultUrl: 'https://api.apiperu.dev/dni',
    tokenHelpUrl: 'https://apiperu.dev',
  },
];

export function providerInfo(provider: DniProvider): DniProviderInfo {
  const info = DNI_PROVIDER_CATALOG.find((item) => item.provider === provider);
  if (!info) throw new Error(`Proveedor de DNI desconocido: ${provider}`);
  return info;
}
