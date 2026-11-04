import { z } from 'zod';

/**
 * Pagamento como o serviço de Pagamentos o serializa (`view()` em payments/src/payments.ts). Datas em ISO 8601.
 * `event_id` e `activity_id` são nulos em pagamentos criados antes de o serviço guardá-los.
 */
export const PaymentStatusSchema = z.enum([
  'PENDING',
  'APPROVED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
  'REFUNDED',
]);

export const PaymentSchema = z.object({
  payment_id: z.guid(),
  registration_id: z.guid(),
  user_id: z.guid(),
  event_id: z.guid().nullish(),
  activity_id: z.guid().nullish(),
  amount_minor: z.number().int(),
  currency: z.string(),
  status: PaymentStatusSchema,
  expires_at: z.string(),
  created_at: z.string(),
});

export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;
export type Payment = z.infer<typeof PaymentSchema>;
export type SimulateAction = 'approve' | 'decline' | 'expire';

/** Estados finais: o pagamento não muda mais (README de Pagamentos). */
export const FINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'APPROVED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
  'REFUNDED',
];
