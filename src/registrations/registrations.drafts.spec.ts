import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
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
  CreateRegistrationDto,
  ParticipantDto,
} from './dto/create-registration.dto';
import { RegistrationsService } from './registrations.service';

const DELEGATE = 40;
const OTHER_DELEGATE = 41;
const ADMIN = 1;
const TREASURER = 3;
const GROUP_ID = 5;
const FUTSAL = 12;
const VOLEY = 13;
const BASE_VOUCHER = 100;
const PNG = '/uploads/vouchers/extra.png';

const user = (id: number, role: Role): RequestUser => ({
  id,
  role,
  email: `${id}@undc.edu.pe`,
  fullName: `Usuario ${id}`,
});
const delegate = user(DELEGATE, Role.STUDENT);
const otherDelegate = user(OTHER_DELEGATE, Role.STUDENT);
const admin = user(ADMIN, Role.ADMIN_SYSTEM);
const treasurer = user(TREASURER, Role.TREASURER);

function roster(
  count: number,
  options: { captainIndex?: number; seed?: number; withDni?: boolean } = {},
): ParticipantDto[] {
  const { captainIndex = 0, seed = 1, withDni = true } = options;
  return Array.from({ length: count }, (_, i) => ({
    fullName: `ALUMNO ${seed}-${i + 1}`,
    studentCode: String(2300000000 + seed * 100 + i),
    dni: withDni ? String(70000000 + seed * 100 + i) : null,
    gender: 'O' as const,
    isDelegate: false,
    countsAsPlayer: true,
    isCaptain: i === captainIndex,
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

function build() {
  const dataset = buildGroupsDataset();
  dataset.vouchers.push({
    id: BASE_VOUCHER,
    kind: VoucherKind.BASE,
    groupId: GROUP_ID,
    teamId: null,
    amount: new Prisma.Decimal('100'),
    operationNumber: '1',
    imageUrl: '/uploads/vouchers/base.png',
    status: VoucherStatus.PENDING,
    rejectionReason: null,
    validatedById: null,
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
  const draft = async (overrides: Partial<CreateRegistrationDto> = {}) => {
    const created = await service.create(
      DELEGATE,
      dto({ draft: true, ...overrides }),
    );
    return created!.id;
  };
  return { prisma, service, team, draft };
}

describe('Borradores: guardar un equipo sin enviarlo', () => {
  it('queda en DRAFT con su cupo y cubierto por el pago general', async () => {
    const { team, draft } = build();
    const id = await draft({ participants: roster(1) });

    expect(team(id)).toMatchObject({
      status: RegistrationStatus.DRAFT,
      slot: 1,
      voucherId: BASE_VOUCHER,
      groupId: GROUP_ID,
    });
  });

  it('acepta una nómina incompleta: sin DNI, sin capitán o vacía', async () => {
    const { draft } = build();
    await expect(
      draft({ participants: roster(2, { withDni: false }) }),
    ).resolves.toBeDefined();
    await expect(
      draft({
        teamName: 'Sin capitán',
        disciplineId: VOLEY,
        participants: roster(2, { captainIndex: 9 }),
      }),
    ).resolves.toBeDefined();
    await expect(
      draft({ teamName: 'Vacío', disciplineId: 14, participants: [] }),
    ).resolves.toBeDefined();
  });

  it('sigue rechazando lo que no se arregla al enviar: exceso de jugadores, duplicados, dos capitanes', async () => {
    const { service } = build();
    const draftDto = (overrides: Partial<CreateRegistrationDto>) =>
      service.create(DELEGATE, dto({ draft: true, ...overrides }));

    await expect(draftDto({ participants: roster(10) })).rejects.toThrow(
      /entre 1 y 9 jugadores/,
    );
    const duplicated = roster(2);
    duplicated[1].studentCode = duplicated[0].studentCode;
    await expect(draftDto({ participants: duplicated })).rejects.toThrow(
      /duplicado/,
    );
    const twoCaptains = roster(2).map((p) => ({ ...p, isCaptain: true }));
    await expect(draftDto({ participants: twoCaptains })).rejects.toThrow(
      /más de uno/,
    );
  });

  it('el segundo equipo de una disciplina (adicional) exige su comprobante aunque sea borrador', async () => {
    const { prisma, service, team } = build();
    await service.create(DELEGATE, dto());

    await expect(
      service.create(DELEGATE, dto({ draft: true, teamName: 'Segundo' })),
    ).rejects.toThrow(/requiere su comprobante/);

    const second = await service.create(
      DELEGATE,
      dto({ draft: true, teamName: 'Segundo', operationNumber: '77' }),
      PNG,
    );
    expect(team(second!.id)).toMatchObject({
      status: RegistrationStatus.DRAFT,
      slot: 2,
    });
    const extra = prisma.data.vouchers.find(
      (v) => v.kind === VoucherKind.EXTRA,
    );
    expect(extra).toMatchObject({ status: VoucherStatus.PENDING });
    expect(Number(extra!.amount)).toBe(20);
  });

  it('un equipo normal sigue validando todo al crearse', async () => {
    const { service } = build();
    await expect(
      service.create(
        DELEGATE,
        dto({ participants: roster(2, { withDni: false }) }),
      ),
    ).rejects.toThrow(/Falta el DNI/);
  });
});

describe('Borradores: editar y enviar', () => {
  it('el delegado edita nombre, celular y reemplaza la nómina completa', async () => {
    const { service, team, draft } = build();
    const id = await draft({ participants: roster(1) });

    await service.update(delegate, id, {
      teamName: 'Los Bits 2',
      phone: '988877766',
      participants: roster(4, { seed: 2, captainIndex: 2 }),
    });

    expect(team(id).name).toBe('Los Bits 2');
    expect(team(id).phone).toBe('988877766');
    expect(team(id).participants).toHaveLength(4);
    expect(team(id).participants?.filter((p) => p.isCaptain)).toHaveLength(1);
    expect(team(id).status).toBe(RegistrationStatus.DRAFT);
  });

  it('sin participants solo cambia los datos del equipo y conserva la nómina', async () => {
    const { service, team, draft } = build();
    const id = await draft({ participants: roster(3) });
    await service.update(delegate, id, { teamName: 'Nuevo nombre' });
    expect(team(id).name).toBe('Nuevo nombre');
    expect(team(id).participants).toHaveLength(3);
  });

  it('no deja un nombre vacío', async () => {
    const { service, draft } = build();
    const id = await draft();
    await expect(
      service.update(delegate, id, { teamName: '   ' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('otro delegado y el tesorero no pueden editar un borrador ajeno', async () => {
    const { service, draft } = build();
    const id = await draft();
    await expect(
      service.update(otherDelegate, id, { teamName: 'X' }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.update(treasurer, id, { teamName: 'X' }),
    ).rejects.toThrow(ForbiddenException);
    await expect(service.submit(treasurer, id)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.remove(otherDelegate, id)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('el delegado no edita después del cierre de la disciplina; el administrador sí', async () => {
    const { prisma, service, draft } = build();
    const id = await draft();
    for (const event of prisma.data.events) {
      for (const discipline of event.disciplines) {
        discipline.registrationDeadline = new Date('2000-01-01T00:00:00Z');
      }
    }
    await expect(
      service.update(delegate, id, { teamName: 'Tarde' }),
    ).rejects.toThrow(/plazo/);
    await expect(
      service.update(admin, id, { teamName: 'Tarde pero admin' }),
    ).resolves.toBeDefined();
  });

  it('el delegado no edita con el evento cerrado', async () => {
    const { prisma, service, draft } = build();
    const id = await draft();
    prisma.data.events[0].isOpen = false;
    await expect(
      service.update(delegate, id, { teamName: 'Cerrado' }),
    ).rejects.toThrow(/no está abierto/);
  });

  it('enviar exige la nómina completa y explica qué falta', async () => {
    const { service, team, draft } = build();
    const sinDni = await draft({ participants: roster(2, { withDni: false }) });
    await expect(service.submit(delegate, sinDni)).rejects.toThrow(
      /Falta el DNI/,
    );
    expect(team(sinDni).status).toBe(RegistrationStatus.DRAFT);

    const sinCapitan = await draft({
      teamName: 'Sin capitán',
      disciplineId: VOLEY,
      participants: roster(2, { captainIndex: 9 }),
    });
    await expect(service.submit(delegate, sinCapitan)).rejects.toThrow(
      /capitán/,
    );

    const vacio = await draft({
      teamName: 'Vacío',
      disciplineId: 14,
      participants: [],
    });
    await expect(service.submit(delegate, vacio)).rejects.toThrow(
      /entre 1 y 9 jugadores/,
    );
  });

  it('un borrador completo pasa a PENDING y ya no lo edita el delegado', async () => {
    const { service, team, draft } = build();
    const id = await draft({ participants: roster(3) });

    await service.submit(delegate, id);

    expect(team(id).status).toBe(RegistrationStatus.PENDING);
    await expect(
      service.update(delegate, id, { teamName: 'Otra vez' }),
    ).rejects.toThrow(/ya fue enviado/);
    await expect(service.submit(admin, id)).rejects.toThrow(/ya fue enviado/);
    await expect(service.remove(delegate, id)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('el administrador puede enviar un borrador a nombre del delegado', async () => {
    const { service, team, draft } = build();
    const id = await draft({ participants: roster(3) });
    await service.submit(admin, id);
    expect(team(id).status).toBe(RegistrationStatus.PENDING);
  });

  it('un borrador no se aprueba ni se rechaza', async () => {
    const { service, draft } = build();
    const id = await draft();
    await expect(service.approve(id)).rejects.toThrow(/borrador/);
    await expect(service.reject(id, 'motivo')).rejects.toThrow(/borrador/);
  });
});

describe('Edición del administrador', () => {
  it('edita un equipo enviado: agrega y quita jugadores y cambia el capitán', async () => {
    const { service, team } = build();
    const created = await service.create(
      DELEGATE,
      dto({ participants: roster(3) }),
    );

    await service.update(admin, created!.id, {
      participants: roster(4, { seed: 7, captainIndex: 3 }),
    });

    expect(team(created!.id).participants).toHaveLength(4);
    expect(team(created!.id).participants?.[3].isCaptain).toBe(true);
    expect(team(created!.id).status).toBe(RegistrationStatus.PENDING);
  });

  it('un equipo aprobado sigue aprobado si cumple las reglas', async () => {
    const { service, team } = build();
    const created = await service.create(
      DELEGATE,
      dto({ participants: roster(3) }),
    );
    team(created!.id).status = RegistrationStatus.APPROVED;

    await service.update(admin, created!.id, {
      participants: roster(5, { seed: 3 }),
    });

    expect(team(created!.id).status).toBe(RegistrationStatus.APPROVED);
    expect(team(created!.id).participants).toHaveLength(5);
  });

  it('si el cambio incumple las reglas se rechaza y no se toca nada', async () => {
    const { service, team } = build();
    const created = await service.create(
      DELEGATE,
      dto({ participants: roster(3) }),
    );

    await expect(
      service.update(admin, created!.id, {
        teamName: 'No debería quedar',
        participants: roster(2, { captainIndex: 9 }),
      }),
    ).rejects.toThrow(/capitán/);
    await expect(
      service.update(admin, created!.id, { participants: roster(12) }),
    ).rejects.toThrow(/entre 1 y 9 jugadores/);

    expect(team(created!.id).name).toBe('Los Bits');
    expect(team(created!.id).participants).toHaveLength(3);
  });

  it('un equipo cancelado no se edita', async () => {
    const { service, team } = build();
    const created = await service.create(DELEGATE, dto());
    team(created!.id).status = RegistrationStatus.CANCELLED;
    await expect(
      service.update(admin, created!.id, { teamName: 'X' }),
    ).rejects.toThrow(/cancelado/);
  });

  it('un equipo inexistente responde 404', async () => {
    const { service } = build();
    await expect(service.update(admin, 999, { teamName: 'X' })).rejects.toThrow(
      /no encontrado/,
    );
  });
});

describe('Quitar un borrador', () => {
  it('libera el cupo: el siguiente equipo vuelve a ocupar el cupo 1', async () => {
    const { prisma, service, draft } = build();
    const id = await draft();
    await expect(service.remove(delegate, id)).resolves.toEqual({
      id,
      deleted: true,
    });
    expect(prisma.data.teams).toHaveLength(0);

    const again = await service.create(DELEGATE, dto({ teamName: 'Otro' }));
    expect(again).toMatchObject({ slot: 1, voucherId: BASE_VOUCHER });
  });

  it('solo se quitan borradores', async () => {
    const { service } = build();
    const created = await service.create(DELEGATE, dto());
    await expect(service.remove(admin, created!.id)).rejects.toThrow(
      /en borrador/,
    );
  });

  it('si era el último equipo de un comprobante adicional pendiente, lo elimina', async () => {
    const { prisma, service } = build();
    await service.create(DELEGATE, dto());
    const second = await service.create(
      DELEGATE,
      dto({ draft: true, teamName: 'Adicional' }),
      PNG,
    );
    expect(
      prisma.data.vouchers.filter((v) => v.kind === VoucherKind.EXTRA),
    ).toHaveLength(1);

    await service.remove(delegate, second!.id);

    expect(
      prisma.data.vouchers.filter((v) => v.kind === VoucherKind.EXTRA),
    ).toHaveLength(0);
    expect(
      prisma.data.vouchers.find((v) => v.id === BASE_VOUCHER),
    ).toBeDefined();
  });

  it('si comparte comprobante con otros equipos, recalcula su monto', async () => {
    const { prisma, service } = build();
    await service.create(DELEGATE, dto());
    const second = await service.create(
      DELEGATE,
      dto({ draft: true, teamName: 'Adicional 1' }),
      PNG,
    );
    const extraId = prisma.data.vouchers.find(
      (v) => v.kind === VoucherKind.EXTRA,
    )!.id;
    const third = await service.create(
      DELEGATE,
      dto({ draft: true, teamName: 'Adicional 2', extraVoucherId: extraId }),
    );
    expect(
      Number(prisma.data.vouchers.find((v) => v.id === extraId)!.amount),
    ).toBe(40);

    await service.remove(delegate, third!.id);

    expect(
      Number(prisma.data.vouchers.find((v) => v.id === extraId)!.amount),
    ).toBe(20);
    expect(prisma.data.teams.map((t) => t.id)).toContain(second!.id);
  });

  it('un comprobante adicional ya validado no se toca', async () => {
    const { prisma, service } = build();
    await service.create(DELEGATE, dto());
    const second = await service.create(
      DELEGATE,
      dto({ draft: true, teamName: 'Adicional' }),
      PNG,
    );
    const extra = prisma.data.vouchers.find(
      (v) => v.kind === VoucherKind.EXTRA,
    )!;
    extra.status = VoucherStatus.VALIDATED;

    await service.remove(delegate, second!.id);

    expect(prisma.data.vouchers.find((v) => v.id === extra.id)).toBeDefined();
  });
});

describe('Quién ve los borradores', () => {
  const whereOf = (spy: jest.Mock): Record<string, unknown> =>
    (spy.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;

  function withTeamSpy() {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new RegistrationsService({
      team: { findMany },
    } as unknown as PrismaService);
    return { service, findMany };
  }

  it('el tesorero nunca recibe borradores en la lista de equipos', async () => {
    const { service, findMany } = withTeamSpy();
    await service.findAll({}, Role.TREASURER);
    expect(whereOf(findMany).status).toEqual({
      not: RegistrationStatus.DRAFT,
    });
  });

  it('el tesorero que filtra por DRAFT no obtiene nada', async () => {
    const { service, findMany } = withTeamSpy();
    await service.findAll({ status: RegistrationStatus.DRAFT }, Role.TREASURER);
    expect(whereOf(findMany).status).toEqual({ in: [] });
  });

  it('el tesorero conserva los demás filtros de estado', async () => {
    const { service, findMany } = withTeamSpy();
    await service.findAll(
      { status: RegistrationStatus.PENDING },
      Role.TREASURER,
    );
    expect(whereOf(findMany).status).toBe(RegistrationStatus.PENDING);
  });

  it('owner y administrador ven los borradores (sin filtro de estado por defecto)', async () => {
    const { service, findMany } = withTeamSpy();
    await service.findAll({}, Role.ADMIN_SYSTEM);
    expect(whereOf(findMany).status).toBeUndefined();
  });

  it('un integrante de un equipo no ve el borrador de otro delegado, pero el delegado sí el suyo', async () => {
    const { service, findMany } = withTeamSpy();
    await service.findMine(DELEGATE);
    expect(whereOf(findMany)).toEqual({
      OR: [
        { delegateId: DELEGATE },
        {
          participants: { some: { userId: DELEGATE } },
          status: { not: RegistrationStatus.DRAFT },
        },
      ],
    });
  });
});
