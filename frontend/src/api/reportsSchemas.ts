import { z } from 'zod';

/**
 * Relatórios (reports/src/server.ts e queries.ts). Valores em unidades inteiras; dinheiro em centavos, sempre
 * por moeda (nunca somado entre moedas). Taxas são 0–1 ou `null` quando o denominador é zero.
 */
const count = z.number().int().nonnegative();
const rate = z.number().nullable();

export const MoneySchema = z.object({ currency: z.string(), amount_minor: z.number().int() });

export const ReportEventSchema = z.object({
  event_id: z.guid(),
  organizer_id: z.string().nullable(),
  name: z.string().nullable(),
  status: z.string(),
  starts_at: z.string().nullable(),
  ends_at: z.string().nullable(),
});

export const RegistrationsSchema = z.object({
  pending_payment: count,
  offered: count,
  confirmed: count,
  waitlisted: count,
  cancelled: count,
  expired: count,
  rejected: count,
  total: count,
});

export const PaymentsSchema = z.object({
  pending: count,
  approved: count,
  declined: count,
  expired: count,
  cancelled: count,
  refunded_count: count,
  revenue: z.array(MoneySchema),
  refunded: z.array(MoneySchema),
});

export const OccupancySchema = z.object({ capacity: count, occupied: count, rate });

export const AttendanceSchema = z.object({
  confirmed: count,
  checkins: count,
  rate,
  certificate_eligible: count,
  certificate_eligible_rate: rate,
});

export const LifecycleCountsSchema = z.object({ open: count, ended: count, cancelled: count });

export const SummarySchema = z.object({
  event: ReportEventSchema,
  registrations: RegistrationsSchema,
  payments: PaymentsSchema,
  occupancy: OccupancySchema,
  attendance: AttendanceSchema,
  activities: LifecycleCountsSchema,
});

export const ActivityReportSchema = z.object({
  activity_id: z.guid(),
  name: z.string().nullable(),
  capacity: z.number().int().nullable(),
  paid: z.boolean(),
  lifecycle: z.enum(['OPEN', 'ENDED', 'CANCELLED', 'DELETED']),
  ended_at: z.string().nullable(),
  pending_payment: count,
  offered: count,
  confirmed: count,
  waitlisted: count,
  cancelled: count,
  expired: count,
  rejected: count,
  payments_approved: count,
  revenue: z.array(MoneySchema),
  refunded: z.array(MoneySchema),
  occupied: count,
  occupancy_rate: rate,
  checkins: count,
  attendance_rate: rate,
});

export const ActivityReportPageSchema = z.object({
  items: z.array(ActivityReportSchema),
  total: count,
  limit: z.number().int(),
  offset: z.number().int(),
  activities: LifecycleCountsSchema,
});

export type Money = z.infer<typeof MoneySchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type ActivityReport = z.infer<typeof ActivityReportSchema>;
export type ActivityReportPage = z.infer<typeof ActivityReportPageSchema>;
