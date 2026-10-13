import { BadRequestException } from '@nestjs/common';
import {
  GenderPolicy,
  ParticipantType,
  Prisma,
  PricingMode,
  Role,
  VoucherStatus,
} from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { CreateRegistrationDto } from './dto/create-registration.dto';
import { RegistrationsService } from './registrations.service';

const FUTURE = new Date('2099-12-31T23:59:00.000Z');

function buildService(options: { isPaid: boolean }) {
  const tx = {
    team: {
      create: jest.fn().mockResolvedValue({ id: 301 }),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ id: 301 }),
    },
    voucher: { create: jest.fn().mockResolvedValue({ id: 77 }) },
  };
  const prisma = {
    discipline: {
      findUnique: jest.fn().mockResolvedValue({
        id: 10,
        participantType: ParticipantType.STUDENT,
        minPlayers: 1,
        maxPlayers: 9,
        genderPolicy: GenderPolicy.FREE,
        registrationDeadline: FUTURE,
        maxTeams: 0,
        isPaid: options.isPaid,
        cost: new Prisma.Decimal('50'),
        _count: { teams: 0 },
        event: {
          id: 1,
          pricingMode: PricingMode.PER_DISCIPLINE,
          isOpen: true,
          pricing: null,
        },
      }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        role: Role.STUDENT,
        email: '2301010149@undc.edu.pe',
        studentCode: '2301010149',
        dni: null,
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };
  const service = new RegistrationsService(prisma as unknown as PrismaService);
  return { service, tx };
}

const dto: CreateRegistrationDto = {
  disciplineId: 10,
  teamName: 'Los Bits',
  phone: '999999999',
  cycle: 'VIII',
  section: 'A',
  operationNumber: '123456',
  participants: [
    {
      fullName: 'ALUMNO UNO',
      studentCode: '2301010149',
      dni: null,
      gender: 'O',
      isDelegate: false,
      countsAsPlayer: true,
    },
  ],
};

describe('RegistrationsService.create (flujo por disciplina, sin cambios de comportamiento)', () => {
  it('crea el voucher del equipo y enlaza Team.voucherId (doble escritura de transición)', async () => {
    const { service, tx } = buildService({ isPaid: true });

    await service.create(5, dto, '/uploads/vouchers/v.png');

    const [created] = tx.voucher.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(created.data).toMatchObject({
      teamId: 301,
      imageUrl: '/uploads/vouchers/v.png',
      status: VoucherStatus.PENDING,
    });
    expect(tx.team.update).toHaveBeenCalledWith({
      where: { id: 301 },
      data: { voucherId: 77 },
    });
  });

  it('una disciplina gratuita no crea voucher ni toca Team.voucherId', async () => {
    const { service, tx } = buildService({ isPaid: false });

    await service.create(5, dto);

    expect(tx.voucher.create).not.toHaveBeenCalled();
    expect(tx.team.update).not.toHaveBeenCalled();
  });

  it('una disciplina pagada sigue exigiendo el comprobante', async () => {
    const { service, tx } = buildService({ isPaid: true });

    await expect(service.create(5, dto)).rejects.toThrow(BadRequestException);
    await expect(service.create(5, dto)).rejects.toThrow(
      'Esta disciplina requiere adjuntar el comprobante de pago',
    );
    expect(tx.team.create).not.toHaveBeenCalled();
  });
});
