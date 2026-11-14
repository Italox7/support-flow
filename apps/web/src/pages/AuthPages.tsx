import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { PasswordField, TextField } from '../components/Fields';
import { Page } from '../components/Page';
import { FormAlert } from '../components/States';
import { describeError, fieldErrors, toApiError } from '../lib/errors';
import { session } from '../lib/session';
import { useFocusFirstInvalid } from '../lib/useFocusFirstInvalid';
import { useSession } from '../lib/useSession';
import { useSlow, WAKING_MESSAGE } from '../lib/useSlow';

// Depois do login, quem leva ao destino é o PublicOnly (App.tsx): vale também para outra aba.
function WakingNotice({ pending }: { pending: boolean }) {
  const slow = useSlow(pending);
  return (
    <p role="status" className={slow ? 'text-muted' : 'sr-only'}>
      {slow ? WAKING_MESSAGE : ''}
    </p>
  );
}

/** Balão de conversa com um visto: decorativo, o nome ao lado é o que se lê. */
function LogoMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" className="size-9" fill="none">
      <rect width="32" height="32" rx="8" className="fill-brand" />
      <path
        d="M9 10.5A2.5 2.5 0 0 1 11.5 8h9A2.5 2.5 0 0 1 23 10.5v7a2.5 2.5 0 0 1-2.5 2.5H15l-4.2 3.4c-.5.4-1.3 0-1.3-.6V20A2.5 2.5 0 0 1 9 17.5v-7Z"
        fill="white"
      />
      <path
        d="m12.5 14 2.5 2.5 4.5-4.5"
        className="stroke-brand"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Moldura das telas de entrada: marca, cartão e um fundo suave atrás. */
function AuthShell({
  title,
  subtitle,
  footer,
  children,
}: {
  title: string;
  subtitle: string;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div
        aria-hidden="true"
        className="fixed inset-0 -z-10 bg-linear-to-b from-slate-300 via-slate-300 to-slate-400"
      />
      <div className="mx-auto max-w-md space-y-6 sm:pt-6">
        <div className="flex items-center justify-center gap-3">
          <LogoMark />
          <span className="text-xl font-bold tracking-tight">Support Flow</span>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-surface p-6 shadow-xl shadow-slate-900/20 sm:p-8">
          <Page title={title}>
            <p className="-mt-2 text-muted">{subtitle}</p>
            {children}
            <p className="border-t border-gray-200 pt-4 text-center text-sm text-muted">{footer}</p>
          </Page>
        </div>
      </div>
    </>
  );
}

type Errors = Partial<Record<'name' | 'email' | 'password', string>>;

export function LoginPage() {
  const state = useSession();
  const form = useRef<HTMLFormElement>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useFocusFirstInvalid(form, errors);

  const expired = state.status === 'anonymous' && state.reason === 'expired';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const local: Errors = {};
    if (!email.trim()) local.email = 'Informe seu e-mail.';
    if (!password) local.password = 'Informe sua senha.';
    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length > 0) return;

    setPending(true);
    try {
      await session.login({ email, password });
    } catch (error) {
      const { status } = toApiError(error);
      if (status === 400) {
        const found = fieldErrors(error, {
          email: 'Informe um e-mail válido.',
          password: 'Confira sua senha.',
        });
        setErrors(found);
        if (Object.keys(found).length === 0) setFormError(describeError(error));
      } else {
        setFormError(
          status === 401
            ? 'E-mail ou senha incorretos.'
            : describeError(error, { action: 'login' }),
        );
      }
      setPending(false);
    }
  };

  return (
    <AuthShell
      title="Entrar"
      subtitle="Acesse sua conta para continuar."
      footer={
        <>
          Ainda não tem conta?{' '}
          <Link className="link" to="/cadastro">
            Criar conta
          </Link>
        </>
      }
    >
      <div className="space-y-4">
        {expired && <FormAlert message="Sua sessão expirou. Entre de novo para continuar." />}
        <FormAlert message={formError} />
        <form ref={form} noValidate className="space-y-4" onSubmit={(e) => void submit(e)}>
          <TextField
            label="E-mail"
            type="email"
            autoComplete="email"
            value={email}
            error={errors.email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <PasswordField
            label="Senha"
            autoComplete="current-password"
            value={password}
            error={errors.password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <WakingNotice pending={pending} />
          <button type="submit" className="btn btn-primary w-full" disabled={pending}>
            {pending ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </div>
    </AuthShell>
  );
}

export const PASSWORD_MIN = 8;

export function RegisterPage() {
  const form = useRef<HTMLFormElement>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useFocusFirstInvalid(form, errors);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const local: Errors = {};
    if (!name.trim()) local.name = 'Informe seu nome.';
    if (!email.trim()) local.email = 'Informe seu e-mail.';
    if (password.length < PASSWORD_MIN) {
      local.password = `A senha precisa de pelo menos ${PASSWORD_MIN} caracteres.`;
    }
    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length > 0) return;

    setPending(true);
    try {
      await session.register({ name, email, password });
    } catch (error) {
      const { status } = toApiError(error);
      if (status === 409) {
        setErrors({ email: 'Já existe uma conta com este e-mail.' });
      } else if (status === 400) {
        setErrors(
          fieldErrors(error, {
            name: 'Informe um nome de até 100 caracteres.',
            email: 'Informe um e-mail válido.',
            password: `A senha precisa ter de ${PASSWORD_MIN} a 128 caracteres.`,
          }),
        );
      } else {
        setFormError(describeError(error));
      }
      setPending(false);
    }
  };

  return (
    <AuthShell
      title="Criar conta"
      subtitle="Abra tickets e acompanhe as respostas da equipe."
      footer={
        <>
          Já tem conta?{' '}
          <Link className="link" to="/entrar">
            Entrar
          </Link>
        </>
      }
    >
      <div className="space-y-4">
        <p className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
          Esta é uma demonstração pública. Não use dados nem senhas reais: invente um e-mail (não é
          preciso confirmá-lo, por exemplo nome@example.com) e uma senha nova. Contas e tickets são
          apagados todos os dias.
        </p>
        <FormAlert message={formError} />
        <form ref={form} noValidate className="space-y-4" onSubmit={(e) => void submit(e)}>
          <TextField
            label="Nome"
            autoComplete="name"
            maxLength={100}
            value={name}
            error={errors.name}
            onChange={(e) => setName(e.target.value)}
          />
          <TextField
            label="E-mail"
            type="email"
            autoComplete="email"
            value={email}
            error={errors.email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <PasswordField
            label="Senha"
            autoComplete="new-password"
            hint={`Pelo menos ${PASSWORD_MIN} caracteres.`}
            maxLength={128}
            value={password}
            error={errors.password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <WakingNotice pending={pending} />
          <button type="submit" className="btn btn-primary w-full" disabled={pending}>
            {pending ? 'Criando conta…' : 'Criar conta'}
          </button>
        </form>
      </div>
    </AuthShell>
  );
}
