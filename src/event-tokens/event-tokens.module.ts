import { Module } from '@nestjs/common';
import { ApiTokenHasher } from './api-token-hasher.service';
import { EventTokensController } from './event-tokens.controller';
import { EventTokensService } from './event-tokens.service';

@Module({
  providers: [EventTokensService, ApiTokenHasher],
  controllers: [EventTokensController],
  exports: [ApiTokenHasher],
})
export class EventTokensModule {}
