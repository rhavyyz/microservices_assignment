import test from 'node:test';
import assert from 'node:assert/strict';
import { toActivityView } from '../src/services/views.ts';
import type { ActivityRow, EventRow } from '../src/domain/model.ts';

test('toActivityView drops the legacy reserved/available columns that SELECT a.* still returns', () => {
  const event = {
    id: 'e1', organizer_id: 'org-1', organization: null, title: 'E', description: null, location: null, banner_url: null,
    starts_at: new Date('2030-01-01T10:00:00Z'), ends_at: new Date('2030-01-01T18:00:00Z'), status: 'PUBLISHED',
    created_at: new Date('2029-01-01T00:00:00Z'), updated_at: new Date('2029-01-01T00:00:00Z'),
  } as EventRow;
  const row = {
    id: 'a1', event_id: 'e1', title: 'A', description: null, speaker: null, location: null,
    starts_at: new Date('2030-01-01T11:00:00Z'), ends_at: new Date('2030-01-01T12:00:00Z'),
    capacity: 10, price_cents: 2500, paid: true, waitlist_enabled: false, ended_at: null,
    created_at: new Date('2029-01-01T00:00:00Z'), updated_at: new Date('2029-01-01T00:00:00Z'),
    reserved: 3, available: 7,
  } as unknown as ActivityRow;
  const v = toActivityView(event, row, new Date('2030-01-01T09:00:00Z'));
  assert.equal('reserved' in v, false);
  assert.equal('available' in v, false);
  assert.equal(v.activity_id, 'a1');
  assert.equal(v.amount_minor, 2500);
  assert.equal(v.currency, 'BRL');
  assert.equal(typeof v.registration_open, 'boolean');
  assert.ok(v.lifecycle);
});
