import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PricingMode } from '@prisma/client';
import { toMoneyNumber } from '../groups/group-pricing';
import { PrismaService } from '../prisma/prisma.service';
import { UpdatePricingDto } from './dto/update-pricing.dto';

export interface PricingView {
  eventId: number;
  pricingMode: PricingMode;
  sectionBase: number;
  cycleBase: number;
  sectionExtra: number;
  cycleExtra: number;
}

/** Tarifas del evento para el cobro por salón o ciclo (spec 002). */
@Injectable()
export class EventPricingService {
  constructor(private readonly prisma: PrismaService) {}

  async getPricing(eventId: number): Promise<PricingView> {
    const event = await this.prisma.sportEvent.findUnique({
      where: { id: eventId },
      select: { id: true, pricingMode: true, pricing: true },
    });
    if (!event) {
      throw new NotFoundException('Evento no encontrado');
    }
    const pricing = event.pricing;
    return {
      eventId: event.id,
      pricingMode: event.pricingMode,
      sectionBase: toMoneyNumber(pricing?.sectionBase ?? 0),
      cycleBase: toMoneyNumber(pricing?.cycleBase ?? 0),
      sectionExtra: toMoneyNumber(pricing?.sectionExtra ?? 0),
      cycleExtra: toMoneyNumber(pricing?.cycleExtra ?? 0),
    };
  }

  async setPricing(
    eventId: number,
    dto: UpdatePricingDto,
  ): Promise<PricingView> {
    const event = await this.prisma.sportEvent.findUnique({
      where: { id: eventId },
      select: { id: true, pricingMode: true },
    });
    if (!event) {
      throw new NotFoundException('Evento no encontrado');
    }

    if (
      event.pricingMode === PricingMode.PER_GROUP &&
      dto.pricingMode === PricingMode.PER_DISCIPLINE
    ) {
      const groups = await this.prisma.classGroup.count({ where: { eventId } });
      if (groups > 0) {
        throw new BadRequestException(
          'El evento ya tiene salones o ciclos inscritos: no puede volver al cobro por disciplina',
        );
      }
    }

    const fees = {
      sectionBase: dto.sectionBase,
      cycleBase: dto.cycleBase,
      sectionExtra: dto.sectionExtra,
      cycleExtra: dto.cycleExtra,
    };
    await this.prisma.$transaction([
      this.prisma.sportEvent.update({
        where: { id: eventId },
        data: { pricingMode: dto.pricingMode },
      }),
      this.prisma.eventPricing.upsert({
        where: { eventId },
        create: { eventId, ...fees },
        update: fees,
      }),
    ]);

    return this.getPricing(eventId);
  }
}
