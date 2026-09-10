import { ApiProperty } from '@nestjs/swagger';

export class CurrencyBalanceDto {
  @ApiProperty({ example: 'THB' })
  currency: string;

  @ApiProperty({
    example: 48320.5,
    description: 'Exact free balance in this currency — a plain sum, never converted.',
  })
  amount: number;
}

export class BalanceResponseDto {
  @ApiProperty({ example: 'THB', description: "User's base currency for the balance field" })
  baseCurrency: string;

  @ApiProperty({
    type: [CurrencyBalanceDto],
    description:
      'The balance itself: one exact figure per currency held (income − expenses − active goal ' +
      'reserves), with no conversion involved. The base currency is always listed, even at zero. ' +
      'This is the source of truth — `balance` below is a convenience roll-up.',
  })
  byCurrency: CurrencyBalanceDto[];

  @ApiProperty({
    example: 66000,
    nullable: true,
    description:
      'Everything rolled into the base currency: base-currency money exactly as it is, other ' +
      "currencies at today's mid-market rate. null if a conversion was needed and rates were " +
      'unavailable.',
  })
  balance: number | null;

  @ApiProperty({
    example: 2062.5,
    nullable: true,
    description: 'The same roll-up in USD. null if rates are unavailable.',
  })
  balanceUsd: number | null;

  @ApiProperty({
    example: false,
    description:
      '`balance` involved converting a foreign holding, so it is an estimate — show it with a ' +
      '"≈". False means every figure is exact.',
  })
  isApproximate: boolean;

  @ApiProperty({
    example: 913200,
    nullable: true,
    description: 'Money reserved across active goals, in the base currency.',
  })
  inGoals: number | null;

  @ApiProperty({
    example: 25000,
    nullable: true,
    description: 'The same goal reserve in USD.',
  })
  inGoalsUsd: number | null;
}
