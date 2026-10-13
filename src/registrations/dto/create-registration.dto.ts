import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Gender } from '@prisma/client';

export class ParticipantDto {
  @IsString()
  @MaxLength(150)
  fullName!: string;

  @IsOptional()
  @IsString()
  studentCode?: string | null;

  @IsOptional()
  @IsString()
  dni?: string | null;

  @IsOptional()
  @IsString()
  @IsEnum(Gender)
  gender?: Gender;

  @IsOptional()
  isDelegate?: boolean;

  @IsOptional()
  countsAsPlayer?: boolean;

  /** Capitán/a del equipo; en eventos por salón o ciclo debe haber exactamente uno. */
  @IsOptional()
  isCaptain?: boolean;
}

export class CreateRegistrationDto {
  @Type(() => Number)
  disciplineId!: number;

  @IsString()
  @MaxLength(120)
  teamName!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  cycle?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  section?: string | null;

  @IsOptional()
  @IsString()
  operationNumber?: string;

  @IsOptional()
  @Type(() => Number)
  delegateId?: number;

  /** Salón o ciclo que paga (eventos con pricingMode = PER_GROUP). */
  @IsOptional()
  @Type(() => Number)
  groupId?: number;

  /** Comprobante EXTRA pendiente del mismo grupo al que se suma un equipo adicional. */
  @IsOptional()
  @Type(() => Number)
  extraVoucherId?: number;

  /** Guarda el equipo como borrador (solo salón o ciclo): la nómina puede estar incompleta hasta enviarlo. */
  @IsOptional()
  @IsBoolean()
  draft?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ParticipantDto)
  participants!: ParticipantDto[];
}

/** Cambios de un equipo (`PATCH /registrations/:id`): todos opcionales; `participants` reemplaza la lista completa. */
export class UpdateRegistrationDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  teamName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ParticipantDto)
  participants?: ParticipantDto[];
}
