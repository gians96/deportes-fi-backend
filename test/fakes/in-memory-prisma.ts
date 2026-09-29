import {
  ParticipantType,
  Prisma,
  RegistrationStatus,
  Role,
  VoucherStatus,
} from '@prisma/client';

/**
 * Fake de Prisma en memoria para pruebas unitarias/HTTP sin base de datos.
 *
 * - Respeta `select` (incluido `_count`), `orderBy`, `skip` y `take`.
 * - Es estricto: lanza un error ante filtros no soportados y ante consultas de
 *   equipos o vouchers que no estén acotadas por `eventId`. Así una prueba falla
 *   si el código deja de filtrar por el evento del token.
 * - Los registros incluyen datos sensibles (DNI, códigos, teléfonos, URLs de
 *   vouchers) para detectar fugas en las respuestas.
 */

type Row = Record<string, unknown>;
type SortDirection = 'asc' | 'desc';

export interface FakeEvent {
  id: number;
  name: string;
  description: string | null;
  facultyId: number;
  startDate: Date;
  endDate: Date;
  isOpen: boolean;
}

export interface FakeDiscipline {
  id: number;
  eventId: number;
  name: string;
  participantType: ParticipantType;
  isPaid: boolean;
  cost: Prisma.Decimal;
}

export interface FakeTeam {
  id: number;
  disciplineId: number;
  delegateId: number;
  name: string;
  phone: string | null;
  status: RegistrationStatus;
  createdAt: Date;
}

export interface FakeParticipant {
  id: number;
  teamId: number;
  fullName: string;
  studentCode: string | null;
  dni: string | null;
}

export interface FakeVoucher {
  id: number;
  teamId: number;
  amount: Prisma.Decimal;
  status: VoucherStatus;
  operationNumber: string | null;
  imageUrl: string;
  uploadedAt: Date;
  updatedAt: Date;
}

export interface FakeUser {
  id: number;
  email: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  studentCode: string | null;
}

export interface FakeToken {
  id: number;
  eventId: number;
  name: string;
  tokenPrefix: string;
  tokenHash: string;
  createdById: number | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeDataset {
  events: FakeEvent[];
  disciplines: FakeDiscipline[];
  teams: FakeTeam[];
  participants: FakeParticipant[];
  vouchers: FakeVoucher[];
  users: FakeUser[];
  tokens: FakeToken[];
}

export interface FakeCall {
  model: string;
  action: string;
  args: unknown;
}

interface FindArgs {
  where?: Row;
  select?: Row;
  orderBy?: unknown;
  skip?: number;
  take?: number;
}

export class InMemoryPrisma {
  readonly calls: FakeCall[] = [];
  private tokenSeq: number;

  constructor(readonly data: FakeDataset) {
    this.tokenSeq = Math.max(0, ...data.tokens.map((token) => token.id));
  }

  readonly sportEvent = {
    findUnique: (args: FindArgs) => {
      this.record('sportEvent', 'findUnique', args);
      const where = requireWhere(args, 'sportEvent');
      assertKeys(where, ['id'], 'sportEvent');
      const event = this.data.events.find((item) => item.id === where.id);
      return Promise.resolve(
        event ? applySelect({ ...event }, args.select) : null,
      );
    },
  };

  readonly discipline = {
    findMany: (args: FindArgs) => {
      this.record('discipline', 'findMany', args);
      const where = requireWhere(args, 'discipline');
      assertKeys(where, ['eventId'], 'discipline');
      if (typeof where.eventId !== 'number') {
        throw new Error('FakePrisma: disciplinas sin filtro por evento');
      }
      const rows = this.data.disciplines.filter(
        (item) => item.eventId === where.eventId,
      );
      return Promise.resolve(
        paginate(sortRows(rows, args.orderBy), args).map((item) =>
          applySelect(this.hydrateDiscipline(item), args.select),
        ),
      );
    },
  };

  readonly team = {
    findMany: (args: FindArgs) => {
      this.record('team', 'findMany', args);
      const rows = this.filterTeams(requireWhere(args, 'team'));
      return Promise.resolve(
        paginate(sortRows(rows, args.orderBy), args).map((item) =>
          applySelect(this.hydrateTeam(item), args.select),
        ),
      );
    },
    count: (args: FindArgs) => {
      this.record('team', 'count', args);
      return Promise.resolve(
        this.filterTeams(requireWhere(args, 'team')).length,
      );
    },
  };

  readonly voucher = {
    findMany: (args: FindArgs) => {
      this.record('voucher', 'findMany', args);
      const rows = this.filterVouchers(requireWhere(args, 'voucher'));
      return Promise.resolve(
        paginate(sortRows(rows, args.orderBy), args).map((item) =>
          applySelect(this.hydrateVoucher(item), args.select),
        ),
      );
    },
    count: (args: FindArgs) => {
      this.record('voucher', 'count', args);
      return Promise.resolve(
        this.filterVouchers(requireWhere(args, 'voucher')).length,
      );
    },
  };

  readonly user = {
    findUnique: (args: FindArgs) => {
      this.record('user', 'findUnique', args);
      const where = requireWhere(args, 'user');
      assertKeys(where, ['id'], 'user');
      const user = this.data.users.find((item) => item.id === where.id);
      return Promise.resolve(
        user ? applySelect({ ...user }, args.select) : null,
      );
    },
  };

  readonly eventApiToken = {
    findUnique: (args: FindArgs) => {
      this.record('eventApiToken', 'findUnique', args);
      const where = requireWhere(args, 'eventApiToken');
      const token = this.data.tokens.find((item) =>
        this.matchToken(item, where),
      );
      return Promise.resolve(
        token ? applySelect({ ...token }, args.select) : null,
      );
    },
    findFirst: (args: FindArgs) => {
      this.record('eventApiToken', 'findFirst', args);
      const where = requireWhere(args, 'eventApiToken');
      const token = this.data.tokens.find((item) =>
        this.matchToken(item, where),
      );
      return Promise.resolve(
        token ? applySelect({ ...token }, args.select) : null,
      );
    },
    findMany: (args: FindArgs) => {
      this.record('eventApiToken', 'findMany', args);
      const where = requireWhere(args, 'eventApiToken');
      const rows = this.data.tokens.filter((item) =>
        this.matchToken(item, where),
      );
      return Promise.resolve(
        paginate(sortRows(rows, args.orderBy), args).map((item) =>
          applySelect({ ...item }, args.select),
        ),
      );
    },
    create: (args: { data: Row; select?: Row }) => {
      this.record('eventApiToken', 'create', args);
      const data = args.data;
      const eventId = data.eventId as number;
      if (!this.data.events.some((event) => event.id === eventId)) {
        return Promise.reject(new Error('FakePrisma: violación de FK eventId'));
      }
      const duplicate = this.data.tokens.some(
        (token) =>
          token.tokenPrefix === data.tokenPrefix ||
          token.tokenHash === data.tokenHash,
      );
      if (duplicate) {
        return Promise.reject(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'fake',
          }),
        );
      }
      const now = new Date();
      this.tokenSeq += 1;
      const token: FakeToken = {
        id: this.tokenSeq,
        eventId,
        name: data.name as string,
        tokenPrefix: data.tokenPrefix as string,
        tokenHash: data.tokenHash as string,
        createdById: (data.createdById as number | null | undefined) ?? null,
        lastUsedAt: null,
        expiresAt: (data.expiresAt as Date | null | undefined) ?? null,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.data.tokens.push(token);
      return Promise.resolve(applySelect({ ...token }, args.select));
    },
    updateMany: (args: { where: Row; data: Row }) => {
      this.record('eventApiToken', 'updateMany', args);
      const matches = this.data.tokens.filter((item) =>
        this.matchToken(item, args.where),
      );
      for (const token of matches) {
        Object.assign(token, args.data, { updatedAt: new Date() });
      }
      return Promise.resolve({ count: matches.length });
    },
  };

  /** Como el `$transaction([...])` de Prisma: resuelve todas las consultas. */
  $transaction<T extends readonly unknown[]>(
    operations: [...T],
  ): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
    this.record('$transaction', 'array', operations.length);
    return Promise.all(operations);
  }

  /** Modelos consultados sin contar `$transaction`. */
  queriedModels(): string[] {
    return this.calls
      .filter((call) => call.model !== '$transaction')
      .map((call) => `${call.model}.${call.action}`);
  }

  private record(model: string, action: string, args: unknown): void {
    this.calls.push({ model, action, args });
  }

  private filterTeams(where: Row): FakeTeam[] {
    assertKeys(where, ['discipline', 'status'], 'team');
    const eventId = requireEventFilter(where.discipline, 'team.discipline');
    return this.data.teams.filter(
      (team) =>
        this.disciplineById(team.disciplineId).eventId === eventId &&
        (where.status === undefined || team.status === where.status),
    );
  }

  private filterVouchers(where: Row): FakeVoucher[] {
    assertKeys(where, ['team', 'status'], 'voucher');
    const teamWhere = where.team as Row | undefined;
    if (!teamWhere) {
      throw new Error('FakePrisma: vouchers sin filtro por evento');
    }
    assertKeys(teamWhere, ['discipline'], 'voucher.team');
    const eventId = requireEventFilter(
      teamWhere.discipline,
      'voucher.team.discipline',
    );
    return this.data.vouchers.filter((voucher) => {
      const team = this.teamById(voucher.teamId);
      return (
        this.disciplineById(team.disciplineId).eventId === eventId &&
        (where.status === undefined || voucher.status === where.status)
      );
    });
  }

  private matchToken(token: FakeToken, where: Row): boolean {
    assertKeys(
      where,
      ['id', 'eventId', 'tokenHash', 'revokedAt'],
      'eventApiToken',
    );
    if (where.id !== undefined && token.id !== where.id) return false;
    if (where.eventId !== undefined && token.eventId !== where.eventId)
      return false;
    if (where.tokenHash !== undefined && token.tokenHash !== where.tokenHash) {
      return false;
    }
    if ('revokedAt' in where) {
      if (where.revokedAt !== null) {
        throw new Error('FakePrisma: solo se soporta revokedAt: null');
      }
      if (token.revokedAt !== null) return false;
    }
    return true;
  }

  private hydrateDiscipline(discipline: FakeDiscipline): Row {
    return {
      ...discipline,
      event: { ...this.eventById(discipline.eventId) },
    };
  }

  private hydrateTeam(team: FakeTeam): Row {
    const participants = this.data.participants.filter(
      (participant) => participant.teamId === team.id,
    );
    const voucher = this.data.vouchers.find((item) => item.teamId === team.id);
    return {
      ...team,
      discipline: this.hydrateDiscipline(
        this.disciplineById(team.disciplineId),
      ),
      participants: participants.map((participant) => ({ ...participant })),
      voucher: voucher ? { ...voucher } : null,
      _count: { participants: participants.length },
    };
  }

  private hydrateVoucher(voucher: FakeVoucher): Row {
    return {
      ...voucher,
      team: this.hydrateTeam(this.teamById(voucher.teamId)),
    };
  }

  private eventById(id: number): FakeEvent {
    return findOrThrow(this.data.events, id, 'evento');
  }

  private disciplineById(id: number): FakeDiscipline {
    return findOrThrow(this.data.disciplines, id, 'disciplina');
  }

  private teamById(id: number): FakeTeam {
    return findOrThrow(this.data.teams, id, 'equipo');
  }
}

function findOrThrow<T extends { id: number }>(
  rows: T[],
  id: number,
  label: string,
): T {
  const row = rows.find((item) => item.id === id);
  if (!row) throw new Error(`FakePrisma: ${label} ${id} inexistente`);
  return row;
}

function requireWhere(args: FindArgs, model: string): Row {
  if (!args.where) throw new Error(`FakePrisma: ${model} sin where`);
  return args.where;
}

function requireEventFilter(value: unknown, path: string): number {
  const where = value as Row | undefined;
  if (!where || typeof where.eventId !== 'number') {
    throw new Error(`FakePrisma: ${path} sin filtro por eventId`);
  }
  assertKeys(where, ['eventId'], path);
  return where.eventId;
}

function assertKeys(where: Row, allowed: string[], path: string): void {
  for (const key of Object.keys(where)) {
    if (!allowed.includes(key)) {
      throw new Error(`FakePrisma: filtro no soportado ${path}.${key}`);
    }
  }
}

function applySelect(record: Row, select?: Row): Row {
  if (!select) return record;
  const out: Row = {};
  for (const [key, spec] of Object.entries(select)) {
    if (!spec) continue;
    const value = record[key];
    if (key === '_count') {
      const countSelect = (spec as { select: Row }).select;
      const counts = value as Record<string, number>;
      out._count = Object.fromEntries(
        Object.keys(countSelect).map((relation) => [
          relation,
          counts[relation],
        ]),
      );
    } else if (spec === true) {
      out[key] = value;
    } else {
      const nested = (spec as { select?: Row }).select;
      if (value === null || value === undefined) {
        out[key] = null;
      } else if (Array.isArray(value)) {
        out[key] = (value as Row[]).map((item) => applySelect(item, nested));
      } else {
        out[key] = applySelect(value as Row, nested);
      }
    }
  }
  return out;
}

function sortRows<T extends object>(rows: T[], orderBy: unknown): T[] {
  if (!orderBy) return [...rows];
  const clauses = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Record<
    string,
    SortDirection
  >[];
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      const [key, direction] = Object.entries(clause)[0];
      const result = compareValues((a as Row)[key], (b as Row)[key]);
      if (result !== 0) return direction === 'desc' ? -result : result;
    }
    return 0;
  });
}

function compareValues(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'es');
}

function paginate<T>(rows: T[], args: FindArgs): T[] {
  const start = args.skip ?? 0;
  const end = args.take === undefined ? undefined : start + args.take;
  return rows.slice(start, end);
}
