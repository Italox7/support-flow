// Escolha do responsável, sem banco: quem monta a lista de candidatos (só
// agentes disponíveis) e conta a carga é o AssignmentService.

export interface AgentLoad {
  id: string;
  /** Tickets atribuídos em OPEN_STATUSES. */
  openTickets: number;
  lastAssignedAt: Date | null;
}

/**
 * Menor carga primeiro; no empate, quem recebeu há mais tempo (nunca ter
 * recebido conta como o mais antigo) e, por fim, o id, para o resultado não
 * depender da ordem da lista. Sem candidatos, o ticket fica sem responsável.
 */
export function pickAgent(candidates: readonly AgentLoad[]): string | null {
  let best: AgentLoad | undefined;
  for (const candidate of candidates) {
    if (!best || compareAgents(candidate, best) < 0) best = candidate;
  }
  return best?.id ?? null;
}

function compareAgents(a: AgentLoad, b: AgentLoad): number {
  if (a.openTickets !== b.openTickets) return a.openTickets - b.openTickets;
  const aTime = a.lastAssignedAt?.getTime() ?? -Infinity;
  const bTime = b.lastAssignedAt?.getTime() ?? -Infinity;
  if (aTime !== bTime) return aTime < bTime ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
