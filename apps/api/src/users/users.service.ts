import { Injectable, NotFoundException } from '@nestjs/common';
import type { AgentSummary, Availability } from '@support-flow/shared';
import { AssignmentService } from '../assignment/assignment.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignment: AssignmentService,
  ) {}

  async listAgents(): Promise<AgentSummary[]> {
    const agents = await this.assignment.agents(this.prisma);
    return agents.map(({ id, name, email, isAvailable, openTickets }) => ({
      id,
      name,
      email,
      isAvailable,
      openTickets,
    }));
  }

  /** 404 também para um id que existe mas não é de agente (cliente, admin). */
  async getAvailability(agentId: string): Promise<Availability> {
    const agent = await this.prisma.user.findFirst({
      where: { id: agentId, role: 'AGENT' },
      select: { isAvailable: true },
    });
    if (!agent) throw agentNotFound();
    return agent;
  }

  async setAvailability(agentId: string, { isAvailable }: Availability): Promise<Availability> {
    const found = await this.assignment.inLock((tx) =>
      this.assignment.setAvailability(tx, agentId, isAvailable, new Date()),
    );
    if (!found) throw agentNotFound();
    return { isAvailable };
  }
}

const agentNotFound = () => new NotFoundException('Agente não encontrado.');
