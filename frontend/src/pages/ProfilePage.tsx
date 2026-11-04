import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { describeError, isAbortError, toApiError, type ErrorDescription } from '../api/errors';
import type { UserProfile } from '../api/schemas';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime } from '../components/format';
import { roleLabels } from '../components/roles';
import { Alert, Button, LoadingState, TextField } from '../components/ui';
import { usePageTitle } from '../components/usePageTitle';
import { profileSchema, type ProfileForm } from '../schemas/forms';
import { useServices } from '../services/ServicesContext';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; error: ErrorDescription }
  | { kind: 'loaded'; profile: UserProfile };

export function ProfilePage() {
  usePageTitle('Meu perfil');
  const { usersApi } = useServices();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // Um 401 aqui encerra a sessão pelo cliente HTTP e <RequireAuth> redireciona; não há tratamento duplicado.
  useEffect(() => {
    const controller = new AbortController();
    usersApi
      .getMe(controller.signal)
      .then((profile) => setState({ kind: 'loaded', profile }))
      .catch((e: unknown) => {
        if (!isAbortError(e)) setState({ kind: 'error', error: describeError(e) });
      });
    return () => controller.abort();
  }, [usersApi, attempt]);

  function retry() {
    setState({ kind: 'loading' });
    setAttempt((a) => a + 1);
  }

  return (
    <section className="card">
      <h1>Meu perfil</h1>
      {state.kind === 'loading' ? <LoadingState label="Carregando perfil…" /> : null}
      {state.kind === 'error' ? (
        <>
          <Alert kind="error" traceId={state.error.traceId}>
            {state.error.message}
          </Alert>
          <Button type="button" variant="secondary" onClick={retry}>
            Tentar novamente
          </Button>
        </>
      ) : null}
      {state.kind === 'loaded' ? (
        <ProfileDetails
          profile={state.profile}
          onSaved={(profile) => setState({ kind: 'loaded', profile })}
        />
      ) : null}
    </section>
  );
}

function ProfileDetails({
  profile,
  onSaved,
}: {
  profile: UserProfile;
  onSaved: (p: UserProfile) => void;
}) {
  const { usersApi } = useServices();
  const { updateUserName } = useAuth();
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState<ErrorDescription | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    defaultValues: { name: profile.name },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSaved(false);
    setFormError(null);
    try {
      const updated = await usersApi.updateMe({ name: values.name });
      updateUserName(updated.name);
      onSaved(updated);
      setSaved(true);
    } catch (e) {
      const err = toApiError(e);
      const nameIssue = err.fieldErrors.find((i) => i.field === 'name');
      if (nameIssue) setError('name', { message: nameIssue.message });
      else setFormError(describeError(err));
    }
  });

  return (
    <>
      <dl className="details">
        <dt>E-mail</dt>
        <dd>{profile.email}</dd>
        <dt>Papéis</dt>
        <dd>{roleLabels(profile.roles)}</dd>
        <dt>Conta criada em</dt>
        <dd>{formatDateTime(profile.createdAt)}</dd>
      </dl>
      <h2>Editar nome</h2>
      {saved ? <Alert kind="success">Perfil atualizado com sucesso.</Alert> : null}
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
        <Button type="submit" loading={isSubmitting} loadingText="Salvando…">
          Salvar
        </Button>
      </form>
    </>
  );
}
