import {
  DniLookupOrigin,
  DniLookupResult,
  DniProvider,
  DniTokenState,
  RenewalPeriod,
} from '@prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service';

export interface FakeTokenRow {
  id: number;
  provider: DniProvider;
  name: string;
  tokenCipher: string;
  tokenIv: string;
  tokenTag: string;
  tokenLast4: string;
  apiUrl: string | null;
  priority: number;
  enabled: boolean;
  state: DniTokenState;
  queryLimit: number | null;
  queriesUsed: number;
  renewalPeriod: RenewalPeriod;
  renewsAt: Date | null;
  lastError: string | null;
  lastUsedAt: Date | null;
  exhaustedAt: Date | null;
  createdById: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeLogRow {
  id: number;
  tokenId: number | null;
  provider: DniProvider | null;
  dniMask: string;
  result: DniLookupResult;
  httpStatus: number | null;
  durationMs: number | null;
  origin: DniLookupOrigin;
  detail: string | null;
  createdAt: Date;
}

export interface FakeCacheRow {
  dni: string;
  fullName: string;
  provider: DniProvider;
  fetchedAt: Date;
}

type Where = Record<string, unknown>;
type Row = Record<string, unknown>;

function matches(row: object, where: Where = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = (row as Row)[key];
    if (cond instanceof Date) {
      return value instanceof Date && value.getTime() === cond.getTime();
    }
    if (cond && typeof cond === 'object') {
      const c = cond as { not?: unknown; lte?: Date; gte?: Date };
      if ('not' in c && value === c.not) return false;
      if (c.lte && !(value instanceof Date && value <= c.lte)) return false;
      if (c.gte && !(value instanceof Date && value >= c.gte)) return false;
      return true;
    }
    return value === cond;
  });
}

function sorted<T extends object>(
  rows: T[],
  orderBy?:
    | Record<string, 'asc' | 'desc'>
    | Array<Record<string, 'asc' | 'desc'>>,
): T[] {
  const orders = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  return [...rows].sort((a, b) => {
    for (const order of orders) {
      const [field, dir] = Object.entries(order)[0];
      const x = (a as Row)[field] as number | Date;
      const y = (b as Row)[field] as number | Date;
      if (x === y) continue;
      const cmp = x < y ? -1 : 1;
      return dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
}

function pick(row: object, select?: Record<string, boolean>): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.entries(row).filter(([key]) => select[key]));
}

function applyData(target: object, data: Row): void {
  const row = target as Row;
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (
      value &&
      typeof value === 'object' &&
      !(value instanceof Date) &&
      'increment' in value
    ) {
      row[key] =
        (row[key] as number) + (value as { increment: number }).increment;
    } else {
      row[key] = value;
    }
  }
}

/**
 * Fake mínimo de Prisma para el pool de DNI: solo los modelos y las consultas que usan los servicios.
 * `failLogWrites` simula una base caída al registrar la bitácora.
 */
export class FakeDniPrisma {
  tokens: FakeTokenRow[] = [];
  logs: FakeLogRow[] = [];
  cache = new Map<string, FakeCacheRow>();
  failLogWrites = false;
  private nextTokenId = 1;
  private nextLogId = 1;

  asPrisma(): PrismaService {
    return this as unknown as PrismaService;
  }

  dniToken = {
    findMany: ({
      where,
      orderBy,
      take,
      select,
    }: {
      where?: Where;
      orderBy?:
        | Record<string, 'asc' | 'desc'>
        | Array<Record<string, 'asc' | 'desc'>>;
      take?: number;
      select?: Record<string, boolean>;
    } = {}) => {
      let rows = sorted(
        this.tokens.filter((row) => matches(row, where)),
        orderBy,
      );
      if (take !== undefined) rows = rows.slice(0, take);
      return Promise.resolve(rows.map((row) => pick(row, select)));
    },
    findUnique: ({ where }: { where: { id: number } }) =>
      Promise.resolve(this.tokens.find((row) => row.id === where.id) ?? null),
    count: () => Promise.resolve(this.tokens.length),
    create: ({ data }: { data: Partial<FakeTokenRow> }) => {
      const now = new Date();
      const row = Object.assign(
        {
          id: this.nextTokenId++,
          apiUrl: null,
          priority: 100,
          enabled: true,
          state: DniTokenState.ACTIVE,
          queryLimit: null,
          queriesUsed: 0,
          renewalPeriod: RenewalPeriod.MONTHLY,
          renewsAt: null,
          lastError: null,
          lastUsedAt: null,
          exhaustedAt: null,
          createdById: null,
          createdAt: now,
          updatedAt: now,
        },
        data,
      ) as FakeTokenRow;
      this.tokens.push(row);
      return Promise.resolve({ ...row });
    },
    update: ({ where, data }: { where: { id: number }; data: Row }) => {
      const row = this.tokens.find((item) => item.id === where.id);
      if (!row) return Promise.reject(new Error('Registro no encontrado'));
      applyData(row, data);
      row.updatedAt = new Date();
      return Promise.resolve({ ...row });
    },
    updateMany: ({ where, data }: { where: Where; data: Row }) => {
      const rows = this.tokens.filter((row) => matches(row, where));
      for (const row of rows) applyData(row, data);
      return Promise.resolve({ count: rows.length });
    },
    delete: ({ where }: { where: { id: number } }) => {
      const index = this.tokens.findIndex((row) => row.id === where.id);
      if (index < 0) return Promise.reject(new Error('Registro no encontrado'));
      const [removed] = this.tokens.splice(index, 1);
      // ON DELETE SET NULL: el historial se conserva sin el token.
      for (const log of this.logs)
        if (log.tokenId === removed.id) log.tokenId = null;
      return Promise.resolve(removed);
    },
  };

  dniLookupLog = {
    create: ({ data }: { data: Partial<FakeLogRow> }) => {
      if (this.failLogWrites) return Promise.reject(new Error('BD caída'));
      const row = Object.assign(
        {
          id: this.nextLogId++,
          tokenId: null,
          provider: null,
          httpStatus: null,
          durationMs: null,
          detail: null,
          createdAt: new Date(),
        },
        data,
      ) as FakeLogRow;
      this.logs.push(row);
      return Promise.resolve({ ...row });
    },
    count: () => Promise.resolve(this.logs.length),
    findMany: ({
      where,
      orderBy,
      skip = 0,
      take,
      select,
      include,
    }: {
      where?: Where;
      orderBy?: Record<string, 'asc' | 'desc'>;
      skip?: number;
      take?: number;
      select?: Record<string, boolean>;
      include?: { token?: { select: { name: boolean } } };
    } = {}) => {
      let rows = sorted(
        this.logs.filter((row) => matches(row, where)),
        orderBy,
      ).slice(skip);
      if (take !== undefined) rows = rows.slice(0, take);
      return Promise.resolve(
        rows.map((row) => {
          if (select) return pick(row, select);
          if (!include?.token) return { ...row };
          const token = this.tokens.find((item) => item.id === row.tokenId);
          return { ...row, token: token ? { name: token.name } : null };
        }),
      );
    },
  };

  dniPersonCache = {
    findUnique: ({ where }: { where: { dni: string } }) => {
      const row = this.cache.get(where.dni);
      return Promise.resolve(row ? { ...row } : null);
    },
    upsert: ({
      where,
      create,
      update,
    }: {
      where: { dni: string };
      create: FakeCacheRow;
      update: Partial<FakeCacheRow>;
    }) => {
      const current = this.cache.get(where.dni);
      const next = current ? { ...current, ...update } : { ...create };
      this.cache.set(where.dni, next);
      return Promise.resolve({ ...next });
    },
    deleteMany: () => {
      const count = this.cache.size;
      this.cache.clear();
      return Promise.resolve({ count });
    },
  };
}
