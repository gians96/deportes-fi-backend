import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ParticipantType, RegistrationStatus, Role } from '@prisma/client';
import { RegistrationsService } from './registrations.service';
import {
  CreateRegistrationDto,
  ParticipantDto,
  UpdateRegistrationDto,
} from './dto/create-registration.dto';
import { RejectDto } from './dto/reject.dto';
import { SetStatusDto } from './dto/set-status.dto';
import { voucherMulterOptions } from '../common/upload/voucher-upload.options';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/decorators/current-user.decorator';
import { PAYMENT_ROLES, isStaffRole } from '../common/roles';

function optionalId(value: string | undefined, name: string) {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException(`${name} debe ser un número entero positivo`);
  }
  return parsed;
}

@Controller('registrations')
export class RegistrationsController {
  constructor(private readonly registrations: RegistrationsService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...PAYMENT_ROLES)
  @Get()
  findAll(
    @CurrentUser() user: RequestUser,
    @Query('status') status?: RegistrationStatus,
    @Query('eventId') eventId?: string,
    @Query('facultyId') facultyId?: string,
    @Query('schoolId') schoolId?: string,
    @Query('disciplineId') disciplineId?: string,
    @Query('isPaid') isPaid?: string,
    @Query('participantType') participantType?: ParticipantType,
  ) {
    return this.registrations.findAll(
      {
        status,
        eventId: eventId ? Number(eventId) : undefined,
        facultyId: facultyId ? Number(facultyId) : undefined,
        schoolId: schoolId ? Number(schoolId) : undefined,
        disciplineId: disciplineId ? Number(disciplineId) : undefined,
        isPaid: isPaid === undefined ? undefined : isPaid === 'true',
        participantType,
      },
      user.role,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('mine')
  findMine(@CurrentUser() user: RequestUser) {
    return this.registrations.findMine(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  @UseInterceptors(FileInterceptor('voucher', voucherMulterOptions))
  create(
    @CurrentUser() user: RequestUser,
    @Body() body: Record<string, string>,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    let participants: ParticipantDto[];
    try {
      participants = JSON.parse(body.participants ?? '[]') as ParticipantDto[];
    } catch {
      throw new BadRequestException('Formato de integrantes inválido');
    }

    const dto: CreateRegistrationDto = {
      disciplineId: Number(body.disciplineId),
      teamName: body.teamName,
      phone: body.phone,
      cycle: body.cycle,
      section: body.section,
      operationNumber: body.operationNumber,
      groupId: optionalId(body.groupId, 'groupId'),
      extraVoucherId: optionalId(body.extraVoucherId, 'extraVoucherId'),
      draft: body.draft === 'true' || body.draft === '1',
      participants,
    };

    // Solo owner/admin pueden registrar un equipo en nombre de otro delegado.
    const isStaff = isStaffRole(user.role);
    const delegateId =
      isStaff && body.delegateId ? Number(body.delegateId) : undefined;

    const voucherPath = file ? `/uploads/vouchers/${file.filename}` : undefined;
    return this.registrations.create(user.id, dto, voucherPath, delegateId);
  }

  /** Edita un equipo: el delegado sus borradores y los equipos observados; owner y administrador cualquiera (lo decide el servicio). */
  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRegistrationDto,
  ) {
    return this.registrations.update(user, id, dto);
  }

  /** «Enviar»: pasa un borrador (o un equipo observado ya corregido) a PENDIENTE, con las reglas completas. */
  @UseGuards(JwtAuthGuard)
  @Post(':id/submit')
  submit(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.registrations.submit(user, id);
  }

  /** Quita un equipo y libera su cupo: el delegado solo borradores; owner y administrador cualquier estado. */
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.registrations.remove(user, id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER_SYSTEM, Role.ADMIN_SYSTEM)
  @Patch(':id/approve')
  approve(@Param('id', ParseIntPipe) id: number) {
    return this.registrations.approve(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER_SYSTEM, Role.ADMIN_SYSTEM)
  @Patch(':id/reject')
  reject(@Param('id', ParseIntPipe) id: number, @Body() dto: RejectDto) {
    return this.registrations.reject(id, dto.reason);
  }

  /**
   * Cambio manual de estado (corregir un «aprobar» equivocado, observar, restaurar un rechazo, cancelar).
   * Solo owner y administrador; `REJECTED` y `OBSERVED` exigen `reason`.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER_SYSTEM, Role.ADMIN_SYSTEM)
  @Patch(':id/status')
  setStatus(@Param('id', ParseIntPipe) id: number, @Body() dto: SetStatusDto) {
    return this.registrations.setStatus(id, dto);
  }
}
