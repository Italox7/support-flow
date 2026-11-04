import {
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react';

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
}

function FieldShell({
  id,
  label,
  error,
  hint,
  children,
}: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block font-medium">
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function ariaProps(id: string, { error, hint }: FieldProps) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ');
  return { 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy || undefined };
}

export function TextField({
  label,
  error,
  hint,
  ...input
}: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} error={error} hint={hint}>
      <input id={id} className="input" {...ariaProps(id, { label, error, hint })} {...input} />
    </FieldShell>
  );
}

export function TextAreaField({
  label,
  error,
  hint,
  textareaRef,
  ...input
}: FieldProps &
  TextareaHTMLAttributes<HTMLTextAreaElement> & {
    textareaRef?: Ref<HTMLTextAreaElement>;
  }) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} error={error} hint={hint}>
      <textarea
        id={id}
        ref={textareaRef}
        className="input"
        rows={5}
        {...ariaProps(id, { label, error, hint })}
        {...input}
      />
    </FieldShell>
  );
}

export function PasswordField({
  label,
  error,
  hint,
  ...input
}: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <FieldShell id={id} label={label} error={error} hint={hint}>
      <div className="flex gap-2">
        <input
          id={id}
          className="input"
          {...ariaProps(id, { label, error, hint })}
          {...input}
          type={visible ? 'text' : 'password'}
        />
        <button
          type="button"
          className="btn shrink-0"
          aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? 'Ocultar' : 'Mostrar'}
        </button>
      </div>
    </FieldShell>
  );
}
