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

/** Avisa a tela da repetição em andamento: a tentativa atual, ou null ao terminar. */
export function onBusyRetry(listener: BusyListener): () => void {
  busyListeners.add(listener);
  return () => busyListeners.delete(listener);
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
      if (delay === null || attempt >= MAX_ATTEMPTS) throw new ApiError(res.status, payload);
      attempt += 1;
      const current = attempt;
      busyListeners.forEach((listener) => listener(current));
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    }
  } finally {
    if (attempt > 1) busyListeners.forEach((listener) => listener(null));
  }
}
