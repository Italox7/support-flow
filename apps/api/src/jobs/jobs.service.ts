import { Injectable, Logger } from '@nestjs/common';
import { AssignmentService } from '../assignment/assignment.service.js';
import { REOPEN_WINDOW_MS } from '../tickets/ticket-state-machine.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { DemoResetService } from './demo-reset.service.js';

export interface JobsRunResult {
  restored: boolean;
  closed: number;
  assigned: number;
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly demoReset: DemoResetService,
    private readonly tickets: TicketsService,
    private readonly assignment: AssignmentService,
  ) {}

  /**
   * Nesta ordem: restaurar recria o ticket vencido e o órfão que os passos seguintes
   * tratam. Uma falha no meio vira 500, e tudo aqui pode rodar de novo com segurança.
   */
  async run(): Promise<JobsRunResult> {
    const restored = await this.demoReset.restore();

    const closingAt = new Date();
    const closed = await this.tickets.closeResolvedBefore(
      new Date(closingAt.getTime() - REOPEN_WINDOW_MS),
      closingAt,
    );

    const assigned = await this.assignment.inLock((tx) =>
      this.assignment.assignOrphans(tx, new Date()),
    );

    const result = { restored, closed, assigned };
    this.logger.log(`Jobs concluídos: ${JSON.stringify(result)}`);
    return result;
  }
}
