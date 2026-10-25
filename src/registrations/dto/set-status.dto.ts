import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { RegistrationStatus } from '@prisma/client';

/** Estados a los que el staff puede llevar un equipo a mano (`DRAFT` no: para devolverlo se usa `OBSERVED`). */
export const MANUAL_STATUSES = [
  RegistrationStatus.PENDING,
  RegistrationStatus.APPROVED,
  RegistrationStatus.REJECTED,
  RegistrationStatus.OBSERVED,
  RegistrationStatus.CANCELLED,
] as const;

export type ManualStatus = (typeof MANUAL_STATUSES)[number];

/** Cambio manual de estado (`PATCH /registrations/:id/status`). */
export class SetStatusDto {
  @IsIn(MANUAL_STATUSES, {
    message:
      'El estado debe ser PENDING, APPROVED, REJECTED, OBSERVED o CANCELLED',
  })
  status!: ManualStatus;

  /** Motivo del rechazo o texto de la observación; obligatorio para `REJECTED` y `OBSERVED`. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
