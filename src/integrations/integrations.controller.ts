import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { EventTokenGuard } from '../common/guards/event-token.guard';
import { CurrentEventToken } from '../common/decorators/current-event-token.decorator';
import type { EventTokenContext } from '../common/decorators/current-event-token.decorator';
import { IntegrationsService } from './integrations.service';
import {
  IntegrationPaymentsQueryDto,
  IntegrationRegistrationsQueryDto,
} from './dto/integration-list-query.dto';

/**
 * Contrato 2 (backend-ciisic/docs/arquitectura-ecosistema.md). Autenticación
 * solo con `X-Api-Key`; el evento sale exclusivamente del token.
 */
@UseGuards(EventTokenGuard)
@Controller('integrations/event')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  event(@CurrentEventToken() token: EventTokenContext) {
    return this.integrations.getEvent(token.eventId);
  }

  @Get('summary')
  summary(@CurrentEventToken() token: EventTokenContext) {
    return this.integrations.getSummary(token.eventId);
  }

  @Get('payments')
  payments(
    @CurrentEventToken() token: EventTokenContext,
    @Query() query: IntegrationPaymentsQueryDto,
  ) {
    return this.integrations.listPayments(token.eventId, query);
  }

  @Get('registrations')
  registrations(
    @CurrentEventToken() token: EventTokenContext,
    @Query() query: IntegrationRegistrationsQueryDto,
  ) {
    return this.integrations.listRegistrations(token.eventId, query);
  }
}
