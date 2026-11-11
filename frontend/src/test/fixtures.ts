// Formatos reais dos serviços (events/src/http/schemas.ts e subscription/app/*). Datas "abertas" ficam em 2099 e
// "encerradas" em 2000, para os testes não dependerem do dia em que rodam.
export const EVENT_ID = '11111111-1111-4111-8111-111111111111';
export const ACTIVITY_ID = '22222222-2222-4222-8222-222222222222';
export const REGISTRATION_ID = '33333333-3333-4333-8333-333333333333';
const USER = '00ec3dc4-9986-4159-b37f-9cc1087b9203';

export const event = (over: Record<string, unknown> = {}) => ({
  event_id: EVENT_ID,
  organizer_id: 'org-1',
  title: 'Semana de Tecnologia',
  organization: 'Universidade Exemplo',
  description: 'Palestras e oficinas.',
  location: 'Campus Central',
  banner_url: null,
  starts_at: '2099-03-10T12:00:00.000Z',
  ends_at: '2099-03-12T21:00:00.000Z',
  status: 'PUBLISHED',
  created_at: '2026-11-01T10:00:00.000Z',
  updated_at: '2026-11-01T10:00:00.000Z',
  ...over,
});

export const activity = (over: Record<string, unknown> = {}) => ({
  activity_id: ACTIVITY_ID,
  event_id: EVENT_ID,
  title: 'Oficina de React',
  description: null,
  speaker: 'Ana Souza',
  location: 'Sala 2',
  starts_at: '2099-03-10T13:00:00.000Z',
  ends_at: '2099-03-10T15:00:00.000Z',
  capacity: 30,
  amount_minor: 5000,
  currency: 'BRL',
  paid: true,
  waitlist_enabled: true,
  registration_open: true,
  lifecycle: 'OPEN',
  ended_at: null,
  created_at: '2026-11-01T10:00:00.000Z',
  updated_at: '2026-11-01T10:00:00.000Z',
  ...over,
});

export const eventDetail = (
  over: Record<string, unknown> = {},
  activities: unknown[] = [activity()],
) => ({
  ...event(over),
  activities,
});

export const eventPage = (items: unknown[], total = items.length, offset = 0) => ({
  items,
  total,
  limit: 12,
  offset,
});

/** Inscrição como o serviço a serializa: linha da tabela, datas no formato str(datetime) do Python. */
export const registration = (over: Record<string, unknown> = {}) => ({
  id: REGISTRATION_ID,
  activity_id: ACTIVITY_ID,
  user_id: USER,
  status: 'CONFIRMED',
  amount_minor: 5000,
  currency: 'BRL',
  expires_at: null,
  version: 1,
  created_at: '2026-11-03 23:25:45.175467+00:00',
  updated_at: '2026-11-03 23:25:45.175467+00:00',
  parent_event_id: EVENT_ID,
  ...over,
});

/** Vagas como Inscrições as informa (GET /activities/{id}/availability). */
export const availability = (over: Record<string, unknown> = {}) => ({
  activity_id: ACTIVITY_ID,
  capacity: 30,
  reserved: 10,
  confirmed: 8,
  available: 12,
  registration_open: true,
  ...over,
});

/** Presença como Inscrições a serializa (tabela `attendance`). */
export const attendance = (over: Record<string, unknown> = {}) => ({
  registration_id: REGISTRATION_ID,
  checked_in_at: '2099-03-10 13:05:00.123456+00:00',
  recorded_by: '00ec3dc4-9986-4159-b37f-9cc1087b9203',
  eligible_emitted: false,
  ...over,
});

export const PAYMENT_ID = '66666666-6666-4666-8666-666666666666';
export const NOTIFICATION_ID = '77777777-7777-4777-8777-777777777777';

/** Pagamento como Pagamentos o serializa (payments/src/payments.ts). */
export const payment = (over: Record<string, unknown> = {}) => ({
  payment_id: PAYMENT_ID,
  registration_id: REGISTRATION_ID,
  user_id: USER,
  event_id: EVENT_ID,
  activity_id: ACTIVITY_ID,
  amount_minor: 5000,
  currency: 'BRL',
  status: 'PENDING',
  expires_at: '2099-03-10T12:15:00.000Z',
  created_at: '2026-11-10T12:00:00.000Z',
  ...over,
});

/** Notificação como o serviço de Notificações a serializa (notifications/api.go). */
export const notification = (over: Record<string, unknown> = {}) => ({
  id: NOTIFICATION_ID,
  message: 'Seu pagamento de BRL 50.00 foi aprovado.',
  redirect_url: null,
  payload: { payment_id: PAYMENT_ID, registration_id: REGISTRATION_ID, status: 'APPROVED' },
  payload_type: 'payment',
  status: 'DEFAULT',
  created_at: '2026-11-10T12:05:00.123Z',
  ...over,
});

export const notificationList = (items: unknown[], next: string | null = null) => ({
  notifications: items,
  next_base_notification_id: next,
});

export const CERTIFICATE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Certificado como o serviço o lista (certificates/app/schemas/certificate.py). */
export const certificate = (over: Record<string, unknown> = {}) => ({
  id: CERTIFICATE_ID,
  registration_id: REGISTRATION_ID,
  activity_id: ACTIVITY_ID,
  event_id: EVENT_ID,
  issued_at: '2026-11-10T15:00:00.123456Z',
  ...over,
});

/** Resumo de Relatórios (reports/src/server.ts, rota /summary). */
export const reportSummary = (over: Record<string, unknown> = {}) => ({
  event: {
    event_id: EVENT_ID,
    name: 'Semana de Tecnologia',
    status: 'PUBLISHED',
    starts_at: '2099-03-10T12:00:00.000Z',
    ends_at: '2099-03-12T21:00:00.000Z',
  },
  registrations: {
    pending_payment: 1,
    offered: 2,
    confirmed: 4,
    waitlisted: 3,
    cancelled: 5,
    expired: 6,
    rejected: 7,
    total: 28,
  },
  payments: {
    pending: 1,
    approved: 2,
    declined: 0,
    expired: 0,
    cancelled: 0,
    refunded_count: 1,
    revenue: [
      { currency: 'BRL', amount_minor: 2500 },
      { currency: 'USD', amount_minor: 1000 },
    ],
    refunded: [{ currency: 'BRL', amount_minor: 700 }],
  },
  occupancy: { capacity: 20, occupied: 7, rate: 0.35 },
  attendance: {
    confirmed: 4,
    checkins: 3,
    rate: 0.75,
    certificate_eligible: 2,
    certificate_eligible_rate: 0.6667,
  },
  activities: { open: 1, ended: 2, cancelled: 1 },
  ...over,
});

export const activityReport = (over: Record<string, unknown> = {}) => ({
  activity_id: ACTIVITY_ID,
  name: 'Oficina de React',
  capacity: 30,
  paid: true,
  lifecycle: 'OPEN',
  ended_at: null,
  pending_payment: 1,
  offered: 0,
  confirmed: 4,
  waitlisted: 2,
  cancelled: 0,
  expired: 0,
  rejected: 0,
  payments_approved: 4,
  revenue: [{ currency: 'BRL', amount_minor: 20000 }],
  refunded: [],
  occupied: 5,
  occupancy_rate: 0.1667,
  checkins: 3,
  attendance_rate: 0.75,
  ...over,
});

export const activityReportPage = (items: unknown[], total = items.length) => ({
  items,
  total,
  limit: 20,
  offset: 0,
  activities: { open: 1, ended: 0, cancelled: 0 },
});
