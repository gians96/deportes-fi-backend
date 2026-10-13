import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialState, DniProvider, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DNI_PROVIDER_CATALOG, DniProviderInfo } from './dni-provider.catalog';
import { UpdateDniProviderDto } from './dto/dni-provider.dto';
import { LookupOutcome, lookupDni } from './dni-lookup';
import {
  decryptSecret,
  deriveSecretKey,
  encryptSecret,
  parseSecretKey,
} from './secret-box';

/**
 * Origen de la clave que cifra los tokens: `dedicated` (INTEGRATION_SECRET_KEY), `derived` (a partir
 * de JWT_SECRET, que el servidor ya tiene) o `none` (no se puede guardar ningún token).
 */
export type EncryptionKeySource = 'dedicated' | 'derived' | 'none';

export interface DniProviderView {
  provider: DniProvider;
  label: string;
  enabled: boolean;
  priority: number;
  /** URL efectiva que se consulta y la oficial por defecto. */
  apiUrl: string;
  defaultUrl: string;
  customUrl: boolean;
  /** Hay un token guardado en la plataforma. */
  configured: boolean;
  /** Solo los últimos 4 caracteres del token guardado. */
  tokenMask: string | null;
  state: CredentialState;
  lastError: string | null;
  lastCheckedAt: Date | null;
}

/** Proveedor listo para consultar: token ya descifrado y URL efectiva. */
export interface ResolvedDniProvider {
  provider: DniProvider;
  token: string;
  url: string;
  priority: number;
}

export interface DniProviderTestResult {
  ok: boolean;
  result: LookupOutcome['kind'];
  message: string;
}

const MIN_TOKEN_LENGTH = 8;

const TEST_MESSAGES: Record<LookupOutcome['kind'], string> = {
  found: 'El proveedor respondió correctamente.',
  not_found: 'El proveedor funciona, pero no encontró ese DNI.',
  unauthorized:
    'El proveedor rechazó el token: es inválido o se agotó el límite de consultas.',
  limit: 'Se alcanzó el límite de consultas del proveedor.',
  unavailable: 'El proveedor no respondió correctamente.',
};

type ProviderRow = Prisma.DniProviderConfigGetPayload<object>;

/** Campos editables de una fila (sin el proveedor, que es su clave). */
type ConfigFields = Partial<
  Omit<Prisma.DniProviderConfigUncheckedCreateInput, 'provider'>
>;

/**
 * Proveedores de consulta de DNI. Toda la configuración (token cifrado, URL, prioridad, activación)
 * vive en la base de datos y se lee en cada consulta, así que un cambio hecho desde la plataforma
 * se aplica de inmediato, sin reiniciar el servidor ni tocar variables de entorno.
 */
@Injectable()
export class DniProvidersService {
  private readonly logger = new Logger(DniProvidersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  encryptionKeySource(): EncryptionKeySource {
    return this.keyAndSource()?.source ?? 'none';
  }

  async list(): Promise<DniProviderView[]> {
    const rows = await this.prisma.dniProviderConfig.findMany();
    return DNI_PROVIDER_CATALOG.map((info) =>
      this.toView(
        info,
        rows.find((row) => row.provider === info.provider),
      ),
    ).sort((a, b) => a.priority - b.priority);
  }

  async update(
    providerName: string,
    dto: UpdateDniProviderDto,
    actorId: number,
  ): Promise<DniProviderView> {
    const info = this.infoOf(providerName);
    const fields: ConfigFields = { updatedById: actorId };
    if (dto.enabled !== undefined) fields.enabled = dto.enabled;
    if (dto.priority !== undefined) fields.priority = dto.priority;
    if (dto.apiUrl !== undefined) fields.apiUrl = this.normalizeUrl(dto.apiUrl);
    if (dto.token !== undefined) {
      Object.assign(fields, this.tokenFields(dto.token));
    }

    const row = await this.prisma.dniProviderConfig.upsert({
      where: { provider: info.provider },
      create: {
        provider: info.provider,
        enabled: true,
        priority: info.defaultPriority,
        ...fields,
      },
      update: fields,
    });
    return this.toView(info, row);
  }

  /** Proveedores activos con token, ordenados por prioridad: la cadena de consulta del DNI. */
  async resolveChain(): Promise<ResolvedDniProvider[]> {
    const rows = await this.prisma.dniProviderConfig.findMany();
    const chain: (ResolvedDniProvider & { order: number })[] = [];

    DNI_PROVIDER_CATALOG.forEach((info, order) => {
      const row = rows.find((item) => item.provider === info.provider);
      if (!row || !row.enabled) return;
      const token = this.decryptToken(info, row);
      if (!token) return;
      chain.push({
        provider: info.provider,
        token,
        url: row.apiUrl ?? info.defaultUrl,
        priority: row.priority,
        order,
      });
    });

    return chain
      .sort((a, b) => a.priority - b.priority || a.order - b.order)
      .map((item) => ({
        provider: item.provider,
        token: item.token,
        url: item.url,
        priority: item.priority,
      }));
  }

  /** Guarda el resultado de una consulta real; un fallo de la base nunca rompe la consulta. */
  async recordOutcome(
    provider: DniProvider,
    outcome: LookupOutcome,
  ): Promise<void> {
    const info = DNI_PROVIDER_CATALOG.find(
      (item) => item.provider === provider,
    );
    if (!info) return;
    const fields: ConfigFields = { lastCheckedAt: new Date() };
    switch (outcome.kind) {
      case 'found':
      case 'not_found':
        fields.state = CredentialState.VALID;
        fields.lastError = null;
        break;
      case 'unauthorized':
        fields.state = CredentialState.INVALID;
        fields.lastError = 'UNAUTHORIZED_OR_LIMIT';
        break;
      case 'limit':
        fields.lastError = 'RATE_LIMITED';
        break;
      default:
        fields.lastError = 'UNAVAILABLE';
    }
    try {
      await this.prisma.dniProviderConfig.upsert({
        where: { provider },
        create: {
          provider,
          enabled: true,
          priority: info.defaultPriority,
          ...fields,
        },
        update: fields,
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo guardar el estado de ${provider}: ${String(error)}`,
      );
    }
  }

  /** Prueba un proveedor con un DNI (aunque esté desactivado). No devuelve datos personales. */
  async test(
    providerName: string,
    dni: string,
  ): Promise<DniProviderTestResult> {
    const info = this.infoOf(providerName);
    const row = await this.prisma.dniProviderConfig.findUnique({
      where: { provider: info.provider },
    });
    const token = row ? this.decryptToken(info, row) : null;
    if (!row || !token) {
      throw new BadRequestException(
        'Este proveedor no tiene un token guardado en la plataforma.',
      );
    }
    const outcome = await lookupDni(info.provider, {
      url: row.apiUrl ?? info.defaultUrl,
      token,
      dni,
    });
    await this.recordOutcome(info.provider, outcome);
    return {
      ok: outcome.kind === 'found' || outcome.kind === 'not_found',
      result: outcome.kind,
      message: TEST_MESSAGES[outcome.kind],
    };
  }

  private keyAndSource(): { key: Buffer; source: EncryptionKeySource } | null {
    const dedicated = parseSecretKey(
      this.config.get<string>('INTEGRATION_SECRET_KEY'),
    );
    if (dedicated) return { key: dedicated, source: 'dedicated' };
    const derived = deriveSecretKey(this.config.get<string>('JWT_SECRET'));
    return derived ? { key: derived, source: 'derived' } : null;
  }

  private infoOf(providerName: string): DniProviderInfo {
    const info = DNI_PROVIDER_CATALOG.find(
      (item) => item.provider === providerName.toUpperCase(),
    );
    if (!info) {
      throw new NotFoundException('Proveedor de DNI no encontrado');
    }
    return info;
  }

  /** `null` = usar la URL oficial. Solo se aceptan direcciones http(s) válidas. */
  private normalizeUrl(raw: string | null): string | null {
    const value = (raw ?? '').trim();
    if (!value) return null;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new BadRequestException('La URL del proveedor no es válida.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new BadRequestException(
        'La URL del proveedor debe empezar con http:// o https://.',
      );
    }
    return value;
  }

  /** Campos de la fila para un token nuevo (cifrado) o para borrarlo. */
  private tokenFields(rawToken: string | null): ConfigFields {
    const cleared: ConfigFields = {
      tokenCipher: null,
      tokenIv: null,
      tokenTag: null,
      tokenLast4: null,
      state: CredentialState.UNVERIFIED,
      lastError: null,
      lastCheckedAt: null,
    };
    const token = (rawToken ?? '').trim().replace(/^bearer\s+/i, '');
    if (!token) return cleared;

    if (token.length < MIN_TOKEN_LENGTH) {
      throw new BadRequestException('El token es demasiado corto.');
    }
    const keyInfo = this.keyAndSource();
    if (!keyInfo) {
      throw new HttpException(
        'No hay una clave para cifrar los tokens: el servidor no tiene INTEGRATION_SECRET_KEY ni JWT_SECRET.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const encrypted = encryptSecret(token, keyInfo.key);
    return {
      ...cleared,
      tokenCipher: encrypted.ciphertext,
      tokenIv: encrypted.iv,
      tokenTag: encrypted.authTag,
      tokenLast4: token.slice(-4),
    };
  }

  /** Token guardado (descifrado); `null` si no hay o si no se puede descifrar con la clave actual. */
  private decryptToken(info: DniProviderInfo, row: ProviderRow): string | null {
    if (!row.tokenCipher || !row.tokenIv || !row.tokenTag) return null;
    const keyInfo = this.keyAndSource();
    if (!keyInfo) {
      this.logger.warn(
        `No hay clave de cifrado: no se puede usar el token guardado de ${info.provider}`,
      );
      return null;
    }
    try {
      return decryptSecret(
        {
          ciphertext: row.tokenCipher,
          iv: row.tokenIv,
          authTag: row.tokenTag,
        },
        keyInfo.key,
      );
    } catch {
      this.logger.warn(
        `No se pudo descifrar el token guardado de ${info.provider}: vuelve a ingresarlo en la plataforma`,
      );
      return null;
    }
  }

  private toView(
    info: DniProviderInfo,
    row: ProviderRow | undefined,
  ): DniProviderView {
    const configured = !!row?.tokenCipher;
    return {
      provider: info.provider,
      label: info.label,
      enabled: row?.enabled ?? true,
      priority: row?.priority ?? info.defaultPriority,
      apiUrl: row?.apiUrl ?? info.defaultUrl,
      defaultUrl: info.defaultUrl,
      customUrl: !!row?.apiUrl,
      configured,
      tokenMask: configured && row?.tokenLast4 ? `••••${row.tokenLast4}` : null,
      state: row?.state ?? CredentialState.UNVERIFIED,
      lastError: row?.lastError ?? null,
      lastCheckedAt: row?.lastCheckedAt ?? null,
    };
  }
}
