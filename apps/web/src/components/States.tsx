import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { describeError, toApiError } from '../lib/errors';
import { formatTime } from '../lib/format';
import { useSlow, WAKING_MESSAGE } from '../lib/useSlow';

export function Loading() {
  const slow = useSlow(true);
  return (
    <div className="space-y-3">
      <p role="status" className={slow ? 'text-muted' : 'sr-only'}>
        {slow ? WAKING_MESSAGE : 'Carregando…'}
      </p>
      <div aria-hidden="true" className="space-y-2 motion-safe:animate-pulse">
        <div className="h-5 w-2/3 rounded bg-gray-300" />
        <div className="h-5 w-full rounded bg-gray-300" />
        <div className="h-5 w-5/6 rounded bg-gray-300" />
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="card space-y-3 text-center">{children}</div>;
}

export function NotFoundView() {
  return (
    <div className="card space-y-3">
      <p className="font-semibold">Ticket ou página não encontrados.</p>
      <p>Confira o endereço ou volte para o início.</p>
      <Link className="link" to="/">
        Ir para o início
      </Link>
    </div>
  );
}

export function ForbiddenView() {
  return (
    <div className="card space-y-3">
      <p className="font-semibold">Você não tem acesso a esta tela.</p>
      <Link className="link" to="/">
        Ir para o início
      </Link>
    </div>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="card space-y-3 border-danger">
      <p className="text-danger">{message}</p>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Tentar de novo
        </button>
      )}
    </div>
  );
}

/** Tela inteira no lugar dos dados que não vieram. */
export function QueryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { status } = toApiError(error);
  // Ticket inexistente e ticket de outra pessoa dão a mesma tela: não revela o que existe.
  if (status === 404) return <NotFoundView />;
  if (status === 403) return <ForbiddenView />;
  return <ErrorNotice message={describeError(error)} onRetry={onRetry} />;
}

/** O refetch falhou, mas ainda há dados: melhor mostrá-los com aviso do que limpar a tela. */
export function StaleNotice({ failed, updatedAt }: { failed: boolean; updatedAt: number }) {
  if (!failed) return null;
  return (
    <p role="status" className="rounded-md border border-amber-700 bg-amber-100 p-2 text-amber-950">
      Não foi possível atualizar. Mostrando os dados das {formatTime(updatedAt)}.
    </p>
  );
}

export function FormAlert({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md border border-danger bg-red-50 p-2 text-danger">
      {message}
    </p>
  );
}
