import { DniProvider, RenewalPeriod } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Largo mínimo de un token: descarta valores obviamente incompletos. */
export const DNI_TOKEN_MIN_LENGTH = 8;
export const DNI_TOKEN_MAX_LENGTH = 512;

export class CreateDniTokenDto {
  @IsEnum(DniProvider, { message: 'El proveedor no es válido' })
  provider!: DniProvider;

  /** Alias para reconocerlo en la lista (p. ej. «Decolecta cuenta congreso»). */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  /** Valor del token. Se guarda cifrado y no se vuelve a mostrar. */
  @IsString()
  @MinLength(DNI_TOKEN_MIN_LENGTH, { message: 'El token es demasiado corto' })
  @MaxLength(DNI_TOKEN_MAX_LENGTH)
  token!: string;

  /** URL del servicio; nulo o vacío = la URL oficial del proveedor. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  apiUrl?: string | null;

  /** Menor número = se consulta primero. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** Cupo del plan del proveedor; nulo = sin límite conocido. */
  @IsOptional()
  @IsInt()
  @Min(1)
  queryLimit?: number | null;

  /** Consultas que el token ya tenía gastadas en este periodo. */
  @IsOptional()
  @IsInt()
  @Min(0)
  queriesUsed?: number;

  @IsOptional()
  @IsEnum(RenewalPeriod)
  renewalPeriod?: RenewalPeriod;

  /** Fecha (ISO 8601) en que el proveedor reinicia el cupo; nulo = sin fecha. */
  @IsOptional()
  @IsISO8601()
  renewsAt?: string | null;
}

export class UpdateDniTokenDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  /** Un valor nuevo reemplaza al guardado y devuelve el token a `ACTIVE`. Si se omite, no cambia. */
  @IsOptional()
  @IsString()
  @MinLength(DNI_TOKEN_MIN_LENGTH, { message: 'El token es demasiado corto' })
  @MaxLength(DNI_TOKEN_MAX_LENGTH)
  token?: string;

  /** Nulo o vacío vuelve a la URL oficial. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  apiUrl?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  queryLimit?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  queriesUsed?: number;

  @IsOptional()
  @IsEnum(RenewalPeriod)
  renewalPeriod?: RenewalPeriod;

  @IsOptional()
  @IsISO8601()
  renewsAt?: string | null;
}

export class DniDto {
  @IsString()
  @Matches(/^\d{8}$/, { message: 'El DNI debe tener 8 dígitos' })
  dni!: string;
}
