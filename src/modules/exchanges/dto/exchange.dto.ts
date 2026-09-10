import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsNumber, IsOptional, IsPositive, IsString, Matches } from 'class-validator';

const CURRENCY = { message: 'must be a 3-letter ISO 4217 code' };

export class CreateExchangeDto {
  @ApiProperty({ example: 'USD', description: 'Currency handed over' })
  @IsString()
  @Matches(/^[A-Z]{3}$/, CURRENCY)
  fromCurrency: string;

  @ApiProperty({ example: 100, description: 'Amount handed over, in fromCurrency' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  fromAmount: number;

  @ApiProperty({ example: 'THB', description: 'Currency received' })
  @IsString()
  @Matches(/^[A-Z]{3}$/, CURRENCY)
  toCurrency: string;

  @ApiProperty({
    example: 3180,
    description: "Amount actually received, in toCurrency — after the counter's spread and fees",
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  toAmount: number;

  @ApiProperty({ example: '2026-09-01T00:00:00', description: 'Operation local time' })
  @IsDate()
  @Type(() => Date)
  date: Date;

  @ApiPropertyOptional({ example: 'SuperRich, Asok' })
  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateExchangeDto {
  @ApiPropertyOptional({ example: 'USD' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, CURRENCY)
  fromCurrency?: string;

  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  fromAmount?: number;

  @ApiPropertyOptional({ example: 'THB' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, CURRENCY)
  toCurrency?: string;

  @ApiPropertyOptional({ example: 3180 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  toAmount?: number;

  @ApiPropertyOptional({ example: '2026-09-01T00:00:00' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  date?: Date;

  @ApiPropertyOptional({ example: 'SuperRich, Asok' })
  @IsOptional()
  @IsString()
  description?: string;
}

export class ExchangeDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'USD' }) fromCurrency: string;
  @ApiProperty({ example: 100 }) fromAmount: number;
  @ApiProperty({ example: 'THB' }) toCurrency: string;
  @ApiProperty({ example: 3180 }) toAmount: number;
  @ApiProperty({ example: 'SuperRich, Asok' }) description: string;
  @ApiProperty() date: Date;

  @ApiProperty({ example: 31.8, description: 'toAmount / fromAmount — the rate actually received' })
  effectiveRate: number;

  @ApiProperty({
    example: 32.4,
    nullable: true,
    description: 'Mid-market rate on that date, from the stored rate history. null if unknown.',
  })
  midMarketRate: number | null;

  @ApiProperty({
    example: 1.85,
    nullable: true,
    description:
      'What the exchange actually cost, as a percentage of the mid-market value — the real spread ' +
      'paid, measured rather than assumed. null if the mid-market rate for that date is unknown.',
  })
  costPct: number | null;
}
