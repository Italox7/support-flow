import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { connectSession } from './connectSession';
import { loadDraft, saveDraft } from './drafts';
import { Session } from './session';

const user = { id: 'a', email: 'a@x.dev', name: 'A', role: 'AGENT' };

function setup(routes: Record<string, () => Response>) {
  const session = new Session({
    fetch: vi.fn(async (input: string) => {
      const route = routes[input];
      if (!route) throw new Error(input);
      return route();
    }),
  });
  const client = new QueryClient();
  connectSession(session, client);
  return { session, client };
}

const refreshOk = () => new Response(JSON.stringify({ accessToken: 't', user }));

describe('connectSession', () => {
  it('logout limpa o cache e os rascunhos', async () => {
    const { session, client } = setup({
      '/api/auth/refresh': refreshOk,
      '/api/auth/logout': () => new Response(null, { status: 204 }),
    });
    await session.bootstrap();
    client.setQueryData(['u', 'a', 'x'], 1);
    saveDraft('a', 't', { text: 'texto', isInternal: false });

    await session.logout();

    expect(client.getQueryData(['u', 'a', 'x'])).toBeUndefined();
    expect(loadDraft('a', 't').text).toBe('');
  });

  it('expiração limpa o cache, mas mantém o rascunho', async () => {
    let expired = false;
    const { session, client } = setup({
      '/api/auth/refresh': () => (expired ? new Response('{}', { status: 401 }) : refreshOk()),
    });
    await session.bootstrap();
    client.setQueryData(['u', 'a', 'x'], 1);
    saveDraft('a', 't', { text: 'texto', isInternal: false });
    expired = true;

    await expect(session.refresh(session.getToken())).rejects.toMatchObject({ status: 401 });

    expect(client.getQueryData(['u', 'a', 'x'])).toBeUndefined();
    expect(loadDraft('a', 't').text).toBe('texto');
  });
});
