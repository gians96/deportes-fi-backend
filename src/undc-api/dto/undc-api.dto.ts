import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Conexión con API_UNDC (JP). `apiKey` solo se envía al crearla o rotarla; vacía conserva la guardada. */
export class SaveUndcApiDto {
  @IsString()
  @MaxLength(300)
  baseUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  apiKey?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(30000)
  timeoutMs?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
