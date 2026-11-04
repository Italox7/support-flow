import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './errors';
import { Session, type SessionChannel } from './session';

const USER_A = { id: 'a', email: 'a@x.dev', name: 'A', role: 'CUSTOMER' as const };
const USER_B = { id: 'b', email: 'b@x.dev', name: 'B', role: 'AGENT' as const };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Fila FIFO, como navigator.locks: o próximo só entra quando a promessa anterior termina. */
function fakeLocks() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    request: vi.fn((_name: string, _options: object, fn: () => Promise<unknown>) => {
      const run = tail.then(fn);
      tail = run.catch(() => undefined);
      return run;
    }),
  } as never;
}

/** Canal entre abas: entrega às outras, como o BroadcastChannel. */
function fakeHub() {
  const members: SessionChannel[] = [];
  const sent: unknown[] = [];
  return {
    sent,
    channel(): SessionChannel {
      const self: SessionChannel = {
        onmessage: null,
        postMessage(message) {
          sent.push(message);
          queueMicrotask(() =>
            members.filter((m) => m !== self).forEach((m) => m.onmessage?.({ data: message })),
          );
        },
      };
      members.push(self);
      return self;
    },
  };
}

/** A política real de rotate: reapresentar um token já usado revoga a família e dá 401. */
function fakeServer() {
  const server = {
    cookie: 'r0' as string | null,
    used: new Set<string>(),
    revoked: false,
    refreshes: 0,
    user: USER_A as typeof USER_A | typeof USER_B,
    next: 1,
    latency: 0,
    fetch: vi.fn(async (input: string, init: RequestInit) => {
      void init;
      // O navegador lê o cookie ao enviar, antes de a resposta da outra aba chegar.
      const presented = server.cookie;
      await new Promise((resolve) => setTimeout(resolve, server.latency));
      if (input.endsWith('/refresh')) {
        server.refreshes += 1;
        if (!presented || server.revoked) return json({}, 401);
        if (server.used.has(presented)) {
          server.revoked = true;
          server.cookie = null;
          return json({}, 401);
        }
        server.used.add(presented);
        server.cookie = `r${server.next}`;
        return json({ accessToken: `t${server.next++}`, user: server.user });
      }
      if (input.endsWith('/logout')) {
        server.cookie = null;
        return new Response(null, { status: 204 });
      }
      server.cookie = `r${server.next}`;
      server.used.clear();
      server.revoked = false;
      server.user = USER_B;
      return json({ accessToken: `t${server.next++}`, user: USER_B });
    }),
  };
  return server;
}

function tabs(count: number, server: ReturnType<typeof fakeServer>, locks: never) {
  const hub = fakeHub();
  const list = Array.from(
    { length: count },
    () => new Session({ fetch: server.fetch, locks, channel: hub.channel() }),
  );
  return { hub, list };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('Session: refresh entre abas', () => {
  it('duas abas abrindo juntas renovam em fila, sem revogar a família', async () => {
    const server = fakeServer();
    server.latency = 2;
    const { list } = tabs(2, server, fakeLocks());
    const [a, b] = list as [Session, Session];

    await Promise.all([a.bootstrap(), b.bootstrap()]);

    expect(server.revoked).toBe(false);
    expect(server.refreshes).toBe(2);
    expect(a.getState().status).toBe('authenticated');
    expect(b.getState().status).toBe('authenticated');
    expect(a.getToken()).not.toBe(b.getToken());
  });

  it('sem Web Locks, a corrida entre abas revoga a família (risco aceito)', async () => {
    const server = fakeServer();
    server.latency = 2;
    const a = new Session({ fetch: server.fetch });
    const b = new Session({ fetch: server.fetch });

    await Promise.all([a.bootstrap(), b.bootstrap()]);

    expect(server.revoked).toBe(true);
  });

  it('sem Web Locks, a mesma aba nunca renova duas vezes ao mesmo tempo', async () => {
    const server = fakeServer();
    const tab = new Session({ fetch: server.fetch });

    await Promise.all([tab.refresh(null), tab.refresh(null), tab.refresh(null)]);

    expect(server.refreshes).toBe(1);
    expect(server.revoked).toBe(false);
  });

  it('401 com token antigo depois da rotação só reaproveita o token novo', async () => {
    const server = fakeServer();
    const tab = new Session({ fetch: server.fetch, locks: fakeLocks() });
    await tab.bootstrap();
    const old = tab.getToken();
    await tab.refresh(old);
    const refreshes = server.refreshes;

    await expect(tab.refresh(old)).resolves.toBe(tab.getToken());

    expect(server.refreshes).toBe(refreshes);
  });

  it('o lock cobre o fetch inteiro: a próxima aba só parte depois da resposta', async () => {
    const server = fakeServer();
    server.latency = 5;
    const order: string[] = [];
    const fetch = vi.fn(async (input: string, init: RequestInit) => {
      order.push('início');
      const res = await server.fetch(input, init);
      order.push('fim');
      return res;
    });
    const locks = fakeLocks();
    const a = new Session({ fetch, locks });
    const b = new Session({ fetch, locks });

    await Promise.all([a.bootstrap(), b.bootstrap()]);

    expect(order).toEqual(['início', 'fim', 'início', 'fim']);
  });
});

describe('Session: falhas do refresh', () => {
  it.each([429, 500, 503])('%i mantém a sessão', async (status) => {
    const server = fakeServer();
    const fetch = vi.fn(server.fetch);
    const tab = new Session({ fetch, locks: fakeLocks() });
    await tab.bootstrap();
    fetch.mockResolvedValueOnce(json({}, status));

    await expect(tab.refresh(tab.getToken())).rejects.toMatchObject({ status });

    expect(tab.getState().status).toBe('authenticated');
    expect(tab.getToken()).not.toBeNull();
  });

  it('erro de rede mantém a sessão e não repete sozinho', async () => {
    const server = fakeServer();
    const fetch = vi.fn(server.fetch);
    const tab = new Session({ fetch, locks: fakeLocks() });
    await tab.bootstrap();
    fetch.mockRejectedValueOnce(new TypeError('rede'));
    const calls = fetch.mock.calls.length;

    await expect(tab.refresh(tab.getToken())).rejects.toMatchObject({ status: 0 });

    expect(fetch.mock.calls.length).toBe(calls + 1);
    expect(tab.getState().status).toBe('authenticated');
  });

  it('401 encerra como expirada e avisa as outras abas', async () => {
    const server = fakeServer();
    const { hub, list } = tabs(2, server, fakeLocks());
    const [a, b] = list as [Session, Session];
    await a.bootstrap();
    await b.bootstrap();
    server.revoked = true;

    await expect(a.refresh(a.getToken())).rejects.toBeInstanceOf(ApiError);
    await settle();

    expect(a.getState()).toEqual({ status: 'anonymous', reason: 'expired' });
    expect(b.getState()).toEqual({ status: 'anonymous', reason: 'expired' });
    expect(hub.sent).toEqual(['session-ended']);
  });

  it('401 ao abrir sem cookie é anônimo, sem falar em sessão expirada', async () => {
    const server = fakeServer();
    server.cookie = null;
    const tab = new Session({ fetch: server.fetch, locks: fakeLocks() });

    await tab.bootstrap();

    expect(tab.getState()).toEqual({ status: 'anonymous', reason: 'none' });
  });

  it('API fora do ar ao abrir é indisponível, não anônimo', async () => {
    const tab = new Session({
      fetch: vi.fn().mockRejectedValue(new TypeError('rede')),
      locks: fakeLocks(),
    });

    await tab.bootstrap();

    expect(tab.getState().status).toBe('unavailable');
  });

  it('tempo esgotado na espera do lock é transitório e não chama a API', async () => {
    const fetch = vi.fn();
    const locks = {
      request: vi.fn().mockRejectedValue(new DOMException('tempo', 'TimeoutError')),
    } as never;
    const tab = new Session({ fetch, locks });

    await tab.bootstrap();

    expect(tab.getState().status).toBe('unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resposta inválida no refresh não vira sessão', async () => {
    const tab = new Session({
      fetch: vi.fn().mockResolvedValue(json({ accessToken: 123 })),
      locks: fakeLocks(),
    });

    await tab.bootstrap();

    expect(tab.getState().status).toBe('unavailable');
    expect(tab.getToken()).toBeNull();
  });
});

describe('Session: login e logout entre abas', () => {
  it('logout durante um refresh espera na fila e o refresh não ressuscita a sessão', async () => {
    const server = fakeServer();
    server.latency = 2;
    const { list } = tabs(2, server, fakeLocks());
    const [a, b] = list as [Session, Session];
    await a.bootstrap();
    await b.bootstrap();

    const refreshing = a.refresh(a.getToken());
    const leaving = b.logout();
    await refreshing;
    await leaving;
    await settle();

    expect(server.cookie).toBeNull();
    expect(a.getState()).toEqual({ status: 'anonymous', reason: 'logged-out' });
    expect(b.getState()).toEqual({ status: 'anonymous', reason: 'logged-out' });
    expect(a.getToken()).toBeNull();
  });

  it('depois do logout, a aba não renova mais', async () => {
    const server = fakeServer();
    const tab = new Session({ fetch: server.fetch, locks: fakeLocks() });
    await tab.bootstrap();
    await tab.logout();
    const refreshes = server.refreshes;

    await expect(tab.refresh(null)).rejects.toMatchObject({ status: 401 });

    expect(server.refreshes).toBe(refreshes);
  });

  it('logout que falha mantém a sessão', async () => {
    const server = fakeServer();
    const fetch = vi.fn(server.fetch);
    const tab = new Session({ fetch, locks: fakeLocks() });
    await tab.bootstrap();
    fetch.mockRejectedValueOnce(new TypeError('rede'));

    await expect(tab.logout()).rejects.toMatchObject({ status: 0 });

    expect(tab.getState().status).toBe('authenticated');
  });

  it('login de outra pessoa troca a sessão das outras abas e limpa os dados delas', async () => {
    const server = fakeServer();
    const { list } = tabs(2, server, fakeLocks());
    const [a, b] = list as [Session, Session];
    await a.bootstrap();
    await b.bootstrap();
    const cleared = vi.fn();
    a.onIdentityChange(cleared);

    await b.login({ email: 'b@x.dev', password: 'senha-forte' });
    await settle();

    expect(cleared).toHaveBeenCalled();
    expect(a.getState()).toEqual({ status: 'authenticated', user: USER_B });
    expect(server.revoked).toBe(false);
  });

  it('login recusado traz o status da API', async () => {
    const tab = new Session({
      fetch: vi.fn().mockResolvedValue(json({ message: 'Unauthorized' }, 401)),
      locks: fakeLocks(),
    });

    await expect(tab.login({ email: 'a@x.dev', password: 'errada' })).rejects.toMatchObject({
      status: 401,
    });
  });

  it('o canal só carrega avisos conhecidos, nunca token', async () => {
    const server = fakeServer();
    const { hub, list } = tabs(2, server, fakeLocks());
    const [a, b] = list as [Session, Session];
    await a.bootstrap();
    await a.login({ email: 'b@x.dev', password: 'senha-forte' });
    await settle();
    await a.logout();
    await settle();

    expect(hub.sent).toEqual(['user-changed', 'logged-out']);
    expect(b.getToken()).toBeNull();
  });

  it('mensagem desconhecida no canal é ignorada', async () => {
    const server = fakeServer();
    const channel: SessionChannel = { onmessage: null, postMessage: vi.fn() };
    const tab = new Session({ fetch: server.fetch, locks: fakeLocks(), channel });
    await tab.bootstrap();
    const token = tab.getToken();

    channel.onmessage?.({ data: { type: 'token', accessToken: 'forjado' } });
    channel.onmessage?.({ data: 'toString' });

    expect(tab.getState().status).toBe('authenticated');
    expect(tab.getToken()).toBe(token);
  });
});

describe('Session: login sem resposta', () => {
  it('tempo esgotado na fila do lock não mandou nada: não é incerto', async () => {
    const fetch = vi.fn();
    const locks = {
      request: vi.fn().mockRejectedValue(new DOMException('tempo', 'TimeoutError')),
    } as never;
    const tab = new Session({ fetch, locks });

    await expect(tab.login({ email: 'a@x.dev', password: 'senha' })).rejects.toMatchObject({
      status: 0,
      uncertain: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('falha no envio do login pode ter sido processada: é incerto', async () => {
    const tab = new Session({
      fetch: vi.fn().mockRejectedValue(new TypeError('rede')),
      locks: fakeLocks(),
    });

    await expect(tab.login({ email: 'a@x.dev', password: 'senha' })).rejects.toMatchObject({
      status: 0,
      uncertain: true,
    });
  });
});
