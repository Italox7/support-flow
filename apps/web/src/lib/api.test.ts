import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, busyRetryDelay, onBusyRetry } from './api';
import { session } from './session';

const USER = { id: 'u', email: 'u@x.dev', name: 'U', role: 'AGENT' };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const busy = () =>
  json({ code: 'ASSIGNMENT_BUSY', message: 'ocupado' }, 503, { 'Retry-After': '1' });

/** Sessão válida, com as respostas em ordem para o que não for /auth/refresh. */
async function withRoutes(...responses: (() => Response)[]) {
  let refreshes = 0;
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    void init;
    if (input.endsWith('/auth/refresh')) {
      refreshes += 1;
      return json({ accessToken: `token-${refreshes}`, user: USER });
    }
    const next = responses.shift();
    if (!next) throw new Error(`chamada inesperada: ${input}`);
    return next();
  });
  vi.stubGlobal('fetch', fetch);
  await session.bootstrap();
  fetch.mockClear();
  return fetch;
}

describe('api', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('não repete o 503 do hash de senha, mesmo com Retry-After', async () => {
    const fetch = await withRoutes(() =>
      json({ code: 'PASSWORD_HASH_BUSY' }, 503, { 'Retry-After': '2' }),
    );

    await expect(api('/users/agents', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 503,
      code: 'PASSWORD_HASH_BUSY',
      retryAfterSeconds: 2,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('manda o token e devolve o corpo', async () => {
    const fetch = await withRoutes(() => json({ ok: true }));

    await expect(api('/tickets')).resolves.toEqual({ ok: true });

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/tickets');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${session.getToken()}`,
    );
  });

  it('em 401, renova uma vez e repete com o token novo', async () => {
    const fetch = await withRoutes(
      () => json({}, 401),
      () => json({ ok: true }),
    );
    const before = session.getToken();

    await expect(api('/tickets')).resolves.toEqual({ ok: true });

    expect(session.getToken()).not.toBe(before);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/tickets',
      '/api/auth/refresh',
      '/api/tickets',
    ]);
  });

  it('401 de novo depois de renovar não entra em laço', async () => {
    const fetch = await withRoutes(
      () => json({}, 401),
      () => json({}, 401),
    );

    await expect(api('/tickets')).rejects.toMatchObject({ status: 401 });

    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('repete o 503 do lock até dar certo, inclusive em POST', async () => {
    const fetch = await withRoutes(busy, () => json({ id: 1 }, 201));
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 200 });
    const attempts: (number | null)[] = [];
    const stop = onBusyRetry((attempt) => attempts.push(attempt));

    await expect(api('/tickets', { method: 'POST', body: {} })).resolves.toEqual({ id: 1 });
    stop();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual([2, null]);
  });

  it('uma repetição que termina não apaga o aviso de outra que ainda espera', async () => {
    const routes: Record<string, (() => Response)[]> = {
      '/api/a': [busy, () => json({ a: 1 })],
      '/api/b': [busy, busy, () => json({ b: 1 })],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.endsWith('/auth/refresh')) return json({ accessToken: 't', user: USER });
        const next = routes[input]?.shift();
        if (!next) throw new Error(`chamada inesperada: ${input}`);
        return next();
      }),
    );
    await session.bootstrap();
    vi.useFakeTimers();
    const attempts: (number | null)[] = [];
    const stop = onBusyRetry((attempt) => attempts.push(attempt));

    const a = api('/a', { method: 'POST', body: {} });
    await vi.advanceTimersByTimeAsync(500);
    const b = api('/b', { method: 'POST', body: {} });
    await vi.advanceTimersByTimeAsync(500);
    await expect(a).resolves.toEqual({ a: 1 });
    // A terminou, mas B ainda espera: o aviso continua ligado.
    expect(attempts.at(-1)).toBe(2);

    await vi.advanceTimersByTimeAsync(2000);
    await expect(b).resolves.toEqual({ b: 1 });
    stop();

    expect(attempts).toEqual([2, 2, 2, 3, null]);
  });

  it('quem se inscreve no meio da repetição recebe a tentativa atual na hora', async () => {
    await withRoutes(busy, busy, () => json({ ok: 1 }));
    vi.useFakeTimers();

    const call = api('/tickets', { method: 'POST', body: {} });
    await vi.advanceTimersByTimeAsync(500);
    // Ex.: o Layout remonta enquanto a tentativa 2 espera.
    const attempts: (number | null)[] = [];
    const stop = onBusyRetry((attempt) => attempts.push(attempt));
    expect(attempts).toEqual([2]);

    await vi.advanceTimersByTimeAsync(2000);
    await expect(call).resolves.toEqual({ ok: 1 });
    stop();

    expect(attempts).toEqual([2, 3, null]);
  });

  it('para em 3 tentativas no total', async () => {
    const fetch = await withRoutes(busy, busy, busy, busy);
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 200 });

    await expect(api('/tickets', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 503,
    });

    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('503 de proxy, sem o code, não repete o POST', async () => {
    const fetch = await withRoutes(() => json({}, 503, { 'Retry-After': '1' }));

    await expect(api('/tickets', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 503,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('429 com Retry-After nunca repete', async () => {
    const fetch = await withRoutes(() => json({}, 429, { 'Retry-After': '1' }));

    await expect(api('/tickets')).rejects.toMatchObject({ status: 429 });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('troca de pessoa durante a espera do 503: a escrita de A não sai como B', async () => {
    const other = { ...USER, id: 'outra' };
    const fetch = await withRoutes(busy, () => json({ accessToken: 'token-b', user: other }));
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 200 });

    const writing = api('/tickets', { method: 'POST', body: { title: 'de A' } });
    const failure = expect(writing).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await session.login({ email: 'b@x.dev', password: 'senha-forte' });
    await failure;

    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/tickets', '/api/auth/login']);
  });

  it('troca de pessoa durante o refresh do 401: a escrita de A não sai como B', async () => {
    let refreshes = 0;
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      void init;
      if (input.endsWith('/auth/refresh')) {
        refreshes += 1;
        const user = refreshes === 1 ? USER : { ...USER, id: 'outra' };
        return json({ accessToken: `token-${refreshes}`, user });
      }
      return json({}, 401);
    });
    vi.stubGlobal('fetch', fetch);
    await session.bootstrap();

    await expect(api('/tickets', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 401,
    });

    expect(fetch.mock.calls.filter(([url]) => url === '/api/tickets')).toHaveLength(1);
  });

  it('leitura usa o teto de 60 s; escrita, o de 120 s', async () => {
    await withRoutes(
      () => json({}),
      () => json({}),
    );
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    await api('/tickets');
    await api('/tickets', { method: 'POST', body: {} });

    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([60_000, 120_000]);
    timeout.mockRestore();
  });

  it('escrita sem resposta fica marcada como incerta; leitura, não', async () => {
    await withRoutes();
    const failing = vi.fn().mockRejectedValue(new TypeError('rede'));
    vi.stubGlobal('fetch', failing);

    await expect(api('/tickets', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 0,
      uncertain: true,
    });
    await expect(api('/tickets')).rejects.toMatchObject({ status: 0, uncertain: false });
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe('busyRetryDelay', () => {
  const body = { code: 'ASSIGNMENT_BUSY' };
  const res = (status: number, retryAfter?: string) =>
    new Response(null, {
      status,
      headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
    });

  it.each(['1', '5'])('aceita Retry-After %s', (value) => {
    expect(busyRetryDelay(res(503, value), body)).toBe(Number(value));
  });

  it.each(['0', '6', '1.5', '-1', 'abc', 'Wed, 21 Oct 2026 07:28:00 GMT', ''])(
    'recusa Retry-After %j',
    (value) => {
      expect(busyRetryDelay(res(503, value), body)).toBeNull();
    },
  );

  it('recusa sem o cabeçalho, sem o code, com corpo nulo e fora do 503', () => {
    expect(busyRetryDelay(res(503), body)).toBeNull();
    expect(busyRetryDelay(res(503, '1'), { code: 'OUTRO' })).toBeNull();
    expect(busyRetryDelay(res(503, '1'), null)).toBeNull();
    expect(busyRetryDelay(res(429, '1'), body)).toBeNull();
  });
});
