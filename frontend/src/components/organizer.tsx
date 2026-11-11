import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { describeError, toApiError, type ErrorDescription } from '../api/errors';
import type { Activity, EventItem } from '../api/eventsSchemas';
import { activityDefaults, eventDefaults } from './organizerMeta';
import {
  activityFormSchema,
  eventFormSchema,
  type ActivityForm,
  type EventForm,
} from '../schemas/organizer';
import { Alert, Button, CheckboxField, TextAreaField, TextField } from './ui';

const SERVER_FIELD: Record<string, keyof EventForm> = {
  title: 'title',
  organization: 'organization',
  description: 'description',
  location: 'location',
  banner_url: 'bannerUrl',
  starts_at: 'startsAt',
  ends_at: 'endsAt',
};

/** Formulário de evento (criar e editar). `onSubmit` lança o erro da API; erros de campo voltam ao campo. */
export function EventFormFields({
  initial,
  submitLabel,
  loadingText,
  onSubmit,
  onCancel,
}: {
  initial?: EventItem | undefined;
  submitLabel: string;
  loadingText: string;
  onSubmit: (values: EventForm) => Promise<void>;
  onCancel?: (() => void) | undefined;
}) {
  const [formError, setFormError] = useState<ErrorDescription | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<EventForm>({
    resolver: zodResolver(eventFormSchema),
    defaultValues: eventDefaults(initial),
  });

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await onSubmit(values);
    } catch (e) {
      const err = toApiError(e);
      const mapped = err.fieldErrors.filter((i) => i.field in SERVER_FIELD);
      for (const i of mapped) setError(SERVER_FIELD[i.field]!, { message: i.message });
      if (mapped.length === 0) setFormError(describeError(err));
    }
  });

  return (
    <form onSubmit={submit} noValidate>
      {formError ? (
        <Alert kind="error" traceId={formError.traceId}>
          {formError.message}
        </Alert>
      ) : null}
      <TextField label="Título" error={errors.title?.message} {...register('title')} />
      <TextField
        label="Organização"
        error={errors.organization?.message}
        {...register('organization')}
      />
      <TextAreaField
        label="Descrição"
        error={errors.description?.message}
        {...register('description')}
      />
      <TextField label="Local" error={errors.location?.message} {...register('location')} />
      <TextField
        label="Endereço do banner"
        type="url"
        hint="Opcional. O endereço deve ser seguro (começando com https)."
        error={errors.bannerUrl?.message}
        {...register('bannerUrl')}
      />
      <TextField
        label="Início"
        type="datetime-local"
        error={errors.startsAt?.message}
        {...register('startsAt')}
      />
      <TextField
        label="Término"
        type="datetime-local"
        error={errors.endsAt?.message}
        {...register('endsAt')}
      />
      <div className="row-actions">
        <Button type="submit" loading={isSubmitting} loadingText={loadingText}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" variant="secondary" disabled={isSubmitting} onClick={onCancel}>
            Fechar
          </Button>
        ) : null}
      </div>
    </form>
  );
}

const SERVER_ACTIVITY_FIELD: Record<string, keyof ActivityForm> = {
  title: 'title',
  description: 'description',
  speaker: 'speaker',
  location: 'location',
  starts_at: 'startsAt',
  ends_at: 'endsAt',
  amount_minor: 'price',
  capacity: 'capacity',
  waitlist_enabled: 'waitlistEnabled',
};

/**
 * Formulário de atividade. Ao editar, a capacidade é só leitura (imutável no serviço) e o preço só muda
 * enquanto o evento é rascunho (o serviço recusa com EVENT_NOT_DRAFT; aqui o campo já vem desabilitado).
 */
export function ActivityFormFields({
  initial,
  priceLocked = false,
  submitLabel,
  loadingText,
  onSubmit,
  onCancel,
}: {
  initial?: Activity | undefined;
  priceLocked?: boolean;
  submitLabel: string;
  loadingText: string;
  onSubmit: (values: ActivityForm) => Promise<void>;
  onCancel?: (() => void) | undefined;
}) {
  const [formError, setFormError] = useState<ErrorDescription | null>(null);
  const editing = initial !== undefined;
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ActivityForm>({
    resolver: zodResolver(activityFormSchema),
    defaultValues: activityDefaults(initial),
  });

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await onSubmit(values);
    } catch (e) {
      const err = toApiError(e);
      const mapped = err.fieldErrors.filter((i) => i.field in SERVER_ACTIVITY_FIELD);
      for (const i of mapped) setError(SERVER_ACTIVITY_FIELD[i.field]!, { message: i.message });
      if (mapped.length === 0) setFormError(describeError(err));
    }
  });

  return (
    <form onSubmit={submit} noValidate aria-label={editing ? 'Editar atividade' : 'Nova atividade'}>
      {formError ? (
        <Alert kind="error" traceId={formError.traceId}>
          {formError.message}
        </Alert>
      ) : null}
      <TextField label="Título da atividade" error={errors.title?.message} {...register('title')} />
      <TextAreaField
        label="Descrição da atividade"
        error={errors.description?.message}
        {...register('description')}
      />
      <TextField label="Palestrante" error={errors.speaker?.message} {...register('speaker')} />
      <TextField
        label="Local da atividade"
        error={errors.location?.message}
        {...register('location')}
      />
      <TextField
        label="Início da atividade"
        type="datetime-local"
        error={errors.startsAt?.message}
        {...register('startsAt')}
      />
      <TextField
        label="Término da atividade"
        type="datetime-local"
        error={errors.endsAt?.message}
        {...register('endsAt')}
      />
      <TextField
        label="Valor da inscrição (R$)"
        inputMode="decimal"
        hint={
          priceLocked
            ? 'O valor só pode mudar enquanto o evento é rascunho.'
            : 'Deixe vazio para atividade gratuita.'
        }
        readOnly={priceLocked}
        error={errors.price?.message}
        {...register('price')}
      />
      <TextField
        label="Capacidade"
        inputMode="numeric"
        hint={editing ? 'A capacidade não pode ser alterada depois de criada.' : undefined}
        readOnly={editing}
        error={errors.capacity?.message}
        {...register('capacity')}
      />
      <CheckboxField
        label="Permitir lista de espera"
        hint="Quem não conseguir vaga pode entrar na fila."
        {...register('waitlistEnabled')}
      />
      <div className="row-actions">
        <Button type="submit" loading={isSubmitting} loadingText={loadingText}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" variant="secondary" disabled={isSubmitting} onClick={onCancel}>
            Fechar
          </Button>
        ) : null}
      </div>
    </form>
  );
}
