import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateEventApiTokenDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'El nombre del token debe ser texto' })
  @IsNotEmpty({ message: 'El nombre del token es obligatorio' })
  @MaxLength(100, {
    message: 'El nombre del token no puede superar 100 caracteres',
  })
  name!: string;

  @IsOptional()
  @IsDateString(
    {},
    { message: 'La fecha de expiración debe tener formato ISO 8601' },
  )
  expiresAt?: string;
}
