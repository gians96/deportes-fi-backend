import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  GroupScope,
  Prisma,
  PricingMode,
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
  CreateRegistrationDto,
  ParticipantDto,
} from './dto/create-registration.dto';
import { RegistrationsService } from './registrations.service';

const DELEGATE = 40;
const OTHER_DELEGATE = 41;
const ADMIN = 1;
const GROUP_ID = 5;
const FUTSAL = 12;
const BASE_VOUCHER = 100;
const PAST = new Date('2000-01-01T00:00:00Z');

const user = (id: number, role: Role): RequestUser => ({
  id,
  role,
  email: `${id}@undc.edu.pe`,
  fullName: `Usuario ${id}`,
});
const delegate = user(DELEGATE, Role.STUDENT);
const otherDelegate = user(OTHER_DELEGATE, Role.STUDENT);
const admin = user(ADMIN, Role.ADMIN_SYSTEM);

function roster(count: number, seed = 1): ParticipantDto[] {
  return Array.from({ length: count }, (_, i) => ({
    fullName: `ALUMNO ${seed}-${i + 1}`,
    studentCode: String(2300000000 + seed * 100 + i),
    dni: String(70000000 + seed * 100 + i),
    gender: 'O' as const,
    isDelegate: false,
    countsAsPlayer: true,
    isCaptain: i === 0,
  }));
}

function dto(
  overrides: Partial<CreateRegistrationDto> = {},
): CreateRegistrationDto {
  return {
    disciplineId: FUTSAL,
    teamName: 'Los Bits',
    phone: '999999999',
    groupId: GROUP_ID,
    participants: roster(3),
    ...overrides,
  };
}

function build(options: { perDiscipline?: boolean } = {}) {
  const dataset = buildGroupsDataset(
    options.perDiscipline ? { pricingMode: PricingMode.PER_DISCIPLINE } : {},
  );
  dataset.vouchers.push({
    id: BASE_VOUCHER,
    kind: VoucherKind.BASE,
    groupId: GROUP_ID,
    teamId: null,
    amount: new Prisma.Decimal('100'),
    operationNumber: '1',
    imageUrl: '/uploads/vouchers/base.png',
    status: VoucherStatus.VALIDATED,
    rejectionReason: null,
    validatedById: ADMIN,
  });
  dataset.groups.push({
    id: GROUP_ID,
    eventId: 1,
    schoolId: 1,
    scope: GroupScope.SECTION,
    cycle: 'V',
    section: 'A1',
    delegateId: DELEGATE,
    baseVoucherId: BASE_VOUCHER,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const prisma = new GroupsPrisma(dataset);
  const service = new RegistrationsService(prisma as unknown as PrismaService);
  const team = (id: number) => prisma.data.teams.find((t) => t.id === id)!;
  const create = async (overrides: Partial<CreateRegistrationDto> = {}) =>
    (await service.create(DELEGATE, dto(overrides)))!.id;
  const closeDeadline = () => {
    for (const event of prisma.data.events) {
      for (const discipline of event.disciplines) {
        discipline.registrationDeadline = PAST;
      }
    }
  };
  return { prisma, service, team, create, closeDeadline };
}

describe('Cambio manual de estado', () => {
  it('corrige un «aprobar» equivocado: APPROVED → PENDING conserva cupo y comprobante', async () => {
    const { service, team, create } = build();
    const id = await create();
    await service.setStatus(id, { status: RegistrationStatus.APPROVED });
    expect(team(id).status).toBe(RegistrationStatus.APPROVED);

    await service.setStatus(id, { status: RegistrationStatus.PENDING });

    expect(team(id)).toMatchObject({
      status: RegistrationStatus.PENDING,
      slot: 1,
      voucherId: BASE_VOUCHER,
      rejectionReason: null,
      observation: null,
    });
  });

  it('aprobar exige las mismas reglas que approve: comprobante validado y bases', async () => {
    const { prisma, service, team, create } = build();
    const id = await create();
    prisma.data.vouchers[0].status = VoucherStatus.PENDING;
    await expect(
      service.setStatus(id, { status: RegistrationStatus.APPROVED }),
    ).rejects.toThrow(/Primero valida el comprobante/);

    prisma.data.vouchers[0].status = VoucherStatus.VALIDATED;
    team(id).participants = [];
    await expect(
      service.setStatus(id, { status: RegistrationStatus.APPROVED }),
    ).rejects.toThrow(BadRequestException);
    expect(team(id).status).toBe(RegistrationStatus.PENDING);
  });

  it('rechazar y observar exigen un motivo; el resto lo limpia', async () => {
    const { service, team, create } = build();
    const id = await create();
    await expect(
      service.setStatus(id, { status: RegistrationStatus.REJECTED }),
    ).rejects.toThrow(/motivo del rechazo/);
    await expect(
      service.setStatus(id, {
        status: RegistrationStatus.OBSERVED,
        reason: '   ',
      }),
    ).rejects.toThrow(/observación/);

    await service.setStatus(id, {
      status: RegistrationStatus.OBSERVED,
      reason: 'Falta el DNI de dos jugadores',
    });
    expect(team(id)).toMatchObject({
      status: RegistrationStatus.OBSERVED,
      observation: 'Falta el DNI de dos jugadores',
      rejectionReason: null,
      slot: 1,
    });

    await service.setStatus(id, { status: RegistrationStatus.PENDING });
    expect(team(id).observation).toBeNull();
  });

  it('no cambia a un estado en el que ya está ni toca un borrador', async () => {
    const { service, team, create } = build();
    const id = await create();
    await expect(
      service.setStatus(id, { status: RegistrationStatus.PENDING }),
    ).rejects.toThrow(/ya está en ese estado/);

    team(id).status = RegistrationStatus.DRAFT;
    await expect(
      service.setStatus(id, {
        status: RegistrationStatus.OBSERVED,
        reason: 'x',
      }),
    ).rejects.toThrow(/borrador/);

    await expect(
      service.setStatus(999, { status: RegistrationStatus.PENDING }),
    ).rejects.toThrow(NotFoundException);
  });

  it('rechazar libera el cupo y restaurar lo vuelve a tomar', async () => {
    const { service, team, create } = build();
    const id = await create();
    await service.setStatus(id, {
      status: RegistrationStatus.REJECTED,
      reason: 'Equivocado',
    });
    expect(team(id)).toMatchObject({
      status: RegistrationStatus.REJECTED,
      rejectionReason: 'Equivocado',
      slot: null,
    });

    await service.setStatus(id, { status: RegistrationStatus.PENDING });
    expect(team(id)).toMatchObject({
      status: RegistrationStatus.PENDING,
      slot: 1,
      rejectionReason: null,
    });
  });

  it('un rechazo equivocado se puede pasar directo a aprobado si el pago está validado', async () => {
    const { service, team, create } = build();
    const id = await create();
    await service.setStatus(id, {
      status: RegistrationStatus.REJECTED,
      reason: 'Equivocado',
    });
    await service.setStatus(id, { status: RegistrationStatus.APPROVED });
    expect(team(id)).toMatchObject({
      status: RegistrationStatus.APPROVED,
      slot: 1,
    });
  });

  it('no restaura un equipo si el cupo base ya lo ocupa otro (necesitaría un comprobante adicional)', async () => {
    const { service, team, create } = build();
    const first = await create();
    await service.setStatus(first, {
      status: RegistrationStatus.REJECTED,
      reason: 'Equivocado',
    });
    const replacement = await create({
      teamName: 'Reemplazo',
      participants: roster(3, 2),
    });
    expect(team(replacement).slot).toBe(1);

    await expect(
      service.setStatus(first, { status: RegistrationStatus.PENDING }),
    ).rejects.toThrow(/cupo base/);
    expect(team(first).status).toBe(RegistrationStatus.REJECTED);
    expect(team(first).slot).toBeNull();
  });

  it('cancelar libera el cupo del grupo', async () => {
    const { service, team, create } = build();
    const id = await create();
    await service.setStatus(id, { status: RegistrationStatus.CANCELLED });
    expect(team(id)).toMatchObject({
      status: RegistrationStatus.CANCELLED,
      slot: null,
    });
  });

  it('approve limpia la observación vigente', async () => {
    const { service, team, create } = build();
    const id = await create();
    await service.setStatus(id, {
      status: RegistrationStatus.OBSERVED,
      reason: 'Revisar',
    });
    await service.approve(id);
    expect(team(id)).toMatchObject({
      status: RegistrationStatus.APPROVED,
      observation: null,
    });
  });
});

describe('Equipo observado: corrección del delegado', () => {
  async function observed() {
    const ctx = build();
    const id = await ctx.create();
    await ctx.service.setStatus(id, {
      status: RegistrationStatus.OBSERVED,
      reason: 'Corrige la nómina',
    });
    return { ...ctx, id };
  }

  it('el delegado edita aunque el plazo haya vencido y el evento esté cerrado', async () => {
    const { prisma, service, team, id, closeDeadline } = await observed();
    closeDeadline();
    prisma.data.events[0].isOpen = false;

    await service.update(delegate, id, {
      teamName: 'Los Bits 2',
      participants: roster(2, 4),
    });

    expect(team(id).name).toBe('Los Bits 2');
    expect(team(id).participants).toHaveLength(2);
    expect(team(id).status).toBe(RegistrationStatus.OBSERVED);
  });

  it('puede guardar una nómina incompleta mientras corrige, pero no reenviarla', async () => {
    const { service, id } = await observed();
    const sinDni = roster(3, 5).map((p) => ({ ...p, dni: null }));
    await expect(
      service.update(delegate, id, { participants: sinDni }),
    ).resolves.toBeDefined();
    await expect(service.submit(delegate, id)).rejects.toThrow(/DNI/);
  });

  it('reenviar lo devuelve a PENDING, limpia la observación y no exige plazo', async () => {
    const { prisma, service, team, id, closeDeadline } = await observed();
    closeDeadline();
    prisma.data.events[0].isOpen = false;

    await service.submit(delegate, id);

    expect(team(id)).toMatchObject({
      status: RegistrationStatus.PENDING,
      observation: null,
    });
  });

  it('un equipo pendiente o aprobado sigue siendo solo del administrador', async () => {
    const { service, create, team } = build();
    const id = await create();
    await expect(
      service.update(delegate, id, { teamName: 'Nuevo' }),
    ).rejects.toThrow(/solo un administrador/);
    team(id).status = RegistrationStatus.APPROVED;
    await expect(
      service.update(delegate, id, { teamName: 'Nuevo' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('otro delegado no corrige un equipo observado ajeno', async () => {
    const { service, id } = await observed();
    await expect(
      service.update(otherDelegate, id, { teamName: 'Ajeno' }),
    ).rejects.toThrow(/No puedes modificar/);
  });

  it('el delegado no toca los campos del administrador', async () => {
    const { service, id } = await observed();
    await expect(
      service.update(delegate, id, { delegateId: OTHER_DELEGATE }),
    ).rejects.toThrow(/Solo un administrador/);
    await expect(service.update(delegate, id, { cycle: 'X' })).rejects.toThrow(
      /Solo un administrador/,
    );
  });

  it('el delegado no elimina un equipo observado', async () => {
    const { service, id } = await observed();
    await expect(service.remove(delegate, id)).rejects.toThrow(
      /Solo se puede quitar un equipo en borrador/,
    );
  });
});

describe('Edición total del administrador', () => {
  it('cambia el delegado de un equipo', async () => {
    const { service, team, create } = build();
    const id = await create();
    await service.update(admin, id, { delegateId: OTHER_DELEGATE });
    expect(team(id).delegateId).toBe(OTHER_DELEGATE);
    await expect(
      service.update(admin, id, { delegateId: 9999 }),
    ).rejects.toThrow(/Delegado no encontrado/);
  });

  it('el ciclo y la sección de un equipo de salón los define el salón', async () => {
    const { service, create } = build();
    const id = await create();
    await expect(
      service.update(admin, id, { cycle: 'IX', section: 'B' }),
    ).rejects.toThrow(/los define su salón/);
  });

  it('en un equipo sin salón cambia ciclo y sección', async () => {
    const { service, team } = build({ perDiscipline: true });
    const created = await service.create(DELEGATE, {
      disciplineId: FUTSAL,
      teamName: 'Sin salón',
      cycle: 'V',
      section: 'A',
      participants: roster(3),
    });
    await service.update(admin, created!.id, { cycle: 'IX', section: 'B' });
    expect(team(created!.id)).toMatchObject({ cycle: 'IX', section: 'B' });

    // Una disciplina de estudiantes no admite dejar ciclo o sección en blanco.
    await expect(
      service.update(admin, created!.id, { section: '' }),
    ).rejects.toThrow(/ciclo y seccion/);
  });
});

describe('Eliminar una inscripción', () => {
  it('el administrador elimina un equipo aprobado y libera el cupo', async () => {
    const { service, prisma, team, create } = build();
    const id = await create();
    await service.setStatus(id, { status: RegistrationStatus.APPROVED });

    await expect(service.remove(admin, id)).resolves.toEqual({
      id,
      deleted: true,
    });
    expect(prisma.data.teams).toHaveLength(0);

    const again = await create({ teamName: 'Nuevo' });
    expect(team(again).slot).toBe(1);
  });

  it('el delegado no elimina un equipo ya enviado', async () => {
    const { service, create } = build();
    const id = await create();
    await expect(service.remove(delegate, id)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('se bloquea si el equipo ya figura en el fixture', async () => {
    const { prisma, service, create } = build();
    const id = await create();
    prisma.data.matches = [
      { homeTeamId: 77, awayTeamId: id, winnerTeamId: null },
    ];
    await expect(service.remove(admin, id)).rejects.toThrow(/fixture/);
    expect(prisma.data.teams).toHaveLength(1);

    prisma.data.matches = [];
    await expect(service.remove(admin, id)).resolves.toMatchObject({
      deleted: true,
    });
  });

  it('un equipo adicional eliminado no deja huérfano su comprobante pendiente', async () => {
    const { prisma, service, create } = build();
    await create();
    const second = (await service.create(
      DELEGATE,
      dto({ teamName: 'B', participants: roster(3, 2) }),
      '/uploads/vouchers/extra.png',
    ))!.id;
    const extra = prisma.data.vouchers.find(
      (v) => v.kind === VoucherKind.EXTRA,
    );
    expect(extra?.status).toBe(VoucherStatus.PENDING);

    await service.remove(admin, second);

    expect(prisma.data.vouchers.some((v) => v.kind === VoucherKind.EXTRA)).toBe(
      false,
    );
  });
});
