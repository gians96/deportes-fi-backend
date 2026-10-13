import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateDniProviderDto {
  /**
   * Token del proveedor. Una cadena nueva reemplaza al guardado; `null` o vacío lo borra. Si se
   * omite, no cambia. Se guarda cifrado en la base de datos, nunca en el entorno.
   */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  token?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** URL del servicio; `null` o vacío vuelve a la URL oficial del proveedor. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  apiUrl?: string | null;

  /** Menor = se consulta primero. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  priority?: number;
}

export class TestDniProviderDto {
  @IsString()
  @Matches(/^\d{8}$/, { message: 'El DNI debe tener 8 dígitos' })
  dni!: string;
}
