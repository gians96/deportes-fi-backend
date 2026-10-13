import { Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { EventPricingService } from './event-pricing.service';

@Module({
  providers: [EventsService, EventPricingService],
  controllers: [EventsController],
})
export class EventsModule {}
