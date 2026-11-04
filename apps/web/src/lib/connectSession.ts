import type { QueryClient } from '@tanstack/react-query';
import { clearDrafts } from './drafts';
import type { Session } from './session';

/** Dados de um usuário nunca sobrevivem à saída dele nem à troca de sessão. */
export function connectSession(session: Session, queryClient: QueryClient): void {
  session.onIdentityChange(() => queryClient.clear());
  session.subscribe(() => {
    const state = session.getState();
    if (state.status === 'anonymous' && state.reason === 'logged-out') clearDrafts();
  });
}
