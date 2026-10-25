import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role, VoucherStatus } from '@prisma/client';
import { unlink } from 'node:fs/promises';
import { VouchersService } from './vouchers.service';
import { ReplaceVoucherDto } from './dto/replace-voucher.dto';
import { voucherMulterOptions } from '../common/upload/voucher-upload.options';
import { RejectDto } from '../registrations/dto/reject.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { PAYMENT_ROLES, STAFF_ROLES } from '../common/roles';
import { UpdateVoucherDto } from './dto/update-voucher.dto';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...PAYMENT_ROLES)
@Controller('vouchers')
export class VouchersController {
  constructor(private readonly vouchers: VouchersService) {}

  @Get()
  findAll(
    @Query('status') status?: VoucherStatus,
    @Query('eventId') eventId?: string,
    @Query('facultyId') facultyId?: string,
    @Query('schoolId') schoolId?: string,
    @Query('disciplineId') disciplineId?: string,
  ) {
    return this.vouchers.findAll({
      status,
      eventId: eventId ? Number(eventId) : undefined,
      facultyId: facultyId ? Number(facultyId) : undefined,
      schoolId: schoolId ? Number(schoolId) : undefined,
      disciplineId: disciplineId ? Number(disciplineId) : undefined,
    });
  }

  @Patch(':id/validate')
  validate(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: RequestUser,
  ) {
    return this.vouchers.validate(id, user.id);
  }

  @Patch(':id/reject')
  reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.vouchers.reject(id, dto.reason, user.id);
  }

  /** Deshace una validación o un rechazo equivocado: vuelve a PENDING (y los equipos aprobados con él, también). */
  @Roles(...STAFF_ROLES)
  @Patch(':id/reopen')
  reopen(@Param('id', ParseIntPipe) id: number) {
    return this.vouchers.reopen(id);
  }

  /** Corrige el N.º de operación y/o el monto del comprobante. */
  @Roles(...STAFF_ROLES)
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateVoucherDto) {
    return this.vouchers.update(id, dto);
  }

  /**
   * Reemplaza un comprobante rechazado. Lo usa el delegado del grupo o del equipo (el servicio
   * comprueba que sea el responsable), por eso el rol exigido es más amplio que el del resto.
   */
  @Roles(Role.OWNER_SYSTEM, Role.ADMIN_SYSTEM, Role.STUDENT, Role.OTHER)
  @Patch(':id/replace')
  @UseInterceptors(FileInterceptor('voucher', voucherMulterOptions))
  async replace(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReplaceVoucherDto,
    @CurrentUser() user: RequestUser,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const voucherPath = file ? `/uploads/vouchers/${file.filename}` : undefined;
    try {
      return await this.vouchers.replace(
        user,
        id,
        voucherPath,
        dto.operationNumber,
      );
    } catch (error) {
      // Si no se pudo reemplazar, no se deja la imagen nueva huérfana en disco.
      if (file) await unlink(file.path).catch(() => undefined);
      throw error;
    }
  }
}
