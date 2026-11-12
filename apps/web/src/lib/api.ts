import { ASSIGNMENT_BUSY_CODE } from '@support-flow/shared';
import { ApiError, readBody } from './errors';
import { session } from './session';

export const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_SECONDS = 5;
/** Leitura: teto da espera, inclusive do servidor acordando. */
const READ_LIMIT_MS = 60_000;
/** Escrita: mais folga, porque abortar não desfaz o que o servidor já gravou. */
const WRITE_LIMIT_MS = 120_000;

/**
 * Segundos até repetir, ou null. Só o 503 do lock prova que nada foi gravado: um
 * 503 com Retry-After vindo de proxy pode chegar depois de a API gravar, e o 429
 * também traz o cabeçalho.
 */
export function busyRetryDelay(res: Response, body: unknown): number | null {
  if (res.status !== 503) return null;
  if ((body as { code?: unknown } | null)?.code !== ASSIGNMENT_BUSY_CODE) return null;
  const header = res.headers.get('Retry-After') ?? '';
  if (!/^\d+$/.test(header)) return null;
  const seconds = Number(header);
  return seconds >= 1 && seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : null;
}

type BusyListener = (attempt: number | null) => void;
const busyListeners = new Set<BusyListener>();
/** Tentativa atual de cada chamada que está repetindo agora. */
const activeRetries = new Map<symbol, number>();

/**
 * Avisa a tela das repetições em andamento: a maior tentativa entre as chamadas
 * que repetem, ou null quando nenhuma repete mais. Uma chamada que termina não
 * apaga o aviso de outra que ainda espera. Quem se inscreve no meio de uma
 * repetição recebe a tentativa atual na hora, durante a própria inscrição; sem
 * repetição ativa, nada é chamado (null é o estado inicial de quem ouve).
 */
export function onBusyRetry(listener: BusyListener): () => void {
  busyListeners.add(listener);
  const attempt = currentBusyAttempt();
  if (attempt !== null) listener(attempt);
  return () => busyListeners.delete(listener);
}

function currentBusyAttempt(): number | null {
  return activeRetries.size > 0 ? Math.max(...activeRetries.values()) : null;
}

function emitBusy() {
  const attempt = currentBusyAttempt();
  busyListeners.forEach((listener) => listener(attempt));
}

function send(path: string, method: string, body: unknown, token: string): Promise<Response> {
  const hasBody = body !== undefined;
  return globalThis.fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    body: hasBody ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(method === 'GET' ? READ_LIMIT_MS : WRITE_LIMIT_MS),
  });
}

/**
 * Chamada autenticada. Em 401, renova uma única vez e repete com o token novo; no
 * 503 do lock, repete em até MAX_ATTEMPTS tentativas. O resto vira ApiError. O
 * tipo de retorno confia no contrato de @support-flow/shared.
 */
export async function api<T>(
  path: string,
  { method = 'GET', body }: { method?: string; body?: unknown } = {},
): Promise<T> {
  const isWrite = method !== 'GET';
  let refreshed = false;
  let attempt = 1;
  let owner: string | null | undefined;
  const retryKey = Symbol(path);
  try {
    for (;;) {
      const token = session.getToken() ?? (await session.refresh(null));
      // Durante a espera, outra pessoa pode ter entrado: o que A escreveu nunca sai como B.
      const userId = session.getUserId();
      if (owner !== undefined && userId !== owner) throw new ApiError(401);
      owner = userId;
      let res: Response;
      try {
        res = await send(path, method, body, token);
      } catch {
        throw new ApiError(0, null, isWrite);
      }

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await session.refresh(token);
        continue;
      }

      const payload = await readBody(res);
      if (res.ok) return payload as T;

      const delay = busyRetryDelay(res, payload);
      if (delay === null || attempt >= MAX_ATTEMPTS) throw ApiError.fromResponse(res, payload);
      attempt += 1;
      activeRetries.set(retryKey, attempt);
      emitBusy();
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    }
  } finally {
    if (activeRetries.delete(retryKey)) emitBusy();
  }
}
