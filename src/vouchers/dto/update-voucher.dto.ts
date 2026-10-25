import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Corrección manual de los datos de un comprobante (solo Owner y Administrador). */
export class UpdateVoucherDto {
  /** N.º de operación; una cadena vacía lo borra. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  operationNumber?: string;

  /** Monto en soles, con hasta 2 decimales. Es una corrección deliberada del staff: no recalcula tarifas. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99999999)
  amount?: number;
}
