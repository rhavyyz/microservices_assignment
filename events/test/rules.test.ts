import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.ts';
import type { ActivityRow, EventRow } from '../src/domain/model.ts';
import {
  assertCanPublish, assertDraft, assertNotCancelled, assertOrganizer, assertOwner, assertValidPeriod,
  assertWithinEvent, canView, seatRejection,
} from '../src/domain/rules.ts';

const d = (s: string) => new Date(s);
const event = (o: Partial<EventRow> = {}): EventRow => ({
  id: 'e1', organizer_id: 'org', organization: null, title: 'Conf', description: null, location: null, banner_url: null,
  starts_at: d('2030-05-01T08:00:00Z'), ends_at: d('2030-05-03T18:00:00Z'), status: 'DRAFT',
  created_at: d('2026-01-01T00:00:00Z'), updated_at: d('2026-01-01T00:00:00Z'), ...o,
});
const activity = (o: Partial<ActivityRow> = {}): ActivityRow => ({
  id: 'a1', event_id: 'e1', title: 'Talk', description: null, speaker: null, location: null,
  starts_at: d('2030-05-01T09:00:00Z'), ends_at: d('2030-05-01T10:00:00Z'), capacity: 10, reserved: 10, available: 0,
  price_cents: 0, paid: false, waitlist_enabled: false, created_at: d('2026-01-01T00:00:00Z'),
  updated_at: d('2026-01-01T00:00:00Z'), ...o,
});
const organizer = { userId: 'org', roles: ['ORGANIZER'] };
const participant = { userId: 'p1', roles: ['PARTICIPANT'] };

/** Asserts fn throws an AppError with this status and code. */
function rejects(fn: () => unknown, status: number, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof AppError && e.status === status && e.code === code);
}

test('only organizers create events', () => {
  assertOrganizer(organizer);
  rejects(() => assertOrganizer(participant), 403, 'FORBIDDEN');
});

test("someone else's event looks exactly like a missing one (RN07)", () => {
  assertOwner(event(), organizer);
  rejects(() => assertOwner(event(), participant), 404, 'NOT_FOUND');
  rejects(() => assertOwner(null, organizer), 404, 'NOT_FOUND');
});

test('drafts are visible to their organizer only; published and cancelled to everyone', () => {
  assert.equal(canView(event(), null), false);
  assert.equal(canView(event(), participant), false);
  assert.equal(canView(event(), organizer), true);
  assert.equal(canView(event({ status: 'PUBLISHED' }), null), true);
  assert.equal(canView(event({ status: 'CANCELLED' }), null), true);
});

test('periods must end after they start', () => {
  assertValidPeriod({ starts_at: d('2030-01-01T10:00:00Z'), ends_at: d('2030-01-01T10:00:01Z') });
  rejects(() => assertValidPeriod({ starts_at: d('2030-01-01T10:00:00Z'), ends_at: d('2030-01-01T10:00:00Z') }), 422, 'INVALID_PERIOD');
});

test('activities must fit in the event period (bounds included)', () => {
  const e = event();
  assertWithinEvent({ starts_at: e.starts_at, ends_at: e.ends_at }, e);
  rejects(() => assertWithinEvent({ starts_at: d('2030-04-30T23:00:00Z'), ends_at: d('2030-05-01T09:00:00Z') }, e), 422, 'ACTIVITY_OUTSIDE_EVENT');
  rejects(() => assertWithinEvent({ starts_at: d('2030-05-03T17:00:00Z'), ends_at: d('2030-05-03T18:00:01Z') }, e), 422, 'ACTIVITY_OUTSIDE_EVENT');
});

test('cancelled is final and only drafts accept destructive schedule changes', () => {
  assertNotCancelled(event({ status: 'PUBLISHED' }));
  rejects(() => assertNotCancelled(event({ status: 'CANCELLED' })), 409, 'EVENT_CANCELLED');
  assertDraft(event(), 'x');
  rejects(() => assertDraft(event({ status: 'PUBLISHED' }), 'x'), 409, 'EVENT_NOT_DRAFT');
});

test('publishing needs a draft with activities that has not ended', () => {
  const now = d('2030-01-01T00:00:00Z');
  assertCanPublish(event(), 1, now);
  rejects(() => assertCanPublish(event({ status: 'PUBLISHED' }), 1, now), 409, 'INVALID_STATUS');
  rejects(() => assertCanPublish(event(), 0, now), 409, 'EVENT_WITHOUT_ACTIVITIES');
  rejects(() => assertCanPublish(event(), 1, d('2031-01-01T00:00:00Z')), 409, 'EVENT_ENDED');
});

test('a refused seat is explained in order: missing, not open, closed, full', () => {
  const now = d('2030-01-01T00:00:00Z');
  const published = event({ status: 'PUBLISHED' });
  assert.equal(seatRejection(null, 'e1', now), 'ACTIVITY_NOT_FOUND');
  assert.equal(seatRejection({ event: published, activity: activity() }, 'other-event', now), 'ACTIVITY_NOT_FOUND');
  assert.equal(seatRejection({ event: event(), activity: activity() }, 'e1', now), 'EVENT_NOT_OPEN');
  assert.equal(seatRejection({ event: event({ status: 'CANCELLED' }), activity: activity() }, 'e1', now), 'EVENT_NOT_OPEN');
  assert.equal(seatRejection({ event: published, activity: activity() }, 'e1', d('2030-05-01T09:00:00Z')), 'REGISTRATION_CLOSED');
  assert.equal(seatRejection({ event: published, activity: activity() }, 'e1', now), 'FULL');
});
