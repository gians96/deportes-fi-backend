import {
  ParticipantType,
  Prisma,
  RegistrationStatus,
  Role,
  VoucherKind,
  VoucherStatus,
} from '@prisma/client';
import type {
  FakeDataset,
  FakeParticipant,
  FakeTeam,
  FakeVoucher,
} from './in-memory-prisma';

/**
 * Dos eventos con datos conocidos para verificar el resumen y el aislamiento.
 *
 * Evento A (id 1): 5 disciplinas, 11 equipos, 17 integrantes, 9 vouchers.
 * Evento B (id 2): datos "llamativos" (montos 999.99, nombres con "B") que no
 * deben aparecer nunca en respuestas de un token del evento A.
 */
export const EVENT_A_ID = 1;
export const EVENT_B_ID = 2;
export const OWNER_USER_ID = 1;
export const STUDENT_USER_ID = 2;

const D = (value: string) => new Prisma.Decimal(value);
const at = (minutes: number) =>
  new Date(Date.UTC(2026, 9, 1, 12, 0, 0) + minutes * 60_000);

let participantSeq = 0;
function participants(teamId: number, count: number): FakeParticipant[] {
  return Array.from({ length: count }, () => {
    participantSeq += 1;
    return {
      id: participantSeq,
      teamId,
      fullName: `INTEGRANTE ${participantSeq}`,
      studentCode: `20201${String(participantSeq).padStart(5, '0')}`,
      dni: `7${String(participantSeq).padStart(7, '0')}`,
    };
  });
}

function team(
  id: number,
  disciplineId: number,
  name: string,
  status: RegistrationStatus,
): FakeTeam {
  return {
    id,
    disciplineId,
    delegateId: STUDENT_USER_ID,
    name,
    phone: `9${String(id).padStart(8, '0')}`,
    status,
    createdAt: at(id),
  };
}

function voucher(
  id: number,
  teamId: number,
  amount: string,
  status: VoucherStatus,
): FakeVoucher {
  return {
    id,
    teamId,
    amount: D(amount),
    status,
    operationNumber: `OP-${id}`,
    imageUrl: `/uploads/vouchers/comprobante-${id}.jpg`,
    uploadedAt: at(id),
    updatedAt: at(id + 1),
  };
}

export function buildSportsDataset(): FakeDataset {
  participantSeq = 0;
  const teams: FakeTeam[] = [
    // Evento A
    team(100, 10, 'Los Bits', RegistrationStatus.APPROVED),
    team(101, 10, 'Compiladores FC', RegistrationStatus.APPROVED),
    team(102, 10, 'Null Pointers', RegistrationStatus.PENDING),
    team(103, 10, 'Stack Overflow', RegistrationStatus.REJECTED),
    team(104, 11, 'Voley Docentes', RegistrationStatus.APPROVED),
    team(105, 11, 'Voley Admin', RegistrationStatus.PENDING),
    team(106, 11, 'Voley Egresados', RegistrationStatus.CANCELLED),
    team(107, 12, 'Alfiles', RegistrationStatus.APPROVED),
    team(108, 12, 'Torres', RegistrationStatus.PENDING),
    team(109, 14, 'Raquetas 1', RegistrationStatus.APPROVED),
    team(110, 14, 'Raquetas 2', RegistrationStatus.APPROVED),
    // Evento B
    team(200, 20, 'Equipo B1 secreto', RegistrationStatus.APPROVED),
    team(201, 20, 'Equipo B2 secreto', RegistrationStatus.PENDING),
  ];

  const participantCounts: Record<number, number> = {
    100: 3,
    101: 2,
    102: 2,
    103: 1,
    104: 2,
    105: 1,
    106: 1,
    107: 1,
    108: 2,
    109: 1,
    110: 1,
    200: 5,
    201: 1,
  };

  return {
    events: [
      {
        id: EVENT_A_ID,
        name: 'Juegos Semana Sistémica 2026',
        description: '<p>Juegos de la semana</p>',
        facultyId: 1,
        startDate: new Date('2026-10-19T00:00:00.000Z'),
        endDate: new Date('2026-10-24T00:00:00.000Z'),
        isOpen: true,
      },
      {
        id: EVENT_B_ID,
        name: 'Olimpiadas B secretas',
        description: null,
        facultyId: 1,
        startDate: new Date('2026-11-02T00:00:00.000Z'),
        endDate: new Date('2026-11-06T00:00:00.000Z'),
        isOpen: false,
      },
    ],
    disciplines: [
      // Evento A
      {
        id: 10,
        eventId: EVENT_A_ID,
        name: 'Fútbol 7 varones',
        participantType: ParticipantType.STUDENT,
        isPaid: true,
        cost: D('50.00'),
      },
      {
        id: 11,
        eventId: EVENT_A_ID,
        name: 'Vóley mixto',
        participantType: ParticipantType.OTHER,
        isPaid: true,
        cost: D('12.50'),
      },
      {
        id: 12,
        eventId: EVENT_A_ID,
        name: 'Ajedrez',
        participantType: ParticipantType.STUDENT,
        isPaid: false,
        cost: D('0.00'),
      },
      {
        id: 13,
        eventId: EVENT_A_ID,
        name: 'Básquet damas',
        participantType: ParticipantType.STUDENT,
        isPaid: true,
        cost: D('30.00'),
      },
      {
        id: 14,
        eventId: EVENT_A_ID,
        name: 'Tenis de mesa',
        participantType: ParticipantType.OTHER,
        isPaid: true,
        cost: D('10.10'),
      },
      // Evento B
      {
        id: 20,
        eventId: EVENT_B_ID,
        name: 'Natación B secreta',
        participantType: ParticipantType.STUDENT,
        isPaid: true,
        cost: D('999.99'),
      },
    ],
    teams,
    participants: teams.flatMap((item) =>
      participants(item.id, participantCounts[item.id] ?? 0),
    ),
    vouchers: [
      // Evento A
      voucher(1000, 100, '50.00', VoucherStatus.VALIDATED),
      voucher(1001, 101, '50.00', VoucherStatus.VALIDATED),
      voucher(1002, 102, '50.00', VoucherStatus.PENDING),
      voucher(1003, 103, '50.00', VoucherStatus.REJECTED),
      voucher(1004, 104, '12.50', VoucherStatus.VALIDATED),
      voucher(1005, 105, '12.50', VoucherStatus.PENDING),
      voucher(1006, 106, '12.50', VoucherStatus.PENDING),
      voucher(1007, 109, '10.10', VoucherStatus.VALIDATED),
      voucher(1008, 110, '10.20', VoucherStatus.VALIDATED),
      // Evento B
      voucher(2000, 200, '999.99', VoucherStatus.VALIDATED),
      voucher(2001, 201, '999.99', VoucherStatus.PENDING),
    ],
    users: [
      {
        id: OWNER_USER_ID,
        email: 'owner.local@example.test',
        fullName: 'OWNER LOCAL',
        role: Role.OWNER_SYSTEM,
        isActive: true,
        tokenVersion: 0,
        studentCode: null,
      },
      {
        id: STUDENT_USER_ID,
        email: '2020100001@undc.edu.pe',
        fullName: 'ESTUDIANTE LOCAL',
        role: Role.STUDENT,
        isActive: true,
        tokenVersion: 0,
        studentCode: '2020100001',
      },
    ],
    tokens: [],
  };
}

/** Resumen esperado del evento A (calculado a mano desde el dataset). */
export const EXPECTED_SUMMARY_A = {
  teams: { total: 11, pending: 3, approved: 6, rejected: 1, cancelled: 1 },
  participants: { total: 17 },
  payments: {
    validated: { count: 5, amount: 132.8 },
    pending: { count: 3, amount: 75 },
    rejected: { count: 1, amount: 50 },
  },
  byDiscipline: [
    {
      disciplineId: 12,
      name: 'Ajedrez',
      participantType: 'STUDENT',
      isPaid: false,
      cost: 0,
      teams: { total: 2, approved: 1, pending: 1 },
      validatedAmount: 0,
      pendingAmount: 0,
    },
    {
      disciplineId: 13,
      name: 'Básquet damas',
      participantType: 'STUDENT',
      isPaid: true,
      cost: 30,
      teams: { total: 0, approved: 0, pending: 0 },
      validatedAmount: 0,
      pendingAmount: 0,
    },
    {
      disciplineId: 10,
      name: 'Fútbol 7 varones',
      participantType: 'STUDENT',
      isPaid: true,
      cost: 50,
      teams: { total: 4, approved: 2, pending: 1 },
      validatedAmount: 100,
      pendingAmount: 50,
    },
    {
      disciplineId: 14,
      name: 'Tenis de mesa',
      participantType: 'OTHER',
      isPaid: true,
      cost: 10.1,
      teams: { total: 2, approved: 2, pending: 0 },
      validatedAmount: 20.3,
      pendingAmount: 0,
    },
    {
      disciplineId: 11,
      name: 'Vóley mixto',
      participantType: 'OTHER',
      isPaid: true,
      cost: 12.5,
      teams: { total: 3, approved: 1, pending: 1 },
      validatedAmount: 12.5,
      pendingAmount: 25,
    },
  ],
  byParticipantType: [
    {
      participantType: 'STUDENT',
      teams: 6,
      validatedAmount: 100,
      pendingAmount: 50,
    },
    {
      participantType: 'OTHER',
      teams: 5,
      validatedAmount: 32.8,
      pendingAmount: 25,
    },
  ],
} as const;

/** Valores del evento B que jamás deben aparecer con un token del evento A. */
export const EVENT_B_MARKERS = ['secret', '999.99', 'Olimpiadas B'];

/** Datos personales que ninguna respuesta de integración debe exponer. */
export function sensitiveValues(dataset: FakeDataset): string[] {
  return [
    ...dataset.participants.flatMap((item) => [
      item.dni ?? '',
      item.studentCode ?? '',
      item.fullName,
    ]),
    ...dataset.teams.map((item) => item.phone ?? ''),
    ...dataset.vouchers.map((item) => item.imageUrl),
    ...dataset.users.map((item) => item.email),
    '/uploads/',
    '@',
  ].filter(Boolean);
}

/**
 * Dataset A con pagos compartidos (spec 002):
 * - grupo 1 (Sistemas, V-A1): pago BASE 3000 (S/100, VALIDATED) que cubre 3 equipos de las
 *   disciplinas 10, 12 y 13, y un EXTRA 3001 (S/20, PENDING) que cubre el equipo adicional 303;
 * - grupo 2 (Sistemas, VI ciclo completo): pago BASE 3002 (S/150, PENDING) sin equipos todavía;
 * - grupo 3 del evento B: pago BASE 4000 (S/999.99, VALIDATED) con el equipo 400.
 */
export function buildMixedDataset(): FakeDataset {
  const dataset = buildSportsDataset();
  const groupVoucher = (
    id: number,
    amount: string,
    status: VoucherStatus,
    kind: VoucherKind,
    groupId: number,
  ): FakeVoucher => ({
    ...voucher(id, 0, amount, status),
    teamId: null,
    kind,
    groupId,
  });
  const covered = (item: FakeTeam, voucherId: number): FakeTeam => ({
    ...item,
    voucherId,
  });

  dataset.groups = [
    {
      id: 1,
      eventId: EVENT_A_ID,
      schoolName: 'Ingeniería de Sistemas',
      scope: 'SECTION',
      cycle: 'V',
      section: 'A1',
    },
    {
      id: 2,
      eventId: EVENT_A_ID,
      schoolName: 'Ingeniería de Sistemas',
      scope: 'CYCLE',
      cycle: 'VI',
      section: '',
    },
    {
      id: 3,
      eventId: EVENT_B_ID,
      schoolName: 'Ingeniería Ambiental',
      scope: 'SECTION',
      cycle: 'II',
      section: 'B2',
    },
  ];
  const groupTeams = [
    covered(team(300, 10, 'Salón Fútbol', RegistrationStatus.APPROVED), 3000),
    covered(team(301, 12, 'Salón Ajedrez', RegistrationStatus.APPROVED), 3000),
    covered(team(302, 13, 'Salón Básquet', RegistrationStatus.APPROVED), 3000),
    covered(team(303, 10, 'Salón Fútbol B', RegistrationStatus.PENDING), 3001),
    covered(
      team(400, 20, 'Equipo del salón B', RegistrationStatus.APPROVED),
      4000,
    ),
  ];
  dataset.teams.push(...groupTeams);
  dataset.participants.push(
    ...groupTeams.flatMap((item) => participants(item.id, 1)),
  );
  dataset.vouchers.push(
    groupVoucher(3000, '100.00', VoucherStatus.VALIDATED, VoucherKind.BASE, 1),
    groupVoucher(3001, '20.00', VoucherStatus.PENDING, VoucherKind.EXTRA, 1),
    groupVoucher(3002, '150.00', VoucherStatus.PENDING, VoucherKind.BASE, 2),
    groupVoucher(4000, '999.99', VoucherStatus.VALIDATED, VoucherKind.BASE, 3),
  );
  return dataset;
}

/**
 * Resumen esperado del evento A con pagos compartidos. El pago base de S/100 se reparte en
 * centavos exactos entre sus 3 equipos (33.34 + 33.33 + 33.33, por orden de id).
 */
export const EXPECTED_SUMMARY_A_MIXED = {
  teams: { total: 15, pending: 4, approved: 9, rejected: 1, cancelled: 1 },
  participants: { total: 21 },
  payments: {
    validated: { count: 6, amount: 232.8 },
    pending: { count: 5, amount: 245 },
    rejected: { count: 1, amount: 50 },
  },
  byDiscipline: [
    {
      disciplineId: 12,
      name: 'Ajedrez',
      participantType: 'STUDENT',
      isPaid: false,
      cost: 0,
      teams: { total: 3, approved: 2, pending: 1 },
      validatedAmount: 33.33,
      pendingAmount: 0,
    },
    {
      disciplineId: 13,
      name: 'Básquet damas',
      participantType: 'STUDENT',
      isPaid: true,
      cost: 30,
      teams: { total: 1, approved: 1, pending: 0 },
      validatedAmount: 33.33,
      pendingAmount: 0,
    },
    {
      disciplineId: 10,
      name: 'Fútbol 7 varones',
      participantType: 'STUDENT',
      isPaid: true,
      cost: 50,
      teams: { total: 6, approved: 3, pending: 2 },
      validatedAmount: 133.34,
      pendingAmount: 70,
    },
    {
      disciplineId: 14,
      name: 'Tenis de mesa',
      participantType: 'OTHER',
      isPaid: true,
      cost: 10.1,
      teams: { total: 2, approved: 2, pending: 0 },
      validatedAmount: 20.3,
      pendingAmount: 0,
    },
    {
      disciplineId: 11,
      name: 'Vóley mixto',
      participantType: 'OTHER',
      isPaid: true,
      cost: 12.5,
      teams: { total: 3, approved: 1, pending: 1 },
      validatedAmount: 12.5,
      pendingAmount: 25,
    },
  ],
  byParticipantType: [
    {
      participantType: 'STUDENT',
      teams: 10,
      validatedAmount: 200,
      pendingAmount: 70,
    },
    {
      participantType: 'OTHER',
      teams: 5,
      validatedAmount: 32.8,
      pendingAmount: 25,
    },
  ],
} as const;
