import { Injectable } from '@nestjs/common';
import { RegistrationStatus, VoucherStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard() {
    const [
      pendingVouchers,
      totalTeams,
      totalParticipants,
      activeEvents,
      byStatus,
    ] = await Promise.all([
      this.prisma.voucher.count({ where: { status: VoucherStatus.PENDING } }),
      this.prisma.team.count({
        where: { status: { not: RegistrationStatus.DRAFT } },
      }),
      this.prisma.participant.count(),
      this.prisma.sportEvent.count({ where: { isOpen: true } }),
      this.prisma.team.groupBy({
        by: ['status'],
        where: { status: { not: RegistrationStatus.DRAFT } },
        _count: { _all: true },
      }),
    ]);

    const statusOrder: RegistrationStatus[] = [
      RegistrationStatus.PENDING,
      RegistrationStatus.APPROVED,
      RegistrationStatus.REJECTED,
      RegistrationStatus.CANCELLED,
    ];
    const statusLabels: Record<RegistrationStatus, string> = {
      PENDING: 'Pendientes',
      APPROVED: 'Aprobados',
      REJECTED: 'Rechazados',
      CANCELLED: 'Cancelados',
      DRAFT: 'Borradores',
    };

    const countMap = new Map<RegistrationStatus, number>();
    for (const row of byStatus) {
      countMap.set(row.status, row._count._all);
    }

    return {
      pendingVouchers,
      totalTeams,
      totalParticipants,
      activeEvents,
      chartLabels: statusOrder.map((s) => statusLabels[s]),
      chartValues: statusOrder.map((s) => countMap.get(s) ?? 0),
    };
  }
}
