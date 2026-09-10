import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CreateExchangeDto, ExchangeDto, UpdateExchangeDto } from './dto/exchange.dto';
import { ExchangesService } from './exchanges.service';

@ApiTags('exchanges')
@Controller('exchanges')
export class ExchangesController {
  constructor(private readonly exchangesService: ExchangesService) {}

  @Get()
  @ApiOperation({
    summary: 'Currency exchanges',
    description:
      'Every recorded exchange, newest first, with the rate actually received and how far that ' +
      'was from mid-market on the day — the real cost of converting, measured.',
  })
  @ApiOkResponse({ type: [ExchangeDto] })
  findAll(@CurrentUser() user: { id: string }) {
    return this.exchangesService.findAll(user.id);
  }

  @Post()
  @ApiOperation({
    summary: 'Record an exchange',
    description:
      'Moves money between two of your currencies. It is not an income or an expense, so it does ' +
      'not touch any income/expense report — only the per-currency balances.',
  })
  @ApiOkResponse({ type: ExchangeDto })
  create(@CurrentUser() user: { id: string }, @Body() dto: CreateExchangeDto) {
    return this.exchangesService.create(user.id, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an exchange' })
  @ApiOkResponse({ type: ExchangeDto })
  update(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: UpdateExchangeDto,
  ) {
    return this.exchangesService.update(id, user.id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an exchange' })
  remove(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.exchangesService.remove(id, user.id);
  }
}
