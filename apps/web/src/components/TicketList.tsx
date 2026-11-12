import type { Paginated, Role, TicketSummary } from '@support-flow/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { PRIORITY_LABELS, statusLabel } from '../lib/labels';
import { keys, REFETCH_MS } from '../lib/queries';
import { useUser } from '../lib/useSession';
import { QueueSlaBadge } from './SlaBadge';
import { EmptyState, Loading, QueryError, StaleNotice } from './States';

function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav aria-label="Paginação" className="flex flex-wrap items-center justify-between gap-3">
      <button type="button" className="btn" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Página anterior
      </button>
      <span>
        Página {page} de {pages}
      </span>
      <button
        type="button"
        className="btn"
        disabled={page >= pages}
        onClick={() => onChange(page + 1)}
      >
        Próxima página
      </button>
    </nav>
  );
}

function TicketTable({
  tickets,
  role,
  receivedAt,
}: {
  tickets: TicketSummary[];
  role: Role;
  receivedAt: number;
}) {
  const isStaff = role !== 'CUSTOMER';
  const head = 'px-3 py-2 text-left text-sm font-semibold';
  const cell = 'px-3 py-2 align-top';
  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full border-collapse">
        <caption className="sr-only">Tickets</caption>
        <thead className="border-b border-gray-300">
          <tr>
            <th scope="col" className={head}>
              Ticket
            </th>
            <th scope="col" className={head}>
              Status
            </th>
            <th scope="col" className={head}>
              Prioridade
            </th>
            {isStaff && (
              <>
                <th scope="col" className={head}>
                  SLA
                </th>
                <th scope="col" className={head}>
                  Responsável
                </th>
              </>
            )}
            <th scope="col" className={head}>
              Aberto em
            </th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket) => (
            <tr key={ticket.id} className="border-b border-gray-200 last:border-0">
              <td className={cell}>
                <Link className="link" to={`/tickets/${ticket.id}`}>
                  #{ticket.number} {ticket.title}
                </Link>
              </td>
              <td className={cell}>{statusLabel(ticket.status, role)}</td>
              <td className={cell}>{PRIORITY_LABELS[ticket.priority]}</td>
              {isStaff && (
                <>
                  <td className={cell}>
                    {ticket.sla && <QueueSlaBadge sla={ticket.sla} receivedAt={receivedAt} />}
                  </td>
                  <td className={cell}>{ticket.assignee?.name ?? 'Sem responsável'}</td>
                </>
              )}
              <td className={`${cell} whitespace-nowrap`}>
                <time dateTime={ticket.createdAt}>{formatDateTime(ticket.createdAt)}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const countLabel = (total: number) => (total === 1 ? '1 ticket' : `${total} tickets`);

/** Consulta, estados, tabela e paginação; quem usa só define os parâmetros e o vazio. */
export function TicketList({
  params,
  empty,
  onPageChange,
}: {
  params: string;
  empty: ReactNode;
  onPageChange: (page: number) => void;
}) {
  const user = useUser();
  const results = useRef<HTMLDivElement>(null);
  const query = useQuery({
    queryKey: keys.tickets(user, params),
    // O instante vai junto dos dados: com keepPreviousData, `dataUpdatedAt` vale 0 enquanto
    // a página anterior está na tela, e a contagem do SLA viraria um Violado falso.
    queryFn: async () => ({
      ...(await api<Paginated<TicketSummary>>(`/tickets?${params}`)),
      receivedAt: Date.now(),
    }),
    placeholderData: keepPreviousData,
    refetchInterval: REFETCH_MS,
  });

  if (query.isPending) return <Loading />;
  if (query.isError && !query.data) {
    return <QueryError error={query.error} onRetry={() => void query.refetch()} />;
  }
  const { items, page, pageSize, total, receivedAt } = query.data;

  const changePage = (next: number) => {
    onPageChange(next);
    results.current?.focus();
  };

  return (
    <div ref={results} tabIndex={-1} className="space-y-3 outline-none">
      <StaleNotice failed={query.isRefetchError} updatedAt={query.dataUpdatedAt} />
      <p role="status" className="text-sm text-muted">
        {countLabel(total)}
      </p>
      {items.length === 0 && total === 0 && empty}
      {items.length === 0 && total > 0 && (
        <EmptyState>
          <p>Esta página não existe mais.</p>
          <button
            type="button"
            className="btn"
            onClick={() => changePage(Math.ceil(total / pageSize))}
          >
            Ir para a última página
          </button>
        </EmptyState>
      )}
      {items.length > 0 && <TicketTable tickets={items} role={user.role} receivedAt={receivedAt} />}
      {items.length > 0 && (
        <Pagination page={page} pageSize={pageSize} total={total} onChange={changePage} />
      )}
    </div>
  );
}
