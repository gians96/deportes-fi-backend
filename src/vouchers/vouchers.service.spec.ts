import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  Gender,
  GroupScope,
  Prisma,
  RegistrationStatus,
  Role,
  VoucherKind,
  VoucherStatus,
} from '@prisma/client';
import type { RequestUser } from '../common/decorators/current-user.decorator';
import type { PrismaService } from '../prisma/prisma.service';
import {
  buildGroupsDataset,
  GroupsPrisma,
} from '../../test/fakes/groups-prisma';
import type {
  FakeGroupTeamRow,
  FakeGroupVoucherRow,
  FakeParticipantRow,
} from '../../test/fakes/groups-prisma';
import { VouchersService } from './vouchers.service';

const ADMIN_ID = 1;
const DELEGATE_ID = 40;
const STRANGER_ID = 41;
const GROUP_ID = 5;
const BASE = 100;
const EXTRA = 101;
const TEAM_VOUCHER = 200;
const FUTSAL = 12;
const VOLEY = 13;
const AJEDREZ = 11;

const asUser = (id: number, role: Role): RequestUser => ({
  id,
  role,
  email: `${id}@undc.edu.pe`,
  fullName: `Usuario ${id}`,
});
const admin = asUser(ADMIN_ID, Role.ADMIN_SYSTEM);
const delegate = asUser(DELEGATE_ID, Role.STUDENT);
const stranger = asUser(STRANGER_ID, Role.STUDENT);

function members(
  count: number,
  seed: number,
  options: { captain?: boolean } = {},
): FakeParticipantRow[] {
  const { captain = true } = options;
  return Array.from({ length: count }, (_, i) => ({
    fullName: `ALUMNO ${seed}-${i + 1}`,
    studentCode: String(2300000000 + seed * 100 + i),
    dni: String(70000000 + seed * 100 + i),
    gender: Gender.O,
    isDelegate: false,
    countsAsPlayer: true,
    isCaptain: captain && i === 0,
    userId: null,
  }));
}

function groupTeam(
  id: number,
  disciplineId: number,
  overrides: Partial<FakeGroupTeamRow> = {},
): FakeGroupTeamRow {
  return {
    id,
    groupId: GROUP_ID,
    disciplineId,
    name: `Equipo ${id}`,
    slot: 1,
    status: RegistrationStatus.PENDING,
    voucherId: BASE,
    delegateId: DELEGATE_ID,
    cycle: 'V',
    section: 'A1',
    phone: '999999999',
    participants: members(3, id),
    ...overrides,
  };
}

function voucherRow(
  id: number,
  kind: VoucherKind,
  overrides: Partial<FakeGroupVoucherRow> = {},
): FakeGroupVoucherRow {
  return {
    id,
    kind,
    groupId: kind === VoucherKind.TEAM ? null : GROUP_ID,
    teamId: null,
    amount: new Prisma.Decimal(kind === VoucherKind.EXTRA ? '20' : '100'),
    operationNumber: String(id),
    imageUrl: `/uploads/vouchers/v${id}.png`,
    status: VoucherStatus.PENDING,
    rejectionReason: null,
    validatedById: null,
    uploadedAt: new Date(2026, 9, 13, 8, id % 60),
    ...overrides,
  };
}

/**
 * Salón V-A1 con pago base (equipos de Futsal, Voley y Ajedrez), un equipo adicional de Futsal con
 * su comprobante EXTRA y un equipo de un evento por disciplina con voucher TEAM.
 */
function build() {
  const dataset = buildGroupsDataset();
  dataset.groups.push({
    id: GROUP_ID,
    eventId: 1,
    schoolId: 1,
    scope: GroupScope.SECTION,
    cycle: 'V',
    section: 'A1',
    delegateId: DELEGATE_ID,
    baseVoucherId: BASE,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  dataset.vouchers.push(
    voucherRow(BASE, VoucherKind.BASE),
    voucherRow(EXTRA, VoucherKind.EXTRA),
    voucherRow(TEAM_VOUCHER, VoucherKind.TEAM, {
      teamId: 50,
      amount: new Prisma.Decimal('50'),
    }),
  );
  dataset.teams.push(
    groupTeam(1, FUTSAL),
    groupTeam(2, VOLEY),
    groupTeam(3, AJEDREZ),
    groupTeam(4, FUTSAL, { slot: 2, voucherId: EXTRA }),
    {
      id: 50,
      groupId: null,
      disciplineId: FUTSAL,
      name: 'Equipo por disciplina',
      slot: null,
      status: RegistrationStatus.PENDING,
      voucherId: TEAM_VOUCHER,
      delegateId: STRANGER_ID,
      cycle: 'VIII',
      section: 'A',
      phone: '988888888',
      participants: members(3, 50, { captain: false }),
    },
  );
  const prisma = new GroupsPrisma(dataset);
  const service = new VouchersService(prisma as unknown as PrismaService);
  const status = (teamId: number) =>
    prisma.data.teams.find((t) => t.id === teamId)?.status;
  const voucher = (id: number) =>
    prisma.data.vouchers.find((v) => v.id === id) as FakeGroupVoucherRow;
  return { prisma, service, status, voucher };
}

describe('VouchersService.validate', () => {
  describe('voucher BASE (pago general del salón)', () => {
    it('valida el pago una vez y aprueba los equipos que cubre', async () => {
      const { service, status, voucher } = build();

      const result = await service.validate(BASE, ADMIN_ID);

      expect(result).toMatchObject({
        id: BASE,
        status: VoucherStatus.VALIDATED,
        validatedById: ADMIN_ID,
        approvedTeamIds: [1, 2, 3],
        skipped: [],
      });
      expect(voucher(BASE).status).toBe(VoucherStatus.VALIDATED);
      expect([1, 2, 3].map(status)).toEqual([
        RegistrationStatus.APPROVED,
        RegistrationStatus.APPROVED,
        RegistrationStatus.APPROVED,
      ]);
    });

    it('no aprueba los equipos que cubre otro comprobante ni los de otro flujo', async () => {
      const { service, status } = build();
      await service.validate(BASE, ADMIN_ID);
      expect(status(4)).toBe(RegistrationStatus.PENDING);
      expect(status(50)).toBe(RegistrationStatus.PENDING);
    });

    it('deja PENDING al equipo que no cumple y lo informa con su motivo', async () => {
      const { prisma, service, status } = build();
      prisma.data.teams.find((t) => t.id === 2)!.participants = members(3, 2, {
        captain: false,
      });

      const result = await service.validate(BASE, ADMIN_ID);

      expect(result).toMatchObject({
        approvedTeamIds: [1, 3],
        skipped: [{ teamId: 2, reason: 'Designa un capitán/a del equipo' }],
      });
      expect(status(2)).toBe(RegistrationStatus.PENDING);
      expect(status(1)).toBe(RegistrationStatus.APPROVED);
    });

    it('informa las reglas de la disciplina que no se cumplen', async () => {
      const { prisma, service } = build();
      prisma.data.teams.find((t) => t.id === 3)!.participants = members(10, 3);

      const result = await service.validate(BASE, ADMIN_ID);

      const { approvedTeamIds, skipped } = result as unknown as {
        approvedTeamIds: number[];
        skipped: { teamId: number; reason: string }[];
      };
      expect(approvedTeamIds).toEqual([1, 2]);
      expect(skipped).toHaveLength(1);
      expect(skipped[0].teamId).toBe(3);
      expect(skipped[0].reason).toContain('entre 1 y 9 jugadores');
    });

    it('ignora a los equipos rechazados o ya aprobados', async () => {
      const { prisma, service, status } = build();
      prisma.data.teams.find((t) => t.id === 1)!.status =
        RegistrationStatus.REJECTED;
      prisma.data.teams.find((t) => t.id === 2)!.status =
        RegistrationStatus.APPROVED;

      const result = await service.validate(BASE, ADMIN_ID);

      expect(result).toMatchObject({ approvedTeamIds: [3], skipped: [] });
      expect(status(1)).toBe(RegistrationStatus.REJECTED);
    });

    it('rechaza validar un pago base sin equipos', async () => {
      const { prisma, service, voucher } = build();
      prisma.data.teams.splice(0, prisma.data.teams.length);

      await expect(service.validate(BASE, ADMIN_ID)).rejects.toThrow(
        'El salón aún no envió ningún equipo',
      );
      expect(voucher(BASE).status).toBe(VoucherStatus.PENDING);
    });

    it('un pago base que solo cubre borradores no se puede validar (spec 006)', async () => {
      const { prisma, service, voucher } = build();
      for (const team of prisma.data.teams) {
        if (team.voucherId === BASE) team.status = RegistrationStatus.DRAFT;
      }

      await expect(service.validate(BASE, ADMIN_ID)).rejects.toThrow(
        'El salón aún no envió ningún equipo',
      );
      expect(voucher(BASE).status).toBe(VoucherStatus.PENDING);
    });

    it('al validar solo se aprueban los equipos enviados; el borrador queda como está', async () => {
      const { prisma, service, status } = build();
      prisma.data.teams.find((t) => t.id === 2)!.status =
        RegistrationStatus.DRAFT;

      const result = await service.validate(BASE, ADMIN_ID);

      expect(result).toMatchObject({ approvedTeamIds: [1, 3] });
      expect(status(2)).toBe(RegistrationStatus.DRAFT);
    });

    it('validar de nuevo aprueba los equipos que se sumaron después', async () => {
      const { prisma, service, status } = build();
      await service.validate(BASE, ADMIN_ID);
      prisma.data.teams.push(groupTeam(6, 14));

      const result = await service.validate(BASE, ADMIN_ID);

      expect(result).toMatchObject({ approvedTeamIds: [6], skipped: [] });
      expect(status(6)).toBe(RegistrationStatus.APPROVED);
    });
  });

  describe('voucher EXTRA (equipo adicional)', () => {
    it('aprueba solo el equipo adicional que cubre', async () => {
      const { service, status } = build();

      const result = await service.validate(EXTRA, ADMIN_ID);

      expect(result).toMatchObject({
        status: VoucherStatus.VALIDATED,
        approvedTeamIds: [4],
      });
      expect(status(4)).toBe(RegistrationStatus.APPROVED);
      expect(status(1)).toBe(RegistrationStatus.PENDING);
    });

    it('rechaza validar un comprobante adicional sin equipos', async () => {
      const { prisma, service } = build();
      prisma.data.teams.find((t) => t.id === 4)!.voucherId = null;
      await expect(service.validate(EXTRA, ADMIN_ID)).rejects.toThrow(
        'aún no cubre ningún equipo',
      );
    });

    it('rechaza validar un comprobante adicional cuyo equipo sigue en borrador', async () => {
      const { prisma, service } = build();
      prisma.data.teams.find((t) => t.id === 4)!.status =
        RegistrationStatus.DRAFT;
      await expect(service.validate(EXTRA, ADMIN_ID)).rejects.toThrow(
        'aún no cubre ningún equipo enviado',
      );
    });
  });

  describe('voucher TEAM (flujo por disciplina, sin cambios)', () => {
    it('valida y aprueba el equipo, como siempre', async () => {
      const { service, status, voucher } = build();

      const result = await service.validate(TEAM_VOUCHER, ADMIN_ID);

      expect(result).toMatchObject({ id: TEAM_VOUCHER, status: 'VALIDATED' });
      expect(result).not.toHaveProperty('approvedTeamIds');
      expect(voucher(TEAM_VOUCHER).validatedById).toBe(ADMIN_ID);
      expect(status(50)).toBe(RegistrationStatus.APPROVED);
    });

    it('no valida si el equipo incumple las reglas y no cambia nada', async () => {
      const { prisma, service, status, voucher } = build();
      prisma.data.teams.find((t) => t.id === 50)!.participants = members(
        10,
        50,
      );

      await expect(service.validate(TEAM_VOUCHER, ADMIN_ID)).rejects.toThrow(
        BadRequestException,
      );
      expect(voucher(TEAM_VOUCHER).status).toBe(VoucherStatus.PENDING);
      expect(status(50)).toBe(RegistrationStatus.PENDING);
    });
  });

  it('responde 404 si el comprobante no existe', async () => {
    const { service } = build();
    await expect(service.validate(999, ADMIN_ID)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('VouchersService.reject', () => {
  it('rechazar un pago base devuelve a PENDING a los equipos que había aprobado', async () => {
    const { prisma, service, status, voucher } = build();
    await service.validate(BASE, ADMIN_ID);
    prisma.data.teams.find((t) => t.id === 3)!.status =
      RegistrationStatus.REJECTED;

    const result = await service.reject(BASE, 'Monto incorrecto', ADMIN_ID);

    expect(result).toMatchObject({
      status: VoucherStatus.REJECTED,
      rejectionReason: 'Monto incorrecto',
      validatedById: ADMIN_ID,
    });
    expect(voucher(BASE).status).toBe(VoucherStatus.REJECTED);
    expect(status(1)).toBe(RegistrationStatus.PENDING);
    expect(status(2)).toBe(RegistrationStatus.PENDING);
    expect(status(3)).toBe(RegistrationStatus.REJECTED);
    // El equipo del otro comprobante no se toca.
    expect(status(4)).toBe(RegistrationStatus.PENDING);
  });

  it('rechazar un comprobante adicional afecta solo a sus equipos', async () => {
    const { service, status } = build();
    await service.validate(BASE, ADMIN_ID);
    await service.validate(EXTRA, ADMIN_ID);

    await service.reject(EXTRA, 'Ilegible', ADMIN_ID);

    expect(status(4)).toBe(RegistrationStatus.PENDING);
    expect(status(1)).toBe(RegistrationStatus.APPROVED);
  });

  it('rechazar un voucher TEAM conserva el comportamiento histórico', async () => {
    const { service, status, voucher } = build();
    await service.validate(TEAM_VOUCHER, ADMIN_ID);

    await service.reject(TEAM_VOUCHER, 'Fraude', ADMIN_ID);

    expect(voucher(TEAM_VOUCHER).status).toBe(VoucherStatus.REJECTED);
    expect(status(50)).toBe(RegistrationStatus.APPROVED);
  });

  it('responde 404 si el comprobante no existe', async () => {
    const { service } = build();
    await expect(service.reject(999, 'x', ADMIN_ID)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('VouchersService.replace', () => {
  const PNG = '/uploads/vouchers/nuevo.png';

  it('el delegado reemplaza el pago base rechazado y conserva los equipos', async () => {
    const { service, voucher } = build();
    await service.validate(BASE, ADMIN_ID);
    await service.reject(BASE, 'Imagen borrosa', ADMIN_ID);

    const result = await service.replace(delegate, BASE, PNG, ' 55555 ');

    expect(result).toMatchObject({
      id: BASE,
      imageUrl: PNG,
      operationNumber: '55555',
      status: VoucherStatus.PENDING,
      rejectionReason: null,
      validatedById: null,
    });
    expect(voucher(BASE).status).toBe(VoucherStatus.PENDING);
  });

  it('guarda null si no se informa un nuevo número de operación', async () => {
    const { service } = build();
    await service.reject(BASE, 'Sin datos', ADMIN_ID);
    await expect(
      service.replace(delegate, BASE, PNG, '  '),
    ).resolves.toMatchObject({ operationNumber: null });
  });

  it('solo se reemplaza un comprobante rechazado', async () => {
    const { service } = build();
    await expect(service.replace(delegate, BASE, PNG)).rejects.toThrow(
      'Solo se puede reemplazar un comprobante rechazado',
    );
    await service.validate(BASE, ADMIN_ID);
    await expect(service.replace(delegate, BASE, PNG)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('otro usuario no puede reemplazar el comprobante de un salón ajeno', async () => {
    const { service, voucher } = build();
    await service.reject(BASE, 'Monto', ADMIN_ID);

    await expect(service.replace(stranger, BASE, PNG)).rejects.toThrow(
      ForbiddenException,
    );
    expect(voucher(BASE).status).toBe(VoucherStatus.REJECTED);
    expect(voucher(BASE).imageUrl).not.toBe(PNG);
  });

  it('el staff también puede reemplazarlo', async () => {
    const { service } = build();
    await service.reject(BASE, 'Monto', ADMIN_ID);
    await expect(service.replace(admin, BASE, PNG)).resolves.toMatchObject({
      status: VoucherStatus.PENDING,
    });
  });

  it('un voucher TEAM lo reemplaza el delegado del equipo', async () => {
    const { service } = build();
    await service.reject(TEAM_VOUCHER, 'Monto', ADMIN_ID);

    // El delegado del equipo 50 es el usuario 41; el delegado del salón (40) no.
    await expect(service.replace(delegate, TEAM_VOUCHER, PNG)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(
      service.replace(stranger, TEAM_VOUCHER, PNG),
    ).resolves.toMatchObject({ id: TEAM_VOUCHER, status: 'PENDING' });
  });

  it('exige la nueva imagen y el comprobante debe existir', async () => {
    const { service } = build();
    await expect(service.replace(delegate, BASE, undefined)).rejects.toThrow(
      'Adjunta la nueva imagen del comprobante',
    );
    await expect(service.replace(delegate, 999, PNG)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('VouchersService.findAll', () => {
  it('lista un voucher compartido con todos los equipos que cubre', async () => {
    const { service } = build();

    const list = await service.findAll({ eventId: 1 });
    const base = list.find((v) => v.id === BASE);

    expect(list.map((v) => v.id).sort()).toEqual([BASE, EXTRA, TEAM_VOUCHER]);
    expect(base).toMatchObject({
      kind: 'BASE',
      groupId: GROUP_ID,
      groupLabel: 'Ingeniería de Sistemas · V · A1',
      teamId: 1,
      teamName: 'Equipo 1',
      disciplineName: 'Futsal',
      eventName: 'Juegos de Ingeniería',
      amount: 100,
      participantsCount: 3,
    });
    expect(base?.teams.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(base?.participants).toHaveLength(3);
  });

  it('un voucher TEAM conserva su forma histórica', async () => {
    const { service } = build();
    const list = await service.findAll({ eventId: 1 });
    const legacy = list.find((v) => v.id === TEAM_VOUCHER);

    expect(legacy).toMatchObject({
      kind: 'TEAM',
      groupId: null,
      groupLabel: null,
      teamId: 50,
      teamName: 'Equipo por disciplina',
      cycle: 'VIII',
      section: 'A',
      phone: '988888888',
      operationNumber: '200',
      amount: 50,
      disciplineName: 'Futsal',
      participantType: 'STUDENT',
      participantsCount: 3,
    });
    expect(legacy?.teams.map((t) => t.id)).toEqual([50]);
  });

  it('un pago base sin equipos aparece por su grupo, pero no al filtrar por disciplina', async () => {
    const { prisma, service } = build();
    prisma.data.groups.push({
      id: 6,
      eventId: 1,
      schoolId: 1,
      scope: GroupScope.SECTION,
      cycle: 'VI',
      section: 'B2',
      delegateId: STRANGER_ID,
      baseVoucherId: 300,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.data.vouchers.push(
      voucherRow(300, VoucherKind.BASE, { groupId: 6 }),
    );

    const byEvent = await service.findAll({ eventId: 1 });
    const empty = byEvent.find((v) => v.id === 300);
    expect(empty).toMatchObject({
      teamId: null,
      teamName: '',
      groupLabel: 'Ingeniería de Sistemas · VI · B2',
      eventName: 'Juegos de Ingeniería',
      schoolName: '',
      participantsCount: 0,
      teams: [],
    });

    const byDiscipline = await service.findAll({
      eventId: 1,
      disciplineId: FUTSAL,
    });
    expect(byDiscipline.some((v) => v.id === 300)).toBe(false);
    expect(byDiscipline.map((v) => v.id).sort()).toEqual([
      BASE,
      EXTRA,
      TEAM_VOUCHER,
    ]);
  });

  it('filtra por estado y por evento', async () => {
    const { service } = build();
    await service.validate(EXTRA, ADMIN_ID);

    const validated = await service.findAll({
      status: VoucherStatus.VALIDATED,
    });
    expect(validated.map((v) => v.id)).toEqual([EXTRA]);

    expect(await service.findAll({ eventId: 2 })).toEqual([]);
    expect(await service.findAll({ facultyId: 1 })).toHaveLength(3);
    expect(await service.findAll({ facultyId: 2 })).toEqual([]);
  });
});

describe('VouchersService.reopen', () => {
  it('deshace una validación: el pago vuelve a PENDING y los equipos que aprobó también', async () => {
    const { prisma, service, status, voucher } = build();
    await service.validate(BASE, ADMIN_ID);
    prisma.data.teams.find((t) => t.id === 3)!.status =
      RegistrationStatus.REJECTED;

    const result = await service.reopen(BASE);

    expect(result).toMatchObject({
      status: VoucherStatus.PENDING,
      validatedById: null,
      rejectionReason: null,
    });
    expect(voucher(BASE).status).toBe(VoucherStatus.PENDING);
    expect(status(1)).toBe(RegistrationStatus.PENDING);
    expect(status(2)).toBe(RegistrationStatus.PENDING);
    // Un equipo rechazado no se toca, ni el de otro comprobante.
    expect(status(3)).toBe(RegistrationStatus.REJECTED);
    expect(status(4)).toBe(RegistrationStatus.PENDING);
  });

  it('un comprobante adicional afecta solo a sus equipos', async () => {
    const { service, status } = build();
    await service.validate(BASE, ADMIN_ID);
    await service.validate(EXTRA, ADMIN_ID);

    await service.reopen(EXTRA);

    expect(status(4)).toBe(RegistrationStatus.PENDING);
    expect(status(1)).toBe(RegistrationStatus.APPROVED);
  });

  it('reabre un rechazo equivocado sin cambiar el estado de los equipos', async () => {
    const { service, status, voucher } = build();
    await service.reject(BASE, 'Me equivoqué', ADMIN_ID);

    await service.reopen(BASE);

    expect(voucher(BASE)).toMatchObject({
      status: VoucherStatus.PENDING,
      rejectionReason: null,
    });
    expect(status(1)).toBe(RegistrationStatus.PENDING);
  });

  it('un voucher TEAM validado deja de aprobar al equipo', async () => {
    const { service, status, voucher } = build();
    await service.validate(TEAM_VOUCHER, ADMIN_ID);
    expect(status(50)).toBe(RegistrationStatus.APPROVED);

    await service.reopen(TEAM_VOUCHER);

    expect(voucher(TEAM_VOUCHER).status).toBe(VoucherStatus.PENDING);
    expect(status(50)).toBe(RegistrationStatus.PENDING);
  });

  it('también alcanza al equipo de un comprobante anterior al pago por grupo (solo Voucher.teamId)', async () => {
    const { prisma, service, status } = build();
    await service.validate(TEAM_VOUCHER, ADMIN_ID);
    prisma.data.teams.find((t) => t.id === 50)!.voucherId = null;

    await service.reopen(TEAM_VOUCHER);

    expect(status(50)).toBe(RegistrationStatus.PENDING);
  });

  it('rechaza reabrir un comprobante que ya está pendiente y responde 404 si no existe', async () => {
    const { service } = build();
    await expect(service.reopen(BASE)).rejects.toThrow(/ya está pendiente/);
    await expect(service.reopen(999)).rejects.toThrow(NotFoundException);
  });
});

describe('VouchersService.update', () => {
  it('corrige el N.º de operación y el monto sin tocar estados', async () => {
    const { service, status, voucher } = build();
    await service.validate(BASE, ADMIN_ID);

    await service.update(BASE, { operationNumber: ' 998877 ', amount: 90.5 });

    expect(voucher(BASE).operationNumber).toBe('998877');
    expect(Number(voucher(BASE).amount)).toBe(90.5);
    expect(voucher(BASE).status).toBe(VoucherStatus.VALIDATED);
    expect(status(1)).toBe(RegistrationStatus.APPROVED);
  });

  it('una cadena vacía borra el N.º de operación', async () => {
    const { service, voucher } = build();
    await service.update(BASE, { operationNumber: '  ' });
    expect(voucher(BASE).operationNumber).toBeNull();
  });

  it('exige al menos un dato y que el comprobante exista', async () => {
    const { service } = build();
    await expect(service.update(BASE, {})).rejects.toThrow(BadRequestException);
    await expect(service.update(999, { amount: 1 })).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('VouchersService.validate con equipos observados', () => {
  it('un voucher TEAM de un equipo observado no se valida (no lo aprueba por la puerta de atrás)', async () => {
    const { prisma, service, status, voucher } = build();
    prisma.data.teams.find((t) => t.id === 50)!.status =
      RegistrationStatus.OBSERVED;

    await expect(service.validate(TEAM_VOUCHER, ADMIN_ID)).rejects.toThrow(
      /observado/,
    );
    expect(voucher(TEAM_VOUCHER).status).toBe(VoucherStatus.PENDING);
    expect(status(50)).toBe(RegistrationStatus.OBSERVED);
  });

  it('al validar un pago base el equipo observado no se aprueba', async () => {
    const { prisma, service, status } = build();
    prisma.data.teams.find((t) => t.id === 2)!.status =
      RegistrationStatus.OBSERVED;

    const result = await service.validate(BASE, ADMIN_ID);

    expect(result.approvedTeamIds).toEqual([1, 3]);
    expect(status(2)).toBe(RegistrationStatus.OBSERVED);
  });
});
