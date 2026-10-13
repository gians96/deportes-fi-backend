import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH } from '../password';

export class PasswordLoginDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  /** No se exige el largo mínimo: un valor corto simplemente no coincide y responde "Credenciales incorrectas". */
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}
