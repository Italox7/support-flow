import type { Role } from '@support-flow/shared';
import { useState, type ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { Layout } from './components/Layout';
import { Page } from './components/Page';
import { ErrorNotice, ForbiddenView, Loading, NotFoundView } from './components/States';
import { describeError } from './lib/errors';
import { safeRedirect } from './lib/redirect';
import { session } from './lib/session';
import { useSession, useUser } from './lib/useSession';
import { AgentsPage, SlaPoliciesPage } from './pages/AdminPages';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { MyTicketsPage, NewTicketPage, QueuePage } from './pages/TicketListPages';
import { TicketPage } from './pages/TicketPage';

function Centered({ children }: { children: ReactNode }) {
  return <main className="mx-auto max-w-xl px-4 py-10">{children}</main>;
}

/** O que /entrar recebe: o destino e, se a sessão expirou, de quem ela era. */
interface RedirectState {
  from?: string;
  owner?: string;
}

/** Guarda das rotas logadas; só a expiração guarda o destino, para voltar a ele depois. */
function RequireAuth() {
  const state = useSession();
  const location = useLocation();
  // Quem estava logado nesta URL. A guarda continua montada quando outra aba
  // troca a pessoa (user-changed → bootstrap) ou um refresh adota outra: a URL
  // de A não serve a B, que vai para a própria tela inicial.
  const [owner, setOwner] = useState<{ key: string; userId: string } | null>(null);
  const userId = state.status === 'authenticated' ? state.user.id : null;
  // O dono só é gravado ao chegar numa URL: na mesma URL, outra pessoa não o
  // substitui. O Navigate abaixo troca a location.key, e aí B vira o dono da nova.
  // Limite aceito: se B mexer no histórico (Voltar/Avançar) enquanto a sessão
  // carrega ou está indisponível, a URL de chegada fica com B; a API autoriza a leitura.
  if (userId !== null && owner?.key !== location.key) {
    setOwner({ key: location.key, userId });
  }
  if (userId !== null && owner?.key === location.key && owner.userId !== userId) {
    return <Navigate to="/" replace />;
  }

  switch (state.status) {
    case 'loading':
      return (
        <Centered>
          <Loading />
        </Centered>
      );
    case 'unavailable':
      return (
        <Centered>
          <ErrorNotice
            message={describeError(state.error)}
            onRetry={() => void session.bootstrap()}
          />
        </Centered>
      );
    case 'anonymous': {
      const from = state.reason === 'logged-out' ? undefined : location.pathname + location.search;
      const owner = state.reason === 'expired' ? state.userId : undefined;
      return <Navigate to="/entrar" replace state={{ from, owner } satisfies RedirectState} />;
    }
    case 'authenticated':
      return (
        // Outra pessoa, tela nova: nada digitado por A pode continuar à vista de B.
        // Segunda defesa: o Navigate acima já tira B da URL de A; a key cobre o
        // caso de a troca de URL e a de pessoa caírem no mesmo render.
        <Layout key={state.user.id}>
          <Outlet />
        </Layout>
      );
  }
}

function RequireRole({ roles }: { roles: Role[] }) {
  const user = useUser();
  if (roles.includes(user.role)) return <Outlet />;
  return (
    <Page title="Sem acesso">
      <ForbiddenView />
    </Page>
  );
}

function PublicOnly() {
  const state = useSession();
  const location = useLocation();
  if (state.status === 'loading') {
    return (
      <Centered>
        <Loading />
      </Centered>
    );
  }
  if (state.status === 'authenticated') {
    const saved = location.state as { from?: unknown; owner?: unknown } | null;
    // Destino de uma sessão que expirou só serve a quem era dono dela: outra
    // pessoa entrando aqui, ou em outra aba, vai para a própria tela inicial.
    const mine = saved?.owner === undefined || saved.owner === state.user.id;
    return <Navigate to={mine ? safeRedirect(saved?.from) : '/'} replace />;
  }
  return (
    <Centered>
      <Outlet />
    </Centered>
  );
}

function Home() {
  const user = useUser();
  return <Navigate to={user.role === 'CUSTOMER' ? '/meus-tickets' : '/fila'} replace />;
}

function NotFoundPage() {
  return (
    <Page title="Página não encontrada">
      <NotFoundView />
    </Page>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/entrar" element={<LoginPage />} />
        <Route path="/cadastro" element={<RegisterPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route index element={<Home />} />
        <Route path="/tickets/:id" element={<TicketPage />} />
        <Route element={<RequireRole roles={['CUSTOMER']} />}>
          <Route path="/meus-tickets" element={<MyTicketsPage />} />
          <Route path="/tickets/novo" element={<NewTicketPage />} />
        </Route>
        <Route element={<RequireRole roles={['AGENT', 'ADMIN']} />}>
          <Route path="/fila" element={<QueuePage />} />
        </Route>
        <Route element={<RequireRole roles={['ADMIN']} />}>
          <Route path="/admin/agentes" element={<AgentsPage />} />
          <Route path="/admin/sla" element={<SlaPoliciesPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
