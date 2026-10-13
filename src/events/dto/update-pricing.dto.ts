import { PricingMode } from '@prisma/client';
import { IsEnum, IsNumber, Max, Min } from 'class-validator';

const MONEY = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false };
const MAX_FEE = 99999999.99;

export class UpdatePricingDto {
  @IsEnum(PricingMode, {
    message: 'pricingMode debe ser PER_DISCIPLINE o PER_GROUP',
  })
  pricingMode!: PricingMode;

  @IsNumber(MONEY, {
    message: 'sectionBase debe ser un monto con hasta 2 decimales',
  })
  @Min(0)
  @Max(MAX_FEE)
  sectionBase!: number;

  @IsNumber(MONEY, {
    message: 'cycleBase debe ser un monto con hasta 2 decimales',
  })
  @Min(0)
  @Max(MAX_FEE)
  cycleBase!: number;

  @IsNumber(MONEY, {
    message: 'sectionExtra debe ser un monto con hasta 2 decimales',
  })
  @Min(0)
  @Max(MAX_FEE)
  sectionExtra!: number;

  @IsNumber(MONEY, {
    message: 'cycleExtra debe ser un monto con hasta 2 decimales',
  })
  @Min(0)
  @Max(MAX_FEE)
  cycleExtra!: number;
}
