import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.ts';
import { actorFromHeaders } from '../src/http/identity.ts';

const UID = '11111111-1111-4111-8111-111111111111';

test('the identity is the X-User-Id UUID and the X-User-Roles list', () => {
  assert.deepEqual(actorFromHeaders({ 'x-user-id': UID, 'x-user-roles': 'ORGANIZER,PARTICIPANT' }), {
    userId: UID, roles: ['ORGANIZER', 'PARTICIPANT'],
  });
});

test('roles are trimmed, upper-cased and empty items dropped; absent roles mean no roles', () => {
  assert.deepEqual(actorFromHeaders({ 'x-user-id': UID, 'x-user-roles': ' organizer , ,Participant ' })?.roles, ['ORGANIZER', 'PARTICIPANT']);
  assert.deepEqual(actorFromHeaders({ 'x-user-id': UID })?.roles, []);
  assert.deepEqual(actorFromHeaders({ 'x-user-id': UID, 'x-user-roles': '' })?.roles, []);
});

test('without X-User-Id the caller is anonymous, whatever else is sent', () => {
  assert.equal(actorFromHeaders({}), null);
  assert.equal(actorFromHeaders({ 'x-user-id': '  ' }), null);
  assert.equal(actorFromHeaders({ 'x-user-roles': 'ORGANIZER', authorization: 'Bearer abc.def.ghi' }), null);
});

test('a present X-User-Id that is not a UUID is a 401 UNAUTHENTICATED, never anonymous', () => {
  for (const bad of ['organizer-1', '123', `${UID}x`, `${UID}, ${UID}`, 'null']) {
    assert.throws(() => actorFromHeaders({ 'x-user-id': bad }), (e: unknown) =>
      e instanceof AppError && e.status === 401 && e.code === 'UNAUTHENTICATED');
  }
});

test('a bearer token is ignored: the identity never comes from Authorization', () => {
  const actor = actorFromHeaders({ 'x-user-id': UID, authorization: 'Bearer whatever' });
  assert.equal(actor?.userId, UID);
});
