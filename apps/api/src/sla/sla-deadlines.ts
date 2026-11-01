export interface SlaPolicyMinutes {
  firstResponseMinutes: number;
  resolutionMinutes: number;
}

export interface SlaDeadlines {
  firstResponseDueAt: Date;
  resolutionDueAt: Date;
}

/**
 * Prazos de 1ª resposta e de resolução, em horas corridas a partir da abertura,
 * empurrados pelo tempo que o relógio já ficou pausado. Serve à criação e à
 * troca de prioridade (que recalcula a partir de `createdAt`).
 */
export function computeDeadlines(
  createdAt: Date,
  policy: SlaPolicyMinutes,
  pausedSeconds = 0,
): SlaDeadlines {
  const start = createdAt.getTime() + pausedSeconds * 1000;
  return {
    firstResponseDueAt: new Date(start + policy.firstResponseMinutes * 60_000),
    resolutionDueAt: new Date(start + policy.resolutionMinutes * 60_000),
  };
}
