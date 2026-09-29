import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/decorators/current-user.decorator';
import { EventTokensService } from './event-tokens.service';
import { CreateEventApiTokenDto } from './dto/create-event-api-token.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.OWNER_SYSTEM, Role.ADMIN_SYSTEM)
@Controller('events/:eventId/api-tokens')
export class EventTokensController {
  constructor(private readonly tokens: EventTokensService) {}

  /** Crea un token; la respuesta es la única vez que se entrega en claro. */
  @Post()
  @Header('Cache-Control', 'no-store')
  create(
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() dto: CreateEventApiTokenDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.tokens.create(eventId, dto, user);
  }

  @Get()
  list(@Param('eventId', ParseIntPipe) eventId: number) {
    return this.tokens.list(eventId);
  }

  @Delete(':id')
  revoke(
    @Param('eventId', ParseIntPipe) eventId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.tokens.revoke(eventId, id);
  }
}
