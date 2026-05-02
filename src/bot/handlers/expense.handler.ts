import { Injectable } from '@nestjs/common';
import { Context, InlineKeyboard } from 'grammy';
import { CategoriesService } from '../../modules/categories/categories.service';
import { ExpensesService } from '../../modules/expenses/expenses.service';
import { StateService } from '../state.service';
import { MAIN_MENU } from './start.handler';

@Injectable()
export class ExpenseHandler {
  constructor(
    private readonly categoriesService: CategoriesService,
    private readonly expensesService: ExpensesService,
    private readonly stateService: StateService,
  ) {}

  async handleAdd(ctx: Context, userId: string) {
    const categories = await this.categoriesService.findAllByUser(userId);
    if (!categories.length) {
      await ctx.reply('Для начала добавьте хотя бы одну категорию.');
      return;
    }
    const keyboard = new InlineKeyboard();
    for (const cat of categories) {
      keyboard.text(cat.name, `/addexpense:${cat.id}`).row();
    }
    await ctx.reply('Выберите категорию:', { reply_markup: keyboard });
  }

  async handleCategorySelected(ctx: Context, userId: string, categoryId: string) {
    const category = await this.categoriesService.findOne(categoryId);
    await this.stateService.set(userId, {
      step: 'addexpense:waiting_amount',
      categoryId,
      categoryName: category.name,
    });
    await ctx.reply(`Категория: ${category.name}\n\nВведите сумму:`);
  }

  async handleAmountInput(ctx: Context, userId: string, text: string) {
    const amount = parseFloat(text.replace(',', '.'));
    if (Number.isNaN(amount) || amount <= 0) {
      await ctx.reply('Введите корректную сумму (например: 500 или 1500.50):');
      return;
    }
    await this.stateService.set(userId, {
      step: 'addexpense:waiting_description',
      amount,
    });
    await ctx.reply('Введите описание:');
  }

  async handleDescriptionInput(ctx: Context, userId: string, text: string) {
    const state = await this.stateService.get(userId);
    if (!state?.categoryId || !state?.amount) {
      await this.stateService.reset(userId);
      await ctx.reply('Что-то пошло не так. Начните заново.', { reply_markup: MAIN_MENU });
      return;
    }

    await this.expensesService.create({
      userId,
      categoryId: state.categoryId,
      amount: Number(state.amount),
      description: text,
    });

    await this.stateService.reset(userId);
    await ctx.reply(
      `✅ Трата добавлена!\n\nКатегория: ${state.categoryName}\nСумма: ${Number(state.amount)} \nОписание: ${text}`,
      { reply_markup: MAIN_MENU },
    );
  }
}
