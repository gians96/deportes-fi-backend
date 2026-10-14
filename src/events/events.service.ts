import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { sanitizeRichText } from '../common/rich-text';

@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) { }

  findAll() {
    return this.prisma.sportEvent.findMany({
      orderBy: { startDate: 'desc' },
      include: { _count: { select: { disciplines: true } } },
    });
  }

  async findOne(id: number) {
    const event = await this.prisma.sportEvent.findUnique({
      where: { id },
      include: { faculty: true, school: true },
    });
    if (!event) {
      throw new NotFoundException('Evento no encontrado');
    }
    return event;
  }

  async findDisciplines(eventId: number) {
    const disciplines = await this.prisma.discipline.findMany({
      where: { eventId },
      include: { _count: { select: { teams: true } } },
      orderBy: { name: 'asc' },
    });
    return disciplines.map((discipline) => {
      // Desestructuramos para separar _count del resto de las propiedades
      const { _count, ...rest } = discipline;

      return {
        ...rest,
        teamsCount: _count.teams,
      };
    });
  }

  create(dto: CreateEventDto) {
    return this.prisma.sportEvent.create({
      data: {
        name: dto.name,
        description: sanitizeRichText(dto.description, 'la descripción'),
        facultyId: dto.facultyId,
        schoolId: dto.schoolId ?? null,
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
        isOpen: dto.isOpen ?? true,
      },
    });
  }

  async update(id: number, dto: UpdateEventDto) {
    await this.findOne(id);
    return this.prisma.sportEvent.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && {
          description: sanitizeRichText(dto.description, 'la descripción'),
        }),
        ...(dto.facultyId !== undefined && { facultyId: dto.facultyId }),
        ...(dto.schoolId !== undefined && { schoolId: dto.schoolId }),
        ...(dto.startDate !== undefined && {
          startDate: new Date(dto.startDate),
        }),
        ...(dto.endDate !== undefined && { endDate: new Date(dto.endDate) }),
        ...(dto.isOpen !== undefined && { isOpen: dto.isOpen }),
      },
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.sportEvent.delete({ where: { id } });
    return { success: true };
  }
}
