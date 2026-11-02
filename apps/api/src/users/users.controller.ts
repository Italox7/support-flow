import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import type { AgentSummary, Availability } from '@support-flow/shared';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { RequestUser } from '../auth/auth.types.js';
import { AvailabilityDto } from './users.dto.js';
import { UsersService } from './users.service.js';

// O agente muda só a própria disponibilidade; o admin, a de qualquer agente.
// As rotas `me` vêm antes de `:id`, senão o ParseUUIDPipe recusaria "me".

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('agents')
  @Roles('ADMIN')
  listAgents(): Promise<AgentSummary[]> {
    return this.users.listAgents();
  }

  @Get('me/availability')
  @Roles('AGENT')
  getMyAvailability(@CurrentUser() user: RequestUser): Promise<Availability> {
    return this.users.getAvailability(user.id);
  }

  @Patch('me/availability')
  @Roles('AGENT')
  setMyAvailability(
    @CurrentUser() user: RequestUser,
    @Body() dto: AvailabilityDto,
  ): Promise<Availability> {
    return this.users.setAvailability(user.id, dto);
  }

  @Patch(':id/availability')
  @Roles('ADMIN')
  setAvailability(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AvailabilityDto,
  ): Promise<Availability> {
    return this.users.setAvailability(id, dto);
  }
}
