import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Priority, SlaPolicyDto } from '@support-flow/shared';
import type { RequestUser } from '../auth/auth.types.js';
import type { SlaPolicy } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { UpdateSlaPolicyDto } from './sla-policies.dto.js';

const PRIORITY_ORDER: Priority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];

/**
 * Políticas de SLA por prioridade. Editar vale para tickets novos e para trocas
 * de prioridade: os prazos já gravados nos tickets não são recalculados.
 */
@Injectable()
export class SlaPoliciesService {
  private readonly logger = new Logger(SlaPoliciesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<SlaPolicyDto[]> {
    const policies = await this.prisma.slaPolicy.findMany();
    return policies
      .sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority))
      .map(toSlaPolicyDto);
  }

  async update(
    user: RequestUser,
    priority: Priority,
    dto: UpdateSlaPolicyDto,
  ): Promise<SlaPolicyDto> {
    if (dto.firstResponseMinutes >= dto.resolutionMinutes) {
      throw new BadRequestException('A 1ª resposta precisa ter prazo menor que a resolução.');
    }
    // Upsert: toda prioridade precisa de política para os prazos serem calculados.
    const [before, policy] = await this.prisma.$transaction([
      this.prisma.slaPolicy.findUnique({ where: { priority } }),
      this.prisma.slaPolicy.upsert({
        where: { priority },
        update: dto,
        create: { priority, ...dto },
      }),
    ]);
    // Sem histórico de política nesta fase: o log é o registro de quem mudou o quê.
    this.logger.log({
      event: 'sla_policy_updated',
      adminId: user.id,
      priority,
      before: before && {
        firstResponseMinutes: before.firstResponseMinutes,
        resolutionMinutes: before.resolutionMinutes,
      },
      after: {
        firstResponseMinutes: policy.firstResponseMinutes,
        resolutionMinutes: policy.resolutionMinutes,
      },
    });
    return toSlaPolicyDto(policy);
  }
}

function toSlaPolicyDto(policy: SlaPolicy): SlaPolicyDto {
  return {
    priority: policy.priority,
    firstResponseMinutes: policy.firstResponseMinutes,
    resolutionMinutes: policy.resolutionMinutes,
    updatedAt: policy.updatedAt.toISOString(),
  };
}
