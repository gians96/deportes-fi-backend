import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  GroupScope,
  Prisma,
  RegistrationStatus,
  VoucherKind,
  VoucherStatus,
} from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  buildGroupsDataset,
  GroupsPrisma,
} from '../../test/fakes/groups-prisma';
import type { FakeEventRow } from '../../test/fakes/groups-prisma';
import type {
  CreateRegistrationDto,
  ParticipantDto,
} from './dto/create-registration.dto';
import { RegistrationsService } from './registrations.service';

const DELEGATE = 40;
const OTHER_DELEGATE = 41;
const ADMIN = 1;
const EXTERNAL = 60;
const GROUP_ID = 5;
const FUTSAL = 12;
const VOLEY = 13;
const OTHERS_DISCIPLINE = 99;
const PNG = '/uploads/vouchers/extra.png';

function roster(
  count: number,
  options: { captainIndex?: number; seed?: number } = {},
): ParticipantDto[] {
  const { captainIndex = 0, seed = 1 } = options;
  return Array.from({ length: count }, (_, i) => ({
    fullName: `ALUMNO ${seed}-${i + 1}`,
    studentCode: String(2300000000 + seed * 100 + i),
    dni: String(70000000 + seed * 100 + i),
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

function build(
  options: { scope?: GroupScope; event?: Partial<FakeEventRow> } = {},
) {
  const scope = options.scope ?? GroupScope.SECTION;
  const dataset = buildGroupsDataset(options.event);
  dataset.vouchers.push({
    id: 100,
    kind: VoucherKind.BASE,
    groupId: GROUP_ID,
    teamId: null,
    amount: new Prisma.Decimal(scope === GroupScope.CYCLE ? '150' : '100'),
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
    scope,
    cycle: 'V',
    section: scope === GroupScope.CYCLE ? '' : 'A1',
    delegateId: DELEGATE,
    baseVoucherId: 100,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const prisma = new GroupsPrisma(dataset);
  const service = new RegistrationsService(prisma as unknown as PrismaService);
  return { prisma, service, dataset };
}

const slotsOf = (prisma: GroupsPrisma, disciplineId: number) =>
  prisma.data.teams
    .filter((t) => t.groupId === GROUP_ID && t.disciplineId === disciplineId)
    .map((t) => t.slot)
    .sort();

describe('RegistrationsService.create en un salón o ciclo', () => {
  describe('primer equipo de cada disciplina (cubierto por el pago general)', () => {
    it('queda en el cupo 1, enlazado al voucher base y sin pedir otro comprobante', async () => {
      const { prisma, service } = build();

      const team = await service.create(DELEGATE, dto());

      expect(team).toMatchObject({
        groupId: GROUP_ID,
        slot: 1,
        voucherId: 100,
        cycle: 'V',
        section: 'A1',
        status: RegistrationStatus.PENDING,
        delegateId: DELEGATE,
      });
      expect(prisma.data.vouchers).toHaveLength(1);
    });

    it('un voucher cubre las cinco disciplinas del grupo', async () => {
      const { prisma, service } = build();
      for (const disciplineId of [10, 11, 12, 13, 14]) {
        await service.create(
          DELEGATE,
          dto({ disciplineId, teamName: `Equipo ${disciplineId}` }),
        );
      }
      expect(prisma.data.teams).toHaveLength(5);
      expect(prisma.data.teams.every((t) => t.voucherId === 100)).toBe(true);
      expect(prisma.data.teams.every((t) => t.slot === 1)).toBe(true);
      expect(prisma.data.vouchers).toHaveLength(1);
    });

    it('un ciclo completo guarda "CICLO COMPLETO" como sección', async () => {
      const { service } = build({ scope: GroupScope.CYCLE });
      await expect(service.create(DELEGATE, dto())).resolves.toMatchObject({
        cycle: 'V',
        section: 'CICLO COMPLETO',
        slot: 1,
      });
    });

    it('ignora el ciclo y la sección que envíe el cliente', async () => {
      const { service } = build();
      await expect(
        service.create(DELEGATE, dto({ cycle: 'X', section: 'Z9' })),
      ).resolves.toMatchObject({ cycle: 'V', section: 'A1' });
    });

    it('rechaza adjuntar otro comprobante para el primer equipo', async () => {
      const { prisma, service } = build();
      await expect(service.create(DELEGATE, dto(), PNG)).rejects.toThrow(
        'ya está cubierto por el pago general',
      );
      expect(prisma.data.teams).toHaveLength(0);
      expect(prisma.data.vouchers).toHaveLength(1);
    });

    it('el mismo alumno puede jugar en equipos de distintas disciplinas', async () => {
      const { prisma, service } = build();
      const players = roster(3);
      await service.create(DELEGATE, dto({ participants: players }));
      await service.create(
        DELEGATE,
        dto({ disciplineId: VOLEY, teamName: 'Voley', participants: players }),
      );
      expect(prisma.data.teams).toHaveLength(2);
    });

    it('vincula a los integrantes con su usuario por código de estudiante', async () => {
      const { prisma, service } = build();
      const players = roster(2);
      players[1] = { ...players[1], studentCode: '2301010150' };
      await service.create(DELEGATE, dto({ participants: players }));
      const stored = prisma.data.teams[0].participants ?? [];
      expect(stored.map((p) => p.userId)).toEqual([null, OTHER_DELEGATE]);
      expect(stored.map((p) => p.isCaptain)).toEqual([true, false]);
    });
  });

  describe('equipos adicionales en la misma disciplina', () => {
    it('el segundo equipo exige su comprobante e informa la tarifa', async () => {
      const { prisma, service } = build();
      await service.create(DELEGATE, dto());

      await expect(
        service.create(
          DELEGATE,
          dto({ teamName: 'Los Bits B', participants: roster(3, { seed: 2 }) }),
        ),
      ).rejects.toThrow(
        'El equipo adicional requiere su comprobante de pago (S/ 20.00)',
      );
      expect(slotsOf(prisma, FUTSAL)).toEqual([1]);
    });

    it('con comprobante queda en el cupo 2 y crea un voucher EXTRA de S/20', async () => {
      const { prisma, service } = build();
      await service.create(DELEGATE, dto());

      const team = await service.create(
        DELEGATE,
        dto({
          teamName: 'Los Bits B',
          operationNumber: ' 998 ',
          participants: roster(3, { seed: 2 }),
        }),
        PNG,
      );

      const extra = prisma.data.vouchers.find(
        (v) => v.kind === VoucherKind.EXTRA,
      );
      expect(team).toMatchObject({ slot: 2, groupId: GROUP_ID });
      expect(extra).toMatchObject({
        groupId: GROUP_ID,
        status: VoucherStatus.PENDING,
        operationNumber: '998',
        imageUrl: PNG,
      });
      expect(Number(extra?.amount)).toBe(20);
      expect(team?.voucherId).toBe(extra?.id);
      expect(team?.voucherId).not.toBe(100);
    });

    it('en un ciclo completo el adicional cuesta S/30', async () => {
      const { prisma, service } = build({ scope: GroupScope.CYCLE });
      await service.create(DELEGATE, dto());
      await service.create(
        DELEGATE,
        dto({ teamName: 'B', participants: roster(3, { seed: 2 }) }),
        PNG,
      );
      const extra = prisma.data.vouchers.find(
        (v) => v.kind === VoucherKind.EXTRA,
      );
      expect(Number(extra?.amount)).toBe(30);
    });

    it('el cupo se cuenta por disciplina', async () => {
      const { prisma, service } = build();
      await service.create(DELEGATE, dto());
      await service.create(
        DELEGATE,
        dto({ teamName: 'B', participants: roster(3, { seed: 2 }) }),
        PNG,
      );
      await service.create(
        DELEGATE,
        dto({ disciplineId: VOLEY, teamName: 'Voley' }),
      );
      expect(slotsOf(prisma, FUTSAL)).toEqual([1, 2]);
      expect(slotsOf(prisma, VOLEY)).toEqual([1]);
    });

    it('un tercer equipo puede sumarse al comprobante EXTRA pendiente (S/40)', async () => {
      const { prisma, service } = build();
      await service.create(DELEGATE, dto());
      const second = await service.create(
        DELEGATE,
        dto({ teamName: 'B', participants: roster(3, { seed: 2 }) }),
        PNG,
      );
      const extraId = second?.voucherId as number;

      const third = await service.create(
        DELEGATE,
        dto({
          teamName: 'C',
          participants: roster(3, { seed: 3 }),
          extraVoucherId: extraId,
        }),
      );

      expect(third).toMatchObject({ slot: 3, voucherId: extraId });
      const extra = prisma.data.vouchers.find((v) => v.id === extraId);
      expect(Number(extra?.amount)).toBe(40);
      expect(
        prisma.data.vouchers.filter((v) => v.kind === VoucherKind.EXTRA),
      ).toHaveLength(1);
    });

    it('rechaza un EXTRA ajeno, ya revisado o que no es EXTRA, y mezclarlo con un archivo', async () => {
      const { prisma, service } = build();
      await service.create(DELEGATE, dto());
      const second = await service.create(
        DELEGATE,
        dto({ teamName: 'B', participants: roster(3, { seed: 2 }) }),
        PNG,
      );
      const extraId = second?.voucherId as number;
      const attempt = (extraVoucherId: number, file?: string) =>
        service.create(
          DELEGATE,
          dto({
            teamName: 'C',
            participants: roster(3, { seed: 3 }),
            extraVoucherId,
          }),
          file,
        );

      await expect(attempt(100)).rejects.toThrow(
        'no corresponde a este salón o ciclo',
      );
      await expect(attempt(999)).rejects.toThrow(BadRequestException);
      await expect(attempt(extraId, PNG)).rejects.toThrow('no ambos');

      const extra = prisma.data.vouchers.find((v) => v.id === extraId);
      if (extra) extra.status = VoucherStatus.VALIDATED;
      await expect(attempt(extraId)).rejects.toThrow('ya fue revisado');

      if (extra) {
        extra.status = VoucherStatus.PENDING;
        extra.groupId = 777;
      }
      await expect(attempt(extraId)).rejects.toThrow(
        'no corresponde a este salón o ciclo',
      );
    });

    it('los adicionales también respetan el máximo de equipos de la disciplina', async () => {
      const dataset = buildGroupsDataset();
      dataset.events[0].disciplines.find((d) => d.id === FUTSAL)!.maxTeams = 1;
      const { prisma, service } = build({ event: dataset.events[0] });
      await service.create(DELEGATE, dto());
      await expect(
        service.create(
          DELEGATE,
          dto({ teamName: 'B', participants: roster(3, { seed: 2 }) }),
          PNG,
        ),
      ).rejects.toThrow('número máximo de equipos');
      expect(prisma.data.vouchers).toHaveLength(1);
    });

    it('si el evento no tiene tarifas, no se puede crear un adicional', async () => {
      const { service } = build({ event: { pricing: null } });
      await service.create(DELEGATE, dto());
      await expect(
        service.create(
          DELEGATE,
          dto({ teamName: 'B', participants: roster(3, { seed: 2 }) }),
          PNG,
        ),
      ).rejects.toThrow('no tiene tarifas configuradas');
    });
  });

  describe('cupos liberados y carreras', () => {
    it('al rechazar el equipo del cupo 1 se libera y el reemplazo no paga adicional', async () => {
      const { prisma, service } = build();
      const first = await service.create(DELEGATE, dto());
      await service.reject(first?.id as number, 'Faltan datos');

      const rejected = prisma.data.teams.find((t) => t.id === first?.id);
      expect(rejected).toMatchObject({
        status: RegistrationStatus.REJECTED,
        slot: null,
      });

      const replacement = await service.create(
        DELEGATE,
        dto({ teamName: 'Reemplazo', participants: roster(3, { seed: 2 }) }),
      );
      expect(replacement).toMatchObject({ slot: 1, voucherId: 100 });
      expect(prisma.data.vouchers).toHaveLength(1);
    });

    it('rechazar un equipo de un evento por disciplina no toca el cupo', async () => {
      const { prisma, service } = build();
      prisma.data.teams.push({
        id: 900,
        groupId: null,
        disciplineId: FUTSAL,
        name: 'Legacy',
        slot: null,
        status: RegistrationStatus.PENDING,
        voucherId: null,
      });
      await service.reject(900, 'No cumple');
      expect(prisma.data.teams.find((t) => t.id === 900)).toMatchObject({
        status: RegistrationStatus.REJECTED,
        slot: null,
      });
    });

    it('si otra solicitud gana el cupo 1, la nuestra pasa a adicional y exige comprobante', async () => {
      const { prisma, service } = build();
      prisma.competingTeamOnNextCreate = { name: 'Equipo rival' };

      await expect(service.create(DELEGATE, dto())).rejects.toThrow(
        'requiere su comprobante de pago',
      );

      expect(slotsOf(prisma, FUTSAL)).toEqual([1]);
      expect(prisma.data.teams[0].name).toBe('Equipo rival');
    });

    it('si otra solicitud gana el cupo 2, la nuestra obtiene el 3 y no deja vouchers huérfanos', async () => {
      const { prisma, service } = build();
      await service.create(DELEGATE, dto());
      prisma.competingTeamOnNextCreate = { name: 'Equipo rival' };

      const team = await service.create(
        DELEGATE,
        dto({ teamName: 'B', participants: roster(3, { seed: 2 }) }),
        PNG,
      );

      expect(team?.slot).toBe(3);
      expect(slotsOf(prisma, FUTSAL)).toEqual([1, 2, 3]);
      expect(
        prisma.data.vouchers.filter((v) => v.kind === VoucherKind.EXTRA),
      ).toHaveLength(1);
    });
  });

  describe('nómina del equipo', () => {
    it.each([
      [
        'sin capitán',
        roster(3).map((p) => ({ ...p, isCaptain: false })),
        'Designa un capitán/a',
      ],
      [
        'con dos capitanes',
        roster(3).map((p) => ({ ...p, isCaptain: true })),
        'hay más de uno',
      ],
      [
        'con un DNI faltante',
        roster(3).map((p, i) => (i === 1 ? { ...p, dni: null } : p)),
        'Falta el DNI',
      ],
      [
        'con un DNI de 7 dígitos',
        roster(3).map((p, i) => (i === 2 ? { ...p, dni: '1234567' } : p)),
        'Falta el DNI',
      ],
      [
        'con un DNI repetido',
        roster(3).map((p, i) =>
          i === 2 ? { ...p, dni: roster(3)[0].dni } : p,
        ),
        'DNI repetido',
      ],
      [
        'sin código de estudiante',
        roster(3).map((p, i) => (i === 0 ? { ...p, studentCode: null } : p)),
        'requieren codigo de estudiante',
      ],
    ])('rechaza una nómina %s', async (_name, participants, message) => {
      const { prisma, service } = build();
      await expect(
        service.create(DELEGATE, dto({ participants })),
      ).rejects.toThrow(message);
      expect(prisma.data.teams).toHaveLength(0);
    });

    it('respeta mínimo y máximo de jugadores de la disciplina', async () => {
      const { service } = build();
      await expect(
        service.create(DELEGATE, dto({ participants: roster(10) })),
      ).rejects.toThrow('El equipo debe tener entre 1 y 9 jugadores');
    });
  });

  describe('acceso y reglas del evento', () => {
    it('exige groupId en eventos que cobran por grupo', async () => {
      const { service } = build();
      await expect(
        service.create(DELEGATE, dto({ groupId: undefined })),
      ).rejects.toThrow('primero registra tu salón o ciclo');
    });

    it('responde 404 si el grupo no existe o es de otro evento', async () => {
      const { prisma, service } = build();
      await expect(
        service.create(DELEGATE, dto({ groupId: 999 })),
      ).rejects.toThrow(NotFoundException);
      prisma.data.groups[0].eventId = 2;
      await expect(service.create(DELEGATE, dto())).rejects.toThrow(
        'Salón o ciclo no encontrado',
      );
    });

    it('otro delegado no puede registrar equipos en un salón ajeno', async () => {
      const { prisma, service } = build();
      await expect(service.create(OTHER_DELEGATE, dto())).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.data.teams).toHaveLength(0);
    });

    it('el staff puede registrar y el delegado del equipo es el del grupo', async () => {
      const { service } = build();
      await expect(service.create(ADMIN, dto())).resolves.toMatchObject({
        delegateId: DELEGATE,
        slot: 1,
      });
    });

    it('el staff puede indicar otro delegado para el equipo', async () => {
      const { service } = build();
      await expect(
        // El controlador pasa delegateId como 4.º argumento solo si el actor es staff.
        service.create(ADMIN, dto(), undefined, OTHER_DELEGATE),
      ).resolves.toMatchObject({ delegateId: OTHER_DELEGATE });
    });

    it('rechaza si el evento está cerrado', async () => {
      const { service } = build({ event: { isOpen: false } });
      await expect(service.create(DELEGATE, dto())).rejects.toThrow(
        'no está abierto',
      );
    });

    it('rechaza si venció el plazo de la disciplina', async () => {
      const dataset = buildGroupsDataset();
      dataset.events[0].disciplines.find(
        (d) => d.id === FUTSAL,
      )!.registrationDeadline = new Date('2000-01-01T00:00:00.000Z');
      const { service } = build({ event: dataset.events[0] });
      await expect(service.create(DELEGATE, dto())).rejects.toThrow(
        'El plazo de inscripción para esta disciplina ya cerró',
      );
    });

    it('las disciplinas para otros participantes siguen el flujo por disciplina', async () => {
      const { prisma, service } = build();
      const team = await service.create(
        EXTERNAL,
        dto({
          disciplineId: OTHERS_DISCIPLINE,
          groupId: undefined,
          cycle: null,
          section: null,
          participants: [
            {
              fullName: 'PERSONA EXTERNA',
              studentCode: null,
              dni: '70000002',
              gender: 'O',
              isDelegate: false,
              countsAsPlayer: true,
            },
          ],
        }),
      );
      expect(team).toMatchObject({
        groupId: null,
        slot: null,
        status: 'PENDING',
      });
      expect(prisma.data.vouchers).toHaveLength(1);
    });
  });
});

describe('RegistrationsService.approve / reject con grupos', () => {
  async function pendingTeam() {
    const fixture = build();
    const team = await fixture.service.create(DELEGATE, dto());
    return { ...fixture, teamId: team?.id as number };
  }

  it('exige que el comprobante que cubre al equipo esté validado', async () => {
    const { prisma, service, teamId } = await pendingTeam();
    await expect(service.approve(teamId)).rejects.toThrow(
      'Primero valida el comprobante que cubre al equipo',
    );

    prisma.data.vouchers[0].status = VoucherStatus.VALIDATED;
    await service.approve(teamId);
    expect(prisma.data.teams.find((t) => t.id === teamId)?.status).toBe(
      RegistrationStatus.APPROVED,
    );
  });

  it('un equipo adicional se aprueba con su propio comprobante, no con el base', async () => {
    const { prisma, service } = build();
    await service.create(DELEGATE, dto());
    const second = await service.create(
      DELEGATE,
      dto({ teamName: 'B', participants: roster(3, { seed: 2 }) }),
      PNG,
    );
    prisma.data.vouchers.find((v) => v.id === 100)!.status =
      VoucherStatus.VALIDATED;

    await expect(service.approve(second?.id as number)).rejects.toThrow(
      'Primero valida el comprobante',
    );
    prisma.data.vouchers.find((v) => v.id === second?.voucherId)!.status =
      VoucherStatus.VALIDATED;
    await expect(service.approve(second?.id as number)).resolves.toBeDefined();
  });

  it('no aprueba un equipo rechazado: debe registrarse de nuevo', async () => {
    const { prisma, service, teamId } = await pendingTeam();
    prisma.data.vouchers[0].status = VoucherStatus.VALIDATED;
    await service.reject(teamId, 'Datos incompletos');
    await expect(service.approve(teamId)).rejects.toThrow(
      'debe registrarse de nuevo',
    );
  });

  it('vuelve a comprobar la nómina al aprobar', async () => {
    const { prisma, service, teamId } = await pendingTeam();
    prisma.data.vouchers[0].status = VoucherStatus.VALIDATED;
    const stored = prisma.data.teams.find((t) => t.id === teamId);
    if (stored?.participants) stored.participants[0].isCaptain = false;
    await expect(service.approve(teamId)).rejects.toThrow(
      'Designa un capitán/a',
    );
  });

  it('un equipo de un evento por disciplina conserva su regla de pago anterior', async () => {
    const { prisma, service } = build();
    prisma.data.events[0].disciplines.find((d) => d.id === FUTSAL)!.isPaid =
      true;
    prisma.data.teams.push({
      id: 901,
      groupId: null,
      disciplineId: FUTSAL,
      name: 'Legacy pagado',
      slot: null,
      status: RegistrationStatus.PENDING,
      voucherId: null,
      cycle: 'VIII',
      section: 'A',
      participants: [
        {
          fullName: 'ALUMNO LEGACY',
          studentCode: '2301010199',
          dni: null,
          gender: 'O',
          isDelegate: false,
          countsAsPlayer: true,
          isCaptain: false,
          userId: null,
        },
      ],
    });
    await expect(service.approve(901)).rejects.toThrow(
      'Primero valida el voucher del equipo pagado',
    );
  });
});
