/** Erro de uma chamada à API. `status` 0: a resposta não chegou (rede ou tempo esgotado). */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** Uma escrita sem resposta pode ter sido gravada: repetir pode duplicar. */
  readonly uncertain: boolean;

  constructor(status: number, body: unknown = null, uncertain = false) {
    super(`Falha na API (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.uncertain = uncertain;
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

export function describeError(error: unknown): string {
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
    case 429:
      return 'Muitas tentativas. Aguarde um minuto e tente de novo.';
    case 503:
      return 'O sistema está ocupado. Tente de novo em instantes.';
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
