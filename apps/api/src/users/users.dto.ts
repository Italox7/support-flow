import { IsBoolean } from 'class-validator';
import { RegisterDto } from '../auth/auth.dto.js';

export class AvailabilityDto {
  @IsBoolean()
  isAvailable!: boolean;
}

/** Herda em vez de copiar: o mínimo da senha é o do cadastro, e os dois não divergem. */
export class CreateAgentDto extends RegisterDto {}
