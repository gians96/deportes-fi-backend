import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { VoucherStatus } from '@prisma/client';
import { unlink } from 'node:fs/promises';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { PAYMENT_ROLES } from '../common/roles';
import { voucherMulterOptions } from '../common/upload/voucher-upload.options';
import { CreateGroupDto } from './dto/create-group.dto';
import { GroupsService } from './groups.service';

function positiveInt(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException(`${name} debe ser un número entero positivo`);
  }
  return parsed;
}

@UseGuards(JwtAuthGuard)
@Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Post()
  @UseInterceptors(FileInterceptor('voucher', voucherMulterOptions))
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateGroupDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const voucherPath = file ? `/uploads/vouchers/${file.filename}` : undefined;
    try {
      return await this.groups.create(user, dto, voucherPath);
    } catch (error) {
      // Si la inscripción falla, no se deja el comprobante huérfano en disco.
      if (file) await unlink(file.path).catch(() => undefined);
      throw error;
    }
  }

  @Get('mine')
  findMine(
    @CurrentUser() user: RequestUser,
    @Query('eventId') eventId?: string,
  ) {
    return this.groups.findMine(
      user,
      eventId ? positiveInt(eventId, 'eventId') : undefined,
    );
  }

  @UseGuards(RolesGuard)
  @Roles(...PAYMENT_ROLES)
  @Get()
  findAll(
    @CurrentUser() user: RequestUser,
    @Query('eventId') eventId?: string,
    @Query('schoolId') schoolId?: string,
    @Query('cycle') cycle?: string,
    @Query('status') status?: string,
  ) {
    if (status && !(status in VoucherStatus)) {
      throw new BadRequestException(
        'status debe ser PENDING, VALIDATED o REJECTED',
      );
    }
    return this.groups.findAll(
      {
        eventId: positiveInt(eventId, 'eventId'),
        schoolId: schoolId ? positiveInt(schoolId, 'schoolId') : undefined,
        cycle: cycle || undefined,
        status: status ? (status as VoucherStatus) : undefined,
      },
      user,
    );
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.groups.findOne(user, id);
  }
}
