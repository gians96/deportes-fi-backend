import { Module } from '@nestjs/common';
import { DniLookupService } from './dni-lookup.service';
import { DniTokensController } from './dni-tokens.controller';
import { DniTokensService } from './dni-tokens.service';

@Module({
  controllers: [DniTokensController],
  providers: [DniTokensService, DniLookupService],
  exports: [DniTokensService, DniLookupService],
})
export class DniProvidersModule {}
