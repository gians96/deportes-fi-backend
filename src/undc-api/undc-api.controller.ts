import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { STAFF_ROLES } from '../common/roles';
import { SaveUndcApiDto } from './dto/undc-api.dto';
import { UndcApiService } from './undc-api.service';

/**
 * Conexión con API_UNDC (JP) para traer el DNI al buscar estudiantes por código (spec 006). Solo Owner y
 * Administrador; ninguna respuesta incluye la API key.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...STAFF_ROLES)
@Controller('settings/undc-api')
export class UndcApiController {
  constructor(private readonly undcApi: UndcApiService) {}

  @Get()
  get() {
    return this.undcApi.get();
  }

  @Put()
  save(@CurrentUser() user: RequestUser, @Body() dto: SaveUndcApiDto) {
    return this.undcApi.save(dto, user.id);
  }

  @Post('test')
  @HttpCode(200)
  test() {
    return this.undcApi.test();
  }

  @Delete()
  @HttpCode(204)
  async remove() {
    await this.undcApi.remove();
  }
}
