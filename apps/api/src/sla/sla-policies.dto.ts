import { IsInt, Max, Min } from 'class-validator';

/** Teto de 30 dias: um prazo maior é quase sempre um erro de digitação. */
export const MAX_SLA_MINUTES = 30 * 24 * 60;

/** Os dois prazos juntos; a 1ª resposta menor que a resolução é checada no serviço. */
export class UpdateSlaPolicyDto {
  @IsInt()
  @Min(1)
  @Max(MAX_SLA_MINUTES)
  firstResponseMinutes!: number;

  @IsInt()
  @Min(1)
  @Max(MAX_SLA_MINUTES)
  resolutionMinutes!: number;
}
