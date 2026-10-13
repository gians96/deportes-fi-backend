import { Module } from '@nestjs/common';
import { UndcApiController } from './undc-api.controller';
import { UndcApiService } from './undc-api.service';

@Module({
  controllers: [UndcApiController],
  providers: [UndcApiService],
  exports: [UndcApiService],
})
export class UndcApiModule {}
