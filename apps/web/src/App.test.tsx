import type { AuthUser, TicketDetail, TicketSummary } from '@support-flow/shared';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, type InitialEntry } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { loadDraft, saveDraft } from './lib/drafts';
import { session } from './lib/session';

const CUSTOMER: AuthUser = { id: 'c1', email: 'c@x.dev', name: 'Clara', role: 'CUSTOMER' };
const AGENT: AuthUser = { id: 'a1', email: 'a@x.dev', name: 'Ari', role: 'AGENT' };
const ADMIN: AuthUser = { id: 'd1', email: 'd@x.dev', name: 'Dora', role: 'ADMIN' };
const TICKET_ID = '11111111-1111-4111-8111-111111111111';

const clock = (state: TicketSummary['status'] | string, remainingSeconds = 720) => ({
  state,
  remainingSeconds,
  dueAt: '2026-11-05T12:00:00.000Z',
});

function summary(overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: TICKET_ID,
    number: 7,
    title: 'Impressora parada',
    status: 'IN_PROGRESS',
    priority: 'HIGH',
    requester: { id: 'c1', name: 'Clara' },
    assignee: { id: 'a1', name: 'Ari' },
    createdAt: '2026-11-04T10:00:00.000Z',
    updatedAt: '2026-11-04T10:00:00.000Z',
    ...overrides,
  };
}

function detail(overrides: Partial<TicketDetail> = {}): TicketDetail {
  return {
    ...summary(),
    description: 'Não imprime desde ontem.',
    firstResponseAt: null,
    resolvedAt: null,
    closedAt: null,
    allowedTransitions: [],
    ...overrides,
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const hashBusy = () =>
  json({ code: 'PASSWORD_HASH_BUSY', message: 'ocupado' }, 503, { 'Retry-After': '2' });

type Handler = (init: RequestInit) => Response;

/** API falsa, sem MSW: "MÉTODO /caminho" → resposta. O que não estiver aqui falha o teste. */
function stubApi(user: AuthUser | null, routes: Record<string, Handler | Response>) {
  const calls: { key: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${input.replace(/^\/api/, '')}`;
    calls.push({ key, init });
    const route = routes[key];
    if (route) return typeof route === 'function' ? route(init) : route.clone();
    if (key === 'POST /auth/refresh') {
      return user ? json({ accessToken: 'token', user }) : json({}, 401);
    }
    if (key === 'GET /users/me/availability') return json({ isAvailable: true });
    throw new Error(`rota não prevista no teste: ${key}`);
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}

async function renderAt(entry: InitialEntry) {
  await act(() => session.bootstrap());
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const type = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } });

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sessão e rotas', () => {
  it('sem sessão, manda para /entrar sem falar em expiração', async () => {
    stubApi(null, {});
    await renderAt('/fila');

    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    expect(screen.queryByText(/sessão expirou/)).not.toBeInTheDocument();
  });

  it('API fora do ar ao abrir mostra erro com Tentar de novo e não a tela de login', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('rede')));
    await renderAt('/fila');

    expect(await screen.findByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Entrar' })).not.toBeInTheDocument();
  });

  it('login leva ao destino guardado', async () => {
    stubApi(null, {
      'POST /auth/login': json({ accessToken: 'token', user: AGENT }),
      'GET /tickets?page=1': json({ items: [], page: 1, pageSize: 20, total: 0 }),
    });
    await renderAt({ pathname: '/entrar', state: { from: '/fila' } });

    type(await screen.findByLabelText('E-mail'), 'a@x.dev');
    type(screen.getByLabelText('Senha'), 'senha-forte');
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(await screen.findByRole('heading', { name: 'Fila de tickets' })).toBeInTheDocument();
  });

  it('destino externo no estado da rota cai no início, não em outro site', async () => {
    stubApi(CUSTOMER, {
      'GET /tickets?page=1': json({ items: [], page: 1, pageSize: 20, total: 0 }),
    });
    await renderAt({ pathname: '/entrar', state: { from: '//mau.example' } });

    expect(await screen.findByRole('heading', { name: 'Meus tickets' })).toBeInTheDocument();
  });

  it('credenciais erradas ficam na tela com o texto digitado', async () => {
    stubApi(null, { 'POST /auth/login': json({ message: 'Unauthorized' }, 401) });
    await renderAt('/entrar');

    const email = await screen.findByLabelText('E-mail');
    type(email, 'a@x.dev');
    type(screen.getByLabelText('Senha'), 'errada');
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou senha incorretos.');
    expect(email).toHaveValue('a@x.dev');
  });

  it('login vazio aponta o campo e leva o foco a ele', async () => {
    stubApi(null, {});
    await renderAt('/entrar');

    fireEvent.click(await screen.findByRole('button', { name: 'Entrar' }));

    const email = await screen.findByLabelText('E-mail');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveFocus();
  });

  it('sessão que expira mostra o aviso, guarda o destino e mantém o rascunho', async () => {
    let expired = false;
    stubApi(CUSTOMER, {
      [`GET /tickets/${TICKET_ID}`]: () => json(detail()),
      [`GET /tickets/${TICKET_ID}/comments`]: () => json([]),
      [`POST /tickets/${TICKET_ID}/comments`]: () => {
        expired = true;
        return json({}, 401);
      },
      'POST /auth/refresh': () =>
        expired ? json({}, 401) : json({ accessToken: 'token', user: CUSTOMER }),
    });
    await renderAt(`/tickets/${TICKET_ID}`);

    type(await screen.findByLabelText('Comentário'), 'Texto importante');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Sua sessão expirou');
    expect(loadDraft('c1', TICKET_ID).text).toBe('Texto importante');
  });

  describe('destino de sessão expirada', () => {
    const OTHER: AuthUser = { id: 'c2', email: 'b@x.dev', name: 'Bia', role: 'CUSTOMER' };
    const emptyPage = () => json({ items: [], page: 1, pageSize: 20, total: 0 });

    /** A admin está em /admin/sla quando a sessão dela expira. */
    async function expireAdminOnSla(routes: Record<string, Handler>) {
      let expired = false;
      stubApi(ADMIN, {
        'GET /sla-policies': () => {
          expired = true;
          return json({}, 401);
        },
        'POST /auth/refresh': () =>
          expired ? json({}, 401) : json({ accessToken: 'token', user: ADMIN }),
        'GET /tickets?page=1': emptyPage,
        ...routes,
      });
      await renderAt('/admin/sla');
      expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('Sua sessão expirou');
    }

    function submitLogin(email: string) {
      type(screen.getByLabelText('E-mail'), email);
      type(screen.getByLabelText('Senha'), 'senha-forte');
      fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    }

    it('outra pessoa entrando nesta aba vai para a própria tela inicial', async () => {
      await expireAdminOnSla({
        'POST /auth/login': () => json({ accessToken: 'token-b', user: OTHER }),
      });

      submitLogin('b@x.dev');

      expect(await screen.findByRole('heading', { name: 'Meus tickets' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Sem acesso' })).not.toBeInTheDocument();
    });

    it('outra pessoa entrando em outra aba também não herda o destino', async () => {
      await expireAdminOnSla({});

      // O aviso user-changed faz a aba rodar o bootstrap com o cookie novo.
      stubApi(OTHER, { 'GET /tickets?page=1': emptyPage });
      await act(() => session.bootstrap());

      expect(await screen.findByRole('heading', { name: 'Meus tickets' })).toBeInTheDocument();
    });

    it.each([null, 123, { id: 'c1' }, 'd1'])(
      'dono %j que não é quem entrou leva ao início, não ao destino',
      async (owner) => {
        stubApi(CUSTOMER, { 'GET /tickets?page=1': emptyPage });
        await renderAt({ pathname: '/entrar', state: { from: '/fila', owner } });

        expect(await screen.findByRole('heading', { name: 'Meus tickets' })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Sem acesso' })).not.toBeInTheDocument();
      },
    );

    it('a mesma pessoa voltando a entrar volta ao destino', async () => {
      await expireAdminOnSla({});
      // Depois do login, a tela de SLA carrega de novo.
      stubApi(ADMIN, {
        'POST /auth/login': json({ accessToken: 'token-2', user: ADMIN }),
        'GET /sla-policies': json([]),
      });

      submitLogin('d@x.dev');

      expect(await screen.findByRole('heading', { name: 'Prazos de SLA' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Entrar' })).not.toBeInTheDocument();
    });
  });

  it('sair leva a /entrar sem aviso de expiração', async () => {
    stubApi(CUSTOMER, {
      'GET /tickets?page=1': json({ items: [], page: 1, pageSize: 20, total: 0 }),
      'POST /auth/logout': () => new Response(null, { status: 204 }),
    });
    await renderAt('/meus-tickets');

    fireEvent.click(await screen.findByRole('button', { name: 'Sair' }));

    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    expect(screen.queryByText(/sessão expirou/)).not.toBeInTheDocument();
  });

  it('logout que falha avisa e mantém a pessoa logada', async () => {
    stubApi(CUSTOMER, {
      'GET /tickets?page=1': json({ items: [], page: 1, pageSize: 20, total: 0 }),
      'POST /auth/logout': json({}, 500),
    });
    await renderAt('/meus-tickets');

    fireEvent.click(await screen.findByRole('button', { name: 'Sair' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível sair');
    expect(screen.getByRole('heading', { name: 'Meus tickets' })).toBeInTheDocument();
  });

  it('cada papel cai na própria tela inicial e só o cliente vê Novo ticket', async () => {
    stubApi(AGENT, {
      'GET /tickets?page=1': json({ items: [], page: 1, pageSize: 20, total: 0 }),
    });
    await renderAt('/');

    expect(await screen.findByRole('heading', { name: 'Fila de tickets' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Novo ticket' })).not.toBeInTheDocument();
  });

  it('papel errado vê Sem acesso, não uma tela vazia', async () => {
    stubApi(CUSTOMER, {});
    await renderAt('/admin/agentes');

    expect(await screen.findByText('Você não tem acesso a esta tela.')).toBeInTheDocument();
  });

  it('rota nova leva o foco ao título e troca o título da página', async () => {
    stubApi(CUSTOMER, {
      'GET /tickets?page=1': json({ items: [], page: 1, pageSize: 20, total: 0 }),
    });
    await renderAt('/meus-tickets');

    const heading = await screen.findByRole('heading', { name: 'Meus tickets' });
    expect(heading).toHaveFocus();
    expect(document.title).toBe('Meus tickets | Support Flow');
  });
});

describe('listas', () => {
  it('cliente: sem coluna de SLA, sem filtro de SLA na chamada e com rótulo próprio', async () => {
    const calls = stubApi(CUSTOMER, {
      'GET /tickets?page=1': json({
        items: [summary({ status: 'WAITING_CUSTOMER' })],
        page: 1,
        pageSize: 20,
        total: 1,
      }),
    });
    await renderAt('/meus-tickets');

    expect(await screen.findByRole('link', { name: '#7 Impressora parada' })).toBeInTheDocument();
    expect(screen.getByText('Aguardando você')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'SLA' })).not.toBeInTheDocument();
    expect(calls.some(({ key }) => key.includes('sla='))).toBe(false);
  });

  it('cliente sem tickets vê o vazio próprio', async () => {
    stubApi(CUSTOMER, {
      'GET /tickets?page=1': json({ items: [], page: 1, pageSize: 20, total: 0 }),
    });
    await renderAt('/meus-tickets');

    expect(await screen.findByText('Você ainda não abriu nenhum ticket.')).toBeInTheDocument();
  });

  it('fila: um badge à vista e os dois relógios no texto acessível', async () => {
    stubApi(AGENT, {
      'GET /tickets?page=1': json({
        items: [
          summary({
            sla: {
              firstResponse: clock('AT_RISK', 720) as never,
              resolution: clock('OK', 7200) as never,
            },
          }),
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      }),
    });
    await renderAt('/fila');

    await screen.findByRole('link', { name: '#7 Impressora parada' });
    const row = screen.getAllByRole('row')[1] as HTMLElement;
    expect(within(row).getByText('Em risco')).toBeInTheDocument();
    expect(within(row).queryByText('No prazo')).not.toBeInTheDocument();
    expect(
      within(row).getByText(
        'Primeira resposta: Em risco, vence em 12 min. Resolução: No prazo, vence em 2 h.',
      ),
    ).toBeInTheDocument();
    // A contagem visual fica fora da árvore de acessibilidade: nada é anunciado a cada tick.
    expect(within(row).getByText('Em risco').closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('valor inválido na URL é ignorado, sem virar 400', async () => {
    const calls = stubApi(AGENT, {
      'GET /tickets?status=OPEN&page=1': json({ items: [], page: 1, pageSize: 20, total: 0 }),
    });
    await renderAt('/fila?status=OPEN&sla=QUALQUER&priority=x&page=abc&extra=1');

    expect(await screen.findByText('Nenhum ticket com esses filtros.')).toBeInTheDocument();
    expect(calls.map(({ key }) => key)).toContain('GET /tickets?status=OPEN&page=1');
  });

  it('filtro muda a chamada e Limpar filtros volta à fila inteira', async () => {
    stubApi(AGENT, {
      'GET /tickets?page=1': json({ items: [], page: 1, pageSize: 20, total: 0 }),
      'GET /tickets?sla=BREACHED&page=1': json({ items: [], page: 1, pageSize: 20, total: 0 }),
    });
    await renderAt('/fila');
    expect(await screen.findByText(/A fila está vazia/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('SLA'), { target: { value: 'BREACHED' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Limpar filtros' }));

    expect(await screen.findByText(/A fila está vazia/)).toBeInTheDocument();
  });

  it('erro da lista mostra Tentar de novo, e tentar de novo busca outra vez', async () => {
    let attempts = 0;
    stubApi(AGENT, {
      'GET /tickets?page=1': () => {
        attempts += 1;
        return attempts === 1
          ? json({}, 500)
          : json({ items: [], page: 1, pageSize: 20, total: 0 });
      },
    });
    await renderAt('/fila');

    fireEvent.click(await screen.findByRole('button', { name: 'Tentar de novo' }));

    expect(await screen.findByText(/A fila está vazia/)).toBeInTheDocument();
  });

  it('paginação diz a página atual', async () => {
    stubApi(AGENT, {
      'GET /tickets?page=2': json({ items: [summary()], page: 2, pageSize: 20, total: 41 }),
    });
    await renderAt('/fila?page=2');

    expect(await screen.findByText('Página 2 de 3')).toHaveAttribute('aria-current', 'page');
  });

  it('o agente indisponível vê o aviso e a chave diz o estado em texto', async () => {
    stubApi(AGENT, {
      'GET /tickets?page=1': json({ items: [], page: 1, pageSize: 20, total: 0 }),
      'GET /users/me/availability': json({ isAvailable: false }),
      'PATCH /users/me/availability': json({ isAvailable: true }),
    });
    await renderAt('/fila');

    expect(await screen.findByText(/Você está indisponível: mantém/)).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: 'Disponível para receber tickets' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(screen.queryByText(/Você está indisponível: mantém/)).not.toBeInTheDocument();
    expect(screen.getByText(/Tickets sem responsável podem ser atribuídos/)).toBeInTheDocument();
  });

  it('erro na chave mantém o estado anterior e explica', async () => {
    stubApi(AGENT, {
      'GET /tickets?page=1': json({ items: [], page: 1, pageSize: 20, total: 0 }),
      'PATCH /users/me/availability': json({}, 429),
    });
    await renderAt('/fila');

    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(toggle);

    expect(await screen.findByRole('alert')).toHaveTextContent('Aguarde alguns minutos');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('admin não tem chave de disponibilidade', async () => {
    stubApi(ADMIN, {
      'GET /tickets?page=1': json({ items: [], page: 1, pageSize: 20, total: 0 }),
    });
    await renderAt('/fila');

    await screen.findByRole('heading', { name: 'Fila de tickets' });
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});

describe('ticket', () => {
  const routesFor = (ticket: TicketDetail, extra: Record<string, Handler | Response> = {}) => ({
    [`GET /tickets/${ticket.id}`]: () => json(ticket),
    [`GET /tickets/${ticket.id}/comments`]: () => json([]),
    ...extra,
  });

  it.each([404])('%i mostra a mesma tela de não encontrado', async (status) => {
    stubApi(CUSTOMER, {
      [`GET /tickets/${TICKET_ID}`]: json({}, status),
      [`GET /tickets/${TICKET_ID}/comments`]: json({}, status),
    });
    await renderAt(`/tickets/${TICKET_ID}`);

    expect(await screen.findByText('Ticket ou página não encontrados.')).toBeInTheDocument();
  });

  it('id malformado é não encontrado, sem chamar a API', async () => {
    const calls = stubApi(CUSTOMER, {});
    await renderAt('/tickets/abc');

    expect(await screen.findByText('Ticket ou página não encontrados.')).toBeInTheDocument();
    expect(calls.some(({ key }) => key.startsWith('GET /tickets'))).toBe(false);
  });

  it('botões vêm de allowedTransitions; sem nenhum, explica', async () => {
    stubApi(AGENT, routesFor(detail({ allowedTransitions: ['WAITING_CUSTOMER', 'RESOLVED'] })));
    await renderAt(`/tickets/${TICKET_ID}`);

    expect(await screen.findByRole('button', { name: 'Aguardar cliente' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Marcar como resolvido' })).toBeInTheDocument();
    expect(screen.queryByText('Nenhuma ação disponível neste status.')).not.toBeInTheDocument();
  });

  it('sem transições, mostra a frase em vez de uma barra vazia', async () => {
    stubApi(AGENT, routesFor(detail({ status: 'RESOLVED' })));
    await renderAt(`/tickets/${TICKET_ID}`);

    expect(await screen.findByText('Nenhuma ação disponível neste status.')).toBeInTheDocument();
  });

  it('transição certa atualiza o status, avisa e leva o foco ao status', async () => {
    const updated = detail({ status: 'RESOLVED' });
    stubApi(
      AGENT,
      routesFor(detail({ allowedTransitions: ['RESOLVED'] }), {
        [`POST /tickets/${TICKET_ID}/transitions`]: () => json(updated),
      }),
    );
    await renderAt(`/tickets/${TICKET_ID}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Marcar como resolvido' }));

    expect(await screen.findByText('Status alterado para Resolvido.')).toBeInTheDocument();
    expect(screen.getByText('Status: Resolvido')).toHaveFocus();
  });

  it.each([
    [403, 'Você não pode mais fazer essa ação neste ticket.'],
    [409, 'O ticket mudou enquanto isso.'],
  ])('transição recusada com %i recarrega o ticket e explica', async (status, text) => {
    let reads = 0;
    stubApi(AGENT, {
      [`GET /tickets/${TICKET_ID}`]: () => {
        reads += 1;
        return json(detail({ allowedTransitions: reads === 1 ? ['RESOLVED'] : [] }));
      },
      [`GET /tickets/${TICKET_ID}/comments`]: () => json([]),
      [`POST /tickets/${TICKET_ID}/transitions`]: () =>
        json({ message: 'O ticket mudou enquanto isso.' }, status),
    });
    await renderAt(`/tickets/${TICKET_ID}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Marcar como resolvido' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(await screen.findByText('Nenhuma ação disponível neste status.')).toBeInTheDocument();
    expect(reads).toBe(2);
  });

  it.each([403, 409])(
    'transição recusada com %i e recarga falha não diz que atualizou e oferece Recarregar',
    async (status) => {
      let reads = 0;
      stubApi(AGENT, {
        [`GET /tickets/${TICKET_ID}`]: () => {
          reads += 1;
          if (reads === 2) return json({ message: 'falhou' }, 500);
          return json(detail({ allowedTransitions: reads === 1 ? ['RESOLVED'] : [] }));
        },
        [`GET /tickets/${TICKET_ID}/comments`]: () => json([]),
        [`POST /tickets/${TICKET_ID}/transitions`]: () =>
          json({ message: 'O ticket mudou enquanto isso.' }, status),
      });
      await renderAt(`/tickets/${TICKET_ID}`);

      fireEvent.click(await screen.findByRole('button', { name: 'Marcar como resolvido' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Não foi possível atualizar as ações agora.');
      expect(alert).not.toHaveTextContent('Atualizamos');
      expect(reads).toBe(2);

      fireEvent.click(within(alert).getByRole('button', { name: 'Recarregar ticket' }));

      expect(await screen.findByText('Nenhuma ação disponível neste status.')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    },
  );

  it('409 no comentário mantém o texto e oferece Recarregar ticket', async () => {
    let reads = 0;
    stubApi(CUSTOMER, {
      [`GET /tickets/${TICKET_ID}`]: () => {
        reads += 1;
        return json(detail());
      },
      [`GET /tickets/${TICKET_ID}/comments`]: () => json([]),
      [`POST /tickets/${TICKET_ID}/comments`]: () =>
        json({ message: 'Ticket fechado não aceita comentários.' }, 409),
    });
    await renderAt(`/tickets/${TICKET_ID}`);

    const field = await screen.findByLabelText('Comentário');
    type(field, 'Meu texto');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('não aceita comentários');
    expect(field).toHaveValue('Meu texto');

    const before = reads;
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar ticket' }));

    await screen.findByText('Ticket atualizado.');
    expect(reads).toBe(before + 1);
    expect(field).toHaveValue('Meu texto');
  });

  it.each([
    ['do ticket', `GET /tickets/${TICKET_ID}`],
    ['dos comentários', `GET /tickets/${TICKET_ID}/comments`],
  ])('Recarregar com a leitura %s falhando não diz que atualizou', async (_, failing) => {
    const reads: Record<string, number> = {};
    const once = (key: string, body: unknown) => () => {
      reads[key] = (reads[key] ?? 0) + 1;
      return key === failing && reads[key] > 1 ? json({ message: 'falhou' }, 500) : json(body);
    };
    stubApi(CUSTOMER, {
      [`GET /tickets/${TICKET_ID}`]: once(`GET /tickets/${TICKET_ID}`, detail()),
      [`GET /tickets/${TICKET_ID}/comments`]: once(`GET /tickets/${TICKET_ID}/comments`, []),
      [`POST /tickets/${TICKET_ID}/comments`]: () =>
        json({ message: 'Ticket fechado não aceita comentários.' }, 409),
    });
    await renderAt(`/tickets/${TICKET_ID}`);

    const field = await screen.findByLabelText('Comentário');
    type(field, 'Meu texto');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Recarregar ticket' }));

    expect(
      await screen.findByText('Não foi possível atualizar o ticket agora.'),
    ).toBeInTheDocument();
    expect(reads[failing]).toBe(2);
    expect(screen.queryByText('Ticket atualizado.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recarregar ticket' })).toBeInTheDocument();
    expect(field).toHaveValue('Meu texto');
  });

  it('comentário enviado com a leitura do ticket falhando não cala o status e oferece Recarregar', async () => {
    let status: TicketDetail['status'] = 'WAITING_CUSTOMER';
    let reads = 0;
    stubApi(CUSTOMER, {
      [`GET /tickets/${TICKET_ID}`]: () => {
        reads += 1;
        // 2ª leitura (depois do envio) falha; a do botão Recarregar volta com o status novo.
        return reads === 2 ? json({ message: 'falhou' }, 500) : json(detail({ status }));
      },
      [`GET /tickets/${TICKET_ID}/comments`]: () => json([]),
      [`POST /tickets/${TICKET_ID}/comments`]: () => {
        status = 'IN_PROGRESS';
        return json({}, 201);
      },
    });
    await renderAt(`/tickets/${TICKET_ID}`);

    type(await screen.findByLabelText('Comentário'), 'Segue a resposta');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(await screen.findByText('Seu comentário foi enviado.')).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível atualizar o ticket agora.');

    fireEvent.click(within(alert).getByRole('button', { name: 'Recarregar ticket' }));

    expect(await screen.findByText('Ticket atualizado.')).toBeInTheDocument();
    expect(screen.getByText('Status: Em andamento')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('comentário enviado com a leitura dos comentários falhando avisa que a lista não atualizou', async () => {
    let commentReads = 0;
    stubApi(CUSTOMER, {
      [`GET /tickets/${TICKET_ID}`]: () => json(detail()),
      [`GET /tickets/${TICKET_ID}/comments`]: () => {
        commentReads += 1;
        return commentReads === 1 ? json([]) : json({ message: 'falhou' }, 500);
      },
      [`POST /tickets/${TICKET_ID}/comments`]: () => json({}, 201),
    });
    await renderAt(`/tickets/${TICKET_ID}`);

    type(await screen.findByLabelText('Comentário'), 'Segue a resposta');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(await screen.findByText('Seu comentário foi enviado.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Não foi possível atualizar o ticket agora.',
    );
    expect(commentReads).toBe(2);
  });

  it('comentário que muda o status recarrega, avisa e limpa o rascunho', async () => {
    let status: TicketDetail['status'] = 'WAITING_CUSTOMER';
    stubApi(CUSTOMER, {
      [`GET /tickets/${TICKET_ID}`]: () => json(detail({ status })),
      [`GET /tickets/${TICKET_ID}/comments`]: () => json([]),
      [`POST /tickets/${TICKET_ID}/comments`]: () => {
        status = 'IN_PROGRESS';
        return json({}, 201);
      },
    });
    await renderAt(`/tickets/${TICKET_ID}`);

    const field = await screen.findByLabelText('Comentário');
    type(field, 'Segue a resposta');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(
      await screen.findByText('Seu comentário foi enviado. O status agora é Em andamento.'),
    ).toBeInTheDocument();
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();
    expect(sessionStorage.getItem(`support-flow:draft:c1:${TICKET_ID}`)).toBeNull();
  });

  it('rascunho guardado volta só para o mesmo usuário', async () => {
    saveDraft('c1', TICKET_ID, { text: 'Rascunho da Clara', isInternal: false });
    stubApi(CUSTOMER, routesFor(detail()));
    await renderAt(`/tickets/${TICKET_ID}`);
    expect(await screen.findByLabelText('Comentário')).toHaveValue('Rascunho da Clara');
  });

  it('rascunho de outra pessoa não aparece', async () => {
    saveDraft('c1', TICKET_ID, { text: 'Rascunho da Clara', isInternal: false });
    stubApi(AGENT, routesFor(detail()));
    await renderAt(`/tickets/${TICKET_ID}`);
    expect(await screen.findByLabelText('Comentário')).toHaveValue('');
  });

  it('comentário vazio não é enviado', async () => {
    const calls = stubApi(CUSTOMER, routesFor(detail()));
    await renderAt(`/tickets/${TICKET_ID}`);

    await screen.findByLabelText('Comentário');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(await screen.findByText('Escreva o comentário antes de enviar.')).toBeInTheDocument();
    expect(calls.some(({ key }) => key.startsWith('POST /tickets'))).toBe(false);
  });

  it('nota interna só para a equipe, com rótulo em texto', async () => {
    const comment = {
      id: 'k1',
      ticketId: TICKET_ID,
      author: { id: 'a1', name: 'Ari', role: 'AGENT' },
      body: 'Ver com o fornecedor',
      isInternal: true,
      createdAt: '2026-11-04T10:00:00.000Z',
    };
    const calls = stubApi(AGENT, {
      [`GET /tickets/${TICKET_ID}`]: () => json(detail()),
      [`GET /tickets/${TICKET_ID}/comments`]: () => json([comment]),
      [`POST /tickets/${TICKET_ID}/comments`]: () => json(comment, 201),
    });
    await renderAt(`/tickets/${TICKET_ID}`);

    expect(await screen.findByText('Nota interna')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Nota interna (o cliente não vê)'));
    type(screen.getByRole('textbox', { name: 'Nota interna' }), 'Outra nota');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    await screen.findByText('Seu comentário foi enviado.');
    const sent = calls.find(({ key }) => key.startsWith('POST /tickets'));
    expect(JSON.parse(sent?.init.body as string)).toEqual({ body: 'Outra nota', isInternal: true });
  });

  it('cliente não vê SLA, opção de nota interna nem controles da equipe', async () => {
    const calls = stubApi(CUSTOMER, routesFor(detail()));
    await renderAt(`/tickets/${TICKET_ID}`);

    await screen.findByLabelText('Comentário');
    expect(screen.queryByLabelText(/Nota interna/)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByText('Primeira resposta')).not.toBeInTheDocument();
    expect(calls.some(({ key }) => key.includes('/users/agents'))).toBe(false);
  });

  it('conteúdo com HTML aparece como texto', async () => {
    stubApi(
      CUSTOMER,
      routesFor(detail({ description: '<img src=x onerror=alert(1)>Olá', title: '<b>Título</b>' })),
    );
    const { container } = await renderAt(`/tickets/${TICKET_ID}`);

    expect(await screen.findByText('<img src=x onerror=alert(1)>Olá')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('h1 b')).toBeNull();
  });

  it('prioridade fica travada em ticket resolvido, com o motivo à vista', async () => {
    stubApi(AGENT, routesFor(detail({ status: 'RESOLVED' })));
    await renderAt(`/tickets/${TICKET_ID}`);

    const select = await screen.findByLabelText('Prioridade');
    expect(select).toBeDisabled();
    expect(select).toHaveAccessibleDescription(/não muda de prioridade/);
  });

  it('409 no PATCH de prioridade mantém o valor do servidor e oferece recarregar', async () => {
    stubApi(
      AGENT,
      routesFor(detail(), {
        [`PATCH /tickets/${TICKET_ID}`]: () =>
          json({ message: 'O ticket mudou enquanto isso. Recarregue e tente de novo.' }, 409),
      }),
    );
    await renderAt(`/tickets/${TICKET_ID}`);

    const select = await screen.findByLabelText('Prioridade');
    fireEvent.change(select, { target: { value: 'URGENT' } });

    expect(await screen.findByRole('alert')).toHaveTextContent('O ticket mudou');
    expect(screen.getByRole('button', { name: 'Recarregar ticket' })).toBeInTheDocument();
    expect(select).toHaveValue('HIGH');
  });

  /** Resposta que o teste libera quando quiser: deixa a mutação pendente no meio do caminho. */
  function pending() {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => (release = resolve));
    return { handler: () => response as unknown as Response, release };
  }

  it('transição pendente trava prioridade e responsável até a resposta', async () => {
    const post = pending();
    stubApi(
      ADMIN,
      routesFor(detail({ allowedTransitions: ['RESOLVED'] }), {
        'GET /users/agents': json([
          { id: 'a1', name: 'Ari', email: 'a@x.dev', isAvailable: true, openTickets: 1 },
        ]),
        [`POST /tickets/${TICKET_ID}/transitions`]: post.handler,
      }),
    );
    await renderAt(`/tickets/${TICKET_ID}`);

    await screen.findByRole('option', { name: 'Ari' });
    fireEvent.click(screen.getByRole('button', { name: 'Marcar como resolvido' }));

    await waitFor(() => expect(screen.getByLabelText('Prioridade')).toBeDisabled());
    expect(screen.getByLabelText('Responsável')).toBeDisabled();

    post.release(json(detail({ status: 'IN_PROGRESS', allowedTransitions: ['RESOLVED'] })));

    await waitFor(() => expect(screen.getByLabelText('Prioridade')).toBeEnabled());
    expect(screen.getByLabelText('Responsável')).toBeEnabled();
  });

  it('PATCH de prioridade pendente trava os botões de status até a resposta', async () => {
    const patch = pending();
    stubApi(
      AGENT,
      routesFor(detail({ allowedTransitions: ['RESOLVED'] }), {
        [`PATCH /tickets/${TICKET_ID}`]: patch.handler,
      }),
    );
    await renderAt(`/tickets/${TICKET_ID}`);

    fireEvent.change(await screen.findByLabelText('Prioridade'), { target: { value: 'URGENT' } });

    const resolve = screen.getByRole('button', { name: 'Marcar como resolvido' });
    await waitFor(() => expect(resolve).toBeDisabled());

    patch.release(json(detail({ priority: 'URGENT', allowedTransitions: ['RESOLVED'] })));

    expect(await screen.findByText('Prioridade alterada para Urgente.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Marcar como resolvido' })).toBeEnabled();
  });

  it('só o admin troca o responsável; agente indisponível aparece marcado', async () => {
    stubApi(
      ADMIN,
      routesFor(detail(), {
        'GET /users/agents': json([
          { id: 'a1', name: 'Ari', email: 'a@x.dev', isAvailable: true, openTickets: 1 },
          { id: 'a2', name: 'Bia', email: 'b@x.dev', isAvailable: false, openTickets: 0 },
        ]),
      }),
    );
    await renderAt(`/tickets/${TICKET_ID}`);

    expect(await screen.findByRole('option', { name: 'Bia (indisponível)' })).toBeInTheDocument();
  });

  it('agente não vê a troca de responsável', async () => {
    stubApi(AGENT, routesFor(detail()));
    await renderAt(`/tickets/${TICKET_ID}`);

    await screen.findByLabelText('Prioridade');
    expect(screen.queryByLabelText('Responsável')).not.toBeInTheDocument();
  });

  it.each([
    [true, /por 7 dias após a resolução/],
    [false, /O prazo para reabrir terminou/],
  ])('reabrir dentro do prazo: %s', async (canReopen, text) => {
    stubApi(
      CUSTOMER,
      routesFor(
        detail({
          status: 'RESOLVED',
          resolvedAt: '2026-11-04T10:00:00.000Z',
          allowedTransitions: canReopen ? ['IN_PROGRESS'] : [],
        }),
      ),
    );
    await renderAt(`/tickets/${TICKET_ID}`);

    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: 'Reabrir ticket' })).toHaveLength(
      canReopen ? 1 : 0,
    );
  });

  it('ticket fechado não oferece comentário', async () => {
    stubApi(CUSTOMER, routesFor(detail({ status: 'CLOSED' })));
    await renderAt(`/tickets/${TICKET_ID}`);

    expect(
      await screen.findByText('Este ticket está fechado e não aceita comentários.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Comentário')).not.toBeInTheDocument();
  });

  it('o relógio que passa de zero vira Violado e é anunciado uma vez', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi(
      AGENT,
      routesFor(
        detail({
          sla: {
            firstResponse: clock('AT_RISK', 2) as never,
            resolution: clock('OK', 7200) as never,
          },
        }),
      ),
    );
    await renderAt(`/tickets/${TICKET_ID}`);
    await screen.findByText('Em risco');

    // Um passo por tick: dentro de um único act, o React juntaria os ticks em um só.
    for (let second = 0; second < 4; second += 1) {
      await act(() => vi.advanceTimersByTimeAsync(1_000));
    }

    expect(await screen.findByText('Violado')).toBeInTheDocument();
    expect(screen.getByText('Primeira resposta: o prazo foi violado.')).toHaveAttribute(
      'role',
      'status',
    );
  });
});

describe('novo ticket', () => {
  it('abre e leva ao ticket criado', async () => {
    stubApi(CUSTOMER, {
      'POST /tickets': () => json(detail(), 201),
      [`GET /tickets/${TICKET_ID}/comments`]: () => json([]),
      [`GET /tickets/${TICKET_ID}`]: () => json(detail()),
    });
    await renderAt('/tickets/novo');

    type(await screen.findByLabelText('Título'), 'Impressora parada');
    type(screen.getByLabelText('Descrição'), 'Não imprime.');
    fireEvent.click(screen.getByRole('button', { name: 'Abrir ticket' }));

    expect(
      await screen.findByRole('heading', { name: '#7 Impressora parada' }),
    ).toBeInTheDocument();
  });

  it('erro de rede ao criar não repete sozinho e avisa para conferir', async () => {
    const fetch = vi.fn(async (input: string) => {
      if (input.endsWith('/auth/refresh')) return json({ accessToken: 't', user: CUSTOMER });
      throw new TypeError('rede');
    });
    vi.stubGlobal('fetch', fetch);
    await renderAt('/tickets/novo');

    type(await screen.findByLabelText('Título'), 'Título');
    type(screen.getByLabelText('Descrição'), 'Descrição');
    fireEvent.click(screen.getByRole('button', { name: 'Abrir ticket' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Confira se a ação foi concluída');
    expect(fetch.mock.calls.filter(([url]) => url === '/api/tickets')).toHaveLength(1);
  });

  it('título recusado pela API aparece no campo, em português', async () => {
    stubApi(CUSTOMER, {
      'POST /tickets': () => json({ message: ['title must be shorter'] }, 400),
    });
    await renderAt('/tickets/novo');

    const title = await screen.findByLabelText('Título');
    type(title, 'Título');
    type(screen.getByLabelText('Descrição'), 'Descrição');
    fireEvent.click(screen.getByRole('button', { name: 'Abrir ticket' }));

    expect(await screen.findByText('Informe um título de até 200 caracteres.')).toBeInTheDocument();
    await waitFor(() => expect(title).toHaveFocus());
  });
});

describe('admin', () => {
  it('e-mail repetido ao criar agente aparece no campo', async () => {
    stubApi(ADMIN, {
      'GET /users/agents': () => json([]),
      'POST /users/agents': () => json({ message: 'E-mail já cadastrado.' }, 409),
    });
    await renderAt('/admin/agentes');

    expect(await screen.findByText(/Nenhum agente cadastrado/)).toBeInTheDocument();
    type(screen.getByLabelText('Nome'), 'Bia');
    type(screen.getByLabelText('E-mail'), 'b@x.dev');
    type(screen.getByLabelText('Senha inicial'), 'senha-forte');
    fireEvent.click(screen.getByRole('button', { name: 'Criar agente' }));

    const email = screen.getByLabelText('E-mail');
    expect(await screen.findByText('Já existe uma conta com este e-mail.')).toBeInTheDocument();
    await waitFor(() => expect(email).toHaveFocus());
  });

  it('criar agente limpa a senha do formulário e avisa que ele começa indisponível', async () => {
    stubApi(ADMIN, {
      'GET /users/agents': () => json([]),
      'POST /users/agents': () =>
        json({ id: 'a2', name: 'Bia', email: 'b@x.dev', isAvailable: false, openTickets: 0 }, 201),
    });
    await renderAt('/admin/agentes');

    await screen.findByText(/Nenhum agente cadastrado/);
    type(screen.getByLabelText('Nome'), 'Bia');
    type(screen.getByLabelText('E-mail'), 'b@x.dev');
    const password = screen.getByLabelText('Senha inicial');
    type(password, 'senha-forte');
    fireEvent.click(screen.getByRole('button', { name: 'Criar agente' }));

    expect(await screen.findByText(/Ele começa indisponível/)).toBeInTheDocument();
    expect(password).toHaveValue('');
  });

  it('senha curta não chega à API', async () => {
    const calls = stubApi(ADMIN, { 'GET /users/agents': () => json([]) });
    await renderAt('/admin/agentes');

    await screen.findByText(/Nenhum agente cadastrado/);
    type(screen.getByLabelText('Nome'), 'Bia');
    type(screen.getByLabelText('E-mail'), 'b@x.dev');
    type(screen.getByLabelText('Senha inicial'), 'curta');
    fireEvent.click(screen.getByRole('button', { name: 'Criar agente' }));

    expect(await screen.findByText(/pelo menos 8 caracteres\.$/)).toBeInTheDocument();
    expect(calls.some(({ key }) => key === 'POST /users/agents')).toBe(false);
  });

  it('política de SLA: regra recusada pela API aparece, e a certa salva', async () => {
    const policy = (priority: string) => ({
      priority,
      firstResponseMinutes: 60,
      resolutionMinutes: 240,
      updatedAt: '2026-11-04T10:00:00.000Z',
    });
    let accept = false;
    stubApi(ADMIN, {
      'GET /sla-policies': () => json([policy('URGENT'), policy('LOW')]),
      'PUT /sla-policies/LOW': () =>
        accept
          ? json(policy('LOW'))
          : json({ message: 'A 1ª resposta precisa ter prazo menor que a resolução.' }, 400),
    });
    await renderAt('/admin/sla');

    const save = await screen.findByRole('button', { name: 'Salvar prioridade Baixa' });
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Baixa',
      'Urgente',
    ]);
    fireEvent.click(save);
    expect(await screen.findByRole('alert')).toHaveTextContent('A 1ª resposta precisa ter');

    accept = true;
    fireEvent.click(save);
    expect(await screen.findByText(/Prazos da prioridade Baixa salvos/)).toBeInTheDocument();
  });
});

describe('espera', () => {
  it('depois de ~3 s, troca o carregando por Acordando o servidor', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi(CUSTOMER, {
      'GET /tickets?page=1': () => json({ items: [], page: 1, pageSize: 20, total: 0 }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.endsWith('/auth/refresh')) return json({ accessToken: 't', user: CUSTOMER });
        return new Promise<Response>(() => undefined);
      }),
    );
    await renderAt('/meus-tickets');

    expect(screen.getByText('Carregando…')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3_100));

    expect(screen.getByText(/Acordando o servidor/)).toBeInTheDocument();
  });

  it('repetição no 503 do lock aparece na tela e o ticket é criado', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let posts = 0;
    stubApi(CUSTOMER, {
      'POST /tickets': () => {
        posts += 1;
        return posts === 1
          ? new Response(JSON.stringify({ code: 'ASSIGNMENT_BUSY' }), {
              status: 503,
              headers: { 'Retry-After': '1' },
            })
          : json(detail(), 201);
      },
      [`GET /tickets/${TICKET_ID}`]: () => json(detail()),
      [`GET /tickets/${TICKET_ID}/comments`]: () => json([]),
    });
    await renderAt('/tickets/novo');

    type(await screen.findByLabelText('Título'), 'Título');
    type(screen.getByLabelText('Descrição'), 'Descrição');
    fireEvent.click(screen.getByRole('button', { name: 'Abrir ticket' }));

    expect(await screen.findByText(/Tentando de novo/)).toHaveTextContent('(2 de 3)');
    await act(() => vi.advanceTimersByTimeAsync(1_100));
    expect(
      await screen.findByRole('heading', { name: '#7 Impressora parada' }),
    ).toBeInTheDocument();
    expect(posts).toBe(2);
  });

  /** 1ª leitura do ticket responde na hora; a 2ª só quando o teste chamar `release`. */
  function slowSecondRead(body: () => TicketDetail) {
    let reads = 0;
    let release: () => void = () => undefined;
    const route = () => {
      reads += 1;
      if (reads === 1) return json(body());
      return new Promise<Response>((resolve) => {
        release = () => resolve(json(body()));
      }) as unknown as Response;
    };
    return { route, release: () => act(async () => release()) };
  }

  async function expectRefreshNotice() {
    expect(await screen.findByText('Atualizando o ticket…')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3_100));
    expect(screen.getByText(/Acordando o servidor/)).toBeInTheDocument();
  }

  it('Recarregar ticket diz que está atualizando e, depois de ~3 s, que o servidor está acordando', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const slow = slowSecondRead(() => detail());
    stubApi(CUSTOMER, {
      [`GET /tickets/${TICKET_ID}`]: slow.route,
      [`GET /tickets/${TICKET_ID}/comments`]: () => json([]),
      [`POST /tickets/${TICKET_ID}/comments`]: () =>
        json({ message: 'Ticket fechado não aceita comentários.' }, 409),
    });
    await renderAt(`/tickets/${TICKET_ID}`);

    type(await screen.findByLabelText('Comentário'), 'Meu texto');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Recarregar ticket' }));

    await expectRefreshNotice();
    await slow.release();

    expect(await screen.findByText('Ticket atualizado.')).toBeInTheDocument();
    expect(screen.queryByText(/Acordando o servidor/)).not.toBeInTheDocument();
  });

  it('transição recusada avisa enquanto recarrega as ações', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let first = true;
    const slow = slowSecondRead(() => {
      const allowed: TicketDetail['allowedTransitions'] = first ? ['RESOLVED'] : [];
      first = false;
      return detail({ allowedTransitions: allowed });
    });
    stubApi(AGENT, {
      [`GET /tickets/${TICKET_ID}`]: slow.route,
      [`GET /tickets/${TICKET_ID}/comments`]: () => json([]),
      [`POST /tickets/${TICKET_ID}/transitions`]: () =>
        json({ message: 'O ticket mudou enquanto isso.' }, 409),
    });
    await renderAt(`/tickets/${TICKET_ID}`);

    const button = await screen.findByRole('button', { name: 'Marcar como resolvido' });
    fireEvent.click(button);

    await expectRefreshNotice();
    expect(button).toBeDisabled();
    await slow.release();

    expect(await screen.findByRole('alert')).toHaveTextContent('Atualizamos as ações disponíveis.');
    expect(screen.queryByText(/Acordando o servidor/)).not.toBeInTheDocument();
  });

  it('comentário já gravado não diz Enviando… enquanto a tela recarrega', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const slow = slowSecondRead(() => detail());
    stubApi(CUSTOMER, {
      [`GET /tickets/${TICKET_ID}`]: slow.route,
      [`GET /tickets/${TICKET_ID}/comments`]: () => json([]),
      [`POST /tickets/${TICKET_ID}/comments`]: () => json({}, 201),
    });
    await renderAt(`/tickets/${TICKET_ID}`);

    type(await screen.findByLabelText('Comentário'), 'Segue a resposta');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    await expectRefreshNotice();
    // Travado contra um 2º envio, mas sem dizer que ainda está enviando o que já foi gravado.
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Enviando…' })).not.toBeInTheDocument();
    await slow.release();

    expect(await screen.findByText('Seu comentário foi enviado.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled();
  });
});

describe('correções das revisões', () => {
  const running = (id: string) =>
    summary({
      id,
      sla: {
        firstResponse: clock('OK', 3_600) as never,
        resolution: clock('OK', 7_200) as never,
      },
    });
  const page = (items: TicketSummary[], number = 1, total = items.length) =>
    json({ items, page: number, pageSize: 20, total });

  it('trocar de página não mostra Violado falso enquanto a resposta não chega', async () => {
    const calls = stubApi(AGENT, {
      'GET /tickets?page=1': () => page([running(TICKET_ID)], 1, 41),
      'GET /tickets?page=2': (() => new Promise(() => undefined)) as never,
    });
    await renderAt('/fila');

    await screen.findByText('No prazo');
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));

    await waitFor(() => expect(calls.map(({ key }) => key)).toContain('GET /tickets?page=2'));
    // Na linha da tabela: o filtro de SLA também tem uma opção Violado.
    const row = screen.getAllByRole('row')[1] as HTMLElement;
    expect(within(row).getByText('No prazo')).toBeInTheDocument();
    expect(within(row).queryByText('Violado')).not.toBeInTheDocument();
  });

  it('página fora do intervalo oferece ir para a última', async () => {
    stubApi(AGENT, {
      'GET /tickets?page=5': () => page([], 5, 41),
      'GET /tickets?page=3': () => page([summary()], 3, 41),
    });
    await renderAt('/fila?page=5');

    fireEvent.click(await screen.findByRole('button', { name: 'Ir para a última página' }));

    expect(await screen.findByText('Página 3 de 3')).toBeInTheDocument();
  });

  it('falha ao ler a disponibilidade não afirma estado e permite tentar de novo', async () => {
    let reads = 0;
    stubApi(AGENT, {
      'GET /tickets?page=1': () => page([]),
      'GET /users/me/availability': () => {
        reads += 1;
        return reads === 1 ? json({}, 500) : json({ isAvailable: true });
      },
    });
    await renderAt('/fila');

    expect(
      await screen.findByText('Não foi possível ver sua disponibilidade.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));

    expect(await screen.findByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('rascunho de nota interna volta marcado como interno', async () => {
    saveDraft('a1', TICKET_ID, { text: 'Só para a equipe', isInternal: true });
    const calls = stubApi(AGENT, {
      [`GET /tickets/${TICKET_ID}`]: () => json(detail()),
      [`GET /tickets/${TICKET_ID}/comments`]: () => json([]),
      [`POST /tickets/${TICKET_ID}/comments`]: () => json({}, 201),
    });
    await renderAt(`/tickets/${TICKET_ID}`);

    expect(await screen.findByRole('textbox', { name: 'Nota interna' })).toHaveValue(
      'Só para a equipe',
    );
    expect(screen.getByLabelText('Nota interna (o cliente não vê)')).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await screen.findByText('Seu comentário foi enviado.');

    const sent = calls.find(({ key }) => key.startsWith('POST /tickets'));
    expect(JSON.parse(sent?.init.body as string)).toEqual({
      body: 'Só para a equipe',
      isInternal: true,
    });
  });

  it('cliente nunca envia isInternal, mesmo com rascunho adulterado', async () => {
    saveDraft('c1', TICKET_ID, { text: 'Olá', isInternal: true });
    const calls = stubApi(CUSTOMER, {
      [`GET /tickets/${TICKET_ID}`]: () => json(detail()),
      [`GET /tickets/${TICKET_ID}/comments`]: () => json([]),
      [`POST /tickets/${TICKET_ID}/comments`]: () => json({}, 201),
    });
    await renderAt(`/tickets/${TICKET_ID}`);

    await screen.findByRole('textbox', { name: 'Comentário' });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await screen.findByText('Seu comentário foi enviado.');

    const sent = calls.find(({ key }) => key.startsWith('POST /tickets'));
    expect(JSON.parse(sent?.init.body as string)).toEqual({ body: 'Olá' });
  });

  it('o refetch de 60 s que falha mantém os dados e avisa', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reads = 0;
    stubApi(AGENT, {
      'GET /tickets?page=1': () => {
        reads += 1;
        return reads === 1 ? page([summary()]) : json({}, 500);
      },
    });
    await renderAt('/fila');
    await screen.findByRole('link', { name: '#7 Impressora parada' });

    await act(() => vi.advanceTimersByTimeAsync(60_100));

    expect(reads).toBe(2);
    expect(await screen.findByText(/Mostrando os dados das/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#7 Impressora parada' })).toBeInTheDocument();
  });

  it('com a aba oculta, não há refetch de 60 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reads = 0;
    stubApi(AGENT, {
      'GET /tickets?page=1': () => {
        reads += 1;
        return page([summary()]);
      },
    });
    await renderAt('/fila');
    await screen.findByRole('link', { name: '#7 Impressora parada' });

    focusManager.setFocused(false);
    try {
      await act(() => vi.advanceTimersByTimeAsync(120_100));
      expect(reads).toBe(1);
    } finally {
      focusManager.setFocused(undefined);
    }
  });

  it('429 no formulário mantém o texto e pede para aguardar', async () => {
    stubApi(CUSTOMER, { 'POST /tickets': () => json({}, 429) });
    await renderAt('/tickets/novo');

    const title = await screen.findByLabelText('Título');
    type(title, 'Título');
    type(screen.getByLabelText('Descrição'), 'Descrição');
    fireEvent.click(screen.getByRole('button', { name: 'Abrir ticket' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Aguarde alguns minutos');
    expect(title).toHaveValue('Título');
  });

  it('429 na transição pede para aguardar, sem fingir mudança', async () => {
    stubApi(AGENT, {
      [`GET /tickets/${TICKET_ID}`]: () => json(detail({ allowedTransitions: ['RESOLVED'] })),
      [`GET /tickets/${TICKET_ID}/comments`]: () => json([]),
      [`POST /tickets/${TICKET_ID}/transitions`]: () => json({}, 429),
    });
    await renderAt(`/tickets/${TICKET_ID}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Marcar como resolvido' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Aguarde alguns minutos');
    expect(screen.getByText('Status: Em andamento')).toBeInTheDocument();
  });

  it('403 na lista e na tela de admin mostra Sem acesso', async () => {
    stubApi(ADMIN, { 'GET /users/agents': () => json({}, 403) });
    await renderAt('/admin/agentes');

    expect(await screen.findByText('Você não tem acesso a esta tela.')).toBeInTheDocument();
  });

  it('401 definitivo em formulário que não é o de comentário leva a /entrar', async () => {
    let expired = false;
    stubApi(CUSTOMER, {
      'POST /tickets': () => {
        expired = true;
        return json({}, 401);
      },
      'POST /auth/refresh': () =>
        expired ? json({}, 401) : json({ accessToken: 't', user: CUSTOMER }),
    });
    await renderAt('/tickets/novo');

    type(await screen.findByLabelText('Título'), 'Título');
    type(screen.getByLabelText('Descrição'), 'Descrição');
    fireEvent.click(screen.getByRole('button', { name: 'Abrir ticket' }));

    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Sua sessão expirou');
  });

  it('422 mostra a regra da API, não um erro genérico', async () => {
    stubApi(ADMIN, {
      [`GET /tickets/${TICKET_ID}`]: () => json(detail()),
      [`GET /tickets/${TICKET_ID}/comments`]: () => json([]),
      'GET /users/agents': () =>
        json([{ id: 'a2', name: 'Bia', email: 'b@x.dev', isAvailable: true, openTickets: 0 }]),
      [`PATCH /tickets/${TICKET_ID}`]: () =>
        json({ message: 'O responsável precisa ser um agente.' }, 422),
    });
    await renderAt(`/tickets/${TICKET_ID}`);

    await screen.findByRole('option', { name: 'Bia' });
    fireEvent.change(screen.getByLabelText('Responsável'), { target: { value: 'a2' } });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'O responsável precisa ser um agente.',
    );
  });

  it('o botão de senha diz em texto o que faz', async () => {
    stubApi(null, {});
    await renderAt('/entrar');

    fireEvent.click(await screen.findByRole('button', { name: 'Mostrar senha' }));

    expect(screen.getByRole('button', { name: 'Ocultar senha' })).toBeInTheDocument();
    expect(screen.getByLabelText('Senha')).toHaveAttribute('type', 'text');
  });
});

describe('troca de pessoa com a tela aberta', () => {
  const OTHER: AuthUser = { id: 'a2', email: 'b@x.dev', name: 'Bia', role: 'AGENT' };
  const ticketReads = (calls: { key: string }[]) =>
    calls.filter(({ key }) => key === `GET /tickets/${TICKET_ID}`).length;

  /** A API responde com o usuário da vez; `person` muda quando o teste troca a sessão. */
  function stubPeople(extra: Record<string, Handler> = {}) {
    const state = { person: AGENT };
    const calls = stubApi(AGENT, {
      'POST /auth/refresh': () =>
        json({ accessToken: `token-${state.person.id}`, user: state.person }),
      [`GET /tickets/${TICKET_ID}`]: () => json(detail({ allowedTransitions: ['RESOLVED'] })),
      [`GET /tickets/${TICKET_ID}/comments`]: () => json([]),
      'GET /tickets?page=1': () => json({ items: [], page: 1, pageSize: 20, total: 0 }),
      ...extra,
    });
    return { state, calls };
  }

  it('outra pessoa adotada nesta aba sai da URL de A e vai para a própria tela inicial', async () => {
    const OTHER_CUSTOMER: AuthUser = { ...CUSTOMER, id: 'c2', name: 'Caio' };
    let person = ADMIN;
    const calls = stubApi(ADMIN, {
      'POST /auth/refresh': () => json({ accessToken: `token-${person.id}`, user: person }),
      'GET /sla-policies': () => json([]),
      'GET /tickets?page=1': () => json({ items: [], page: 1, pageSize: 20, total: 0 }),
    });
    await renderAt('/admin/sla');
    await screen.findByRole('heading', { name: 'Prazos de SLA' });

    // O aviso user-changed de outra aba roda o bootstrap com o cookie de B.
    person = OTHER_CUSTOMER;
    await act(() => session.bootstrap());

    expect(await screen.findByRole('heading', { name: 'Meus tickets' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sem acesso' })).not.toBeInTheDocument();
    expect(calls.filter(({ key }) => key === 'GET /sla-policies')).toHaveLength(1);
  });

  it('equipe trocada não reabre o ticket de A com o token de B', async () => {
    const { state, calls } = stubPeople();
    await renderAt(`/tickets/${TICKET_ID}`);
    await screen.findByRole('heading', { name: '#7 Impressora parada' });

    state.person = OTHER;
    await act(() => session.bootstrap());

    expect(await screen.findByRole('heading', { name: 'Fila de tickets' })).toBeInTheDocument();
    expect(ticketReads(calls)).toBe(1);
  });

  it('a mesma pessoa restaurada continua na tela em que estava', async () => {
    stubPeople();
    await renderAt(`/tickets/${TICKET_ID}`);
    await screen.findByRole('heading', { name: '#7 Impressora parada' });

    await act(() => session.bootstrap());

    expect(
      await screen.findByRole('heading', { name: '#7 Impressora parada' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Fila de tickets' })).not.toBeInTheDocument();
  });

  it('comentário de A respondido depois da troca não busca nada com o token de B', async () => {
    let answer: (res: Response) => void = () => undefined;
    const { state, calls } = stubPeople({
      [`POST /tickets/${TICKET_ID}/comments`]: (() =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        })) as never,
    });
    await renderAt(`/tickets/${TICKET_ID}`);
    type(await screen.findByLabelText('Comentário'), 'Texto de A');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() =>
      expect(calls.map(({ key }) => key)).toContain(`POST /tickets/${TICKET_ID}/comments`),
    );

    state.person = OTHER;
    await act(() => session.bootstrap());
    await screen.findByRole('heading', { name: 'Fila de tickets' });

    await act(async () => {
      answer(json({}, 201));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // Só a leitura de A: nem a troca nem a resposta atrasada leem o ticket como B.
    expect(ticketReads(calls)).toBe(1);
    expect(loadDraft('a1', TICKET_ID).text).toBe('');
  });

  it('transição de A recusada depois da troca não recarrega com o token de B', async () => {
    let answer: (res: Response) => void = () => undefined;
    const { state, calls } = stubPeople({
      [`POST /tickets/${TICKET_ID}/transitions`]: (() =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        })) as never,
    });
    await renderAt(`/tickets/${TICKET_ID}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Marcar como resolvido' }));
    await waitFor(() =>
      expect(calls.map(({ key }) => key)).toContain(`POST /tickets/${TICKET_ID}/transitions`),
    );

    state.person = OTHER;
    await act(() => session.bootstrap());
    await screen.findByRole('heading', { name: 'Fila de tickets' });

    await act(async () => {
      answer(json({ message: 'O ticket mudou.' }, 409));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(ticketReads(calls)).toBe(1);
  });

  it('troca durante a recarga depois da transição recusada não mostra o aviso de A para B', async () => {
    let reads = 0;
    let answer: (res: Response) => void = () => undefined;
    const { state, calls } = stubPeople({
      [`GET /tickets/${TICKET_ID}`]: (() => {
        reads += 1;
        if (reads === 1) return json(detail({ allowedTransitions: ['RESOLVED'] }));
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      }) as never,
      [`POST /tickets/${TICKET_ID}/transitions`]: () => json({ message: 'O ticket mudou.' }, 409),
    });
    await renderAt(`/tickets/${TICKET_ID}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Marcar como resolvido' }));
    await waitFor(() => expect(ticketReads(calls)).toBe(2));

    state.person = OTHER;
    await act(() => session.bootstrap());
    await screen.findByRole('heading', { name: 'Fila de tickets' });

    await act(async () => {
      answer(json(detail()));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // A recarga saiu com o token de A antes da troca; nada novo é lido como B. A tela de A
    // já desmontou, então isto cobre o resultado, não a 2ª conferência do onError sozinha.
    expect(ticketReads(calls)).toBe(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Fila de tickets' })).toBeInTheDocument();
  });

  it('troca direta de A para B tira B do formulário de A, sem o texto dele', async () => {
    const OTHER_CUSTOMER: AuthUser = { ...CUSTOMER, id: 'c2', name: 'Caio' };
    let person = CUSTOMER;
    stubApi(CUSTOMER, {
      'POST /auth/refresh': () => json({ accessToken: `token-${person.id}`, user: person }),
      'GET /tickets?page=1': () => json({ items: [], page: 1, pageSize: 20, total: 0 }),
    });
    await renderAt('/tickets/novo');
    type(await screen.findByLabelText('Título'), 'Texto de A');

    // Sem passar por `loading`: é o caso do refresh que adota B antes de o aviso chegar.
    person = OTHER_CUSTOMER;
    await act(async () => {
      await session.refresh(session.getToken());
    });

    expect(await screen.findByRole('heading', { name: 'Meus tickets' })).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Texto de A')).not.toBeInTheDocument();
  });

  it('a caixa de nota interna continua marcada: a 2ª nota seguida não sai pública', async () => {
    const calls = stubApi(AGENT, {
      [`GET /tickets/${TICKET_ID}`]: () => json(detail()),
      [`GET /tickets/${TICKET_ID}/comments`]: () => json([]),
      [`POST /tickets/${TICKET_ID}/comments`]: () => json({}, 201),
    });
    await renderAt(`/tickets/${TICKET_ID}`);

    await screen.findByLabelText('Comentário');
    fireEvent.click(screen.getByLabelText('Nota interna (o cliente não vê)'));
    type(screen.getByRole('textbox', { name: 'Nota interna' }), 'Primeira nota');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await screen.findByText('Seu comentário foi enviado.');

    const field = screen.getByRole('textbox', { name: 'Nota interna' });
    expect(field).toHaveValue('');
    expect(screen.getByLabelText('Nota interna (o cliente não vê)')).toBeChecked();

    type(field, 'Segunda nota');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() =>
      expect(calls.filter(({ key }) => key.startsWith('POST /tickets'))).toHaveLength(2),
    );

    const second = calls.filter(({ key }) => key.startsWith('POST /tickets'))[1];
    expect(JSON.parse(second?.init.body as string)).toEqual({
      body: 'Segunda nota',
      isInternal: true,
    });
  });

  it('desmarcar a caixa volta a enviar comentário público', async () => {
    const calls = stubApi(AGENT, {
      [`GET /tickets/${TICKET_ID}`]: () => json(detail()),
      [`GET /tickets/${TICKET_ID}/comments`]: () => json([]),
      [`POST /tickets/${TICKET_ID}/comments`]: () => json({}, 201),
    });
    await renderAt(`/tickets/${TICKET_ID}`);

    await screen.findByLabelText('Comentário');
    const box = screen.getByLabelText('Nota interna (o cliente não vê)');
    fireEvent.click(box);
    fireEvent.click(box);
    type(screen.getByRole('textbox', { name: 'Comentário' }), 'Resposta pública');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await screen.findByText('Seu comentário foi enviado.');

    const sent = calls.find(({ key }) => key.startsWith('POST /tickets'));
    expect(JSON.parse(sent?.init.body as string)).toEqual({
      body: 'Resposta pública',
      isInternal: false,
    });
  });
});

describe('limites do hash de senha e do login', () => {
  const fillLogin = async () => {
    const email = await screen.findByLabelText('E-mail');
    const password = screen.getByLabelText('Senha');
    type(email, 'a@x.dev');
    type(password, 'minha-senha');
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    return { email, password };
  };

  it('429 no login diz quanto esperar, sem falar em conta, e mantém os campos', async () => {
    const calls = stubApi(null, {
      'POST /auth/login': () => json({ statusCode: 429 }, 429, { 'Retry-After': '840' }),
    });
    await renderAt('/entrar');
    const { email, password } = await fillLogin();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Muitas tentativas de entrada. Aguarde cerca de 14 minutos e tente de novo.',
    );
    expect(alert).not.toHaveTextContent(/conta|bloque/i);
    expect(email).toHaveValue('a@x.dev');
    expect(password).toHaveValue('minha-senha');
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeEnabled();
    expect(calls.filter(({ key }) => key === 'POST /auth/login')).toHaveLength(1);
  });

  it('503 do hash no login avisa e não repete sozinho', async () => {
    const calls = stubApi(null, { 'POST /auth/login': hashBusy });
    await renderAt('/entrar');
    const { password } = await fillLogin();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'O servidor está ocupado agora. Tente entrar de novo em alguns segundos.',
    );
    expect(password).toHaveValue('minha-senha');
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeEnabled();
    expect(calls.filter(({ key }) => key === 'POST /auth/login')).toHaveLength(1);
  });

  it('503 do hash no cadastro diz que nada foi salvo e não repete', async () => {
    const calls = stubApi(null, { 'POST /auth/register': hashBusy });
    await renderAt('/cadastro');

    type(await screen.findByLabelText('Nome'), 'Ana');
    type(screen.getByLabelText('E-mail'), 'a@x.dev');
    const password = screen.getByLabelText('Senha');
    type(password, 'senha-forte');
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Nada foi salvo.');
    expect(password).toHaveValue('senha-forte');
    expect(screen.getByRole('button', { name: 'Criar conta' })).toBeEnabled();
    expect(calls.filter(({ key }) => key === 'POST /auth/register')).toHaveLength(1);
  });

  it('503 do hash ao criar agente avisa, mantém a senha e não repete', async () => {
    const calls = stubApi(ADMIN, {
      'GET /users/agents': () => json([]),
      'POST /users/agents': hashBusy,
    });
    await renderAt('/admin/agentes');

    await screen.findByText(/Nenhum agente cadastrado/);
    type(screen.getByLabelText('Nome'), 'Bia');
    type(screen.getByLabelText('E-mail'), 'b@x.dev');
    const password = screen.getByLabelText('Senha inicial');
    type(password, 'senha-forte');
    fireEvent.click(screen.getByRole('button', { name: 'Criar agente' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Nada foi salvo.');
    expect(password).toHaveValue('senha-forte');
    expect(calls.filter(({ key }) => key === 'POST /users/agents')).toHaveLength(1);
  });
});
