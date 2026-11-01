import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { Paginated, TicketDetail, TicketSummary } from '@support-flow/shared';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { RequestUser } from '../auth/auth.types.js';
import {
  CreateTicketDto,
  ListTicketsQuery,
  TransitionDto,
  UpdateTicketDto,
} from './tickets.dto.js';
import { TicketsService } from './tickets.service.js';

// Sem @Roles(): todo papel usa estas rotas, e o que cada um alcança é decidido
// no TicketsService (escopo do cliente e permissões por transição).

@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query() query: ListTicketsQuery,
  ): Promise<Paginated<TicketSummary>> {
    return this.tickets.list(user, query);
  }

  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateTicketDto): Promise<TicketDetail> {
    return this.tickets.create(user, dto);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TicketDetail> {
    return this.tickets.findOne(user, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTicketDto,
  ): Promise<TicketDetail> {
    return this.tickets.updatePriority(user, id, dto);
  }

  @Post(':id/transitions')
  @HttpCode(200)
  transition(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionDto,
  ): Promise<TicketDetail> {
    return this.tickets.transition(user, id, dto.to);
  }
}
