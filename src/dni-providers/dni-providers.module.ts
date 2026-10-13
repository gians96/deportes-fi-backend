import { Module } from '@nestjs/common';
import { DniProvidersController } from './dni-providers.controller';
import { DniProvidersService } from './dni-providers.service';

@Module({
  controllers: [DniProvidersController],
  providers: [DniProvidersService],
  exports: [DniProvidersService],
})
export class DniProvidersModule {}
