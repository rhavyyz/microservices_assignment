import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, type Change } from '../src/contracts.ts';

// Fixtures are shaped like the producers' output: a FLAT envelope (message_id, schema_version, type,
// occurred_at with offset, trace_id) with the type's fields at the root. Envelope fields come last, as
// in events/src/messaging/envelope.ts.
const OCCURRED = '2026-10-31T12:00:00.000-03:00';
const ids = {
  event: '22222222-2222-4222-8222-222222222222',
  activity: '11111111-1111-4111-8111-111111111111',
  registration: '33333333-3333-4333-8333-333333333333',
  payment: '44444444-4444-4444-8444-444444444444',
  user: '55555555-5555-4555-8555-555555555555',
  organizer: '66666666-6666-4666-8666-666666666666',
};

const msg = (type: string, fields: object, extra: object = {}) =>
  JSON.stringify({
    ...fields,
    message_id: '77777777-7777-4777-8777-777777777777',
    schema_version: 1,
    type,
    occurred_at: OCCURRED,
    trace_id: null,
    ...extra,
  });

// Events service (events/src/messaging/messages.ts)
const eventFields = {
  event_id: ids.event,
  organizer_id: ids.organizer,
  organization: 'Org',
  name: 'Conf',
  status: 'DRAFT',
  starts_at: '2026-12-01T12:00:00.000Z',
  ends_at: '2026-12-01T18:00:00.000Z',
};
const activityFields = {
  activity_id: ids.activity,
  event_id: ids.event,
  name: 'Workshop',
  starts_at: '2026-12-01T12:00:00.000Z',
  ends_at: '2026-12-01T18:00:00.000Z',
  capacity: 100,
  amount_minor: 2500,
  currency: 'BRL',
  paid: true,
  waitlist_enabled: true,
};
// Subscription service: registration and check-in messages carry event_id.
const registrationFields = {
  registration_id: ids.registration,
  event_id: ids.event,
  activity_id: ids.activity,
  user_id: ids.user,
  aggregate_version: 3,
  status: 'CONFIRMED',
};
// Payments service (payments/src/events.ts buildPaymentEvent)
const paymentFields = {
  payment_id: ids.payment,
  registration_id: ids.registration,
  user_id: ids.user,
  event_id: ids.event,
  activity_id: ids.activity,
  amount_minor: 2500,
  currency: 'BRL',
  status: 'APPROVED',
  reason: null,
};

function change(raw: string): Change {
  const r = parseMessage(raw);
  assert.ok(r.ok, r.ok ? '' : r.error);
  return r.value.change;
}

test('envelope: flat fields, schema_version, ISO offset, null trace_id', () => {
  const r = parseMessage(msg('EventCreated', eventFields));
  assert.ok(r.ok);
  assert.deepEqual(r.value.envelope, {
    message_id: '77777777-7777-4777-8777-777777777777',
    type: 'EventCreated',
    schema_version: 1,
    occurred_at: OCCURRED,
    trace_id: null,
  });
});

test('envelope: trace_id string is kept', () => {
  const r = parseMessage(msg('EventCreated', eventFields, { trace_id: 't1' }));
  assert.ok(r.ok);
  assert.equal(r.value.envelope.trace_id, 't1');
});

test('EventCreated takes organizer, name and status from the root', () => {
  assert.deepEqual(change(msg('EventCreated', eventFields)), {
    kind: 'event', eventId: ids.event, organizerId: ids.organizer, name: 'Conf', status: 'DRAFT',
    startsAt: '2026-12-01T12:00:00.000Z', endsAt: '2026-12-01T18:00:00.000Z',
  });
});

test('EventUpdated takes status from the message', () => {
  const c = change(msg('EventUpdated', { ...eventFields, status: 'PUBLISHED', name: 'Conf 2' }));
  assert.ok(c.kind === 'event');
  assert.equal(c.status, 'PUBLISHED');
  assert.equal(c.name, 'Conf 2');
});

test('EventPublished forces PUBLISHED', () => {
  const c = change(msg('EventPublished', { ...eventFields, status: 'DRAFT' }));
  assert.ok(c.kind === 'event');
  assert.equal(c.status, 'PUBLISHED');
});

test('EventCancelled forces CANCELLED', () => {
  const c = change(msg('EventCancelled', { ...eventFields, status: 'PUBLISHED' }));
  assert.ok(c.kind === 'event');
  assert.equal(c.status, 'CANCELLED');
});

test('ActivityCreated and ActivityUpdated read capacity and paid', () => {
  for (const type of ['ActivityCreated', 'ActivityUpdated']) {
    assert.deepEqual(change(msg(type, activityFields)), {
      kind: 'activity', activityId: ids.activity, eventId: ids.event, name: 'Workshop', capacity: 100, paid: true,
    });
  }
});

test('payment types map to their status', () => {
  const expected: Record<string, string> = {
    PaymentCreated: 'PENDING',
    PaymentApproved: 'APPROVED',
    PaymentDeclined: 'DECLINED',
    PaymentExpired: 'EXPIRED',
    PaymentCancelled: 'CANCELLED',
    PaymentRefunded: 'REFUNDED',
  };
  for (const [type, status] of Object.entries(expected)) {
    assert.deepEqual(change(msg(type, paymentFields)), {
      kind: 'payment', paymentId: ids.payment, registrationId: ids.registration, eventId: ids.event,
      activityId: ids.activity, amountMinor: 2500, currency: 'BRL', status,
    });
  }
});

test('payment without activity_id (nullable) is accepted', () => {
  const c = change(msg('PaymentCreated', { ...paymentFields, activity_id: null }));
  assert.ok(c.kind === 'payment');
  assert.equal(c.activityId, null);
});

test('amount_minor is kept as an integer, with no decimal conversion', () => {
  const amount = (minor: number) => {
    const c = change(msg('PaymentApproved', { ...paymentFields, amount_minor: minor }));
    assert.ok(c.kind === 'payment');
    return c.amountMinor;
  };
  for (const minor of [2500, 5, 0, 10, 123456789, Number.MAX_SAFE_INTEGER]) assert.equal(amount(minor), minor);
});

test('amount_minor must be a non-negative safe integer', () => {
  for (const bad of [25.5, -1, '2500', true, Number.MAX_SAFE_INTEGER + 1]) {
    const r = parseMessage(msg('PaymentApproved', { ...paymentFields, amount_minor: bad }));
    assert.ok(!r.ok, `accepted ${String(bad)}`);
    assert.match(r.error, /amount_minor must be a non-negative integer/);
  }
});

test('a missing or null amount_minor is stored as no amount (the row keeps its previous one)', () => {
  for (const amount_minor of [null, undefined]) {
    const c = change(msg('PaymentApproved', { ...paymentFields, amount_minor }));
    assert.ok(c.kind === 'payment');
    assert.equal(c.amountMinor, null);
  }
});

test('payments without event_id are rejected', () => {
  const r = parseMessage(msg('PaymentApproved', { ...paymentFields, event_id: null }));
  assert.ok(!r.ok);
  assert.match(r.error, /event_id is required/);
});

test('registration and check-in messages without event_id are rejected', () => {
  const types = [
    'RegistrationPendingPayment', 'RegistrationConfirmed', 'RegistrationWaitlisted', 'WaitlistOffered',
    'RegistrationCancelled', 'RegistrationExpired', 'RegistrationRejected', 'AttendanceRecorded',
  ];
  const { event_id: _omitted, ...withoutEvent } = registrationFields;
  for (const type of types) {
    const r = parseMessage(msg(type, withoutEvent));
    assert.ok(!r.ok, `${type} should be rejected`);
    assert.equal(r.error, `${type}: event_id is required`);
  }
});

test('registration types map to Subscription statuses', () => {
  const expected: Record<string, string> = {
    RegistrationWaitlisted: 'WAITLISTED',
    WaitlistOffered: 'OFFERED',
    RegistrationPendingPayment: 'PENDING_PAYMENT',
    RegistrationConfirmed: 'CONFIRMED',
    RegistrationCancelled: 'CANCELLED',
    RegistrationExpired: 'EXPIRED',
    RegistrationRejected: 'REJECTED',
  };
  for (const [type, status] of Object.entries(expected)) {
    assert.deepEqual(change(msg(type, registrationFields)), {
      kind: 'registration', registrationId: ids.registration, eventId: ids.event, activityId: ids.activity,
      userId: ids.user, status,
    });
  }
  assert.deepEqual(change(msg('AttendanceRecorded', registrationFields)), {
    kind: 'checkin', registrationId: ids.registration, eventId: ids.event, activityId: ids.activity, userId: ids.user,
  });
});

test('unknown types are ignored, not errors', () => {
  assert.equal(change(msg('CertificateIssued', { anything: 1 })).kind, 'ignored');
});

// events/src/messaging/messages.ts activityLifecycleMessage: only activity_id, event_id, ends_at.
const lifecycleFields = { activity_id: ids.activity, event_id: ids.event, ends_at: '2026-12-01T18:00:00.000Z' };

test('ActivityEnded, ActivityCancelled and ActivityDeleted map to a lifecycle change', () => {
  for (const [type, lifecycle] of [['ActivityEnded', 'ENDED'], ['ActivityCancelled', 'CANCELLED']] as const) {
    assert.deepEqual(change(msg(type, lifecycleFields)), {
      kind: 'activityLifecycle', activityId: ids.activity, eventId: ids.event, lifecycle,
    });
  }
  // ActivityDeleted carries the full activity fields, but only the ids are needed.
  assert.deepEqual(change(msg('ActivityDeleted', activityFields)), {
    kind: 'activityLifecycle', activityId: ids.activity, eventId: ids.event, lifecycle: 'DELETED',
  });
  assert.equal(
    change(msg('ActivityDeleted', { activity_id: ids.activity, event_id: ids.event })).kind, 'activityLifecycle',
  );
});

test('lifecycle messages require activity_id and event_id', () => {
  for (const type of ['ActivityEnded', 'ActivityCancelled', 'ActivityDeleted']) {
    for (const missing of ['activity_id', 'event_id']) {
      const fields: Record<string, unknown> = { ...lifecycleFields };
      delete fields[missing];
      const r = parseMessage(msg(type, fields));
      assert.equal(r.ok, false, `${type} without ${missing}`);
      if (!r.ok) assert.match(r.error, new RegExp(`${type}: ${missing} is required`));
    }
  }
});

// subscription/app/service.py evaluate_event_attendance: envelope fields plus the registration that triggered it.
const eligibleFields = {
  registration_id: ids.registration,
  event_id: ids.event,
  activity_id: ids.activity,
  user_id: ids.user,
  aggregate_version: 4,
  status: 'CONFIRMED',
  attended_activities: 3,
  total_activities: 4,
  attendance_percentage: 75,
};

test('AttendanceEligible keeps the counts and percentage; registration_id and activity_id are optional', () => {
  assert.deepEqual(change(msg('AttendanceEligible', eligibleFields)), {
    kind: 'eligibility', eventId: ids.event, userId: ids.user, registrationId: ids.registration,
    attendedActivities: 3, totalActivities: 4, attendancePercentage: 75,
  });
  const { registration_id, activity_id, ...minimal } = eligibleFields;
  assert.deepEqual(change(msg('AttendanceEligible', { ...minimal, attendance_percentage: 66.67 })), {
    kind: 'eligibility', eventId: ids.event, userId: ids.user, registrationId: null,
    attendedActivities: 3, totalActivities: 4, attendancePercentage: 66.67,
  });
});

test('AttendanceEligible rejects missing or invalid fields', () => {
  const bad: [string, object][] = [
    ['event_id is required', { event_id: undefined }],
    ['user_id is required', { user_id: undefined }],
    ['attended_activities must be a non-negative integer', { attended_activities: undefined }],
    ['attended_activities must be a non-negative integer', { attended_activities: 1.5 }],
    ['attended_activities must be a non-negative integer', { attended_activities: -1 }],
    ['attended_activities must be a non-negative integer', { attended_activities: '3' }],
    ['total_activities must be a non-negative integer', { total_activities: 2.5 }],
    ['total_activities must be at least 1', { total_activities: 0, attended_activities: 0 }],
    ['attended_activities must not exceed total_activities', { attended_activities: 5 }],
    ['attendance_percentage must be a number between 0 and 100', { attendance_percentage: undefined }],
    ['attendance_percentage must be a number between 0 and 100', { attendance_percentage: '75' }],
    ['attendance_percentage must be a number between 0 and 100', { attendance_percentage: null }],
    ['attendance_percentage must be a number between 0 and 100', { attendance_percentage: -1 }],
    ['attendance_percentage must be a number between 0 and 100', { attendance_percentage: 100.01 }],
  ];
  for (const [reason, override] of bad) {
    const r = parseMessage(msg('AttendanceEligible', { ...eligibleFields, ...override }));
    assert.equal(r.ok, false, JSON.stringify(override));
    if (!r.ok) assert.equal(r.error, `AttendanceEligible: ${reason}`);
  }
  // JSON cannot carry NaN/Infinity: they arrive as null, which is rejected too (covered above).
});

test('the old dotted type names are no longer recognised', () => {
  assert.equal(change(msg('event.created', eventFields)).kind, 'ignored');
  assert.equal(change(msg('payment.confirmed', paymentFields)).kind, 'ignored');
});

test('the old nested data format is rejected (no fallback)', () => {
  const nested = JSON.stringify({
    message_id: 'm1', type: 'EventCreated', version: 1, occurred_at: '2026-10-31T12:00:00Z', trace_id: 't1',
    data: { event_id: ids.event, organizer_id: ids.organizer },
  });
  const r = parseMessage(nested);
  assert.ok(!r.ok);
  assert.match(r.error, /EventCreated: event_id is required/);
});

test('invalid messages are rejected with a reason', () => {
  assert.deepEqual(parseMessage('not json'), { ok: false, error: 'invalid JSON' });
  assert.deepEqual(parseMessage('[]'), { ok: false, error: 'message must be a JSON object' });
  assert.ok(!parseMessage(JSON.stringify({ type: 'EventCreated', occurred_at: OCCURRED, event_id: ids.event })).ok); // no message_id
  assert.ok(!parseMessage(JSON.stringify({ message_id: 'm1', occurred_at: OCCURRED })).ok); // no type
  assert.ok(!parseMessage(msg('EventCreated', { event_id: ids.event }, { occurred_at: 'nope' })).ok);
  assert.ok(!parseMessage(msg('EventCreated', {})).ok); // no event_id
  assert.ok(!parseMessage(msg('ActivityCreated', { ...activityFields, capacity: 'x' })).ok);
});

test('schema_version 2 is rejected, 0 and non-integers are invalid', () => {
  const v2 = parseMessage(msg('EventCreated', eventFields, { schema_version: 2 }));
  assert.ok(!v2.ok && /unsupported schema_version 2/.test(v2.error));
  for (const bad of [0, 1.5, '1', null]) {
    const r = parseMessage(msg('EventCreated', eventFields, { schema_version: bad }));
    assert.ok(!r.ok && /schema_version must be a positive integer/.test(r.error), String(bad));
  }
});

test('a missing schema_version defaults to 1', () => {
  const raw = JSON.stringify({ ...eventFields, message_id: 'm1', type: 'EventCreated', occurred_at: OCCURRED, trace_id: null });
  const r = parseMessage(raw);
  assert.ok(r.ok);
  assert.equal(r.value.envelope.schema_version, 1);
});

test('a message with only the legacy correlation_id has no trace id', () => {
  const r = parseMessage(msg('EventCreated', eventFields, { trace_id: undefined, correlation_id: 'c1' }));
  assert.ok(r.ok);
  assert.equal(r.value.envelope.trace_id, null);
});
