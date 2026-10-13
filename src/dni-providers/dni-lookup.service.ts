import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  DniLookupOrigin,
  DniLookupResult,
  DniProvider,
  DniToken,
  DniTokenState,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LookupOutcome, lookupDniDetailed } from './dni-lookup';
import { DniTokensService, DniTokenView } from './dni-tokens.service';

/** Días que una consulta exitosa se reutiliza sin gastar cupo del proveedor. */
export const DNI_CACHE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOGS_PAGE_SIZE = 20;
/** Lima no tiene horario de verano: UTC-5 todo el año. */
const LIMA_OFFSET_MS = -5 * 60 * 60 * 1000;
const MAX_USAGE_ROWS = 100_000;

export interface DniPerson {
  dni: string;
  fullName: string;
}

export interface DniLookupSuccess {
  person: DniPerson;
  source: 'CACHE' | 'PROVIDER';
  /** Proveedor que respondió (o el que llenó la caché). */
  provider: DniProvider;
}

export interface DniTestResult {
  ok: boolean;
  result: LookupOutcome['kind'];
  message: string;
  token: DniTokenView;
}

export interface DniUsage {
  since: Date;
  days: number;
  byDay: Array<{ date: string } & Partial<Record<DniLookupResult, number>>>;
  byToken: Array<{
    tokenId: number | null;
    name: string;
    provider: DniProvider | null;
    results: Partial<Record<DniLookupResult, number>>;
  }>;
}

const TEST_MESSAGES: Record<LookupOutcome['kind'], string> = {
  found: 'El proveedor respondió correctamente.',
  not_found: 'El proveedor funciona, pero no encontró ese DNI.',
  unauthorized:
    'El proveedor rechazó el token: es inválido o no tiene permiso.',
  limit: 'El proveedor indica que se agotó el cupo de consultas del token.',
  unavailable: 'El proveedor no respondió correctamente.',
};

/** `76251607` → `76****07`: es lo único del DNI que llega a la bitácora. */
export function maskDni(dni: string): string {
  return dni.length <= 4
    ? '*'.repeat(dni.length)
    : `${dni.slice(0, 2)}${'*'.repeat(dni.length - 4)}${dni.slice(-2)}`;
}

/** Fecha de Lima (`YYYY-MM-DD`) de un instante. */
export function limaDate(date: Date): string {
  return new Date(date.getTime() + LIMA_OFFSET_MS).toISOString().slice(0, 10);
}

interface UsageRow {
  createdAt: Date;
  result: DniLookupResult;
  tokenId: number | null;
}

/** Agrega las filas de la bitácora por día (Lima) y por token. Función pura, probada aparte. */
export function aggregateUsage(
  rows: UsageRow[],
  tokens: Array<{ id: number; name: string; provider: DniProvider }>,
): Pick<DniUsage, 'byDay' | 'byToken'> {
  const days = new Map<string, Partial<Record<DniLookupResult, number>>>();
  const perToken = new Map<string, DniUsage['byToken'][number]>();
  const names = new Map(tokens.map((token) => [token.id, token]));

  for (const row of rows) {
    const date = limaDate(row.createdAt);
    const day = days.get(date) ?? {};
    day[row.result] = (day[row.result] ?? 0) + 1;
    days.set(date, day);

    const key = String(row.tokenId ?? 'cache');
    const info = row.tokenId === null ? undefined : names.get(row.tokenId);
    const entry = perToken.get(key) ?? {
      tokenId: row.tokenId,
      name:
        info?.name ??
        (row.tokenId === null ? 'Caché / sin token' : 'Token eliminado'),
      provider: info?.provider ?? null,
      results: {},
    };
    entry.results[row.result] = (entry.results[row.result] ?? 0) + 1;
    perToken.set(key, entry);
  }

  return {
    byDay: [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, results]) => ({ date, ...results })),
    byToken: [...perToken.values()],
  };
}

@Injectable()
export class DniLookupService {
  private readonly logger = new Logger(DniLookupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: DniTokensService,
  ) {}

  /**
   * Consulta un DNI: caché → tokens por prioridad. Si un token es rechazado o se agota, pasa al siguiente;
   * si un proveedor dice que el DNI no existe, prueba un token del otro proveedor antes de responder
   * `null`. Lanza 503 si no hay tokens utilizables y 502 si todos fallan.
   */
  async lookup(
    dni: string,
    origin: DniLookupOrigin,
  ): Promise<DniLookupSuccess | null> {
    const cached = await this.readCache(dni);
    if (cached) {
      await this.log({ dni, origin, result: DniLookupResult.CACHE });
      return {
        person: cached.person,
        source: 'CACHE',
        provider: cached.provider,
      };
    }

    const candidates = await this.tokens.available();
    if (!candidates.length) {
      await this.log({
        dni,
        origin,
        result: DniLookupResult.NO_TOKENS,
        detail: 'No hay tokens disponibles',
      });
      throw new HttpException(
        (await this.tokens.hasAny())
          ? 'El servicio de consulta por DNI no está disponible por el momento'
          : 'El servicio de consulta por DNI no está configurado',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const notFoundAt = new Set<DniProvider>();
    let someoneRejected = false;
    for (const token of candidates) {
      // Si este proveedor ya dijo que el DNI no existe, otro token suyo diría lo mismo.
      if (notFoundAt.has(token.provider)) continue;
      const outcome = await this.consult(token, dni, origin);
      if (outcome.kind === 'found') {
        return {
          person: { dni, fullName: outcome.person.fullName },
          source: 'PROVIDER',
          provider: token.provider,
        };
      }
      if (outcome.kind === 'not_found') notFoundAt.add(token.provider);
      else if (outcome.kind !== 'unavailable') someoneRejected = true;
    }

    if (notFoundAt.size) return null;
    throw new HttpException(
      someoneRejected
        ? 'No se pudo consultar el DNI'
        : 'Servicio de consulta por DNI no disponible',
      HttpStatus.BAD_GATEWAY,
    );
  }

  /** Prueba un token concreto (aunque esté pausado o rechazado). Consume una consulta real y no devuelve datos personales. */
  async testToken(id: number, dni: string): Promise<DniTestResult> {
    const token = await this.tokens.get(id);
    const outcome = await this.consult(token, dni, DniLookupOrigin.PANEL);
    return {
      ok: outcome.kind === 'found' || outcome.kind === 'not_found',
      result: outcome.kind,
      message: TEST_MESSAGES[outcome.kind],
      token: await this.tokens.view(id),
    };
  }

  /** Uso de los últimos `days` días (1 a 90), por día y por token. */
  async usage(days: number): Promise<DniUsage> {
    const span = Math.min(90, Math.max(1, Math.trunc(days) || 30));
    const since = new Date(Date.now() - span * DAY_MS);
    const [rows, tokens] = await Promise.all([
      this.prisma.dniLookupLog.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true, result: true, tokenId: true },
        take: MAX_USAGE_ROWS,
      }),
      this.prisma.dniToken.findMany({
        select: { id: true, name: true, provider: true },
      }),
    ]);
    return { since, days: span, ...aggregateUsage(rows, tokens) };
  }

  async logs(page: number) {
    const current = Math.max(1, Math.trunc(page) || 1);
    const [total, rows] = await Promise.all([
      this.prisma.dniLookupLog.count(),
      this.prisma.dniLookupLog.findMany({
        orderBy: { id: 'desc' },
        skip: (current - 1) * LOGS_PAGE_SIZE,
        take: LOGS_PAGE_SIZE,
        include: { token: { select: { name: true } } },
      }),
    ]);
    return {
      data: rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        dni: row.dniMask,
        provider: row.provider,
        token: row.token?.name ?? null,
        result: row.result,
        httpStatus: row.httpStatus,
        durationMs: row.durationMs,
        origin: row.origin,
        detail: row.detail,
      })),
      meta: {
        page: current,
        pageSize: LOGS_PAGE_SIZE,
        total,
        totalPages: Math.max(1, Math.ceil(total / LOGS_PAGE_SIZE)),
      },
    };
  }

  async clearCache(): Promise<{ deleted: number }> {
    const { count } = await this.prisma.dniPersonCache.deleteMany({});
    return { deleted: count };
  }

  /**
   * Una consulta real con un token: llama al proveedor, suma el uso, marca el token según la respuesta,
   * llena la caché y deja la bitácora. Registrar nunca rompe la consulta.
   */
  private async consult(
    row: DniToken,
    dni: string,
    origin: DniLookupOrigin,
  ): Promise<LookupOutcome> {
    const started = Date.now();
    const secret = this.tokens.decrypt(row);
    if (!secret) {
      const detail = 'No se pudo descifrar el token: vuelve a ingresarlo';
      await this.safely(() =>
        this.tokens.markFailure(row.id, DniTokenState.INVALID, detail),
      );
      await this.log({
        dni,
        origin,
        row,
        result: DniLookupResult.INVALID_TOKEN,
        detail,
      });
      return { kind: 'unauthorized' };
    }

    const { outcome, httpStatus } = await lookupDniDetailed(row.provider, {
      url: this.tokens.effectiveUrl(row),
      token: secret,
      dni,
    });
    const common = {
      dni,
      origin,
      row,
      httpStatus,
      durationMs: Date.now() - started,
    };

    switch (outcome.kind) {
      case 'found':
        await this.safely(() => this.tokens.countUse(row.id));
        await this.safely(() =>
          this.writeCache(dni, outcome.person.fullName, row.provider),
        );
        await this.log({ ...common, result: DniLookupResult.SUCCESS });
        break;
      case 'not_found':
        await this.safely(() => this.tokens.countUse(row.id));
        await this.log({ ...common, result: DniLookupResult.NOT_FOUND });
        break;
      case 'unauthorized': {
        const detail = `Token rechazado por el proveedor${httpStatus ? ` (HTTP ${httpStatus})` : ''}`;
        await this.safely(() =>
          this.tokens.markFailure(row.id, DniTokenState.INVALID, detail),
        );
        await this.log({
          ...common,
          result: DniLookupResult.INVALID_TOKEN,
          detail,
        });
        break;
      }
      case 'limit': {
        const detail = `Cupo agotado según el proveedor${httpStatus ? ` (HTTP ${httpStatus})` : ''}`;
        await this.safely(() =>
          this.tokens.markFailure(row.id, DniTokenState.EXHAUSTED, detail),
        );
        await this.log({
          ...common,
          result: DniLookupResult.EXHAUSTED,
          detail,
        });
        break;
      }
      default: {
        const detail = 'El proveedor no respondió correctamente';
        await this.safely(() => this.tokens.markFailure(row.id, null, detail));
        await this.log({ ...common, result: DniLookupResult.ERROR, detail });
      }
    }
    return outcome;
  }

  private async readCache(
    dni: string,
    now = new Date(),
  ): Promise<{ person: DniPerson; provider: DniProvider } | null> {
    const row = await this.prisma.dniPersonCache.findUnique({ where: { dni } });
    if (
      !row ||
      now.getTime() - row.fetchedAt.getTime() > DNI_CACHE_DAYS * DAY_MS
    ) {
      return null;
    }
    return {
      person: { dni: row.dni, fullName: row.fullName },
      provider: row.provider,
    };
  }

  private async writeCache(
    dni: string,
    fullName: string,
    provider: DniProvider,
  ): Promise<void> {
    const data = {
      fullName: fullName.slice(0, 250),
      provider,
      fetchedAt: new Date(),
    };
    await this.prisma.dniPersonCache.upsert({
      where: { dni },
      create: { dni, ...data },
      update: data,
    });
  }

  private async log(entry: {
    dni: string;
    origin: DniLookupOrigin;
    result: DniLookupResult;
    row?: DniToken;
    httpStatus?: number | null;
    durationMs?: number;
    detail?: string;
  }): Promise<void> {
    await this.safely(() =>
      this.prisma.dniLookupLog.create({
        data: {
          tokenId: entry.row?.id ?? null,
          provider: entry.row?.provider ?? null,
          dniMask: maskDni(entry.dni),
          result: entry.result,
          httpStatus: entry.httpStatus ?? null,
          durationMs: entry.durationMs ?? null,
          origin: entry.origin,
          detail: entry.detail?.slice(0, 300) ?? null,
        },
      }),
    );
  }

  /** La bitácora y los contadores nunca deben impedir una consulta. */
  private async safely(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.logger.warn(
        `No se pudo registrar el resultado de una consulta de DNI: ${String(error)}`,
      );
    }
  }
}
