import { Injectable } from '@nestjs/common';
import { Context, Keyboard } from 'grammy';
import { UsersService } from '../../modules/users/users.service';

export const MAIN_MENU = new Keyboard()
  .text('Удалить категорию')
  .text('Посмотреть все категории')
  .row()
  .text('Добавить категорию')
  .text('Статистика')
  .row()
  .text('Добавить трату')
  .resized();

@Injectable()
export class StartHandler {
  constructor(private readonly usersService: UsersService) {}

  async handle(ctx: Context) {
    if (!ctx.from) return;
    const telegramId = BigInt(ctx.from.id);
    const { isNew } = await this.usersService.findOrCreateByTelegramId(telegramId);

    const text = isNew
      ? 'Добро пожаловать! Я помогу вести учёт расходов.\n\nДля начала добавьте категорию.'
      : 'С возвращением! Выберите действие:';

    await ctx.reply(text, { reply_markup: MAIN_MENU });
  }
}
