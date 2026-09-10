import { Module } from '@nestjs/common';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { GoalsModule } from '../goals/goals.module';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

@Module({
  imports: [ExchangesModule, GoalsModule],
  controllers: [TransactionsController],
  providers: [TransactionsService],
})
export class TransactionsModule {}
