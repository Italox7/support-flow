import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AgentSummary, Availability } from '@support-flow/shared';
import { AssignmentService } from '../assignment/assignment.service.js';
import type { RequestUser } from '../auth/auth.types.js';
import { hashPassword } from '../auth/password.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateAgentDto } from './users.dto.js';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly assignment: AssignmentService,
  ) {}

  /**
   * Nasce indisponível, contra o default do schema: não recebe tickets antes do
   * primeiro login e dispensa o lock, porque indisponível não é candidato. Ao
   * ficar disponível, `setAvailability` faz a varredura de órfãos.
   */
  async createAgent(admin: RequestUser, dto: CreateAgentDto): Promise<AgentSummary> {
    const passwordHash = await hashPassword(dto.password);
    let agent: Pick<AgentSummary, 'id' | 'name' | 'email' | 'isAvailable'>;
    try {
      agent = await this.prisma.user.create({
        data: {
          email: dto.email,
          name: dto.name,
          passwordHash,
          role: 'AGENT',
          isAvailable: false,
        },
        select: { id: true, name: true, email: true, isAvailable: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Este e-mail já está cadastrado.');
      }
      throw error;
    }
    // Quem criou fica no log. Sem e-mail nem senha: basta o id.
    this.logger.log({ event: 'agent_created', adminId: admin.id, agentId: agent.id });
    return { ...agent, openTickets: 0 };
  }

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
