import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  TestDniProviderDto,
  UpdateDniProviderDto,
} from './dto/dni-provider.dto';
import { DniProvidersService } from './dni-providers.service';

/** Configuración de los proveedores de DNI. Nunca devuelve tokens. */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.OWNER_SYSTEM, Role.ADMIN_SYSTEM)
@Controller('settings/dni-providers')
export class DniProvidersController {
  constructor(private readonly providers: DniProvidersService) {}

  @Get()
  async list() {
    return {
      encryptionKey: this.providers.encryptionKeySource(),
      providers: await this.providers.list(),
    };
  }

  @Put(':provider')
  update(
    @Param('provider') provider: string,
    @Body() dto: UpdateDniProviderDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.providers.update(provider, dto, user.id);
  }

  @Post(':provider/test')
  test(@Param('provider') provider: string, @Body() dto: TestDniProviderDto) {
    return this.providers.test(provider, dto.dni);
  }
}
