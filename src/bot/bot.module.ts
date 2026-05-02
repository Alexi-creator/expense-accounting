import { Module } from '@nestjs/common';
import { CategoriesModule } from '../modules/categories/categories.module';
import { ExpensesModule } from '../modules/expenses/expenses.module';
import { UsersModule } from '../modules/users/users.module';
import { BotController } from './bot.controller';
import { BotService } from './bot.service';
import { CategoryHandler } from './handlers/category.handler';
import { ExpenseHandler } from './handlers/expense.handler';
import { StartHandler } from './handlers/start.handler';
import { StatHandler } from './handlers/stat.handler';
import { StateService } from './state.service';

@Module({
  imports: [UsersModule, CategoriesModule, ExpensesModule],
  controllers: [BotController],
  providers: [BotService, StateService, StartHandler, CategoryHandler, ExpenseHandler, StatHandler],
})
export class BotModule {}
