import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  GroupScope,
  ParticipantType,
  Prisma,
  PricingMode,
  Role,
  VoucherKind,
  VoucherStatus,
} from '@prisma/client';
import type { RequestUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { CreateGroupDto } from './dto/create-group.dto';
import {
  DisciplineRef,
  GroupDetail,
  GroupWithDetail,
  groupDetailInclude,
  isActiveGroup,
  toGroupDetail,
} from './group-detail';
import { normalizeCycle, normalizeSection } from './group-normalize';
import { baseFee } from './group-pricing';

const STAFF_ROLES: Role[] = [Role.OWNER_SYSTEM, Role.ADMIN_SYSTEM];

function isStaff(actor: RequestUser): boolean {
  return STAFF_ROLES.includes(actor.role);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? (error as { code?: string }).code
    : undefined;
}

export interface GroupListQuery {
  eventId: number;
  schoolId?: number;
  cycle?: string;
  status?: VoucherStatus;
}

@Injectable()
export class GroupsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Crea el grupo (salón o ciclo completo) junto con su voucher BASE. La unicidad del grupo la
   * garantiza la base de datos; la exclusión ciclo/sección se valida en una transacción
   * serializable porque dos claves distintas no pueden bloquearse con un índice único.
   */
  async create(
    actor: RequestUser,
    dto: CreateGroupDto,
    voucherPath?: string,
  ): Promise<GroupDetail> {
    if (!voucherPath) {
      throw new BadRequestException('Adjunta el comprobante del pago general');
    }
    const staff = isStaff(actor);
    if (!staff && actor.role !== Role.STUDENT) {
      throw new ForbiddenException(
        'Solo los estudiantes pueden inscribir un salón o ciclo',
      );
    }

    const event = await this.prisma.sportEvent.findUnique({
      where: { id: dto.eventId },
      include: {
        pricing: true,
        disciplines: {
          select: { participantType: true, registrationDeadline: true },
        },
      },
    });
    if (!event) {
      throw new NotFoundException('Evento no encontrado');
    }
    if (event.pricingMode !== PricingMode.PER_GROUP) {
      throw new BadRequestException('Este evento no cobra por salón o ciclo');
    }
    if (!event.isOpen) {
      throw new BadRequestException(
        'El evento no está abierto a inscripciones',
      );
    }
    const deadlines = event.disciplines
      .filter((d) => d.participantType === ParticipantType.STUDENT)
      .map((d) => d.registrationDeadline.getTime());
    if (!deadlines.length) {
      throw new BadRequestException(
        'El evento no tiene disciplinas para estudiantes',
      );
    }
    if (Date.now() > Math.max(...deadlines)) {
      throw new BadRequestException('El plazo de inscripción ya cerró');
    }
    const pricing = event.pricing;
    if (!pricing) {
      throw new BadRequestException('El evento no tiene tarifas configuradas');
    }

    const school = await this.prisma.professionalSchool.findUnique({
      where: { id: dto.schoolId },
      select: { id: true, facultyId: true },
    });
    if (!school) {
      throw new NotFoundException('Escuela profesional no encontrada');
    }
    if (
      school.facultyId !== event.facultyId ||
      (event.schoolId !== null && event.schoolId !== school.id)
    ) {
      throw new BadRequestException('La escuela no corresponde a este evento');
    }

    let delegateId = actor.id;
    if (staff && dto.delegateId) {
      const delegate = await this.prisma.user.findUnique({
        where: { id: dto.delegateId },
        select: { id: true },
      });
      if (!delegate) {
        throw new NotFoundException('Delegado no encontrado');
      }
      delegateId = delegate.id;
    }

    const scope = dto.scope;
    const cycle = normalizeCycle(dto.cycle);
    const section =
      scope === GroupScope.CYCLE ? '' : normalizeSection(dto.section ?? '');
    const amount = baseFee(pricing, scope);

    try {
      const groupId = await this.prisma.$transaction(
        async (tx) => {
          const siblings = await tx.classGroup.findMany({
            where: { eventId: event.id, schoolId: school.id, cycle },
            select: {
              scope: true,
              section: true,
              baseVoucher: { select: { status: true } },
              teams: { select: { status: true } },
            },
          });
          const active = siblings.filter(isActiveGroup);
          if (scope === GroupScope.CYCLE) {
            const sections = active
              .filter((g) => g.scope === GroupScope.SECTION)
              .map((g) => g.section)
              .sort();
            if (sections.length) {
              throw new BadRequestException(
                `El ciclo ${cycle} ya tiene salones inscritos (${sections.join(', ')}); no puede inscribirse como ciclo completo`,
              );
            }
          } else if (active.some((g) => g.scope === GroupScope.CYCLE)) {
            throw new BadRequestException(
              `El ciclo ${cycle} ya participa como ciclo completo`,
            );
          }

          let group: { id: number };
          try {
            group = await tx.classGroup.create({
              data: {
                eventId: event.id,
                schoolId: school.id,
                scope,
                cycle,
                section,
                delegateId,
              },
              select: { id: true },
            });
          } catch (error) {
            if (errorCode(error) === 'P2002') {
              throw new ConflictException(
                scope === GroupScope.CYCLE
                  ? 'Este ciclo ya está inscrito'
                  : 'Este salón ya está inscrito',
              );
            }
            throw error;
          }

          const voucher = await tx.voucher.create({
            data: {
              kind: VoucherKind.BASE,
              groupId: group.id,
              operationNumber: dto.operationNumber?.trim() || null,
              amount,
              imageUrl: voucherPath,
              status: VoucherStatus.PENDING,
            },
            select: { id: true },
          });
          await tx.classGroup.update({
            where: { id: group.id },
            data: { baseVoucherId: voucher.id },
          });
          return group.id;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return await this.findDetail(groupId);
    } catch (error) {
      // P2034: conflicto de serialización (otra inscripción simultánea del mismo ciclo).
      if (errorCode(error) === 'P2034') {
        throw new ConflictException(
          'Otra inscripción del mismo ciclo se está procesando; intenta nuevamente',
        );
      }
      throw error;
    }
  }

  async findOne(actor: RequestUser, id: number): Promise<GroupDetail> {
    const group = await this.prisma.classGroup.findUnique({
      where: { id },
      include: groupDetailInclude,
    });
    if (!group) {
      throw new NotFoundException('Salón o ciclo no encontrado');
    }
    if (!isStaff(actor) && group.delegateId !== actor.id) {
      throw new ForbiddenException('No tienes acceso a este salón o ciclo');
    }
    const [detail] = await this.detailMany([group]);
    return detail;
  }

  async findMine(actor: RequestUser, eventId?: number): Promise<GroupDetail[]> {
    const groups = await this.prisma.classGroup.findMany({
      where: { delegateId: actor.id, ...(eventId ? { eventId } : {}) },
      include: groupDetailInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return this.detailMany(groups);
  }

  async findAll(query: GroupListQuery): Promise<GroupDetail[]> {
    const where: Prisma.ClassGroupWhereInput = { eventId: query.eventId };
    if (query.schoolId) where.schoolId = query.schoolId;
    if (query.cycle) where.cycle = normalizeCycle(query.cycle);
    if (query.status) where.baseVoucher = { status: query.status };
    const groups = await this.prisma.classGroup.findMany({
      where,
      include: groupDetailInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return this.detailMany(groups);
  }

  private async findDetail(id: number): Promise<GroupDetail> {
    const group = await this.prisma.classGroup.findUnique({
      where: { id },
      include: groupDetailInclude,
    });
    if (!group) {
      throw new NotFoundException('Salón o ciclo no encontrado');
    }
    const [detail] = await this.detailMany([group]);
    return detail;
  }

  private async detailMany(groups: GroupWithDetail[]): Promise<GroupDetail[]> {
    const disciplinesByEvent = new Map<number, DisciplineRef[]>();
    for (const eventId of new Set(groups.map((g) => g.eventId))) {
      disciplinesByEvent.set(eventId, await this.studentDisciplines(eventId));
    }
    return groups.map((group) =>
      toGroupDetail(group, disciplinesByEvent.get(group.eventId) ?? []),
    );
  }

  private studentDisciplines(eventId: number): Promise<DisciplineRef[]> {
    return this.prisma.discipline.findMany({
      where: { eventId, participantType: ParticipantType.STUDENT },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }
}
