import { Module } from '@nestjs/common';
import { EventTokensModule } from '../event-tokens/event-tokens.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';

@Module({
  // EventTokensModule exporta ApiTokenHasher, que necesita EventTokenGuard.
  imports: [EventTokensModule],
  providers: [IntegrationsService],
  controllers: [IntegrationsController],
})
export class IntegrationsModule {}
