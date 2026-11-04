import type { AuthUser } from '@support-flow/shared';
import { useSyncExternalStore } from 'react';
import { session, type SessionState } from './session';

export function useSession(): SessionState {
  return useSyncExternalStore(session.subscribe, session.getState);
}

/** Para telas atrás do guarda de rota, onde o usuário sempre existe. */
export function useUser(): AuthUser {
  const state = useSession();
  if (state.status !== 'authenticated') throw new Error('Tela exige usuário autenticado');
  return state.user;
}
