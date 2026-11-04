import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AgentSummary, Availability } from '@support-flow/shared';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { RequestUser } from '../auth/auth.types.js';
import { AvailabilityDto, CreateAgentDto } from './users.dto.js';
import { UsersService } from './users.service.js';

// O agente muda só a própria disponibilidade; o admin, a de qualquer agente.
// As rotas `me` vêm antes de `:id`, senão o ParseUUIDPipe recusaria "me".

/** Ficar disponível varre os órfãos sob o lock da atribuição: alternar em loop travaria a fila. */
const AVAILABILITY_THROTTLE = { default: { limit: 10, ttl: 60_000 } };
/** Cada criação calcula um hash argon2, que é caro. */
const CREATE_AGENT_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('agents')
  @Roles('ADMIN')
  listAgents(): Promise<AgentSummary[]> {
    return this.users.listAgents();
  }

  @Post('agents')
  @Roles('ADMIN')
  @Throttle(CREATE_AGENT_THROTTLE)
  createAgent(
    @CurrentUser() admin: RequestUser,
    @Body() dto: CreateAgentDto,
  ): Promise<AgentSummary> {
    return this.users.createAgent(admin, dto);
  }

  @Get('me/availability')
  @Roles('AGENT')
  getMyAvailability(@CurrentUser() user: RequestUser): Promise<Availability> {
    return this.users.getAvailability(user.id);
  }

  @Patch('me/availability')
  @Roles('AGENT')
  @Throttle(AVAILABILITY_THROTTLE)
  setMyAvailability(
    @CurrentUser() user: RequestUser,
    @Body() dto: AvailabilityDto,
  ): Promise<Availability> {
    return this.users.setAvailability(user.id, dto);
  }

  @Patch(':id/availability')
  @Roles('ADMIN')
  @Throttle(AVAILABILITY_THROTTLE)
  setAvailability(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AvailabilityDto,
  ): Promise<Availability> {
    return this.users.setAvailability(id, dto);
  }
}
