import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { RegistrationStatus, VoucherStatus } from '@prisma/client';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export class IntegrationPaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero' })
  @Min(1, { message: 'page debe ser mayor o igual a 1' })
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize debe ser un número entero' })
  @Min(1, { message: 'pageSize debe ser mayor o igual a 1' })
  @Max(MAX_PAGE_SIZE, {
    message: `pageSize no puede ser mayor a ${MAX_PAGE_SIZE}`,
  })
  pageSize?: number;
}

export class IntegrationPaymentsQueryDto extends IntegrationPaginationQueryDto {
  @IsOptional()
  @IsEnum(VoucherStatus, {
    message: 'status debe ser uno de: VALIDATED, PENDING, REJECTED',
  })
  status?: VoucherStatus;
}

export class IntegrationRegistrationsQueryDto extends IntegrationPaginationQueryDto {
  @IsOptional()
  @IsEnum(RegistrationStatus, {
    message: 'status debe ser uno de: PENDING, APPROVED, REJECTED, CANCELLED',
  })
  status?: RegistrationStatus;
}
