import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { BotModule } from './bot/bot.module';
import { envSchema } from './config/env.schema';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { CurrencyModule } from './modules/currency/currency.module';
import { ExchangesModule } from './modules/exchanges/exchanges.module';
import { ExpenseCategoriesModule } from './modules/expense-categories/expense-categories.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { GoalsModule } from './modules/goals/goals.module';
import { IncomeCategoriesModule } from './modules/income-categories/income-categories.module';
import { IncomesModule } from './modules/incomes/incomes.module';
import { InvestingModule } from './modules/investing/investing.module';
import { MailModule } from './modules/mail/mail.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { UsersModule } from './modules/users/users.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config) => envSchema.parse(config),
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    ScheduleModule.forRoot(),
    PrismaModule,
    MailModule,
    CurrencyModule,
    UsersModule,
    ExpenseCategoriesModule,
    IncomeCategoriesModule,
    IncomesModule,
    ExpensesModule,
    ExchangesModule,
    GoalsModule,
    InvestingModule,
    TransactionsModule,
    NotificationsModule,
    SubscriptionsModule,
    AuthModule,
    AdminModule,
    BotModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
