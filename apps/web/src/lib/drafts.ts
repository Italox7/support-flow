// Rascunho de comentário: sobrevive à sessão expirada e volta depois do login. A
// chave leva o usuário, para o texto não aparecer para outra pessoa no navegador.
// sessionStorage pode falhar (modo privado, cota): sem ele, só não há rascunho.

const PREFIX = 'support-flow:draft:';

const keyOf = (userId: string, ticketId: string) => `${PREFIX}${userId}:${ticketId}`;

export interface Draft {
  text: string;
  /** Faz parte do rascunho: uma nota interna nunca pode voltar como comentário público. */
  isInternal: boolean;
}

const EMPTY: Draft = { text: '', isInternal: false };

export function loadDraft(userId: string, ticketId: string): Draft {
  try {
    const raw = sessionStorage.getItem(keyOf(userId, ticketId));
    if (!raw) return EMPTY;
    const draft = JSON.parse(raw) as Partial<Draft> | null;
    if (typeof draft?.text !== 'string') return EMPTY;
    // Na dúvida, interna: o erro barato é a nota não chegar ao cliente, não o contrário.
    return { text: draft.text, isInternal: draft.isInternal !== false };
  } catch {
    return EMPTY;
  }
}

export function saveDraft(userId: string, ticketId: string, draft: Draft): void {
  try {
    if (draft.text) sessionStorage.setItem(keyOf(userId, ticketId), JSON.stringify(draft));
    else sessionStorage.removeItem(keyOf(userId, ticketId));
  } catch {
    // Sem armazenamento, o texto fica só no campo.
  }
}

/** No logout explícito: quem sai não deixa texto para trás. */
export function clearDrafts(): void {
  try {
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith(PREFIX))
      .forEach((key) => sessionStorage.removeItem(key));
  } catch {
    // Idem.
  }
}
