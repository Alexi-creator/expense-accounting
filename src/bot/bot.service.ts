import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot } from 'grammy';
import { UsersService } from '../modules/users/users.service';
import { CategoryHandler } from './handlers/category.handler';
import { ExpenseHandler } from './handlers/expense.handler';
import { StartHandler } from './handlers/start.handler';
import { StatHandler } from './handlers/stat.handler';
import { StateService } from './state.service';

@Injectable()
export class BotService implements OnModuleInit {
readonly bot: Bot;

  constructor(
    private readonly config: ConfigService,
    private readonly usersService: UsersService,
    private readonly stateService: StateService,
    private readonly startHandler: StartHandler,
    private readonly categoryHandler: CategoryHandler,
    private readonly expenseHandler: ExpenseHandler,
    private readonly statHandler: StatHandler,
  ) {
    const token = this.config.get<string>('BOT_TOKEN');
    if (!token) throw new Error('BOT_TOKEN is not defined');
    this.bot = new Bot(token);
  }

  async onModuleInit() {
    await this.bot.init();
    this.registerHandlers();
  }

  handleUpdate(update: object) {
    return this.bot.handleUpdate(update as Parameters<Bot['handleUpdate']>[0]);
  }

  private registerHandlers() {
    this.bot.command('start', (ctx) => this.startHandler.handle(ctx));

    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const telegramId = BigInt(ctx.from.id);
      const { user } = await this.usersService.findOrCreateByTelegramId(telegramId);

      if (data.startsWith('/addexpense:')) {
        await this.expenseHandler.handleCategorySelected(ctx, user.id, data.slice('/addexpense:'.length));
      } else if (data.startsWith('/deletecategory:')) {
        await this.categoryHandler.handleDeleteConfirm(ctx, data.slice('/deletecategory:'.length));
      } else if (data.startsWith('/confirmdelete:')) {
        await this.categoryHandler.handleDelete(ctx, data.slice('/confirmdelete:'.length));
      } else if (data === '/canceldelete') {
        await this.categoryHandler.handleDeleteCancel(ctx);
      } else if (data.startsWith('/stat:')) {
        await this.statHandler.handleCategorySelected(ctx, user.id, data.slice('/stat:'.length));
      } else if (data.startsWith('/period:')) {
        await this.statHandler.handlePeriodSelected(ctx, user.id, data.slice('/period:'.length));
      } else if (data.startsWith('/details:')) {
        await this.statHandler.handleDetailsSelected(ctx, user.id, data.slice('/details:'.length) === 'yes');
      }

      await ctx.answerCallbackQuery();
    });

    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text;
      const telegramId = BigInt(ctx.from.id);

      const existing = await this.usersService.findByTelegramId(telegramId);

      if (!existing) {
        await ctx.reply('Для начала нажмите /start');
        return;
      }

      const userId = existing.id;
      const step = await this.stateService.getStep(userId);

      // роутинг по тексту кнопок меню
      if (text === 'Добавить категорию') return this.categoryHandler.handleAdd(ctx, userId);
      if (text === 'Посмотреть все категории')
        return this.categoryHandler.handleViewAll(ctx, userId);
      if (text === 'Удалить категорию') return this.categoryHandler.handleDeleteMenu(ctx, userId);
      if (text === 'Добавить трату') return this.expenseHandler.handleAdd(ctx, userId);
      if (text === 'Статистика') return this.statHandler.handleStat(ctx, userId);

      // роутинг по текущему шагу FSM
      if (step === 'addcategory:waiting_name') {
        return this.categoryHandler.handleNameInput(ctx, userId, text);
      }
      if (step === 'addexpense:waiting_amount') {
        return this.expenseHandler.handleAmountInput(ctx, userId, text);
      }
      if (step === 'addexpense:waiting_description') {
        return this.expenseHandler.handleDescriptionInput(ctx, userId, text);
      }

      await ctx.reply('Выберите действие из меню.');
    });
  }
}
