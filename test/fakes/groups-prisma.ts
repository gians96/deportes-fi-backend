import {
  Gender,
  GenderPolicy,
  GroupScope,
  ParticipantType,
  Prisma,
  PricingMode,
  RegistrationStatus,
  Role,
  VoucherKind,
  VoucherStatus,
} from '@prisma/client';

/**
 * Fake de Prisma en memoria para las pruebas del pago por salón o ciclo (spec 002).
 *
 * - Simula la unicidad de `ClassGroup(eventId, schoolId, scope, cycle, section)` y de
 *   `Team(groupId, disciplineId, slot)` (error P2002).
 * - `$transaction` con callback hace rollback de grupos, vouchers y equipos si el callback falla.
 * - `competingTeamOnNextCreate` simula otra solicitud que gana el cupo justo antes del insert.
 * - Es estricto con los filtros de `classGroup.findMany`: ante una clave no soportada lanza un
 *   error, así una prueba falla si el código cambia de filtros sin actualizar el fake.
 * - Las consultas devuelven el registro con sus relaciones aunque el código pida un `select`
 *   menor (superconjunto), lo que basta para estas pruebas.
 */

export interface FakeDisciplineRow {
  id: number;
  eventId: number;
  name: string;
  participantType: ParticipantType;
  registrationDeadline: Date;
  minPlayers: number;
  maxPlayers: number;
  genderPolicy: GenderPolicy;
  maxTeams: number;
  isPaid: boolean;
  cost: Prisma.Decimal;
}

export interface FakePricingRow {
  sectionBase: Prisma.Decimal;
  cycleBase: Prisma.Decimal;
  sectionExtra: Prisma.Decimal;
  cycleExtra: Prisma.Decimal;
}

export interface FakeEventRow {
  id: number;
  name: string;
  facultyId: number;
  schoolId: number | null;
  isOpen: boolean;
  pricingMode: PricingMode;
  pricing: FakePricingRow | null;
  disciplines: FakeDisciplineRow[];
}

export interface FakeSchoolRow {
  id: number;
  name: string;
  facultyId: number;
}

export interface FakeUserRow {
  id: number;
  fullName: string;
  role: Role;
  email: string;
  studentCode: string | null;
  dni: string | null;
}

export interface FakeGroupRow {
  id: number;
  eventId: number;
  schoolId: number;
  scope: GroupScope;
  cycle: string;
  section: string;
  delegateId: number;
  baseVoucherId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeGroupVoucherRow {
  id: number;
  kind: VoucherKind;
  groupId: number | null;
  teamId: number | null;
  amount: Prisma.Decimal;
  operationNumber: string | null;
  imageUrl: string;
  status: VoucherStatus;
  rejectionReason: string | null;
  validatedById: number | null;
  uploadedAt?: Date;
}

export interface FakeParticipantRow {
  fullName: string;
  studentCode: string | null;
  dni: string | null;
  gender: Gender;
  isDelegate: boolean;
  countsAsPlayer: boolean;
  isCaptain: boolean;
  userId: number | null;
}

export interface FakeGroupTeamRow {
  id: number;
  groupId: number | null;
  disciplineId: number;
  name: string;
  slot: number | null;
  status: RegistrationStatus;
  voucherId: number | null;
  delegateId?: number;
  cycle?: string | null;
  section?: string | null;
  phone?: string | null;
  rejectionReason?: string | null;
  participants?: FakeParticipantRow[];
}

export interface GroupsDataset {
  events: FakeEventRow[];
  schools: FakeSchoolRow[];
  users: FakeUserRow[];
  groups: FakeGroupRow[];
  vouchers: FakeGroupVoucherRow[];
  teams: FakeGroupTeamRow[];
}

type Row = Record<string, unknown>;
interface WhereArgs {
  where: Row;
}
interface CreateArgs<T> {
  data: T;
}

const SUPPORTED_GROUP_FILTERS = [
  'eventId',
  'schoolId',
  'cycle',
  'delegateId',
  'baseVoucher',
];

function uniqueViolation(): Error {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
  });
}

export class GroupsPrisma {
  readonly transactionOptions: unknown[] = [];
  /** Si se asigna, la próxima transacción con callback lanza este error (un solo uso). */
  failNextTransactionWith: { code: string } | null = null;
  /** Si es true, el próximo `voucher.create` falla (para probar el rollback). */
  failNextVoucherCreate = false;
  /**
   * Si se asigna, el próximo `team.create` pierde la carrera: otra solicitud (ya confirmada)
   * toma ese cupo justo antes y el insert falla con P2002.
   */
  competingTeamOnNextCreate: { name: string } | null = null;

  private groupSeq: number;
  private voucherSeq: number;
  private teamSeq: number;
  private committedByOthers: FakeGroupTeamRow[] = [];

  constructor(readonly data: GroupsDataset) {
    this.groupSeq = Math.max(0, ...data.groups.map((g) => g.id));
    this.voucherSeq = Math.max(0, ...data.vouchers.map((v) => v.id));
    this.teamSeq = Math.max(0, ...data.teams.map((t) => t.id));
  }

  readonly sportEvent = {
    findUnique: ({ where }: WhereArgs) => {
      const event = this.data.events.find((e) => e.id === where.id);
      return Promise.resolve(event ? { ...event } : null);
    },
  };

  readonly professionalSchool = {
    findUnique: ({ where }: WhereArgs) => {
      const school = this.data.schools.find((s) => s.id === where.id);
      return Promise.resolve(school ? { ...school } : null);
    },
  };

  readonly user = {
    findUnique: ({ where }: WhereArgs) => {
      const user = this.data.users.find((u) => u.id === where.id);
      return Promise.resolve(user ? { ...user } : null);
    },
    findMany: ({ where }: { where: { OR: Row[] } }) => {
      const codes = where.OR.flatMap((clause) =>
        clause.studentCode ? (clause.studentCode as { in: string[] }).in : [],
      );
      const dnis = where.OR.flatMap((clause) =>
        clause.dni ? (clause.dni as { in: string[] }).in : [],
      );
      return Promise.resolve(
        this.data.users
          .filter(
            (u) =>
              (u.studentCode && codes.includes(u.studentCode)) ||
              (u.dni && dnis.includes(u.dni)),
          )
          .map((u) => ({ ...u })),
      );
    },
  };

  /** Disciplina con su evento y el conteo de equipos, como la devuelve `discipline.findUnique`. */
  private disciplineWithEvent(id: number) {
    for (const event of this.data.events) {
      const discipline = event.disciplines.find((d) => d.id === id);
      if (discipline) {
        return {
          ...discipline,
          _count: {
            teams: this.data.teams.filter((t) => t.disciplineId === id).length,
          },
          event: {
            id: event.id,
            pricingMode: event.pricingMode,
            isOpen: event.isOpen,
            pricing: event.pricing,
          },
        };
      }
    }
    return null;
  }

  readonly discipline = {
    findUnique: ({ where }: WhereArgs) =>
      Promise.resolve(this.disciplineWithEvent(where.id as number)),
    findMany: ({ where }: WhereArgs) => {
      const disciplines = this.data.events
        .filter((e) => e.id === where.eventId)
        .flatMap((e) => e.disciplines)
        .filter((d) => d.participantType === where.participantType)
        .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
        .map((d) => ({ id: d.id, name: d.name }));
      return Promise.resolve(disciplines);
    },
  };

  readonly classGroup = {
    findMany: ({ where }: { where?: Row }) => {
      const filters = where ?? {};
      for (const key of Object.keys(filters)) {
        if (!SUPPORTED_GROUP_FILTERS.includes(key)) {
          throw new Error(`classGroup.findMany: filtro no soportado "${key}"`);
        }
      }
      const rows = this.data.groups
        .filter((group) => this.matches(group, filters))
        .sort((a, b) => b.id - a.id)
        .map((group) => this.join(group));
      return Promise.resolve(rows);
    },
    findUnique: ({ where }: WhereArgs) => {
      const group = this.data.groups.find((g) => g.id === where.id);
      return Promise.resolve(group ? this.join(group) : null);
    },
    count: ({ where }: WhereArgs) =>
      Promise.resolve(
        this.data.groups.filter((g) => g.eventId === where.eventId).length,
      ),
    create: ({
      data,
    }: CreateArgs<
      Pick<
        FakeGroupRow,
        'eventId' | 'schoolId' | 'scope' | 'cycle' | 'section' | 'delegateId'
      >
    >) => {
      const duplicate = this.data.groups.some(
        (g) =>
          g.eventId === data.eventId &&
          g.schoolId === data.schoolId &&
          g.scope === data.scope &&
          g.cycle === data.cycle &&
          g.section === data.section,
      );
      if (duplicate) {
        return Promise.reject(uniqueViolation());
      }
      const now = new Date();
      const row: FakeGroupRow = {
        id: ++this.groupSeq,
        ...data,
        baseVoucherId: null,
        createdAt: now,
        updatedAt: now,
      };
      this.data.groups.push(row);
      return Promise.resolve({ ...row });
    },
    update: ({ where, data }: WhereArgs & { data: Partial<FakeGroupRow> }) => {
      const group = this.data.groups.find((g) => g.id === where.id);
      if (!group) return Promise.reject(new Error('Group not found'));
      Object.assign(group, data);
      return Promise.resolve({ ...group });
    },
  };

  readonly team = {
    findMany: ({ where }: WhereArgs) =>
      Promise.resolve(
        this.data.teams
          .filter(
            (t) =>
              t.groupId === where.groupId &&
              t.disciplineId === where.disciplineId,
          )
          .map((t) => ({ ...t })),
      ),
    create: ({
      data,
    }: CreateArgs<{
      name: string;
      disciplineId: number;
      delegateId: number;
      cycle: string | null;
      section: string | null;
      phone?: string | null;
      status: RegistrationStatus;
      groupId?: number | null;
      slot?: number | null;
      voucherId?: number | null;
      participants: { create: FakeParticipantRow[] };
    }>) => {
      const groupId = data.groupId ?? null;
      const slot = data.slot ?? null;
      if (this.competingTeamOnNextCreate && groupId !== null) {
        const competing = this.competingTeamOnNextCreate;
        this.competingTeamOnNextCreate = null;
        this.committedByOthers.push({
          id: ++this.teamSeq,
          groupId,
          disciplineId: data.disciplineId,
          name: competing.name,
          slot,
          status: RegistrationStatus.PENDING,
          voucherId: data.voucherId ?? null,
        });
        this.data.teams.push(
          ...this.committedByOthers.slice(-1).map((t) => ({ ...t })),
        );
      }
      const clash =
        groupId !== null &&
        slot !== null &&
        this.data.teams.some(
          (t) =>
            t.groupId === groupId &&
            t.disciplineId === data.disciplineId &&
            t.slot === slot,
        );
      if (clash) {
        return Promise.reject(uniqueViolation());
      }
      const row: FakeGroupTeamRow = {
        id: ++this.teamSeq,
        groupId,
        disciplineId: data.disciplineId,
        name: data.name,
        slot,
        status: data.status,
        voucherId: data.voucherId ?? null,
        delegateId: data.delegateId,
        cycle: data.cycle,
        section: data.section,
        phone: data.phone ?? null,
        participants: data.participants.create.map((p) => ({ ...p })),
      };
      this.data.teams.push(row);
      return Promise.resolve({ id: row.id });
    },
    findUnique: ({ where }: WhereArgs) => {
      const team = this.data.teams.find((t) => t.id === where.id);
      if (!team) return Promise.resolve(null);
      const voucher =
        this.data.vouchers.find((v) => v.id === team.voucherId) ?? null;
      const group = this.data.groups.find((g) => g.id === team.groupId);
      return Promise.resolve({
        ...team,
        participants: (team.participants ?? []).map((p) => ({ ...p })),
        voucher: voucher ? { ...voucher } : null,
        group: group
          ? { id: group.id, delegateId: group.delegateId, scope: group.scope }
          : null,
        discipline: this.disciplineWithEvent(team.disciplineId),
      });
    },
    delete: ({ where }: WhereArgs) => {
      const index = this.data.teams.findIndex((t) => t.id === where.id);
      if (index < 0) return Promise.reject(new Error('Team not found'));
      const [removed] = this.data.teams.splice(index, 1);
      return Promise.resolve({ ...removed });
    },
    count: ({
      where,
    }: {
      where: { voucherId?: number; slot?: { not: null } };
    }) =>
      Promise.resolve(
        this.data.teams.filter(
          (t) =>
            (where.voucherId === undefined ||
              t.voucherId === where.voucherId) &&
            (where.slot === undefined || t.slot !== null),
        ).length,
      ),
    updateMany: ({
      where,
      data,
    }: {
      where: { id?: { in: number[] }; voucherId?: number; status?: string };
      data: Partial<FakeGroupTeamRow>;
    }) => {
      const targets = this.data.teams.filter(
        (t) =>
          (where.id === undefined || where.id.in.includes(t.id)) &&
          (where.voucherId === undefined || t.voucherId === where.voucherId) &&
          (where.status === undefined || t.status === where.status),
      );
      for (const team of targets) Object.assign(team, data);
      return Promise.resolve({ count: targets.length });
    },
    update: ({
      where,
      data,
    }: WhereArgs & { data: Partial<FakeGroupTeamRow> }) => {
      const team = this.data.teams.find((t) => t.id === where.id);
      if (!team) return Promise.reject(new Error('Team not found'));
      Object.assign(team, data);
      return Promise.resolve({ ...team });
    },
  };

  readonly participant = {
    deleteMany: ({ where }: { where: { teamId: number } }) => {
      const team = this.data.teams.find((t) => t.id === where.teamId);
      const count = team?.participants?.length ?? 0;
      if (team) team.participants = [];
      return Promise.resolve({ count });
    },
    createMany: ({
      data,
    }: {
      data: Array<FakeParticipantRow & { teamId: number }>;
    }) => {
      for (const { teamId, ...row } of data) {
        const team = this.data.teams.find((t) => t.id === teamId);
        if (team) (team.participants ??= []).push({ ...row });
      }
      return Promise.resolve({ count: data.length });
    },
    findMany: ({ where }: { where: { teamId: { in: number[] } } }) =>
      Promise.resolve(
        this.data.teams
          .filter((t) => where.teamId.in.includes(t.id))
          .flatMap((t) =>
            (t.participants ?? []).map((p, index) => ({
              ...p,
              id: t.id * 1000 + index,
              teamId: t.id,
            })),
          ),
      ),
  };

  readonly voucher = {
    create: ({
      data,
    }: CreateArgs<
      Pick<
        FakeGroupVoucherRow,
        'kind' | 'groupId' | 'amount' | 'imageUrl' | 'status'
      > & { operationNumber?: string | null }
    >) => {
      if (this.failNextVoucherCreate) {
        this.failNextVoucherCreate = false;
        return Promise.reject(new Error('voucher.create falló'));
      }
      const row: FakeGroupVoucherRow = {
        id: ++this.voucherSeq,
        kind: data.kind,
        groupId: data.groupId,
        teamId: null,
        amount: new Prisma.Decimal(data.amount),
        operationNumber: data.operationNumber ?? null,
        imageUrl: data.imageUrl,
        status: data.status,
        rejectionReason: null,
        validatedById: null,
      };
      this.data.vouchers.push(row);
      return Promise.resolve({ ...row });
    },
    findUnique: ({ where }: WhereArgs) => {
      const voucher = this.data.vouchers.find((v) => v.id === where.id);
      if (!voucher) return Promise.resolve(null);
      return Promise.resolve({
        ...voucher,
        _count: {
          teams: this.data.teams.filter(
            (t) => t.voucherId === voucher.id && t.slot !== null,
          ).length,
        },
        team: this.teamWithRelations(
          this.data.teams.find((t) => t.id === voucher.teamId),
        ),
        teams: this.data.teams
          .filter((t) => t.voucherId === voucher.id)
          .sort((a, b) => a.id - b.id)
          .map((t) => this.teamWithRelations(t)),
        group: this.data.groups.find((g) => g.id === voucher.groupId) ?? null,
      });
    },
    findMany: ({ where }: { where: Row }) =>
      Promise.resolve(
        this.data.vouchers
          .filter((v) => this.voucherMatches(v, where))
          .sort(
            (a, b) =>
              (b.uploadedAt?.getTime() ?? 0) - (a.uploadedAt?.getTime() ?? 0) ||
              b.id - a.id,
          )
          .map((v) => this.voucherListRow(v)),
      ),
    delete: ({ where }: WhereArgs) => {
      const index = this.data.vouchers.findIndex((v) => v.id === where.id);
      if (index < 0) return Promise.reject(new Error('Voucher not found'));
      const [removed] = this.data.vouchers.splice(index, 1);
      // Como `onDelete: SetNull` de Team.voucherId.
      for (const team of this.data.teams) {
        if (team.voucherId === removed.id) team.voucherId = null;
      }
      return Promise.resolve({ ...removed });
    },
    update: ({
      where,
      data,
    }: WhereArgs & { data: Partial<FakeGroupVoucherRow> }) => {
      const voucher = this.data.vouchers.find((v) => v.id === where.id);
      if (!voucher) return Promise.reject(new Error('Voucher not found'));
      Object.assign(voucher, data);
      if (data.amount !== undefined) {
        voucher.amount = new Prisma.Decimal(data.amount);
      }
      return Promise.resolve({ ...voucher });
    },
  };

  async $transaction(
    arg: ((tx: this) => Promise<unknown>) | Promise<unknown>[],
    options?: unknown,
  ): Promise<unknown> {
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    this.transactionOptions.push(options);
    if (this.failNextTransactionWith) {
      const error = this.failNextTransactionWith;
      this.failNextTransactionWith = null;
      throw Object.assign(new Error('Transacción fallida'), error);
    }
    const snapshot = {
      groups: this.data.groups.map((g) => ({ ...g })),
      vouchers: this.data.vouchers.map((v) => ({ ...v })),
      teams: this.data.teams.map((t) => ({ ...t })),
    };
    try {
      return await arg(this);
    } catch (error) {
      this.restore(this.data.groups, snapshot.groups);
      this.restore(this.data.vouchers, snapshot.vouchers);
      this.restore(this.data.teams, snapshot.teams);
      // Lo confirmado por otras solicitudes durante la transacción sobrevive al rollback.
      for (const other of this.committedByOthers) {
        if (!this.data.teams.some((t) => t.id === other.id)) {
          this.data.teams.push({ ...other });
        }
      }
      throw error;
    }
  }

  /**
   * Deshace una transacción conservando la identidad de los objetos: las filas que existían se
   * restauran en el mismo objeto (las referencias que tenga una prueba siguen vigentes) y las
   * creadas dentro de la transacción desaparecen.
   */
  private restore<T extends { id: number }>(live: T[], snapshot: T[]): void {
    const byId = new Map(live.map((row) => [row.id, row]));
    const restored = snapshot.map((saved) => {
      const current = byId.get(saved.id);
      if (!current) return saved;
      Object.assign(current, saved);
      return current;
    });
    live.splice(0, live.length, ...restored);
  }

  private teamWithRelations(team: FakeGroupTeamRow | undefined) {
    if (!team) return null;
    const discipline = this.data.events
      .flatMap((e) => e.disciplines)
      .find((d) => d.id === team.disciplineId);
    return {
      ...team,
      participants: (team.participants ?? []).map((p) => ({ ...p })),
      discipline: discipline ? { ...discipline } : null,
    };
  }

  private schoolRef(id: number) {
    const school = this.data.schools.find((s) => s.id === id);
    return { id, name: school?.name ?? '' };
  }

  private eventRef(eventId: number) {
    const event = this.data.events.find((e) => e.id === eventId);
    return {
      id: eventId,
      name: event?.name ?? '',
      faculty: { id: event?.facultyId ?? 0, name: 'Facultad de Ingeniería' },
      school: event?.schoolId ? this.schoolRef(event.schoolId) : null,
    };
  }

  private disciplineView(disciplineId: number) {
    const discipline = this.data.events
      .flatMap((e) => e.disciplines)
      .find((d) => d.id === disciplineId);
    return {
      id: disciplineId,
      name: discipline?.name ?? '',
      participantType: discipline?.participantType ?? ParticipantType.STUDENT,
      minPlayers: discipline?.minPlayers ?? 0,
      maxPlayers: discipline?.maxPlayers ?? 0,
      genderPolicy: discipline?.genderPolicy ?? GenderPolicy.FREE,
      event: this.eventRef(discipline?.eventId ?? 0),
    };
  }

  private voucherListRow(voucher: FakeGroupVoucherRow) {
    const group = this.data.groups.find((g) => g.id === voucher.groupId);
    return {
      ...voucher,
      uploadedAt: voucher.uploadedAt ?? new Date(0),
      group: group
        ? {
            ...group,
            school: this.schoolRef(group.schoolId),
            event: this.eventRef(group.eventId),
          }
        : null,
      teams: this.data.teams
        .filter((t) => t.voucherId === voucher.id)
        .sort((a, b) => a.id - b.id)
        .map((t) => ({
          id: t.id,
          name: t.name,
          cycle: t.cycle ?? null,
          section: t.section ?? null,
          phone: t.phone ?? null,
          slot: t.slot,
          status: t.status,
          discipline: this.disciplineView(t.disciplineId),
        })),
    };
  }

  private voucherMatches(voucher: FakeGroupVoucherRow, where: Row): boolean {
    for (const [key, expected] of Object.entries(where)) {
      if (key === 'status') {
        if (voucher.status !== expected) return false;
      } else if (key === 'OR') {
        const clauses = expected as Row[];
        if (!clauses.some((clause) => this.voucherClause(voucher, clause))) {
          return false;
        }
      } else {
        throw new Error(`voucher.findMany: filtro no soportado "${key}"`);
      }
    }
    return true;
  }

  private voucherClause(voucher: FakeGroupVoucherRow, clause: Row): boolean {
    if ('teams' in clause) {
      const teamWhere = (clause.teams as { some: Row }).some;
      return this.data.teams.some(
        (t) => t.voucherId === voucher.id && this.teamMatches(t, teamWhere),
      );
    }
    if ('group' in clause) {
      const group = this.data.groups.find((g) => g.id === voucher.groupId);
      if (!group) return false;
      const groupWhere = clause.group as Row;
      return Object.entries(groupWhere).every(([key, expected]) => {
        if (key === 'eventId') return group.eventId === expected;
        if (key === 'event')
          return this.eventMatches(group.eventId, expected as Row);
        throw new Error(
          `voucher.findMany: filtro de grupo no soportado "${key}"`,
        );
      });
    }
    throw new Error('voucher.findMany: cláusula OR no soportada');
  }

  private teamMatches(team: FakeGroupTeamRow, where: Row): boolean {
    return Object.entries(where).every(([key, expected]) => {
      if (key === 'disciplineId') return team.disciplineId === expected;
      if (key === 'discipline') {
        const discipline = this.data.events
          .flatMap((e) => e.disciplines)
          .find((d) => d.id === team.disciplineId);
        if (!discipline) return false;
        return Object.entries(expected as Row).every(([dKey, dExpected]) => {
          if (dKey === 'eventId') return discipline.eventId === dExpected;
          if (dKey === 'event') {
            return this.eventMatches(discipline.eventId, dExpected as Row);
          }
          throw new Error(
            `voucher.findMany: filtro de disciplina no soportado "${dKey}"`,
          );
        });
      }
      throw new Error(
        `voucher.findMany: filtro de equipo no soportado "${key}"`,
      );
    });
  }

  private eventMatches(eventId: number, filter: Row): boolean {
    const event = this.data.events.find((e) => e.id === eventId);
    if (!event) return false;
    return Object.entries(filter).every(([key, expected]) => {
      if (key === 'facultyId') return event.facultyId === expected;
      if (key === 'schoolId') return event.schoolId === expected;
      throw new Error(
        `voucher.findMany: filtro de evento no soportado "${key}"`,
      );
    });
  }

  private matches(group: FakeGroupRow, filters: Row): boolean {
    for (const [key, expected] of Object.entries(filters)) {
      if (key === 'baseVoucher') {
        const voucher = this.data.vouchers.find(
          (v) => v.id === group.baseVoucherId,
        );
        const wanted = (expected as { status: VoucherStatus }).status;
        if (!voucher || voucher.status !== wanted) return false;
        continue;
      }
      if ((group as unknown as Row)[key] !== expected) return false;
    }
    return true;
  }

  private join(group: FakeGroupRow) {
    const school = this.data.schools.find((s) => s.id === group.schoolId);
    const delegate = this.data.users.find((u) => u.id === group.delegateId);
    const baseVoucher =
      this.data.vouchers.find((v) => v.id === group.baseVoucherId) ?? null;
    return {
      ...group,
      school: { id: school?.id ?? 0, name: school?.name ?? '' },
      delegate: { id: delegate?.id ?? 0, fullName: delegate?.fullName ?? '' },
      baseVoucher: baseVoucher ? { ...baseVoucher } : null,
      vouchers: this.data.vouchers
        .filter((v) => v.groupId === group.id && v.kind === VoucherKind.EXTRA)
        .sort((a, b) => a.id - b.id)
        .map((v) => ({
          ...v,
          teams: this.data.teams
            .filter((t) => t.voucherId === v.id)
            .map((t) => ({ id: t.id, status: t.status })),
        })),
      teams: this.data.teams
        .filter((t) => t.groupId === group.id)
        .sort((a, b) => a.disciplineId - b.disciplineId || a.id - b.id)
        .map((t) => ({ ...t })),
    };
  }
}

/** Evento `PER_GROUP` con 5 disciplinas de estudiantes, 1 de otros y tarifas 100/150/20/30. */
export function buildGroupsDataset(
  overrides: Partial<FakeEventRow> = {},
): GroupsDataset {
  const future = new Date('2099-12-31T23:59:00.000Z');
  const names = ['Gincana', 'Ajedrez', 'Futsal', 'Voley', 'Basquet'];
  const baseDiscipline = {
    eventId: 1,
    registrationDeadline: future,
    minPlayers: 1,
    maxPlayers: 9,
    genderPolicy: GenderPolicy.FREE,
    maxTeams: 0,
    isPaid: false,
    cost: new Prisma.Decimal(0),
  };
  const disciplines: FakeDisciplineRow[] = names.map((name, index) => ({
    ...baseDiscipline,
    id: 10 + index,
    name,
    participantType: ParticipantType.STUDENT,
  }));
  disciplines.push({
    ...baseDiscipline,
    id: 99,
    name: 'Fútbol externos',
    participantType: ParticipantType.OTHER,
  });

  return {
    events: [
      {
        id: 1,
        name: 'Juegos de Ingeniería',
        facultyId: 1,
        schoolId: null,
        isOpen: true,
        pricingMode: PricingMode.PER_GROUP,
        pricing: {
          sectionBase: new Prisma.Decimal('100'),
          cycleBase: new Prisma.Decimal('150'),
          sectionExtra: new Prisma.Decimal('20'),
          cycleExtra: new Prisma.Decimal('30'),
        },
        disciplines,
        ...overrides,
      },
    ],
    schools: [
      { id: 1, name: 'Ingeniería de Sistemas', facultyId: 1 },
      { id: 2, name: 'Ingeniería Ambiental', facultyId: 1 },
      { id: 3, name: 'Derecho', facultyId: 2 },
    ],
    users: [
      {
        id: 40,
        fullName: 'Delegada Uno',
        role: Role.STUDENT,
        email: '2301010149@undc.edu.pe',
        studentCode: '2301010149',
        dni: null,
      },
      {
        id: 41,
        fullName: 'Delegado Dos',
        role: Role.STUDENT,
        email: '2301010150@undc.edu.pe',
        studentCode: '2301010150',
        dni: null,
      },
      {
        id: 1,
        fullName: 'Admin',
        role: Role.ADMIN_SYSTEM,
        email: 'admin@undc.edu.pe',
        studentCode: null,
        dni: null,
      },
      {
        id: 60,
        fullName: 'Externo',
        role: Role.OTHER,
        email: 'externo@gmail.com',
        studentCode: null,
        dni: '70000001',
      },
    ],
    groups: [],
    vouchers: [],
    teams: [],
  };
}
