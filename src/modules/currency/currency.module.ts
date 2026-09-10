import { Global, Module } from '@nestjs/common';
import { CurrencyService } from './currency.service';
import { FxRatesService } from './fx-rates.service';

@Global()
@Module({
  providers: [CurrencyService, FxRatesService],
  exports: [CurrencyService, FxRatesService],
})
export class CurrencyModule {}
