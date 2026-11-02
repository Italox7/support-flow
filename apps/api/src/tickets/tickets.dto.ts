import { Priority, TicketStatus } from '@support-flow/shared';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { SLA_FILTERS, type SlaFilter } from '../sla/sla-filters.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const isPresent = (_object: object, value: unknown) => value !== undefined;
/** `?status=OPEN` chega como string e `?status=OPEN&status=CLOSED` como array. */
const toArray = ({ value }: { value: unknown }) =>
  value === undefined || Array.isArray(value) ? value : [value];

const STATUSES = Object.values(TicketStatus);
const PRIORITIES = Object.values(Priority);
const ASSIGNEE_FILTER = /^(me|none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export class ListTicketsQuery {
  @IsOptional()
  @Transform(toArray)
  @IsIn(STATUSES, { each: true })
  status?: TicketStatus[];

  @IsOptional()
  @Transform(toArray)
  @IsIn(PRIORITIES, { each: true })
  priority?: Priority[];

  /** Só para a equipe (403 para o cliente). Um ticket entra se um dos relógios estiver no estado. */
  @IsOptional()
  @Transform(toArray)
  @IsIn(SLA_FILTERS, { each: true })
  // Cada valor repetido viraria mais ramos de OR na consulta: no máximo um de cada.
  @ArrayUnique()
  @ArrayMaxSize(SLA_FILTERS.length)
  sla?: SlaFilter[];

  /** UUID do agente, `me` (o próprio usuário) ou `none` (sem responsável). */
  @IsOptional()
  @Matches(ASSIGNEE_FILTER, { message: 'assigneeId deve ser um UUID, "me" ou "none"' })
  assigneeId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // Um `page` enorme estouraria o OFFSET do Postgres (500 em vez de 400).
  @Max(10_000)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}

/** O cliente sugere a prioridade; o agente ajusta depois. */
export class CreateTicketDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000)
  description!: string;

  @IsOptional()
  @IsIn(PRIORITIES)
  priority?: Priority;
}

/**
 * Prioridade (equipe) e responsável (só admin); ao menos um, checado no
 * serviço. `@ValidateIf` em vez de `@IsOptional`: ausente pode, `null` não.
 */
export class UpdateTicketDto {
  @ValidateIf(isPresent)
  @IsIn(PRIORITIES)
  priority?: Priority;

  @ValidateIf(isPresent)
  @IsUUID()
  assigneeId?: string;
}

export class TransitionDto {
  @IsIn(STATUSES)
  to!: TicketStatus;
}

export class CreateCommentDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000)
  body!: string;

  @IsOptional()
  @IsBoolean()
  isInternal = false;
}
