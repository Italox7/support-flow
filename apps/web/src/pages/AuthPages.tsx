import { useRef, useState, type FormEvent } from 'react';
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
        setFormError(status === 401 ? 'E-mail ou senha incorretos.' : describeError(error));
      }
      setPending(false);
    }
  };

  return (
    <Page title="Entrar">
      <div className="card max-w-md space-y-4">
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
        <p>
          Ainda não tem conta?{' '}
          <Link className="link" to="/cadastro">
            Criar conta
          </Link>
        </p>
      </div>
    </Page>
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
    <Page title="Criar conta">
      <div className="card max-w-md space-y-4">
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
        <p>
          Já tem conta?{' '}
          <Link className="link" to="/entrar">
            Entrar
          </Link>
        </p>
      </div>
    </Page>
  );
}
