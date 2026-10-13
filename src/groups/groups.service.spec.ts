import {
  BadRequestException,
  ConflictException,
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
import type { FakeEventRow } from '../../test/fakes/groups-prisma';
import type { CreateGroupDto } from './dto/create-group.dto';
import { isActiveGroup } from './group-detail';
import { GroupsService } from './groups.service';

const student: RequestUser = {
  id: 40,
  email: '2301010149@undc.edu.pe',
  fullName: 'Delegada Uno',
  role: Role.STUDENT,
};
const otherStudent: RequestUser = {
  ...student,
  id: 41,
  fullName: 'Delegado Dos',
};
const admin: RequestUser = {
  id: 1,
  email: 'admin@undc.edu.pe',
  fullName: 'Admin',
  role: Role.ADMIN_SYSTEM,
};

function sectionDto(overrides: Partial<CreateGroupDto> = {}): CreateGroupDto {
  return {
    eventId: 1,
    scope: GroupScope.SECTION,
    schoolId: 1,
    cycle: '5',
    section: 'a-1',
    operationNumber: ' 123456 ',
    ...overrides,
  };
}

function cycleDto(overrides: Partial<CreateGroupDto> = {}): CreateGroupDto {
  return sectionDto({
    scope: GroupScope.CYCLE,
    section: 'ignorada',
    ...overrides,
  });
}

function build(eventOverrides: Partial<FakeEventRow> = {}) {
  const prisma = new GroupsPrisma(buildGroupsDataset(eventOverrides));
  const service = new GroupsService(prisma as unknown as PrismaService);
  return { prisma, service };
}

const VOUCHER = '/uploads/vouchers/voucher-1.png';

describe('GroupsService.create', () => {
  it('crea un salón con su voucher base de S/100 pendiente', async () => {
    const { prisma, service } = build();

    const group = await service.create(student, sectionDto(), VOUCHER);

    expect(group).toMatchObject({
      eventId: 1,
      scope: 'SECTION',
      label: 'Ingeniería de Sistemas · V · A1',
      cycle: 'V',
      section: 'A1',
      school: { id: 1, name: 'Ingeniería de Sistemas' },
      delegate: { id: 40, fullName: 'Delegada Uno' },
      baseVoucher: {
        kind: 'BASE',
        status: 'PENDING',
        amount: 100,
        operationNumber: '123456',
        imageUrl: VOUCHER,
        rejectionReason: null,
      },
      extraVouchers: [],
    });
    expect(prisma.data.groups).toHaveLength(1);
    expect(prisma.data.groups[0].baseVoucherId).toBe(group.baseVoucher?.id);
    expect(prisma.data.vouchers).toHaveLength(1);
  });

  it('lista las 5 disciplinas de estudiantes y deja fuera las de otros', async () => {
    const { service } = build();
    const group = await service.create(student, sectionDto(), VOUCHER);
    expect(group.disciplines.map((d) => d.name)).toEqual([
      'Ajedrez',
      'Basquet',
      'Futsal',
      'Gincana',
      'Voley',
    ]);
    expect(group.disciplines.every((d) => d.teams.length === 0)).toBe(true);
  });

  it('crea un ciclo completo de S/150 e ignora la sección enviada', async () => {
    const { service } = build();
    const group = await service.create(student, cycleDto(), VOUCHER);
    expect(group).toMatchObject({
      scope: 'CYCLE',
      cycle: 'V',
      section: '',
      label: 'Ingeniería de Sistemas · V · Ciclo completo',
      baseVoucher: { amount: 150 },
    });
  });

  it('usa la tarifa del evento, no un valor fijo', async () => {
    const { service } = build({
      pricing: {
        sectionBase: new Prisma.Decimal('80.50'),
        cycleBase: new Prisma.Decimal('0'),
        sectionExtra: new Prisma.Decimal('0'),
        cycleExtra: new Prisma.Decimal('0'),
      },
    });
    const group = await service.create(student, sectionDto(), VOUCHER);
    expect(group.baseVoucher?.amount).toBe(80.5);
  });

  it('ejecuta la creación en una transacción serializable', async () => {
    const { prisma, service } = build();
    await service.create(student, sectionDto(), VOUCHER);
    expect(prisma.transactionOptions).toEqual([
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ]);
  });

  it('rechaza el mismo salón aunque se escriba distinto y no crea otro pago', async () => {
    const { prisma, service } = build();
    await service.create(student, sectionDto(), VOUCHER);

    await expect(
      service.create(
        otherStudent,
        sectionDto({ cycle: 'v', section: 'A 1' }),
        VOUCHER,
      ),
    ).rejects.toThrow(ConflictException);
    await expect(
      service.create(
        otherStudent,
        sectionDto({ cycle: 'ciclo V', section: 'a-1' }),
        VOUCHER,
      ),
    ).rejects.toThrow('Este salón ya está inscrito');

    expect(prisma.data.groups).toHaveLength(1);
    expect(prisma.data.vouchers).toHaveLength(1);
  });

  it('permite el mismo ciclo y sección en otra escuela', async () => {
    const { prisma, service } = build();
    await service.create(student, sectionDto(), VOUCHER);
    await service.create(otherStudent, sectionDto({ schoolId: 2 }), VOUCHER);
    expect(prisma.data.groups).toHaveLength(2);
  });

  it('un ciclo completo bloquea inscribir salones sueltos de ese ciclo', async () => {
    const { prisma, service } = build();
    await service.create(student, cycleDto(), VOUCHER);

    await expect(
      service.create(otherStudent, sectionDto({ section: 'B2' }), VOUCHER),
    ).rejects.toThrow('ya participa como ciclo completo');
    expect(prisma.data.groups).toHaveLength(1);

    // Otro ciclo no se ve afectado.
    await service.create(otherStudent, sectionDto({ cycle: 'VI' }), VOUCHER);
    expect(prisma.data.groups).toHaveLength(2);
  });

  it('con salones inscritos no se puede abrir el ciclo completo', async () => {
    const { prisma, service } = build();
    await service.create(student, sectionDto({ section: 'A1' }), VOUCHER);
    await service.create(admin, sectionDto({ section: 'B1' }), VOUCHER);

    await expect(
      service.create(otherStudent, cycleDto(), VOUCHER),
    ).rejects.toThrow(/salones inscritos \(A1, B1\)/);
    expect(prisma.data.groups).toHaveLength(2);
  });

  it('un grupo con voucher rechazado y sin equipos no bloquea la exclusión', async () => {
    const { prisma, service } = build();
    const first = await service.create(student, sectionDto(), VOUCHER);
    const voucher = prisma.data.vouchers.find(
      (v) => v.id === first.baseVoucher?.id,
    );
    if (voucher) voucher.status = VoucherStatus.REJECTED;

    const cycle = await service.create(otherStudent, cycleDto(), VOUCHER);
    expect(cycle.scope).toBe('CYCLE');

    // El mismo salón sigue ocupado: se recupera reemplazando el voucher (US5).
    await expect(service.create(admin, sectionDto(), VOUCHER)).rejects.toThrow(
      /ciclo completo|ya está inscrito/,
    );
  });

  it('un equipo activo mantiene el grupo activo aunque su voucher esté rechazado', () => {
    const rejected = { status: VoucherStatus.REJECTED };
    expect(isActiveGroup({ baseVoucher: rejected, teams: [] })).toBe(false);
    expect(
      isActiveGroup({
        baseVoucher: rejected,
        teams: [{ status: RegistrationStatus.REJECTED }],
      }),
    ).toBe(false);
    expect(
      isActiveGroup({
        baseVoucher: rejected,
        teams: [{ status: RegistrationStatus.PENDING }],
      }),
    ).toBe(true);
    expect(
      isActiveGroup({
        baseVoucher: { status: VoucherStatus.PENDING },
        teams: [],
      }),
    ).toBe(true);
    expect(isActiveGroup({ baseVoucher: null, teams: [] })).toBe(true);
  });

  it('hace rollback completo si falla la creación del voucher', async () => {
    const { prisma, service } = build();
    prisma.failNextVoucherCreate = true;

    await expect(
      service.create(student, sectionDto(), VOUCHER),
    ).rejects.toThrow('voucher.create falló');

    expect(prisma.data.groups).toHaveLength(0);
    expect(prisma.data.vouchers).toHaveLength(0);
  });

  it('traduce un conflicto de serialización en un 409 reintentable', async () => {
    const { prisma, service } = build();
    prisma.failNextTransactionWith = { code: 'P2034' };

    await expect(
      service.create(student, sectionDto(), VOUCHER),
    ).rejects.toThrow(/intenta nuevamente/);
    await expect(
      service.create(student, sectionDto(), VOUCHER),
    ).resolves.toBeDefined();
  });

  describe('reglas del evento', () => {
    it('exige el comprobante del pago general', async () => {
      const { service } = build();
      await expect(
        service.create(student, sectionDto(), undefined),
      ).rejects.toThrow('Adjunta el comprobante del pago general');
    });

    it('responde 404 si el evento no existe', async () => {
      const { service } = build();
      await expect(
        service.create(student, sectionDto({ eventId: 7 }), VOUCHER),
      ).rejects.toThrow(NotFoundException);
    });

    it('rechaza eventos que cobran por disciplina', async () => {
      const { service } = build({ pricingMode: PricingMode.PER_DISCIPLINE });
      await expect(
        service.create(student, sectionDto(), VOUCHER),
      ).rejects.toThrow('Este evento no cobra por salón o ciclo');
    });

    it('rechaza eventos cerrados', async () => {
      const { service } = build({ isOpen: false });
      await expect(
        service.create(student, sectionDto(), VOUCHER),
      ).rejects.toThrow('no está abierto');
    });

    it('rechaza cuando venció el plazo de todas las disciplinas', async () => {
      const dataset = buildGroupsDataset();
      for (const d of dataset.events[0].disciplines) {
        d.registrationDeadline = new Date('2000-01-01T00:00:00.000Z');
      }
      const prisma = new GroupsPrisma(dataset);
      const service = new GroupsService(prisma as unknown as PrismaService);
      await expect(
        service.create(student, sectionDto(), VOUCHER),
      ).rejects.toThrow('El plazo de inscripción ya cerró');
    });

    it('acepta mientras alguna disciplina de estudiantes siga abierta', async () => {
      const dataset = buildGroupsDataset();
      dataset.events[0].disciplines.forEach((d, index) => {
        if (index > 0)
          d.registrationDeadline = new Date('2000-01-01T00:00:00.000Z');
      });
      const prisma = new GroupsPrisma(dataset);
      const service = new GroupsService(prisma as unknown as PrismaService);
      await expect(
        service.create(student, sectionDto(), VOUCHER),
      ).resolves.toBeDefined();
    });

    it('rechaza eventos sin tarifas configuradas', async () => {
      const { service } = build({ pricing: null });
      await expect(
        service.create(student, sectionDto(), VOUCHER),
      ).rejects.toThrow('no tiene tarifas configuradas');
    });

    it('rechaza eventos sin disciplinas para estudiantes', async () => {
      const { service } = build({ disciplines: [] });
      await expect(
        service.create(student, sectionDto(), VOUCHER),
      ).rejects.toThrow('El evento no tiene disciplinas para estudiantes');
    });
  });

  describe('escuela, delegado y datos', () => {
    it('responde 404 si la escuela no existe', async () => {
      const { service } = build();
      await expect(
        service.create(student, sectionDto({ schoolId: 77 }), VOUCHER),
      ).rejects.toThrow('Escuela profesional no encontrada');
    });

    it('rechaza una escuela de otra facultad', async () => {
      const { service } = build();
      await expect(
        service.create(student, sectionDto({ schoolId: 3 }), VOUCHER),
      ).rejects.toThrow('La escuela no corresponde a este evento');
    });

    it('rechaza una escuela distinta cuando el evento es de una sola escuela', async () => {
      const { service } = build({ schoolId: 1 });
      await expect(
        service.create(student, sectionDto({ schoolId: 2 }), VOUCHER),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.create(student, sectionDto({ schoolId: 1 }), VOUCHER),
      ).resolves.toBeDefined();
    });

    it('solo estudiantes o staff pueden inscribir', async () => {
      const { service } = build();
      await expect(
        service.create({ ...student, role: Role.OTHER }, sectionDto(), VOUCHER),
      ).rejects.toThrow(ForbiddenException);
    });

    it('el staff puede crear el grupo en nombre de otro delegado', async () => {
      const { service } = build();
      const group = await service.create(
        admin,
        sectionDto({ delegateId: 41 }),
        VOUCHER,
      );
      expect(group.delegate.id).toBe(41);
    });

    it('un estudiante no puede imponer otro delegado', async () => {
      const { service } = build();
      const group = await service.create(
        student,
        sectionDto({ delegateId: 41 }),
        VOUCHER,
      );
      expect(group.delegate.id).toBe(40);
    });

    it('responde 404 si el delegado indicado por el staff no existe', async () => {
      const { service } = build();
      await expect(
        service.create(admin, sectionDto({ delegateId: 999 }), VOUCHER),
      ).rejects.toThrow('Delegado no encontrado');
    });

    it('rechaza un ciclo inválido y una sección vacía', async () => {
      const { service } = build();
      await expect(
        service.create(student, sectionDto({ cycle: '13' }), VOUCHER),
      ).rejects.toThrow(/Ciclo inválido/);
      await expect(
        service.create(student, sectionDto({ section: ' - ' }), VOUCHER),
      ).rejects.toThrow('Indica la sección');
    });

    it('un ciclo completo no exige sección', async () => {
      const { service } = build();
      await expect(
        service.create(student, cycleDto({ section: undefined }), VOUCHER),
      ).resolves.toMatchObject({ scope: 'CYCLE' });
    });
  });
});

describe('GroupsService (lecturas)', () => {
  async function seeded() {
    const { prisma, service } = build();
    const a = await service.create(
      student,
      sectionDto({ section: 'A1' }),
      VOUCHER,
    );
    const b = await service.create(
      otherStudent,
      sectionDto({ section: 'B1' }),
      VOUCHER,
    );
    // Un segundo salón del mismo delegado solo lo puede registrar el staff a su nombre.
    const c = await service.create(
      admin,
      sectionDto({ cycle: 'VI', section: 'A1', delegateId: student.id }),
      VOUCHER,
    );
    return { prisma, service, a, b, c };
  }

  it('el delegado ve su grupo; otro delegado recibe 403; el staff lo ve', async () => {
    const { service, a } = await seeded();
    await expect(service.findOne(student, a.id)).resolves.toMatchObject({
      id: a.id,
    });
    await expect(service.findOne(otherStudent, a.id)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.findOne(admin, a.id)).resolves.toMatchObject({
      id: a.id,
    });
    await expect(service.findOne(admin, 999)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('findMine devuelve solo los grupos del delegado y filtra por evento', async () => {
    const { service } = await seeded();
    const mine = await service.findMine(student);
    expect(mine.map((g) => g.section).sort()).toEqual(['A1', 'A1']);
    expect(mine.every((g) => g.delegate.id === 40)).toBe(true);
    expect(await service.findMine(student, 2)).toEqual([]);
    expect(await service.findMine(student, 1)).toHaveLength(2);
  });

  it('findAll filtra por escuela, ciclo (normalizado) y estado del voucher base', async () => {
    const { prisma, service, b } = await seeded();
    expect(await service.findAll({ eventId: 1 })).toHaveLength(3);
    expect(await service.findAll({ eventId: 1, cycle: '6' })).toHaveLength(1);
    expect(await service.findAll({ eventId: 1, cycle: 'v' })).toHaveLength(2);
    expect(await service.findAll({ eventId: 1, schoolId: 2 })).toHaveLength(0);

    const voucher = prisma.data.vouchers.find(
      (v) => v.id === b.baseVoucher?.id,
    );
    if (voucher) voucher.status = VoucherStatus.VALIDATED;
    const validated = await service.findAll({
      eventId: 1,
      status: VoucherStatus.VALIDATED,
    });
    expect(validated.map((g) => g.id)).toEqual([b.id]);
  });

  it('el detalle agrupa los equipos por disciplina y muestra los vouchers extra', async () => {
    const { prisma, service, a } = await seeded();
    const futsal = 12;
    prisma.data.vouchers.push({
      id: 500,
      kind: VoucherKind.EXTRA,
      groupId: a.id,
      teamId: null,
      amount: new Prisma.Decimal('20'),
      operationNumber: '777',
      imageUrl: '/uploads/vouchers/extra.png',
      status: VoucherStatus.PENDING,
      rejectionReason: null,
      validatedById: null,
    });
    prisma.data.teams.push(
      {
        id: 1,
        groupId: a.id,
        disciplineId: futsal,
        name: 'Los Bits',
        slot: 1,
        status: RegistrationStatus.PENDING,
        voucherId: a.baseVoucher?.id ?? null,
      },
      {
        id: 2,
        groupId: a.id,
        disciplineId: futsal,
        name: 'Los Bits B',
        slot: 2,
        status: RegistrationStatus.PENDING,
        voucherId: 500,
      },
    );

    const detail = await service.findOne(student, a.id);
    const futsalRow = detail.disciplines.find((d) => d.disciplineId === futsal);
    expect(futsalRow?.teams).toEqual([
      {
        id: 1,
        name: 'Los Bits',
        slot: 1,
        status: 'PENDING',
        rejectionReason: null,
        voucherId: a.baseVoucher?.id,
      },
      {
        id: 2,
        name: 'Los Bits B',
        slot: 2,
        status: 'PENDING',
        rejectionReason: null,
        voucherId: 500,
      },
    ]);
    expect(detail.extraVouchers).toEqual([
      expect.objectContaining({
        id: 500,
        kind: 'EXTRA',
        amount: 20,
        teamIds: [2],
      }),
    ]);
  });
});

describe('GroupsService: un salón o ciclo por estudiante y evento (spec 006)', () => {
  it('un estudiante no puede inscribir un segundo salón en el mismo evento', async () => {
    const { prisma, service } = build();
    await service.create(student, sectionDto({ section: 'A1' }), VOUCHER);

    await expect(
      service.create(student, sectionDto({ section: 'B1' }), VOUCHER),
    ).rejects.toThrow(ConflictException);
    await expect(
      service.create(student, cycleDto({ cycle: 'VI' }), VOUCHER),
    ).rejects.toThrow(/Ya inscribiste tu salón o ciclo/);
    expect(prisma.data.groups).toHaveLength(1);
  });

  it('otro estudiante sí puede inscribir su propio salón', async () => {
    const { prisma, service } = build();
    await service.create(student, sectionDto({ section: 'A1' }), VOUCHER);
    await service.create(otherStudent, sectionDto({ section: 'B1' }), VOUCHER);
    expect(prisma.data.groups).toHaveLength(2);
  });

  it('si el pago general fue rechazado y no quedan equipos vigentes puede intentar de nuevo', async () => {
    const { prisma, service } = build();
    const first = await service.create(student, sectionDto(), VOUCHER);
    const voucher = prisma.data.vouchers.find(
      (v) => v.id === first.baseVoucher?.id,
    );
    if (voucher) voucher.status = VoucherStatus.REJECTED;

    await expect(
      service.create(student, sectionDto({ section: 'B1' }), VOUCHER),
    ).resolves.toMatchObject({ section: 'B1' });
  });

  it('el staff puede registrar varios salones, incluso a nombre del mismo delegado', async () => {
    const { prisma, service } = build();
    await service.create(admin, sectionDto({ section: 'A1' }), VOUCHER);
    await service.create(admin, sectionDto({ section: 'B1' }), VOUCHER);
    await service.create(
      admin,
      sectionDto({ section: 'C1', delegateId: student.id }),
      VOUCHER,
    );
    await service.create(
      admin,
      sectionDto({ section: 'D1', delegateId: student.id }),
      VOUCHER,
    );
    expect(prisma.data.groups).toHaveLength(4);
  });
});

describe('GroupsService: borradores (spec 006)', () => {
  const treasurer: RequestUser = {
    id: 3,
    email: 'tesorero@undc.edu.pe',
    fullName: 'Tesorero',
    role: Role.TREASURER,
  };

  async function withDrafts() {
    const { prisma, service } = build();
    const group = await service.create(student, sectionDto(), VOUCHER);
    prisma.data.vouchers.push({
      id: 600,
      kind: VoucherKind.EXTRA,
      groupId: group.id,
      teamId: null,
      amount: new Prisma.Decimal('20'),
      operationNumber: null,
      imageUrl: '/uploads/vouchers/extra.png',
      status: VoucherStatus.PENDING,
      rejectionReason: null,
      validatedById: null,
    });
    prisma.data.teams.push(
      {
        id: 1,
        groupId: group.id,
        disciplineId: 12,
        name: 'Enviado',
        slot: 1,
        status: RegistrationStatus.PENDING,
        voucherId: group.baseVoucher?.id ?? null,
      },
      {
        id: 2,
        groupId: group.id,
        disciplineId: 12,
        name: 'Borrador adicional',
        slot: 2,
        status: RegistrationStatus.DRAFT,
        voucherId: 600,
      },
      {
        id: 3,
        groupId: group.id,
        disciplineId: 13,
        name: 'Otro borrador',
        slot: 1,
        status: RegistrationStatus.DRAFT,
        voucherId: group.baseVoucher?.id ?? null,
      },
    );
    return { service, group };
  }

  it('el delegado y el staff ven los borradores y su cantidad', async () => {
    const { service, group } = await withDrafts();
    for (const viewer of [student, admin]) {
      const detail = await service.findOne(viewer, group.id);
      expect(detail.draftCount).toBe(2);
      const names = detail.disciplines.flatMap((d) =>
        d.teams.map((t) => t.name),
      );
      expect(names).toEqual(
        expect.arrayContaining([
          'Enviado',
          'Borrador adicional',
          'Otro borrador',
        ]),
      );
      expect(detail.extraVouchers).toHaveLength(1);
    }
  });

  it('el tesorero no ve borradores ni un comprobante adicional que solo cubre borradores', async () => {
    const { service, group } = await withDrafts();
    const detail = await service.findOne(treasurer, group.id);
    const names = detail.disciplines.flatMap((d) => d.teams.map((t) => t.name));
    expect(names).toEqual(['Enviado']);
    expect(detail.draftCount).toBe(0);
    expect(detail.extraVouchers).toEqual([]);

    const [listed] = await service.findAll({ eventId: 1 }, treasurer);
    expect(listed.draftCount).toBe(0);
    expect(listed.disciplines.flatMap((d) => d.teams)).toHaveLength(1);
  });

  it('un grupo con voucher rechazado y solo borradores deja de ser activo', () => {
    expect(
      isActiveGroup({
        baseVoucher: { status: VoucherStatus.REJECTED },
        teams: [{ status: RegistrationStatus.DRAFT }],
      }),
    ).toBe(false);
  });
});
