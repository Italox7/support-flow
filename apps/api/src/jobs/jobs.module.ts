import { Module } from '@nestjs/common';
import { AssignmentModule } from '../assignment/assignment.module.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { DemoResetService } from './demo-reset.service.js';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';

@Module({
  imports: [AssignmentModule, TicketsModule],
  controllers: [JobsController],
  providers: [JobsService, DemoResetService],
})
export class JobsModule {}
