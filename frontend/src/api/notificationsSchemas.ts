import { z } from 'zod';

/**
 * Notificações (notifications/api.go, `notificationJSON`). `payload` e `payload_type` vêm juntos ou ausentes.
 * Status: DEFAULT (nova), RECEIVED (entregue ao cliente), SEEN (lida).
 */
export const NotificationStatusSchema = z.enum(['DEFAULT', 'RECEIVED', 'SEEN']);

export const NotificationSchema = z.object({
  id: z.guid(),
  message: z.string(),
  redirect_url: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  payload_type: z.string().nullable(),
  status: NotificationStatusSchema,
  created_at: z.string(),
});

export const NotificationListSchema = z.object({
  notifications: z.array(NotificationSchema),
  next_base_notification_id: z.string().nullable(),
});

/** `errors` mapeia id -> motivo ("invalid id", "notification not found", ...). Pode vir com `updated > 0`. */
export const UpdateStateSchema = z.object({
  updated: z.number().int(),
  errors: z.record(z.string(), z.string()),
});

export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;
export type AppNotification = z.infer<typeof NotificationSchema>;
export type NotificationList = z.infer<typeof NotificationListSchema>;
export type UpdateState = z.infer<typeof UpdateStateSchema>;

/** Notificação ainda não lida. */
export const isUnread = (n: { status: NotificationStatus }): boolean => n.status !== 'SEEN';
