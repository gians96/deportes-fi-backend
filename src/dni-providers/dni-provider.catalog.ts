import { DniProvider } from '@prisma/client';

export interface DniProviderInfo {
  provider: DniProvider;
  label: string;
  /** URL oficial; el administrador puede reemplazarla desde la plataforma. */
  defaultUrl: string;
  /** Menor = se consulta primero. */
  defaultPriority: number;
}

export const DNI_PROVIDER_CATALOG: DniProviderInfo[] = [
  {
    provider: DniProvider.DECOLECTA,
    label: 'Decolecta (RENIEC)',
    defaultUrl: 'https://api.decolecta.com/v1/reniec/dni',
    defaultPriority: 0,
  },
  {
    provider: DniProvider.APIPERU,
    label: 'API Perú',
    defaultUrl: 'https://api.apiperu.dev/dni',
    defaultPriority: 1,
  },
];
