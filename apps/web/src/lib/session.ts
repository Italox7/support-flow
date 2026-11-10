import type { AuthResponse, AuthUser } from '@support-flow/shared';
import { ApiError, readBody, toApiError } from './errors';

// Sessão fora do React: o access token fica só em memória, e o refresh token só
// no cookie httpOnly. Sem janela de tolerância na API, reapresentar um refresh
// token já usado revoga a família inteira; por isso toda escrita do cookie
// (refresh, login, cadastro, logout) roda num lock único entre as abas, cobrindo
// o fetch inteiro. Em fila, cada aba manda o cookie que a anterior deixou.
// Decisões e riscos aceitos: docs/decisions.md, 2026-11-04.

const LOCK_NAME = 'support-flow:auth';
const CHANNEL_NAME = 'support-flow:auth';
/** Só a espera na fila: desistir dela não gasta nenhum token. */
const LOCK_WAIT_MS = 10_000;
/** Teto alto: abortar depois de o servidor rotacionar perderia o token novo. */
const AUTH_FETCH_LIMIT_MS = 120_000;

/** O canal só leva estes avisos, nunca token. */
const NOTICES = ['logged-out', 'session-ended', 'user-changed'] as const;
type Notice = (typeof NOTICES)[number];
const isNotice = (data: unknown): data is Notice => NOTICES.includes(data as Notice);

export type SessionState =
  | { status: 'loading' }
  /** A API não respondeu ao abrir: a sessão pode estar válida, então não é anônimo. */
  | { status: 'unavailable'; error: ApiError }
  | { status: 'authenticated'; user: AuthUser }
  | { status: 'anonymous'; reason: 'none' | 'logged-out' }
  /** `userId` é de quem saiu: o destino guardado só vale para a mesma pessoa. */
  | { status: 'anonymous'; reason: 'expired'; userId: string };

export interface SessionChannel {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface SessionDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Ausente em navegador antigo ou contexto inseguro: a fila passa a valer só nesta aba. */
  locks?: Pick<LockManager, 'request'>;
  channel?: SessionChannel | null;
}

function parseAuthResponse(body: unknown): AuthResponse {
  const auth = body as Partial<AuthResponse> | null;
  if (typeof auth?.accessToken !== 'string' || typeof auth.user?.id !== 'string') {
    throw new ApiError(0);
  }
  return auth as AuthResponse;
}

export class Session {
  private state: SessionState = { status: 'loading' };
  private accessToken: string | null = null;
  private refreshing: Promise<string> | null = null;
  private tabQueue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly identityListeners = new Set<() => void>();
  private readonly deps: SessionDeps;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    if (deps.channel) deps.channel.onmessage = (event) => this.handleNotice(event.data);
  }

  getState = (): SessionState => this.state;

  getToken = (): string | null => this.accessToken;

  getUserId = (): string | null =>
    this.state.status === 'authenticated' ? this.state.user.id : null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Avisa quando o usuário sai ou muda: quem guarda dados dele (cache) limpa aqui. */
  onIdentityChange(listener: () => void): () => void {
    this.identityListeners.add(listener);
    return () => this.identityListeners.delete(listener);
  }

  /** Restaura a sessão pelo cookie, na mesma fila do 401. Nunca rejeita. */
  async bootstrap(): Promise<void> {
    this.accessToken = null;
    this.setState({ status: 'loading' });
    try {
      await this.refresh(null);
    } catch (error) {
      if (this.state.status === 'loading') {
        this.setState({ status: 'unavailable', error: toApiError(error) });
      }
    }
  }

  /**
   * Devolve um token mais novo que `seen` (o que a requisição usou). Rejeita com
   * ApiError: 401 encerra a sessão; 429, 5xx e rede são transitórios e a mantêm.
   */
  async refresh(seen: string | null): Promise<string> {
    if (this.accessToken && this.accessToken !== seen) return this.accessToken;
    this.refreshing ??= this.runRefresh(seen).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  login(credentials: { email: string; password: string }): Promise<AuthUser> {
    return this.authenticate('login', credentials);
  }

  register(data: { name: string; email: string; password: string }): Promise<AuthUser> {
    return this.authenticate('register', data);
  }

  /** Se falhar, a sessão continua: o cookie ainda vale, e dizer que saiu seria falso. */
  async logout(): Promise<void> {
    try {
      await this.withLock(async () => {
        const res = await this.post('logout');
        if (!res.ok) throw ApiError.fromResponse(res, await readBody(res));
        this.accessToken = null;
        this.setState({ status: 'anonymous', reason: 'logged-out' });
        this.notify('logged-out');
      });
    } catch (error) {
      throw toApiError(error);
    }
  }

  private async authenticate(path: 'login' | 'register', body: object): Promise<AuthUser> {
    try {
      return await this.withLock(async () => {
        // Só o envio é incerto: tempo esgotado na fila do lock não mandou nada.
        const res = await this.post(path, body).catch(() => {
          throw new ApiError(0, null, true);
        });
        const payload = await readBody(res);
        if (!res.ok) throw ApiError.fromResponse(res, payload);
        const user = this.adopt(parseAuthResponse(payload));
        this.notify('user-changed');
        return user;
      });
    } catch (error) {
      throw toApiError(error);
    }
  }

  private async runRefresh(seen: string | null): Promise<string> {
    try {
      return await this.withLock(async () => {
        // Outro caminho renovou enquanto esta chamada esperava na fila.
        if (this.accessToken && this.accessToken !== seen) return this.accessToken;
        // A sessão acabou durante a espera: renovar agora ressuscitaria o cookie.
        if (this.state.status === 'anonymous') throw new ApiError(401);

        const res = await this.post('refresh');
        const payload = await readBody(res);
        if (res.status === 401) {
          this.endSession();
          throw new ApiError(401, payload);
        }
        if (!res.ok) throw ApiError.fromResponse(res, payload);
        const auth = parseAuthResponse(payload);
        this.adopt(auth);
        return auth.accessToken;
      });
    } catch (error) {
      throw toApiError(error);
    }
  }

  private adopt({ accessToken, user }: AuthResponse): AuthUser {
    this.accessToken = accessToken;
    this.setState({ status: 'authenticated', user });
    return user;
  }

  private endSession(): void {
    const userId = this.getUserId();
    this.accessToken = null;
    this.setState(
      userId
        ? { status: 'anonymous', reason: 'expired', userId }
        : { status: 'anonymous', reason: 'none' },
    );
    if (userId) this.notify('session-ended');
  }

  private handleNotice(data: unknown): void {
    if (!isNotice(data)) return;
    switch (data) {
      case 'logged-out':
        this.accessToken = null;
        this.setState({ status: 'anonymous', reason: 'logged-out' });
        return;
      case 'session-ended':
        if (this.state.status === 'authenticated') {
          this.accessToken = null;
          this.setState({ status: 'anonymous', reason: 'expired', userId: this.state.user.id });
        }
        return;
      case 'user-changed':
        // O cookie agora é de outra sessão: o token e os dados desta aba não valem mais.
        void this.bootstrap();
        return;
    }
  }

  private notify(notice: Notice): void {
    this.deps.channel?.postMessage(notice);
  }

  private post(path: string, body?: object): Promise<Response> {
    return this.deps.fetch(`/api/auth/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(AUTH_FETCH_LIMIT_MS),
    });
  }

  /** O lock só é liberado quando `fn` termina, depois de a resposta (e o Set-Cookie) chegar. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const { locks } = this.deps;
    if (locks) {
      // O signal só cancela a espera: depois de obtido o lock, ele não aborta nada.
      return locks.request(
        LOCK_NAME,
        { signal: AbortSignal.timeout(LOCK_WAIT_MS) },
        fn,
      ) as Promise<T>;
    }
    const run = this.tabQueue.then(fn, fn);
    this.tabQueue = run.catch(() => undefined);
    return run;
  }

  private setState(next: SessionState): void {
    const before = this.state.status === 'authenticated' ? this.state.user.id : null;
    const after = next.status === 'authenticated' ? next.user.id : null;
    this.state = next;
    if (before && before !== after) this.identityListeners.forEach((listener) => listener());
    this.listeners.forEach((listener) => listener());
  }
}

export const session = new Session({
  fetch: (input, init) => globalThis.fetch(input, init),
  locks: typeof navigator !== 'undefined' ? navigator.locks : undefined,
  channel:
    typeof BroadcastChannel === 'undefined'
      ? null
      : // O handler só lê `data`, que o MessageEvent real sempre tem.
        (new BroadcastChannel(CHANNEL_NAME) as unknown as SessionChannel),
});
