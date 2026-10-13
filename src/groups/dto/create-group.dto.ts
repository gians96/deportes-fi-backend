import { GroupScope } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class CreateGroupDto {
  @IsInt({ message: 'eventId debe ser un número entero' })
  eventId!: number;

  @IsEnum(GroupScope, { message: 'scope debe ser SECTION o CYCLE' })
  scope!: GroupScope;

  @IsInt({ message: 'schoolId debe ser un número entero' })
  schoolId!: number;

  /** Texto libre ("5", "V", "ciclo V"); el servidor lo normaliza a romano. */
  @IsString({ message: 'Indica el ciclo' })
  @MaxLength(30)
  cycle!: string;

  /** Texto libre ("A1", "a-1"); obligatoria para un salón, ignorada para un ciclo completo. */
  @ValidateIf((dto: CreateGroupDto) => dto.scope === GroupScope.SECTION)
  @IsString({ message: 'Indica la sección del salón' })
  @MaxLength(40)
  section?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  operationNumber?: string;

  /** Solo OWNER/ADMIN: crear el grupo en nombre de otro delegado. */
  @IsOptional()
  @IsInt()
  delegateId?: number;
}
