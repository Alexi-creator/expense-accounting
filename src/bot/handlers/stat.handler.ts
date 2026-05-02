import { Injectable } from '@nestjs/common';
import { Context, InlineKeyboard } from 'grammy';
import { CategoriesService } from '../../modules/categories/categories.service';
import { ExpensesService } from '../../modules/expenses/expenses.service';
import { StateService } from '../state.service';
import { MAIN_MENU } from './start.handler';

@Injectable()
export class StatHandler {
  constructor(
    private readonly categoriesService: CategoriesService,
    private readonly expensesService: ExpensesService,
    private readonly stateService: StateService,
  ) {}

  async handleStat(ctx: Context, userId: string) {
    const categories = await this.categoriesService.findAllByUser(userId);
    if (!categories.length) {
      await ctx.reply('Для начала добавьте хотя бы одну категорию.');
      return;
    }

    const keyboard = new InlineKeyboard();
    categories.forEach((cat, i) => {
      keyboard.text(cat.name, `/stat:${cat.id}`);
      if (i % 2 === 1) keyboard.row();
    });
    if (categories.length % 2 === 0) keyboard.row();
    keyboard.text('Все', '/stat:all');

    await ctx.reply('Выберите категорию:', { reply_markup: keyboard });
  }

  async handleCategorySelected(ctx: Context, userId: string, rawId: string) {
    await this.stateService.reset(userId);
    await this.stateService.set(userId, {
      step: 'stat:waiting_for_period',
      ...(rawId !== 'all' ? { categoryId: rawId } : {}),
    });

    const keyboard = new InlineKeyboard()
      .text('Текущий месяц', '/period:month')
      .text('Неделя', '/period:week')
      .text('Сегодня', '/period:day');

    await ctx.reply('Выберите период:', { reply_markup: keyboard });
  }

  async handlePeriodSelected(ctx: Context, userId: string, period: string) {
    await this.stateService.set(userId, { step: 'stat:waiting_for_details', period });

    const keyboard = new InlineKeyboard()
      .text('С детализацией', '/details:yes')
      .text('Без детализации', '/details:no');

    await ctx.reply('Нужна детализация?', { reply_markup: keyboard });
  }

  async handleDetailsSelected(ctx: Context, userId: string, isDetails: boolean) {
    const state = await this.stateService.get(userId);
    if (!state?.period) {
      await this.stateService.reset(userId);
      await ctx.reply('Что-то пошло не так. Начните заново.', { reply_markup: MAIN_MENU });
      return;
    }

    const categoryId = state.categoryId ?? null;
    const { period } = state;
    await this.stateService.reset(userId);

    if (isDetails) {
      const data = await this.expensesService.statDetails(userId, categoryId, period);
      if (!data.length) {
        await ctx.reply('За выбранный период трат нет 🙂', { reply_markup: MAIN_MENU });
        return;
      }

      let text = 'Траты с детализацией:\n\n';
      let grandTotal = 0;
      for (const cat of data) {
        text += `📌 ${cat.category} — ${cat.total.toFixed(2)} ₽\n`;
        for (const item of cat.items) {
          const date = item.date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
          text += `  • ${date}: ${item.amount.toFixed(2)} ₽`;
          if (item.description) text += ` — ${item.description}`;
          text += '\n';
        }
        text += '\n';
        grandTotal += cat.total;
      }
      if (data.length > 1) text += `Итого: ${grandTotal.toFixed(2)} ₽`;

      await ctx.reply(text, { reply_markup: MAIN_MENU });
    } else {
      const data = await this.expensesService.statSummary(userId, categoryId, period);
      if (!data.length) {
        await ctx.reply('За выбранный период трат нет 🙂', { reply_markup: MAIN_MENU });
        return;
      }

      let text = 'Траты:\n\n';
      let total = 0;
      for (const row of data) {
        text += `• ${row.category} — ${row.total.toFixed(2)} ₽\n`;
        total += row.total;
      }
      if (data.length > 1) text += `\nИтого: ${total.toFixed(2)} ₽`;

      await ctx.reply(text, { reply_markup: MAIN_MENU });
    }
  }
}
