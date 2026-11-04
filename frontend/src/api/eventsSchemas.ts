import { z } from 'zod';

/**
 * Schemas das respostas do serviço de Eventos (events/src/http/schemas.ts). Campos em snake_case, datas ISO 8601 em
 * UTC, valores em unidades menores da moeda (`amount_minor`, centavos de BRL). O serviço NÃO informa vagas livres:
 * quem conta as vagas ocupadas é Inscrições (`GET /activities/{id}/availability`).
 */
const nullableText = z.string().nullable();

export const EventStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'CANCELLED']);

export const ActivityLifecycleSchema = z.enum(['OPEN', 'ENDED', 'CANCELLED']);

export const EventSchema = z.object({
  event_id: z.guid(),
  organizer_id: z.string(),
  title: z.string(),
  organization: nullableText,
  description: nullableText,
  location: nullableText,
  banner_url: nullableText,
  starts_at: z.string(),
  ends_at: z.string(),
  status: EventStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

export const ActivitySchema = z.object({
  activity_id: z.guid(),
  event_id: z.guid(),
  title: z.string(),
  description: nullableText,
  speaker: nullableText,
  location: nullableText,
  starts_at: z.string(),
  ends_at: z.string(),
  capacity: z.number().int(),
  amount_minor: z.number().int(),
  currency: z.string(),
  paid: z.boolean(),
  waitlist_enabled: z.boolean(),
  /** Evento publicado, atividade aberta e ainda não iniciada. */
  registration_open: z.boolean(),
  lifecycle: ActivityLifecycleSchema,
  ended_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const EventDetailSchema = EventSchema.extend({ activities: z.array(ActivitySchema) });

export const EventPageSchema = z.object({
  items: z.array(EventSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

export type ActivityLifecycle = z.infer<typeof ActivityLifecycleSchema>;
export type EventStatus = z.infer<typeof EventStatusSchema>;
export type EventItem = z.infer<typeof EventSchema>;
export type Activity = z.infer<typeof ActivitySchema>;
export type EventDetail = z.infer<typeof EventDetailSchema>;
export type EventPage = z.infer<typeof EventPageSchema>;
