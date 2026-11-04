import type { ComponentPropsWithRef, ReactNode } from 'react';

interface TextFieldProps extends ComponentPropsWithRef<'input'> {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
}

/** Campo de texto acessível: label associado, erro anunciado e ligado ao input por aria-describedby. */
export function TextField({ label, error, hint, id, ref, ...rest }: TextFieldProps) {
  const inputId = id ?? `field-${rest.name ?? label}`;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        ref={ref}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint ? (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface ButtonProps extends ComponentPropsWithRef<'button'> {
  loading?: boolean;
  loadingText?: string;
  variant?: 'primary' | 'secondary' | 'link';
}

/** Botão que se desabilita enquanto carrega, evitando envio duplicado. */
export function Button({
  loading = false,
  loadingText,
  variant = 'primary',
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`btn btn-${variant}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (loadingText ?? 'Aguarde…') : children}
    </button>
  );
}

export function Alert({
  kind,
  children,
  traceId,
}: {
  kind: 'error' | 'success' | 'info';
  children: ReactNode;
  traceId?: string | undefined;
}) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <p>{children}</p>
      {traceId ? <p className="alert-trace">Código de suporte: {traceId}</p> : null}
    </div>
  );
}

export function LoadingState({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

interface TextAreaFieldProps extends ComponentPropsWithRef<'textarea'> {
  label: string;
  error?: string | undefined;
}

export function TextAreaField({ label, error, id, ref, ...rest }: TextAreaFieldProps) {
  const inputId = id ?? `field-${rest.name ?? label}`;
  const errorId = `${inputId}-error`;
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <textarea
        id={inputId}
        ref={ref}
        rows={4}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...rest}
      />
      {error ? (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface CheckboxFieldProps extends Omit<ComponentPropsWithRef<'input'>, 'type'> {
  label: string;
  hint?: string | undefined;
}

export function CheckboxField({ label, hint, id, ref, ...rest }: CheckboxFieldProps) {
  const inputId = id ?? `field-${rest.name ?? label}`;
  return (
    <div className="field field-check">
      <input id={inputId} ref={ref} type="checkbox" {...rest} />
      <label htmlFor={inputId}>{label}</label>
      {hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}
