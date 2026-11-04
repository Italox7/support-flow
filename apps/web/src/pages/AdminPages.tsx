import { Priority, type AgentSummary, type SlaPolicyDto } from '@support-flow/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { PasswordField, TextField } from '../components/Fields';
import { Page } from '../components/Page';
import { EmptyState, FormAlert, Loading, QueryError } from '../components/States';
import { api } from '../lib/api';
import { describeError, fieldErrors, toApiError } from '../lib/errors';
import { PRIORITY_LABELS } from '../lib/labels';
import { keys } from '../lib/queries';
import { useFocusFirstInvalid } from '../lib/useFocusFirstInvalid';
import { useUser } from '../lib/useSession';
import { PASSWORD_MIN } from './AuthPages';

type AgentErrors = Partial<Record<'name' | 'email' | 'password', string>>;

function NewAgentForm() {
  const user = useUser();
  const client = useQueryClient();
  const form = useRef<HTMLFormElement>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<AgentErrors>({});
  const [created, setCreated] = useState('');
  useFocusFirstInvalid(form, errors);

  const mutation = useMutation({
    mutationFn: () =>
      api<AgentSummary>('/users/agents', { method: 'POST', body: { name, email, password } }),
    onSuccess: (agent) => {
      setName('');
      setEmail('');
      setPassword('');
      setCreated(`Agente ${agent.name} criado. Ele começa indisponível.`);
      void client.invalidateQueries({ queryKey: keys.agents(user) });
    },
    onError: (error) => {
      setCreated('');
      if (toApiError(error).status === 409) {
        setErrors({ email: 'Já existe uma conta com este e-mail.' });
        return;
      }
      setErrors(
        fieldErrors(error, {
          name: 'Informe um nome de até 100 caracteres.',
          email: 'Informe um e-mail válido.',
          password: `A senha precisa ter de ${PASSWORD_MIN} a 128 caracteres.`,
        }),
      );
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const local: AgentErrors = {};
    if (!name.trim()) local.name = 'Informe o nome.';
    if (!email.trim()) local.email = 'Informe o e-mail.';
    if (password.length < PASSWORD_MIN) {
      local.password = `A senha precisa de pelo menos ${PASSWORD_MIN} caracteres.`;
    }
    setErrors(local);
    setCreated('');
    if (Object.keys(local).length === 0) mutation.mutate();
  };

  const conflictOrField = mutation.isError && toApiError(mutation.error).status === 409;

  return (
    <section aria-labelledby="new-agent" className="card max-w-2xl space-y-4">
      <h2 id="new-agent" className="text-lg font-semibold">
        Criar agente
      </h2>
      <p role="status" className={created ? 'rounded-md bg-slate-200 p-2' : 'sr-only'}>
        {created}
      </p>
      <FormAlert
        message={
          mutation.isError && !conflictOrField && Object.keys(errors).length === 0
            ? describeError(mutation.error)
            : null
        }
      />
      <form ref={form} noValidate className="space-y-4" onSubmit={submit}>
        <TextField
          label="Nome"
          autoComplete="off"
          maxLength={100}
          value={name}
          error={errors.name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label="E-mail"
          type="email"
          autoComplete="off"
          value={email}
          error={errors.email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <PasswordField
          label="Senha inicial"
          autoComplete="new-password"
          maxLength={128}
          hint={`Pelo menos ${PASSWORD_MIN} caracteres. Informe ao agente por um canal externo: esta demonstração ainda não tem troca de senha, e a senha não volta a aparecer aqui.`}
          value={password}
          error={errors.password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
          {mutation.isPending ? 'Criando…' : 'Criar agente'}
        </button>
      </form>
    </section>
  );
}

export function AgentsPage() {
  const user = useUser();
  const query = useQuery({
    queryKey: keys.agents(user),
    queryFn: () => api<AgentSummary[]>('/users/agents'),
  });
  const head = 'px-3 py-2 text-left text-sm font-semibold';
  const cell = 'px-3 py-2';

  return (
    <Page title="Agentes">
      {query.isPending && <Loading />}
      {query.isError && !query.data && (
        <QueryError error={query.error} onRetry={() => void query.refetch()} />
      )}
      {query.data?.length === 0 && (
        <EmptyState>
          <p>Nenhum agente cadastrado. Crie o primeiro abaixo.</p>
        </EmptyState>
      )}
      {query.data && query.data.length > 0 && (
        <div className="card overflow-x-auto p-0">
          <table className="w-full border-collapse">
            <caption className="sr-only">Agentes</caption>
            <thead className="border-b border-gray-300">
              <tr>
                <th scope="col" className={head}>
                  Nome
                </th>
                <th scope="col" className={head}>
                  E-mail
                </th>
                <th scope="col" className={head}>
                  Situação
                </th>
                <th scope="col" className={head}>
                  Tickets em aberto
                </th>
              </tr>
            </thead>
            <tbody>
              {query.data.map((agent) => (
                <tr key={agent.id} className="border-b border-gray-200 last:border-0">
                  <td className={cell}>{agent.name}</td>
                  <td className={cell}>{agent.email}</td>
                  <td className={cell}>{agent.isAvailable ? 'Disponível' : 'Indisponível'}</td>
                  <td className={cell}>{agent.openTickets}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <NewAgentForm />
    </Page>
  );
}

function PolicyForm({ policy }: { policy: SlaPolicyDto }) {
  const user = useUser();
  const client = useQueryClient();
  const form = useRef<HTMLFormElement>(null);
  const [first, setFirst] = useState(String(policy.firstResponseMinutes));
  const [resolution, setResolution] = useState(String(policy.resolutionMinutes));
  const [saved, setSaved] = useState('');
  const [errors, setErrors] = useState<
    Partial<Record<'firstResponseMinutes' | 'resolutionMinutes', string>>
  >({});
  useFocusFirstInvalid(form, errors);
  const label = PRIORITY_LABELS[policy.priority];

  const mutation = useMutation({
    mutationFn: () =>
      api<SlaPolicyDto>(`/sla-policies/${policy.priority}`, {
        method: 'PUT',
        body: { firstResponseMinutes: Number(first), resolutionMinutes: Number(resolution) },
      }),
    onSuccess: () => {
      setErrors({});
      setSaved(
        `Prazos da prioridade ${label} salvos. Valem para tickets novos e trocas de prioridade.`,
      );
      void client.invalidateQueries({ queryKey: keys.slaPolicies(user) });
    },
    onError: (error) => {
      setSaved('');
      const message = 'Informe um número inteiro de minutos, de 1 a 43.200 (30 dias).';
      setErrors(fieldErrors(error, { firstResponseMinutes: message, resolutionMinutes: message }));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved('');
    mutation.mutate();
  };

  return (
    <form ref={form} noValidate className="card space-y-3" onSubmit={submit}>
      <h2 className="text-lg font-semibold">{label}</h2>
      <p role="status" className={saved ? 'rounded-md bg-slate-200 p-2' : 'sr-only'}>
        {saved}
      </p>
      <FormAlert
        message={
          mutation.isError && Object.keys(errors).length === 0
            ? describeError(mutation.error)
            : null
        }
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="1ª resposta (minutos)"
          inputMode="numeric"
          value={first}
          error={errors.firstResponseMinutes}
          onChange={(e) => setFirst(e.target.value)}
        />
        <TextField
          label="Resolução (minutos)"
          inputMode="numeric"
          value={resolution}
          error={errors.resolutionMinutes}
          onChange={(e) => setResolution(e.target.value)}
        />
      </div>
      <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
        {mutation.isPending ? 'Salvando…' : `Salvar prioridade ${label}`}
      </button>
    </form>
  );
}

const ORDER = Object.values(Priority);

export function SlaPoliciesPage() {
  const user = useUser();
  const query = useQuery({
    queryKey: keys.slaPolicies(user),
    queryFn: () => api<SlaPolicyDto[]>('/sla-policies'),
  });
  const policies = query.data
    ? [...query.data].sort((a, b) => ORDER.indexOf(a.priority) - ORDER.indexOf(b.priority))
    : [];

  return (
    <Page title="Prazos de SLA">
      <p className="text-muted">
        Editar um prazo vale para tickets novos e para trocas de prioridade. Os tickets que já
        existem mantêm os prazos deles.
      </p>
      {query.isPending && <Loading />}
      {query.isError && !query.data && (
        <QueryError error={query.error} onRetry={() => void query.refetch()} />
      )}
      {policies.map((policy) => (
        <PolicyForm key={policy.priority} policy={policy} />
      ))}
    </Page>
  );
}
