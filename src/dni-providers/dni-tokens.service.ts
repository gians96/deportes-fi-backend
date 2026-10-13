import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DniProvider,
  DniToken,
  DniTokenState,
  Prisma,
  RenewalPeriod,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DNI_PROVIDER_CATALOG,
  DniProviderInfo,
  providerInfo,
} from './dni-provider.catalog';
import { CreateDniTokenDto, UpdateDniTokenDto } from './dto/dni-token.dto';
import { limitReached, nextRenewal } from './renewal';
import {
  decryptSecret,
  deriveSecretKey,
  encryptSecret,
  parseSecretKey,
} from './secret-box';

/**
 * Origen de la clave que cifra los tokens: `dedicated` (INTEGRATION_SECRET_KEY), `derived` (a partir de
 * JWT_SECRET, que el servidor ya tiene) o `none` (no se puede guardar ningún token).
 */
export type EncryptionKeySource = 'dedicated' | 'derived' | 'none';

/** Un token tal como lo ve el panel: nunca incluye el valor, solo su máscara. */
export interface DniTokenView {
  id: number;
  provider: DniProvider;
  providerLabel: string;
  name: string;
  tokenMask: string;
  /** URL efectiva que se consulta y la oficial del proveedor. */
  apiUrl: string;
  defaultUrl: string;
  customUrl: boolean;
  priority: number;
  enabled: boolean;
  state: DniTokenState;
  /** Se usaría ahora mismo: activo, en estado `ACTIVE` y con cupo. */
  available: boolean;
  queryLimit: number | null;
  queriesUsed: number;
  queriesRemaining: number | null;
  usagePercent: number | null;
  renewalPeriod: RenewalPeriod;
  renewsAt: Date | null;
  lastError: string | null;
  lastUsedAt: Date | null;
  exhaustedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const PRIORITY_STEP = 10;

@Injectable()
export class DniTokensService {
  private readonly logger = new Logger(DniTokensService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  encryptionKeySource(): EncryptionKeySource {
    return this.keyAndSource()?.source ?? 'none';
  }

  providers(): Array<
    Pick<DniProviderInfo, 'provider' | 'label' | 'defaultUrl' | 'tokenHelpUrl'>
  > {
    return DNI_PROVIDER_CATALOG.map((info) => ({ ...info }));
  }

  async list(): Promise<DniTokenView[]> {
    const rows = await this.prisma.dniToken.findMany({
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => this.toView(row));
  }

  async get(id: number): Promise<DniToken> {
    const row = await this.prisma.dniToken.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('El token de DNI no existe');
    return row;
  }

  async view(id: number): Promise<DniTokenView> {
    return this.toView(await this.get(id));
  }

  /** ¿Hay algún token guardado, sin importar su estado? */
  async hasAny(): Promise<boolean> {
    return (await this.prisma.dniToken.count()) > 0;
  }

  async create(dto: CreateDniTokenDto, actorId: number): Promise<DniTokenView> {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Escribe un alias para el token');
    const encrypted = this.encryptToken(dto.token);
    const queryLimit = dto.queryLimit ?? null;
    const queriesUsed = dto.queriesUsed ?? 0;
    const exhausted = limitReached({ queryLimit, queriesUsed });

    const row = await this.prisma.dniToken.create({
      data: {
        provider: dto.provider,
        name,
        ...encrypted,
        apiUrl: this.normalizeUrl(dto.apiUrl),
        priority: dto.priority ?? (await this.nextPriority()),
        enabled: dto.enabled ?? true,
        state: exhausted ? DniTokenState.EXHAUSTED : DniTokenState.ACTIVE,
        exhaustedAt: exhausted ? new Date() : null,
        queryLimit,
        queriesUsed,
        renewalPeriod: dto.renewalPeriod ?? RenewalPeriod.MONTHLY,
        renewsAt: this.parseDate(dto.renewsAt),
        createdById: actorId,
      },
    });
    return this.toView(row);
  }

  async update(id: number, dto: UpdateDniTokenDto): Promise<DniTokenView> {
    const current = await this.get(id);
    const data: Prisma.DniTokenUpdateInput = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name)
        throw new BadRequestException('Escribe un alias para el token');
      data.name = name;
    }
    if (dto.apiUrl !== undefined) data.apiUrl = this.normalizeUrl(dto.apiUrl);
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.queryLimit !== undefined) data.queryLimit = dto.queryLimit;
    if (dto.queriesUsed !== undefined) data.queriesUsed = dto.queriesUsed;
    if (dto.renewalPeriod !== undefined) data.renewalPeriod = dto.renewalPeriod;
    if (dto.renewsAt !== undefined)
      data.renewsAt = this.parseDate(dto.renewsAt);

    let state = current.state;
    if (dto.token !== undefined) {
      // Un valor nuevo vuelve a estar disponible: se limpian el rechazo y el agotamiento anteriores.
      Object.assign(data, this.encryptToken(dto.token));
      data.lastError = null;
      data.exhaustedAt = null;
      state = DniTokenState.ACTIVE;
    }

    // El cupo manda: si lo usado alcanza el límite queda agotado; si se amplía, deja de estarlo.
    const next = {
      queryLimit:
        dto.queryLimit !== undefined ? dto.queryLimit : current.queryLimit,
      queriesUsed:
        dto.queriesUsed !== undefined ? dto.queriesUsed : current.queriesUsed,
    };
    if (state !== DniTokenState.INVALID) {
      if (limitReached(next)) {
        if (state !== DniTokenState.EXHAUSTED) data.exhaustedAt = new Date();
        state = DniTokenState.EXHAUSTED;
      } else if (
        state === DniTokenState.EXHAUSTED &&
        (dto.queryLimit !== undefined || dto.queriesUsed !== undefined)
      ) {
        state = DniTokenState.ACTIVE;
        data.exhaustedAt = null;
      }
    }
    data.state = state;

    const row = await this.prisma.dniToken.update({ where: { id }, data });
    return this.toView(row);
  }

  async remove(id: number): Promise<void> {
    await this.get(id);
    await this.prisma.dniToken.delete({ where: { id } });
  }

  /** Contador en 0 y de nuevo `ACTIVE` (p. ej. tras renovar el plan o corregir el token a mano). */
  async reset(id: number): Promise<DniTokenView> {
    await this.get(id);
    const row = await this.prisma.dniToken.update({
      where: { id },
      data: {
        queriesUsed: 0,
        state: DniTokenState.ACTIVE,
        exhaustedAt: null,
        lastError: null,
      },
    });
    return this.toView(row);
  }

  /**
   * Tokens que se pueden consultar ahora, por prioridad. Antes renueva los vencidos de forma perezosa e
   * idempotente: la actualización es condicional a la fecha leída, así que dos solicitudes simultáneas no
   * renuevan dos veces.
   */
  async available(now = new Date()): Promise<DniToken[]> {
    await this.renewDue(now);
    const rows = await this.prisma.dniToken.findMany({
      where: { enabled: true, state: DniTokenState.ACTIVE },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
    return rows.filter((row) => !limitReached(row));
  }

  async renewDue(now = new Date()): Promise<void> {
    const due = await this.prisma.dniToken.findMany({
      where: {
        enabled: true,
        renewalPeriod: { not: RenewalPeriod.NONE },
        renewsAt: { lte: now },
      },
    });
    for (const token of due) {
      if (!token.renewsAt) continue;
      await this.prisma.dniToken.updateMany({
        where: { id: token.id, renewsAt: token.renewsAt },
        data: {
          queriesUsed: 0,
          exhaustedAt: null,
          renewsAt: nextRenewal(token.renewsAt, token.renewalPeriod, now),
          ...(token.state === DniTokenState.INVALID
            ? {}
            : { state: DniTokenState.ACTIVE }),
        },
      });
    }
  }

  /** Suma una consulta real (atómico) y marca el token como agotado si alcanzó su límite local. */
  async countUse(id: number): Promise<void> {
    const updated = await this.prisma.dniToken.update({
      where: { id },
      data: {
        queriesUsed: { increment: 1 },
        lastUsedAt: new Date(),
        lastError: null,
      },
    });
    if (updated.state === DniTokenState.ACTIVE && limitReached(updated)) {
      await this.prisma.dniToken.updateMany({
        where: { id, state: DniTokenState.ACTIVE },
        data: { state: DniTokenState.EXHAUSTED, exhaustedAt: new Date() },
      });
    }
  }

  /**
   * Guarda por qué falló una consulta. `state` nulo solo registra el último error (falla transitoria: el
   * token sigue disponible); `INVALID` o `EXHAUSTED` lo sacan del pool hasta reiniciarlo o renovarlo.
   */
  async markFailure(
    id: number,
    state: DniTokenState | null,
    detail: string,
  ): Promise<void> {
    await this.prisma.dniToken.update({
      where: { id },
      data: {
        lastError: detail.slice(0, 500),
        ...(state
          ? {
              state,
              exhaustedAt:
                state === DniTokenState.EXHAUSTED ? new Date() : null,
            }
          : {}),
      },
    });
  }

  /** Valor del token descifrado; `null` si no se puede (la clave cambió). */
  decrypt(row: DniToken): string | null {
    const keyInfo = this.keyAndSource();
    if (!keyInfo) return null;
    try {
      return decryptSecret(
        { ciphertext: row.tokenCipher, iv: row.tokenIv, authTag: row.tokenTag },
        keyInfo.key,
      );
    } catch {
      this.logger.warn(
        `No se pudo descifrar el token #${row.id}: vuelve a ingresarlo en la plataforma`,
      );
      return null;
    }
  }

  effectiveUrl(row: Pick<DniToken, 'provider' | 'apiUrl'>): string {
    return row.apiUrl ?? providerInfo(row.provider).defaultUrl;
  }

  toView(row: DniToken): DniTokenView {
    const info = providerInfo(row.provider);
    const reached = limitReached(row);
    return {
      id: row.id,
      provider: row.provider,
      providerLabel: info.label,
      name: row.name,
      tokenMask: `••••${row.tokenLast4}`,
      apiUrl: this.effectiveUrl(row),
      defaultUrl: info.defaultUrl,
      customUrl: row.apiUrl !== null,
      priority: row.priority,
      enabled: row.enabled,
      state: row.state,
      available: row.enabled && row.state === DniTokenState.ACTIVE && !reached,
      queryLimit: row.queryLimit,
      queriesUsed: row.queriesUsed,
      queriesRemaining:
        row.queryLimit === null
          ? null
          : Math.max(0, row.queryLimit - row.queriesUsed),
      usagePercent: row.queryLimit
        ? Math.min(100, Math.round((row.queriesUsed / row.queryLimit) * 100))
        : null,
      renewalPeriod: row.renewalPeriod,
      renewsAt: row.renewsAt,
      lastError: row.lastError,
      lastUsedAt: row.lastUsedAt,
      exhaustedAt: row.exhaustedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async nextPriority(): Promise<number> {
    const [last] = await this.prisma.dniToken.findMany({
      orderBy: { priority: 'desc' },
      take: 1,
      select: { priority: true },
    });
    return (last?.priority ?? 0) + PRIORITY_STEP;
  }

  private keyAndSource(): { key: Buffer; source: EncryptionKeySource } | null {
    const dedicated = parseSecretKey(
      this.config.get<string>('INTEGRATION_SECRET_KEY'),
    );
    if (dedicated) return { key: dedicated, source: 'dedicated' };
    const derived = deriveSecretKey(this.config.get<string>('JWT_SECRET'));
    return derived ? { key: derived, source: 'derived' } : null;
  }

  /** Campos cifrados de la fila para un token nuevo. */
  private encryptToken(
    rawToken: string,
  ): Pick<
    Prisma.DniTokenUncheckedCreateInput,
    'tokenCipher' | 'tokenIv' | 'tokenTag' | 'tokenLast4'
  > {
    const token = rawToken.trim().replace(/^bearer\s+/i, '');
    if (token.length < 8) {
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
      tokenCipher: encrypted.ciphertext,
      tokenIv: encrypted.iv,
      tokenTag: encrypted.authTag,
      tokenLast4: token.slice(-4),
    };
  }

  /** `null` = usar la URL oficial. Solo se aceptan direcciones http(s) válidas. */
  private normalizeUrl(raw: string | null | undefined): string | null {
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

  private parseDate(raw: string | null | undefined): Date | null {
    if (!raw) return null;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('La fecha de renovación no es válida.');
    }
    return date;
  }
}
