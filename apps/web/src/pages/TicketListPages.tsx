import { Priority, TicketStatus, type TicketDetail } from '@support-flow/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { TextAreaField, TextField } from '../components/Fields';
import { Page } from '../components/Page';
import { EmptyState, FormAlert } from '../components/States';
import { TicketList } from '../components/TicketList';
import { api } from '../lib/api';
import { describeError, fieldErrors } from '../lib/errors';
import { PRIORITY_LABELS, SLA_LABELS, statusLabel } from '../lib/labels';
import { keys } from '../lib/queries';
import { session } from '../lib/session';
import { readPage, readQueueQuery, toApiParams, type QueueFilter } from '../lib/queueFilters';
import { useFocusFirstInvalid } from '../lib/useFocusFirstInvalid';
import { useUser } from '../lib/useSession';

export function MyTicketsPage() {
  const [search, setSearch] = useSearchParams();
  const page = readPage(search);
  return (
    <Page
      title="Meus tickets"
      actions={
        <Link className="btn btn-primary" to="/tickets/novo">
          Novo ticket
        </Link>
      }
    >
      <TicketList
        params={`page=${page}`}
        onPageChange={(next) => setSearch({ page: String(next) })}
        empty={
          <EmptyState>
            <p>Você ainda não abriu nenhum ticket.</p>
            <Link className="link" to="/tickets/novo">
              Abrir o primeiro ticket
            </Link>
          </EmptyState>
        }
      />
    </Page>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="block font-medium">{label}</span>
      <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Todos</option>
        {options.map(([optionValue, text]) => (
          <option key={optionValue} value={optionValue}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

export function QueuePage() {
  const user = useUser();
  const [search, setSearch] = useSearchParams();
  const query = useMemo(() => readQueueQuery(search), [search]);
  const hasFilters = Object.keys(query.filters).length > 0;

  const setFilter = (name: QueueFilter, value: string) => {
    const next = new URLSearchParams(query.filters);
    if (value) next.set(name, value);
    else next.delete(name);
    setSearch(next);
  };

  return (
    <Page title="Fila de tickets">
      <div className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FilterSelect
          label="Status"
          value={query.filters.status}
          options={Object.values(TicketStatus).map((s) => [s, statusLabel(s, user.role)])}
          onChange={(value) => setFilter('status', value)}
        />
        <FilterSelect
          label="Prioridade"
          value={query.filters.priority}
          options={Object.values(Priority).map((p) => [p, PRIORITY_LABELS[p]])}
          onChange={(value) => setFilter('priority', value)}
        />
        <FilterSelect
          label="SLA"
          value={query.filters.sla}
          options={[
            ['AT_RISK', SLA_LABELS.AT_RISK],
            ['BREACHED', SLA_LABELS.BREACHED],
          ]}
          onChange={(value) => setFilter('sla', value)}
        />
        <FilterSelect
          label="Responsável"
          value={query.filters.assigneeId}
          options={[
            ['me', 'Atribuídos a mim'],
            ['none', 'Sem responsável'],
          ]}
          onChange={(value) => setFilter('assigneeId', value)}
        />
      </div>
      <TicketList
        params={toApiParams(query)}
        onPageChange={(page) => {
          const next = new URLSearchParams(query.filters);
          next.set('page', String(page));
          setSearch(next);
        }}
        empty={
          hasFilters ? (
            <EmptyState>
              <p>Nenhum ticket com esses filtros.</p>
              <button type="button" className="btn" onClick={() => setSearch({})}>
                Limpar filtros
              </button>
            </EmptyState>
          ) : (
            <EmptyState>
              <p>A fila está vazia. Novos tickets aparecem aqui.</p>
            </EmptyState>
          )
        }
      />
    </Page>
  );
}

type NewTicketErrors = Partial<Record<'title' | 'description', string>>;

export function NewTicketPage() {
  const user = useUser();
  const client = useQueryClient();
  const navigate = useNavigate();
  const form = useRef<HTMLFormElement>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<NewTicketErrors>({});
  useFocusFirstInvalid(form, errors);

  const mutation = useMutation({
    mutationFn: () =>
      api<TicketDetail>('/tickets', { method: 'POST', body: { title, description } }),
    onSuccess: (ticket) => {
      if (session.getUserId() !== user.id) return;
      client.setQueryData(keys.ticket(user, ticket.id), ticket);
      void navigate(`/tickets/${ticket.id}`);
    },
    onError: (error) => {
      setErrors(
        fieldErrors(error, {
          title: 'Informe um título de até 200 caracteres.',
          description: 'Descreva o problema em até 10.000 caracteres.',
        }),
      );
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const local: NewTicketErrors = {};
    if (!title.trim()) local.title = 'Informe um título.';
    if (!description.trim()) local.description = 'Descreva o problema.';
    setErrors(local);
    if (Object.keys(local).length === 0) mutation.mutate();
  };

  return (
    <Page title="Novo ticket">
      <form ref={form} noValidate className="card max-w-2xl space-y-4" onSubmit={submit}>
        <FormAlert message={mutation.isError ? describeError(mutation.error) : null} />
        <TextField
          label="Título"
          maxLength={200}
          value={title}
          error={errors.title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <TextAreaField
          label="Descrição"
          maxLength={10_000}
          value={description}
          error={errors.description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
          {mutation.isPending ? 'Enviando…' : 'Abrir ticket'}
        </button>
      </form>
    </Page>
  );
}
