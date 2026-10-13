import { IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../auth/password';

/** `password: null` quita la contraseña y deja la cuenta en «Solo Google». */
export class SetPasswordDto {
  @ValidateIf((dto: SetPasswordDto) => dto.password !== null)
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, {
    message: `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`,
  })
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string | null;
}
