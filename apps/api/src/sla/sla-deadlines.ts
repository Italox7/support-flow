export interface SlaPolicyMinutes {
  firstResponseMinutes: number;
  resolutionMinutes: number;
}

export interface SlaDeadlines {
  firstResponseDueAt: Date;
  firstResponseRiskAt: Date;
  resolutionDueAt: Date;
  resolutionRiskAt: Date;
}

/**
 * Fração do prazo a partir da qual o ticket fica "em risco". Fica gravada nos
 * *RiskAt: mudar o valor exige uma migration que recalcule os tickets existentes.
 */
export const AT_RISK_SHARE = 0.8;

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
  const due = (minutes: number) => new Date(start + minutes * 60_000);
  // Mesmo arredondamento (ms inteiros) da migration que preencheu os tickets antigos.
  const risk = (minutes: number) => new Date(start + Math.round(minutes * 60_000 * AT_RISK_SHARE));
  return {
    firstResponseDueAt: due(policy.firstResponseMinutes),
    firstResponseRiskAt: risk(policy.firstResponseMinutes),
    resolutionDueAt: due(policy.resolutionMinutes),
    resolutionRiskAt: risk(policy.resolutionMinutes),
  };
}
