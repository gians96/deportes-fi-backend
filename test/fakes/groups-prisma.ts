import {
  GroupScope,
  ParticipantType,
  Prisma,
  PricingMode,
  RegistrationStatus,
  VoucherKind,
  VoucherStatus,
} from '@prisma/client';

/**
 * Fake de Prisma en memoria para las pruebas del pago por salón o ciclo (spec 002).
 *
 * - Simula la unicidad de `ClassGroup(eventId, schoolId, scope, cycle, section)` (error P2002).
 * - `$transaction` con callback hace rollback de grupos, vouchers y equipos si el callback falla.
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
}

export interface FakeGroupTeamRow {
  id: number;
  groupId: number | null;
  disciplineId: number;
  name: string;
  slot: number | null;
  status: RegistrationStatus;
  voucherId: number | null;
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

  private groupSeq: number;
  private voucherSeq: number;

  constructor(readonly data: GroupsDataset) {
    this.groupSeq = Math.max(0, ...data.groups.map((g) => g.id));
    this.voucherSeq = Math.max(0, ...data.vouchers.map((v) => v.id));
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
  };

  readonly discipline = {
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
      this.data.groups.splice(0, this.data.groups.length, ...snapshot.groups);
      this.data.vouchers.splice(
        0,
        this.data.vouchers.length,
        ...snapshot.vouchers,
      );
      this.data.teams.splice(0, this.data.teams.length, ...snapshot.teams);
      throw error;
    }
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
            .map((t) => ({ id: t.id })),
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
  const disciplines: FakeDisciplineRow[] = names.map((name, index) => ({
    id: 10 + index,
    eventId: 1,
    name,
    participantType: ParticipantType.STUDENT,
    registrationDeadline: future,
  }));
  disciplines.push({
    id: 99,
    eventId: 1,
    name: 'Fútbol externos',
    participantType: ParticipantType.OTHER,
    registrationDeadline: future,
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
      { id: 40, fullName: 'Delegada Uno' },
      { id: 41, fullName: 'Delegado Dos' },
      { id: 1, fullName: 'Admin' },
    ],
    groups: [],
    vouchers: [],
    teams: [],
  };
}
