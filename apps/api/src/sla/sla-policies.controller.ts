import { Body, Controller, Get, Param, ParseEnumPipe, Put } from '@nestjs/common';
import { Priority, type SlaPolicyDto } from '@support-flow/shared';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { RequestUser } from '../auth/auth.types.js';
import { UpdateSlaPolicyDto } from './sla-policies.dto.js';
import { SlaPoliciesService } from './sla-policies.service.js';

// A equipe consulta os prazos; só o admin edita. O cliente não vê o SLA.

@Controller('sla-policies')
export class SlaPoliciesController {
  constructor(private readonly policies: SlaPoliciesService) {}

  @Get()
  @Roles('AGENT', 'ADMIN')
  list(): Promise<SlaPolicyDto[]> {
    return this.policies.list();
  }

  @Put(':priority')
  @Roles('ADMIN')
  update(
    @CurrentUser() user: RequestUser,
    @Param('priority', new ParseEnumPipe(Priority)) priority: Priority,
    @Body() dto: UpdateSlaPolicyDto,
  ): Promise<SlaPolicyDto> {
    return this.policies.update(user, priority, dto);
  }
}
