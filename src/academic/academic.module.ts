import { Global, Module } from '@nestjs/common';
import { DniProvidersModule } from '../dni-providers/dni-providers.module';
import { AcademicService } from './academic.service';
import { AcademicController } from './academic.controller';

@Global()
@Module({
  imports: [DniProvidersModule],
  providers: [AcademicService],
  controllers: [AcademicController],
  exports: [AcademicService],
})
export class AcademicModule {}
