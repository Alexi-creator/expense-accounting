import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { BalanceResponseDto } from './dto/balance-response.dto';
import { GetTransactionsDto } from './dto/get-transactions.dto';
import { PaginatedTransactionsDto } from './dto/transactions-response.dto';
import { TransactionsService } from './transactions.service';

@ApiTags('transactions')
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get()
  @ApiOperation({
    summary: 'Transactions feed (income + expenses) with pagination',
    description:
      "A unified paginated list of both the user's income and expenses in a single feed, sorted by date. " +
      'This is the main endpoint for the operation history screen. Filters (all optional): ' +
      'type (income|expense) — keep only one kind; categoryId — by category; ' +
      'search — search in the comment; currency — by currency; from/to — by date range. ' +
      'Pagination: page (from 1) and limit (default 20). The response is the current page records plus meta (total, etc.).',
  })
  @ApiOkResponse({ type: PaginatedTransactionsDto })
  findAll(@CurrentUser() user: { id: string }, @Query() dto: GetTransactionsDto) {
    return this.transactionsService.findAll(user.id, dto);
  }

  @Get('balance')
  @ApiOperation({
    summary: 'Overall all-time balance',
    description:
      'All-time balance: income − expenses − whatever is reserved in active goals. Money is ' +
      'summed inside each currency and returned per currency in `byCurrency` — those figures are ' +
      'exact. `balance`/`balanceUsd` roll them into one number, converting only what is actually ' +
      "held in a foreign currency at today's rate; `isApproximate` says whether that happened.",
  })
  @ApiOkResponse({ type: BalanceResponseDto })
  balance(@CurrentUser() user: { id: string }) {
    return this.transactionsService.getBalance(user.id);
  }
}
