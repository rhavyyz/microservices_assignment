import { z } from 'zod';

/**
 * Schemas das respostas do serviço de Inscrições (subscription/app/api.py e service.py). A inscrição é a linha da
 * tabela `registrations` serializada como está; as datas chegam com `str(datetime)` do Python
 * ("2026-11-03 23:25:45.175467+00:00"), por isso aqui continuam texto e `parseApiDate` as normaliza.
 */
export const RegistrationStatusSchema = z.enum([
  'WAITLISTED',
  'OFFERED',
  'PENDING_PAYMENT',
  'CONFIRMED',
  'CANCELLED',
  'EXPIRED',
  'REJECTED',
]);

export const RegistrationSchema = z.object({
  id: z.guid(),
  activity_id: z.guid(),
  user_id: z.guid(),
  status: RegistrationStatusSchema,
  amount_minor: z.number().int(),
  currency: z.string(),
  expires_at: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  /** Evento da atividade; nulo em inscrições anteriores à migração 004. */
  parent_event_id: z.guid().nullish(),
});

/** Vagas de uma atividade, contadas por Inscrições (leitura informativa; só a criação da inscrição reserva). */
export const AvailabilitySchema = z.object({
  activity_id: z.guid(),
  capacity: z.number().int(),
  reserved: z.number().int(),
  confirmed: z.number().int(),
  available: z.number().int(),
  registration_open: z.boolean(),
});

/** Presença registrada no check-in (tabela `attendance`). */
export const AttendanceSchema = z.object({
  registration_id: z.guid(),
  checked_in_at: z.string(),
  recorded_by: z.guid(),
  eligible_emitted: z.boolean(),
});

export const RegistrationListSchema = z.object({ registrations: z.array(RegistrationSchema) });

export type Attendance = z.infer<typeof AttendanceSchema>;
export type RegistrationStatus = z.infer<typeof RegistrationStatusSchema>;
export type Availability = z.infer<typeof AvailabilitySchema>;
export type Registration = z.infer<typeof RegistrationSchema>;

/** Estados em que a inscrição ainda está viva (pode ser cancelada). Espelha `ACTIVE` em service.py. */
export const ACTIVE_STATUSES: readonly RegistrationStatus[] = [
  'WAITLISTED',
  'OFFERED',
  'PENDING_PAYMENT',
  'CONFIRMED',
];
