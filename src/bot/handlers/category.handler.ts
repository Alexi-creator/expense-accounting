import { Injectable } from '@nestjs/common';
import { Context, InlineKeyboard } from 'grammy';
import { CategoriesService } from '../../modules/categories/categories.service';
import { StateService } from '../state.service';
import { MAIN_MENU } from './start.handler';

@Injectable()
export class CategoryHandler {
  constructor(
    private readonly categoriesService: CategoriesService,
    private readonly stateService: StateService,
  ) {}

  async handleAdd(ctx: Context, userId: string) {
    await this.stateService.set(userId, { step: 'addcategory:waiting_name' });
    await ctx.reply('Введите название категории:');
  }

  async handleNameInput(ctx: Context, userId: string, text: string) {
    await this.categoriesService.create({ userId, name: text });
    await this.stateService.reset(userId);
    await ctx.reply('✅ Категория успешно создана!', { reply_markup: MAIN_MENU });
  }

  async handleViewAll(ctx: Context, userId: string) {
    const categories = await this.categoriesService.findAllByUser(userId);
    if (!categories.length) {
      await ctx.reply('У вас пока нет категорий.');
      return;
    }
    const text = categories.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
    await ctx.reply(`Ваши категории:\n\n${text}`);
  }

  async handleDeleteMenu(ctx: Context, userId: string) {
    const categories = await this.categoriesService.findAllByUser(userId);
    if (!categories.length) {
      await ctx.reply('У вас пока нет категорий.');
      return;
    }
    const keyboard = new InlineKeyboard();
    for (const cat of categories) {
      keyboard.text(`🗑 ${cat.name}`, `/deletecategory:${cat.id}`).row();
    }
    await ctx.reply('Выберите категорию для удаления:', { reply_markup: keyboard });
  }

  async handleDeleteConfirm(ctx: Context, categoryId: string) {
    const category = await this.categoriesService.findOne(categoryId);
    const keyboard = new InlineKeyboard()
      .text('✅ Да, удалить', `/confirmdelete:${categoryId}`)
      .text('❌ Отмена', '/canceldelete');
    await ctx.reply(
      `Удалить категорию «${category.name}»?\n\nВсе траты по ней тоже удалятся.`,
      { reply_markup: keyboard },
    );
  }

  async handleDelete(ctx: Context, categoryId: string) {
    await this.categoriesService.remove(categoryId);
    await ctx.reply('✅ Категория и все её траты удалены.', { reply_markup: MAIN_MENU });
  }

  async handleDeleteCancel(ctx: Context) {
    await ctx.reply('Отменено.', { reply_markup: MAIN_MENU });
  }
}
