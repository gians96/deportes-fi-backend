import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DniLookupOrigin } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { STAFF_ROLES } from '../common/roles';
import { DniLookupService } from './dni-lookup.service';
import { DniTokensService } from './dni-tokens.service';
import {
  CreateDniTokenDto,
  DniDto,
  UpdateDniTokenDto,
} from './dto/dni-token.dto';

/**
 * Pool de tokens de consulta de DNI (spec 005). Solo el equipo (Owner y Administrador). Ninguna respuesta
 * incluye el valor de un token; solo la consulta manual devuelve un nombre.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...STAFF_ROLES)
@Controller('settings/dni-tokens')
export class DniTokensController {
  constructor(
    private readonly tokens: DniTokensService,
    private readonly lookup: DniLookupService,
  ) {}

  @Get()
  async list() {
    return {
      encryptionKey: this.tokens.encryptionKeySource(),
      providers: this.tokens.providers(),
      tokens: await this.tokens.list(),
    };
  }

  @Post()
  create(@Body() dto: CreateDniTokenDto, @CurrentUser() user: RequestUser) {
    return this.tokens.create(dto, user.id);
  }

  @Get('usage')
  usage(@Query('days') days?: string) {
    return this.lookup.usage(Number(days ?? 30));
  }

  @Get('logs')
  logs(@Query('page') page?: string) {
    return this.lookup.logs(Number(page ?? 1));
  }

  /** Consulta manual con el pool y la caché (igual que lo haría un usuario al inscribir). */
  @Post('lookup')
  async manualLookup(@Body() dto: DniDto) {
    const result = await this.lookup.lookup(dto.dni, DniLookupOrigin.PANEL);
    if (!result) return { found: false, dni: dto.dni };
    return {
      found: true,
      dni: result.person.dni,
      fullName: result.person.fullName,
      source: result.source,
      provider: result.provider,
    };
  }

  /** Vacía la caché de personas consultadas. Va antes de `:id` para no confundirse con un identificador. */
  @Delete('cache')
  clearCache() {
    return this.lookup.clearCache();
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDniTokenDto,
  ) {
    return this.tokens.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.tokens.remove(id);
  }

  @Post(':id/reset')
  reset(@Param('id', ParseIntPipe) id: number) {
    return this.tokens.reset(id);
  }

  @Post(':id/test')
  test(@Param('id', ParseIntPipe) id: number, @Body() dto: DniDto) {
    return this.lookup.testToken(id, dto.dni);
  }
}
