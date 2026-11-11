import {
  Priority,
  type AgentSummary,
  type AuthUser,
  type CommentDto,
  type TicketDetail,
  type TicketStatus,
} from '@support-flow/shared';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { TextAreaField } from '../components/Fields';
import { Page } from '../components/Page';
import { SlaPanel } from '../components/SlaBadge';
import { Loading, NotFoundView, QueryError, StaleNotice } from '../components/States';
import { api } from '../lib/api';
import { loadDraft, saveDraft, type Draft } from '../lib/drafts';
import { describeError, toApiError } from '../lib/errors';
import { formatDate, formatDateTime } from '../lib/format';
import { PRIORITY_LABELS, statusLabel, transitionLabel } from '../lib/labels';
import { keys, REFETCH_MS } from '../lib/queries';
import { session } from '../lib/session';
import { useUser } from '../lib/useSession';
import { useSlow, WAKING_MESSAGE } from '../lib/useSlow';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REOPEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface ActionError {
  message: string;
  /** 409 em que o usuário escolhe recarregar: o que ele digitou continua no campo. */
  canReload: boolean;
}

function ReloadableError({ error, onReload }: { error: ActionError; onReload: () => void }) {
  return (
    <div role="alert" className="space-y-2 rounded-md border border-danger bg-red-50 p-3">
      <p className="text-danger">{error.message}</p>
      {error.canReload && (
        <button type="button" className="btn" onClick={onReload}>
          Recarregar ticket
        </button>
      )}
    </div>
  );
}

function CommentList({ comments }: { comments: CommentDto[] }) {
  if (comments.length === 0) return <p className="text-muted">Nenhum comentário ainda.</p>;
  return (
    <ol className="space-y-3">
      {comments.map((comment) => (
        <li
          key={comment.id}
          className={`rounded-md border p-3 ${
            comment.isInternal ? 'border-dashed border-slate-700 bg-slate-100' : 'border-gray-300'
          }`}
        >
          <p className="flex flex-wrap gap-x-2 text-sm text-muted">
            <span className="font-semibold text-ink">{comment.author.name}</span>
            <time dateTime={comment.createdAt}>{formatDateTime(comment.createdAt)}</time>
            {comment.isInternal && <span className="font-semibold">Nota interna</span>}
          </p>
          {/* Sempre como texto do React: conteúdo de ticket nunca vira HTML. */}
          <p className="mt-1 break-words whitespace-pre-wrap">{comment.body}</p>
        </li>
      ))}
    </ol>
  );
}

function CommentForm({
  ticket,
  user,
  onSent,
  onReload,
}: {
  ticket: TicketDetail;
  user: AuthUser;
  onSent: () => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(() => loadDraft(user.id, ticket.id));
  const { text } = draft;
  const [emptyError, setEmptyError] = useState<string | undefined>();
  const [error, setError] = useState<ActionError | null>(null);
  // O POST já respondeu e a mutação só segue pendente pela recarga: o botão não diz "Enviando…".
  const [sent, setSent] = useState(false);
  const isStaff = user.role !== 'CUSTOMER';
  const isInternal = isStaff && draft.isInternal;

  const change = (next: Draft) => {
    setDraft(next);
    saveDraft(user.id, ticket.id, next);
  };

  const mutation = useMutation({
    mutationFn: () =>
      api<CommentDto>(`/tickets/${ticket.id}/comments`, {
        method: 'POST',
        body: isStaff ? { body: text, isInternal } : { body: text },
      }),
    onSuccess: async () => {
      setError(null);
      // A caixa continua como estava: uma 2ª nota seguida não pode sair pública por engano.
      change({ text: '', isInternal });
      // Outra pessoa entrou durante o envio: buscar agora usaria o token dela na chave de A.
      if (session.getUserId() !== user.id) return;
      setSent(true);
      try {
        await onSent();
      } finally {
        setSent(false);
      }
      field.current?.focus({ preventScroll: true });
    },
    onError: (failure) => {
      const { status } = toApiError(failure);
      setError({ message: describeError(failure), canReload: status === 409 });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) {
      setEmptyError('Escreva o comentário antes de enviar.');
      field.current?.focus();
      return;
    }
    setEmptyError(undefined);
    mutation.mutate();
  };

  return (
    <form noValidate className="space-y-3" onSubmit={submit}>
      {error && (
        <ReloadableError
          error={error}
          onReload={() => {
            setError(null);
            void onReload();
          }}
        />
      )}
      <TextAreaField
        label={isInternal ? 'Nota interna' : 'Comentário'}
        textareaRef={field}
        maxLength={10_000}
        value={text}
        error={emptyError}
        onChange={(e) => change({ text: e.target.value, isInternal })}
      />
      {isStaff && (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="size-5"
            checked={isInternal}
            onChange={(e) => change({ text, isInternal: e.target.checked })}
          />
          Nota interna (o cliente não vê)
        </label>
      )}
      <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
        {mutation.isPending && !sent ? 'Enviando…' : 'Enviar'}
      </button>
    </form>
  );
}

/** Texto derivado de `resolvedAt`: quem decide o botão é o `allowedTransitions` da API. */
function ReopenHint({ ticket }: { ticket: TicketDetail }) {
  if (ticket.status !== 'RESOLVED' || !ticket.resolvedAt) return null;
  if (!ticket.allowedTransitions.includes('IN_PROGRESS')) {
    return <p className="text-muted">O prazo para reabrir terminou. Abra um novo ticket.</p>;
  }
  const until = new Date(ticket.resolvedAt).getTime() + REOPEN_WINDOW_MS;
  return (
    <p className="text-muted">
      Você pode reabrir este ticket por 7 dias após a resolução (até {formatDate(until)}).
    </p>
  );
}

function priorityLockReason(status: TicketStatus): string | undefined {
  if (status === 'RESOLVED') {
    return 'Ticket resolvido não muda de prioridade. Só reabrindo.';
  }
  return status === 'CLOSED' ? 'Ticket fechado não muda de prioridade.' : undefined;
}

function StaffControls({
  ticket,
  user,
  onSaved,
  onError,
}: {
  ticket: TicketDetail;
  user: AuthUser;
  onSaved: (ticket: TicketDetail, notice: string) => void;
  onError: (error: unknown) => void;
}) {
  const isAdmin = user.role === 'ADMIN';
  const agents = useQuery({
    queryKey: keys.agents(user),
    queryFn: () => api<AgentSummary[]>('/users/agents'),
    enabled: isAdmin,
  });
  const mutation = useMutation({
    mutationKey: keys.ticketWrite(user, ticket.id),
    mutationFn: (patch: { priority?: Priority; assigneeId?: string }) =>
      api<TicketDetail>(`/tickets/${ticket.id}`, { method: 'PATCH', body: patch }),
    onSuccess: (updated, patch) =>
      onSaved(
        updated,
        patch.priority
          ? `Prioridade alterada para ${PRIORITY_LABELS[updated.priority]}.`
          : `Responsável alterado para ${updated.assignee?.name ?? 'ninguém'}.`,
      ),
    onError,
  });
  // Inclui a transição de status: a resposta que chegasse por último gravaria um ticket velho.
  const busy = useIsMutating({ mutationKey: keys.ticketWrite(user, ticket.id) }) > 0;
  const lockReason = priorityLockReason(ticket.status);

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <label htmlFor="ticket-priority" className="block font-medium">
          Prioridade
        </label>
        <select
          id="ticket-priority"
          className="input"
          value={ticket.priority}
          disabled={Boolean(lockReason) || busy}
          aria-describedby={lockReason ? 'ticket-priority-lock' : undefined}
          onChange={(e) => mutation.mutate({ priority: e.target.value as Priority })}
        >
          {Object.values(Priority).map((priority) => (
            <option key={priority} value={priority}>
              {PRIORITY_LABELS[priority]}
            </option>
          ))}
        </select>
        {lockReason && (
          <p id="ticket-priority-lock" className="text-sm text-muted">
            {lockReason}
          </p>
        )}
      </div>
      {isAdmin && (
        <div className="space-y-1">
          <label htmlFor="ticket-assignee" className="block font-medium">
            Responsável
          </label>
          <select
            id="ticket-assignee"
            className="input"
            value={ticket.assignee?.id ?? ''}
            disabled={ticket.status === 'CLOSED' || busy || !agents.data}
            onChange={(e) => mutation.mutate({ assigneeId: e.target.value })}
          >
            {!ticket.assignee && <option value="">Sem responsável</option>}
            {ticket.assignee && !agents.data?.some((a) => a.id === ticket.assignee?.id) && (
              <option value={ticket.assignee.id}>{ticket.assignee.name}</option>
            )}
            {agents.data?.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
                {agent.isAvailable ? '' : ' (indisponível)'}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

function TicketContent({ id, user }: { id: string; user: AuthUser }) {
  const client = useQueryClient();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState<ActionError | null>(null);
  // Contador, não booleano: a recarga do comentário e a do botão Recarregar podem se sobrepor.
  // `isFetching` não serve: o polling de REFETCH_MS também liga e anunciaria toda leitura de rotina.
  const [refreshing, setRefreshing] = useState(0);
  const slowRefresh = useSlow(refreshing > 0);

  /** Recarga pedida pela pessoa: a leitura pode levar até um minuto e a tela diz que está esperando. */
  const tracked = async <T,>(work: () => Promise<T>): Promise<T> => {
    setRefreshing((n) => n + 1);
    try {
      return await work();
    } finally {
      setRefreshing((n) => n - 1);
    }
  };

  const ticketQuery = useQuery({
    queryKey: keys.ticket(user, id),
    queryFn: () => api<TicketDetail>(`/tickets/${id}`),
    refetchInterval: REFETCH_MS,
  });
  const commentsQuery = useQuery({
    queryKey: keys.comments(user, id),
    queryFn: () => api<CommentDto[]>(`/tickets/${id}/comments`),
    refetchInterval: REFETCH_MS,
  });

  const transition = useMutation({
    mutationKey: keys.ticketWrite(user, id),
    mutationFn: (to: TicketStatus) =>
      api<TicketDetail>(`/tickets/${id}/transitions`, { method: 'POST', body: { to } }),
    onSuccess: (updated) => {
      // A pessoa saiu durante o envio: o cache já foi limpo e não recebe dados dela de volta.
      if (session.getUserId() !== user.id) return;
      setActionError(null);
      client.setQueryData(keys.ticket(user, id), updated);
      setNotice(`Status alterado para ${statusLabel(updated.status, user.role)}.`);
      statusRef.current?.focus({ preventScroll: true });
    },
    onError: async (failure) => {
      if (session.getUserId() !== user.id) return;
      const { status } = toApiError(failure);
      // A lista de ações estava defasada: recarrega e explica por que os botões mudaram.
      if (status === 403 || status === 409) {
        const reason =
          status === 403
            ? 'Você não pode mais fazer essa ação neste ticket.'
            : describeError(failure);
        // A mutação segue pendente até aqui: os botões vencidos ficam travados durante a leitura.
        const fresh = await tracked(() => ticketQuery.refetch());
        // Outra pessoa entrou durante a leitura: o aviso era de quem saiu.
        if (session.getUserId() !== user.id) return;
        // refetch não lança: falha volta como isError, e aí as ações na tela ainda são as velhas.
        setActionError(
          fresh.isError
            ? { message: `${reason} Não foi possível atualizar as ações agora.`, canReload: true }
            : { message: `${reason} Atualizamos as ações disponíveis.`, canReload: false },
        );
      } else {
        setActionError({ message: describeError(failure), canReload: false });
      }
    },
  });
  // Transição ou PATCH dos StaffControls pendente: as duas gravam o ticket inteiro no cache.
  const writing = useIsMutating({ mutationKey: keys.ticketWrite(user, id) }) > 0;

  if (ticketQuery.isPending) {
    return (
      <Page title="Carregando ticket">
        <Loading />
      </Page>
    );
  }
  if (ticketQuery.isError && !ticketQuery.data) {
    return (
      <Page title="Ticket">
        <QueryError error={ticketQuery.error} onRetry={() => void ticketQuery.refetch()} />
      </Page>
    );
  }

  const ticket = ticketQuery.data;
  const receivedAt = ticketQuery.dataUpdatedAt;
  const isStaff = user.role !== 'CUSTOMER';
  // A mesma região de status de sempre: uma região nova que já nasce com texto costuma não ser lida.
  const status = refreshing > 0 ? (slowRefresh ? WAKING_MESSAGE : 'Atualizando o ticket…') : notice;

  /**
   * Recarrega ticket e comentários. `refetch` não lança: falha volta como `isError` com o dado
   * velho, então quem chama decide o aviso pelo resultado. `null` = outra pessoa entrou no meio.
   */
  const refreshAll = async () => {
    const [fresh, comments] = await tracked(() =>
      Promise.all([ticketQuery.refetch(), commentsQuery.refetch()]),
    );
    if (session.getUserId() !== user.id) return null;
    return { fresh, ok: !fresh.isError && !comments.isError };
  };

  const refreshFailed: ActionError = {
    message: 'Não foi possível atualizar o ticket agora.',
    canReload: true,
  };

  const reload = async () => {
    setActionError(null);
    setNotice('');
    const result = await refreshAll();
    if (!result) return;
    if (result.ok) setNotice('Ticket atualizado.');
    else setActionError(refreshFailed);
  };

  const afterComment = async () => {
    const before = ticket.status;
    const result = await refreshAll();
    if (!result) return;
    // Com a leitura do ticket falha, `data` é o status de antes: não dá para afirmar mudança.
    const after = result.fresh.isError ? undefined : result.fresh.data?.status;
    setNotice(
      after && after !== before
        ? `Seu comentário foi enviado. O status agora é ${statusLabel(after, user.role)}.`
        : 'Seu comentário foi enviado.',
    );
    if (!result.ok) setActionError(refreshFailed);
  };

  const staffError = (failure: unknown) => {
    const { status } = toApiError(failure);
    setActionError({ message: describeError(failure), canReload: status === 409 });
  };

  return (
    <Page title={`#${ticket.number} ${ticket.title}`}>
      <StaleNotice failed={ticketQuery.isRefetchError} updatedAt={ticketQuery.dataUpdatedAt} />
      <p role="status" className={status ? 'rounded-md bg-slate-200 p-2' : 'sr-only'}>
        {status}
      </p>
      {actionError && <ReloadableError error={actionError} onReload={() => void reload()} />}

      <section aria-label="Situação do ticket" className="card space-y-4">
        <p ref={statusRef} tabIndex={-1} className="text-lg font-semibold outline-none">
          Status: {statusLabel(ticket.status, user.role)}
        </p>
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted">Solicitante</dt>
            <dd>{ticket.requester.name}</dd>
          </div>
          <div>
            <dt className="text-muted">Responsável</dt>
            <dd>{ticket.assignee?.name ?? 'Sem responsável'}</dd>
          </div>
          <div>
            <dt className="text-muted">Aberto em</dt>
            <dd>
              <time dateTime={ticket.createdAt}>{formatDateTime(ticket.createdAt)}</time>
            </dd>
          </div>
          {!isStaff && (
            <div>
              <dt className="text-muted">Prioridade</dt>
              <dd>{PRIORITY_LABELS[ticket.priority]}</dd>
            </div>
          )}
        </dl>
        {ticket.sla && <SlaPanel sla={ticket.sla} receivedAt={receivedAt} />}
        {isStaff && (
          <StaffControls
            ticket={ticket}
            user={user}
            onSaved={(updated, message) => {
              if (session.getUserId() !== user.id) return;
              setActionError(null);
              client.setQueryData(keys.ticket(user, id), updated);
              setNotice(message);
            }}
            onError={staffError}
          />
        )}
        {ticket.allowedTransitions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {ticket.allowedTransitions.map((to) => (
              <button
                key={to}
                type="button"
                className="btn"
                disabled={writing}
                onClick={() => transition.mutate(to)}
              >
                {transitionLabel(ticket.status, to)}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-muted">Nenhuma ação disponível neste status.</p>
        )}
        {user.role === 'CUSTOMER' && <ReopenHint ticket={ticket} />}
      </section>

      <section aria-labelledby="ticket-description" className="card space-y-2">
        <h2 id="ticket-description" className="text-lg font-semibold">
          Descrição
        </h2>
        <p className="break-words whitespace-pre-wrap">{ticket.description}</p>
      </section>

      <section aria-labelledby="ticket-comments" className="card space-y-4">
        <h2 id="ticket-comments" className="text-lg font-semibold">
          Comentários
        </h2>
        {commentsQuery.isPending && <Loading />}
        {commentsQuery.isError && !commentsQuery.data && (
          <QueryError error={commentsQuery.error} onRetry={() => void commentsQuery.refetch()} />
        )}
        {commentsQuery.data && <CommentList comments={commentsQuery.data} />}
        {ticket.status === 'CLOSED' ? (
          <p className="text-muted">Este ticket está fechado e não aceita comentários.</p>
        ) : (
          <CommentForm ticket={ticket} user={user} onSent={afterComment} onReload={reload} />
        )}
      </section>
    </Page>
  );
}

export function TicketPage() {
  const { id } = useParams();
  const user = useUser();
  // Id malformado dá 400 na API; para quem usa, é só um ticket que não existe.
  if (!id || !UUID.test(id)) {
    return (
      <Page title="Ticket não encontrado">
        <NotFoundView />
      </Page>
    );
  }
  // A chave reinicia o rascunho e os avisos ao navegar de um ticket para outro.
  return <TicketContent key={id} id={id} user={user} />;
}
