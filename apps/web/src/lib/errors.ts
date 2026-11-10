import { PASSWORD_HASH_BUSY_CODE } from '@support-flow/shared';

/** Erro de uma chamada à API. `status` 0: a resposta não chegou (rede ou tempo esgotado). */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** Uma escrita sem resposta pode ter sido gravada: repetir pode duplicar. */
  readonly uncertain: boolean;
  /** `Retry-After` em segundos, quando a resposta trouxe um válido. */
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    body: unknown = null,
    uncertain = false,
    retryAfterSeconds: number | null = null,
  ) {
    super(`Falha na API (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.uncertain = uncertain;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  static fromResponse(res: Response, body: unknown): ApiError {
    const header = res.headers.get('Retry-After') ?? '';
    const seconds = /^\d+$/.test(header) ? Number(header) : null;
    return new ApiError(res.status, body, false, seconds);
  }

  get code(): string | null {
    const code = (this.body as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : null;
  }

  /** `message` do Nest: string nas regras do serviço, lista na validação dos campos. */
  get apiMessage(): string | string[] | null {
    if (typeof this.body !== 'object' || this.body === null || !('message' in this.body)) {
      return null;
    }
    const { message } = this.body;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.filter((m) => typeof m === 'string');
    return null;
  }
}

export async function readBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Qualquer outra falha (rede, lock ou fetch com tempo esgotado) vira status 0. */
export function toApiError(error: unknown, uncertain = false): ApiError {
  return error instanceof ApiError ? error : new ApiError(0, null, uncertain);
}

/**
 * "cerca de N minutos", a partir do Retry-After, calculado uma vez no erro: um
 * contador vivo seria repetido pelo leitor de tela. Sem o número exato, que
 * revelaria o limite.
 */
function waitText(seconds: number | null): string {
  if (seconds === null) return 'alguns minutos';
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1 ? 'cerca de 1 minuto' : `cerca de ${minutes} minutos`;
}

/**
 * `login`: o 429 fala de tentativas de entrada, sem sugerir que a conta existe
 * nem que foi bloqueada, e o 503 do hash não fala em "salvo".
 */
export function describeError(error: unknown, { action }: { action?: 'login' } = {}): string {
  const apiError = toApiError(error);
  const message = apiError.apiMessage;
  switch (apiError.status) {
    case 0:
      return apiError.uncertain
        ? 'Não recebemos a resposta do servidor. Confira se a ação foi concluída antes de tentar de novo.'
        : 'Não foi possível falar com o servidor. Verifique sua conexão e tente de novo.';
    case 400:
      return typeof message === 'string' ? message : 'Confira os campos e tente de novo.';
    case 401:
      return 'Sua sessão expirou. Entre de novo para continuar.';
    case 403:
      return typeof message === 'string' ? message : 'Você não pode fazer essa ação.';
    case 404:
      return 'Não encontramos o que você procurava.';
    case 409:
    case 422:
      return typeof message === 'string'
        ? message
        : 'Os dados mudaram enquanto isso. Recarregue e tente de novo.';
    case 429: {
      const wait = waitText(apiError.retryAfterSeconds);
      return action === 'login'
        ? `Muitas tentativas de entrada. Aguarde ${wait} e tente de novo.`
        : `Muitas tentativas. Aguarde ${wait} e tente de novo.`;
    }
    case 503:
      if (apiError.code !== PASSWORD_HASH_BUSY_CODE) {
        return 'O sistema está ocupado. Tente de novo em instantes.';
      }
      return action === 'login'
        ? 'O servidor está ocupado agora. Tente entrar de novo em alguns segundos.'
        : 'O servidor está ocupado agora e não concluiu o pedido. Nada foi salvo. Tente de novo em alguns segundos.';
    default:
      return 'Algo deu errado do nosso lado. Tente de novo em instantes.';
  }
}

/**
 * Traduz a validação do Nest ("email must be an email") para o texto de cada
 * campo. A primeira palavra da mensagem é o nome do campo.
 */
export function fieldErrors<F extends string>(
  error: unknown,
  copy: Record<F, string>,
): Partial<Record<F, string>> {
  const message = toApiError(error).apiMessage;
  if (!Array.isArray(message)) return {};
  const found: Partial<Record<F, string>> = {};
  for (const text of message) {
    const field = text.split(' ')[0] as F;
    if (Object.hasOwn(copy, field)) found[field] = copy[field];
  }
  return found;
}
