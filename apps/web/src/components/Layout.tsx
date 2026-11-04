import type { Role } from '@support-flow/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { MAX_ATTEMPTS, onBusyRetry } from '../lib/api';
import { describeError } from '../lib/errors';
import { session } from '../lib/session';
import { useUser } from '../lib/useSession';
import { AvailabilityBanner, AvailabilitySwitch } from './Availability';
import { FormAlert } from './States';

const NAV: Record<Role, { to: string; label: string }[]> = {
  CUSTOMER: [
    { to: '/meus-tickets', label: 'Meus tickets' },
    { to: '/tickets/novo', label: 'Novo ticket' },
  ],
  AGENT: [{ to: '/fila', label: 'Fila' }],
  ADMIN: [
    { to: '/fila', label: 'Fila' },
    { to: '/admin/agentes', label: 'Agentes' },
    { to: '/admin/sla', label: 'Prazos de SLA' },
  ],
};

/** O texto fixo é anunciado uma vez; a contagem de tentativas é só visual. */
function BusyNotice() {
  const [attempt, setAttempt] = useState<number | null>(null);
  useEffect(() => onBusyRetry(setAttempt), []);
  return (
    <p role="status" className={attempt ? 'mb-3 rounded-md bg-slate-200 p-2' : 'sr-only'}>
      {attempt && (
        <>
          O sistema está ocupado. Tentando de novo…{' '}
          <span aria-hidden="true">
            ({attempt} de {MAX_ATTEMPTS})
          </span>
        </>
      )}
    </p>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const user = useUser();
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const logout = async () => {
    setLeaving(true);
    setLogoutError(null);
    try {
      await session.logout();
    } catch (error) {
      setLogoutError(`Não foi possível sair. ${describeError(error)}`);
      setLeaving(false);
    }
  };

  return (
    <>
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10 focus:rounded-md focus:bg-surface focus:p-2"
      >
        Ir para o conteúdo
      </a>
      <header className="border-b border-gray-300 bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link to="/" className="text-lg font-bold">
            Support Flow
          </Link>
          <nav aria-label="Principal" className="flex flex-wrap gap-4">
            {NAV[user.role].map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                end
                className={({ isActive }) => `link ${isActive ? 'no-underline' : ''}`}
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-3">
            {user.role === 'AGENT' && <AvailabilitySwitch />}
            <span className="text-sm">{user.name}</span>
            <button type="button" className="btn" disabled={leaving} onClick={() => void logout()}>
              Sair
            </button>
          </div>
        </div>
      </header>
      <main
        id="conteudo"
        tabIndex={-1}
        className="mx-auto max-w-6xl space-y-4 px-4 py-6 outline-none"
      >
        <FormAlert message={logoutError} />
        <BusyNotice />
        {user.role === 'AGENT' && <AvailabilityBanner />}
        {children}
      </main>
    </>
  );
}
