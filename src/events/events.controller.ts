import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { UpdatePricingDto } from './dto/update-pricing.dto';
import { EventPricingService } from './event-pricing.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('events')
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly pricing: EventPricingService,
  ) {}

  @Get()
  findAll() {
    return this.events.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.events.findOne(id);
  }

  @Get(':id/disciplines')
  findDisciplines(@Param('id', ParseIntPipe) id: number) {
    return this.events.findDisciplines(id);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/pricing')
  getPricing(@Param('id', ParseIntPipe) id: number) {
    return this.pricing.getPricing(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER_SYSTEM, Role.ADMIN_SYSTEM)
  @Put(':id/pricing')
  setPricing(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePricingDto,
  ) {
    return this.pricing.setPricing(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER_SYSTEM, Role.ADMIN_SYSTEM)
  @Post()
  create(@Body() dto: CreateEventDto) {
    return this.events.create(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER_SYSTEM, Role.ADMIN_SYSTEM)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEventDto,
  ) {
    return this.events.update(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER_SYSTEM, Role.ADMIN_SYSTEM)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.events.remove(id);
  }
}
