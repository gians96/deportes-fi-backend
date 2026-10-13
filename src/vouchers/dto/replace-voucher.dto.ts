import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ReplaceVoucherDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  operationNumber?: string;
}
