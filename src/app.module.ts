import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { PrismaModule } from './prisma/prisma.module';
import { AcademicModule } from './academic/academic.module';
import { AuthModule } from './auth/auth.module';
import { FacultiesModule } from './faculties/faculties.module';
import { EventsModule } from './events/events.module';
import { DisciplinesModule } from './disciplines/disciplines.module';
import { RegistrationsModule } from './registrations/registrations.module';
import { VouchersModule } from './vouchers/vouchers.module';
import { UsersModule } from './users/users.module';
import { StandingsModule } from './standings/standings.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { AdminModule } from './admin/admin.module';
import { EventTokensModule } from './event-tokens/event-tokens.module';
import { AppRateLimitGuard } from './common/guards/app-rate-limit.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), process.env.UPLOADS_DIR ?? 'uploads'),
      serveRoot: '/uploads',
    }),
    PrismaModule,
    AcademicModule,
    AuthModule,
    FacultiesModule,
    EventsModule,
    DisciplinesModule,
    RegistrationsModule,
    VouchersModule,
    UsersModule,
    StandingsModule,
    SchedulingModule,
    AdminModule,
    EventTokensModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AppRateLimitGuard }],
})
export class AppModule {}
