import { Priority, TicketStatus } from '@support-flow/shared';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
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

  /** UUID do agente, `me` (o próprio usuário) ou `none` (sem responsável). */
  @IsOptional()
  @Matches(ASSIGNEE_FILTER, { message: 'assigneeId deve ser um UUID, "me" ou "none"' })
  assigneeId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
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

/** Só a prioridade, por enquanto. O responsável entra na Fase 4 (admin). */
export class UpdateTicketDto {
  @IsIn(PRIORITIES)
  priority!: Priority;
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
