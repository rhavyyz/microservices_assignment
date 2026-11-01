import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { AppError } from '../src/errors.ts';
import { bearerToken, createTokenVerifier, type Jwk } from '../src/http/auth.ts';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const pair = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwkOf = (key: KeyObject, kid: string): Jwk => ({ ...(key.export({ format: 'jwk' }) as Jwk), kid, use: 'sig', alg: 'RS256' });

/** Same shape as the tokens of the user service (RS256, kid, iss/sub/roles/iat/exp/jti). */
function token(privateKey: KeyObject, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'RS256', kid: 'k1', ...header });
  const p = b64({ iss: 'eventhub-users', sub: 'user-1', roles: ['ORGANIZER'], iat: now, exp: now + 1800, jti: 'j', ...claims });
  return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
}

const k1 = pair();
function setup(keys: () => Jwk[] = () => [jwkOf(k1.publicKey, 'k1')]) {
  const calls = { n: 0 };
  let clock = Date.now();
  const verify = createTokenVerifier({
    issuer: 'eventhub-users',
    cacheSeconds: 300,
    now: () => clock,
    fetchKeys: async () => { calls.n++; return keys(); },
  });
  return { verify, calls, advance: (ms: number) => { clock += ms; } };
}

async function rejected(p: Promise<unknown>, status = 401) {
  await assert.rejects(p, (e: unknown) => e instanceof AppError && e.status === status);
}

test('a valid token gives the subject and roles; keys are downloaded once and cached', async () => {
  const { verify, calls } = setup();
  assert.deepEqual(await verify(token(k1.privateKey)), { userId: 'user-1', roles: ['ORGANIZER'] });
  await verify(token(k1.privateKey, { sub: 'user-2', roles: undefined }));
  assert.equal(calls.n, 1);
  assert.deepEqual(await verify(token(k1.privateKey, { roles: ['X', 3] })), { userId: 'user-1', roles: ['X'] });
});

test('concurrent first requests wait for the same key download', async () => {
  const { verify, calls } = setup();
  await Promise.all([verify(token(k1.privateKey)), verify(token(k1.privateKey)), verify(token(k1.privateKey))]);
  assert.equal(calls.n, 1);
});

test('forged, tampered, expired, wrong-issuer and subject-less tokens are refused', async () => {
  const { verify } = setup();
  const forged = pair();
  await rejected(verify(token(forged.privateKey)));
  const [h, , s] = token(k1.privateKey).split('.');
  await rejected(verify(`${h}.${b64({ iss: 'eventhub-users', sub: 'admin', exp: 9e9 })}.${s}`));
  await rejected(verify(token(k1.privateKey, { exp: Math.floor(Date.now() / 1000) - 60 })));
  await rejected(verify(token(k1.privateKey, { iss: 'someone-else' })));
  await rejected(verify(token(k1.privateKey, { sub: '' })));
  await rejected(verify(token(k1.privateKey, { nbf: Math.floor(Date.now() / 1000) + 600 })));
  await rejected(verify('not.a.jwt'));
  await rejected(verify('only-one-part'));
});

test('alg none and HMAC tokens are refused whatever their content', async () => {
  const { verify } = setup();
  const p = b64({ iss: 'eventhub-users', sub: 'user-1', exp: 9e9 });
  await rejected(verify(`${b64({ alg: 'none', kid: 'k1' })}.${p}.`));
  await rejected(verify(`${b64({ alg: 'HS256', kid: 'k1' })}.${p}.c2ln`));
  await rejected(verify(`${b64({ alg: 'RS256' })}.${p}.c2ln`)); // no kid
});

test('a new kid (key rotation) triggers a download, at most once per 10s', async () => {
  const k2 = pair();
  let rotated = false;
  const { verify, calls, advance } = setup(() => [jwkOf(k1.publicKey, 'k1'), ...(rotated ? [jwkOf(k2.publicKey, 'k2')] : [])]);
  await verify(token(k1.privateKey));
  rotated = true;
  await rejected(verify(token(k2.privateKey, {}, { kid: 'k2' }))); // within 10s of the last download
  advance(11_000);
  assert.equal((await verify(token(k2.privateKey, {}, { kid: 'k2' }))).userId, 'user-1');
  assert.equal(calls.n, 2);
});

test('when the user service is down, cached keys keep working and an unknown key is a 503', async () => {
  let down = false;
  const { verify, advance } = setup(() => { if (down) throw new Error('connection refused'); return [jwkOf(k1.publicKey, 'k1')]; });
  await verify(token(k1.privateKey));
  down = true;
  advance(301_000); // cache expired
  assert.equal((await verify(token(k1.privateKey))).userId, 'user-1');
  const cold = setup(() => { throw new Error('connection refused'); });
  await rejected(cold.verify(token(k1.privateKey)), 503);
});

test('bearer header parsing', () => {
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(bearerToken('bearer   x'), 'x');
  assert.throws(() => bearerToken('Basic dXNlcg=='), AppError);
  assert.throws(() => bearerToken('Bearer a b'), AppError);
});
