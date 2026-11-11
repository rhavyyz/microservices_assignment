import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { toApiError, describeError, type ErrorDescription } from '../api/errors';
import { Alert, Button, TextField } from '../components/ui';
import { usePageTitle } from '../components/usePageTitle';
import { registerSchema, type RegisterForm } from '../schemas/forms';
import { useServices } from '../services/ServicesContext';

const FIELDS = ['name', 'email', 'password'] as const;
type RegisterField = (typeof FIELDS)[number];
const isRegisterField = (f: string): f is RegisterField =>
  (FIELDS as readonly string[]).includes(f);

export function RegisterPage() {
  usePageTitle('Cadastro');
  const { usersApi } = useServices();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<ErrorDescription | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      name: '',
      email: '',
      password: '',
      confirmPassword: '',
      accountType: 'PARTICIPANT',
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await usersApi.register({
        name: values.name,
        email: values.email,
        password: values.password,
        requestedRole: values.accountType,
      });
      void navigate('/entrar', {
        replace: true,
        state: { registered: true, organizerRequested: values.accountType === 'ORGANIZER' },
      });
    } catch (e) {
      const err = toApiError(e);
      // Erros de validação do servidor voltam para o campo correspondente.
      const mapped = err.fieldErrors.filter((i) => isRegisterField(i.field));
      for (const issue of mapped)
        setError(issue.field as RegisterField, { message: issue.message });
      if (err.code === 'EMAIL_ALREADY_REGISTERED') {
        setError('email', { message: err.message });
      } else if (mapped.length === 0) {
        setFormError(describeError(err));
      }
    }
  });

  return (
    <section className="card">
      <h1>Criar conta</h1>
      <p className="lead">Cadastre-se para participar dos eventos.</p>
      {formError ? (
        <Alert kind="error" traceId={formError.traceId}>
          {formError.message}
        </Alert>
      ) : null}
      <form onSubmit={onSubmit} noValidate>
        <TextField
          label="Nome completo"
          autoComplete="name"
          error={errors.name?.message}
          {...register('name')}
        />
        <TextField
          label="E-mail"
          type="email"
          autoComplete="email"
          inputMode="email"
          error={errors.email?.message}
          {...register('email')}
        />
        <TextField
          label="Senha"
          type="password"
          autoComplete="new-password"
          hint="Use de 10 a 72 caracteres."
          error={errors.password?.message}
          {...register('password')}
        />
        <TextField
          label="Confirmar senha"
          type="password"
          autoComplete="new-password"
          error={errors.confirmPassword?.message}
          {...register('confirmPassword')}
        />
        <fieldset className="field-group">
          <legend>Tipo de conta</legend>
          <div className="field field-check">
            <input
              id="account-participant"
              type="radio"
              value="PARTICIPANT"
              {...register('accountType')}
            />
            <label htmlFor="account-participant">Participante</label>
          </div>
          <div className="field field-check">
            <input
              id="account-organizer"
              type="radio"
              value="ORGANIZER"
              {...register('accountType')}
            />
            <label htmlFor="account-organizer">Organizador</label>
            <p className="field-hint">
              Quem se cadastra como organizador começa como participante. Um administrador precisa
              aprovar o pedido antes de você poder criar eventos.
            </p>
          </div>
        </fieldset>
        <Button type="submit" loading={isSubmitting} loadingText="Cadastrando…">
          Cadastrar
        </Button>
      </form>
      <p className="form-footer">
        Já tem conta? <Link to="/entrar">Entrar</Link>
      </p>
    </section>
  );
}
