import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation } from 'react-router';
import { describeError, type ErrorDescription } from '../api/errors';
import { useAuth } from '../auth/AuthContext';
import { Alert, Button, TextField } from '../components/ui';
import { usePageTitle } from '../components/usePageTitle';
import { loginSchema, type LoginForm } from '../schemas/forms';

export function LoginPage() {
  usePageTitle('Entrar');
  const { login, notice, clearNotice } = useAuth();
  const location = useLocation();
  const justRegistered = (location.state as { registered?: boolean } | null)?.registered === true;
  const [formError, setFormError] = useState<ErrorDescription | null>(null);
  const {
    register,
    handleSubmit,
    resetField,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  // Sucesso: a sessão passa a existir e <GuestOnly> leva ao destino original. 401 de credenciais aparece aqui,
  // sem redirecionamento (o login não é uma requisição autenticada, então não dispara o encerramento de sessão).
  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    clearNotice();
    try {
      await login(values.email, values.password);
    } catch (e) {
      setFormError(describeError(e));
      resetField('password');
    }
  });

  return (
    <section className="card">
      <h1>Entrar</h1>
      {notice ? <Alert kind="info">{notice}</Alert> : null}
      {justRegistered ? (
        <Alert kind="success">Cadastro realizado. Entre com seu e-mail e senha.</Alert>
      ) : null}
      {formError ? (
        <Alert kind="error" traceId={formError.traceId}>
          {formError.message}
        </Alert>
      ) : null}
      <form onSubmit={onSubmit} noValidate>
        <TextField
          label="E-mail"
          type="email"
          autoComplete="username"
          inputMode="email"
          error={errors.email?.message}
          {...register('email')}
        />
        <TextField
          label="Senha"
          type="password"
          autoComplete="current-password"
          error={errors.password?.message}
          {...register('password')}
        />
        <Button type="submit" loading={isSubmitting} loadingText="Entrando…">
          Entrar
        </Button>
      </form>
      <p className="form-footer">
        Ainda não tem conta? <Link to="/cadastro">Cadastre-se</Link>
      </p>
    </section>
  );
}
