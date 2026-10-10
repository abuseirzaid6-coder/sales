import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Stripe from 'stripe';
import { createApp, candidatesFromMetadata } from '../src/app.js';
import { COURSE, RULES, validateAge, validateCandidates, validateName } from '../public/shared.js';

const quietLogger = { info() {}, warn() {}, error() {} };
const WEBHOOK_SECRET = 'whsec_test_secret';

function fakeStripe() {
  const stripe = new Stripe('sk_test_fake');
  const calls = { create: [], retrieve: [] };
  const sessions = new Map();
  stripe.checkout.sessions.create = async (params) => {
    calls.create.push(params);
    const id = `cs_test_${'a'.repeat(20)}${calls.create.length}`;
    const session = {
      id,
      url: `https://checkout.stripe.com/c/pay/${id}`,
      status: 'complete',
      payment_status: 'paid',
      amount_total: params.line_items.reduce((sum, li) => sum + li.price_data.unit_amount * li.quantity, 0),
      currency: 'usd',
      livemode: false,
      customer_details: { email: 'admin@example.com' },
      metadata: params.metadata,
    };
    sessions.set(id, session);
    return session;
  };
  stripe.checkout.sessions.retrieve = async (id) => {
    calls.retrieve.push(id);
    const session = sessions.get(id);
    if (!session) {
      const err = new Error('No such checkout.session');
      err.code = 'resource_missing';
      throw err;
    }
    return session;
  };
  return { stripe, calls, sessions };
}

async function serve(options) {
  const app = createApp({ logger: quietLogger, ...options });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('shared validation', () => {
  test('age must be a whole number of at least 18', () => {
    assert.equal(validateAge(18).value, 18);
    assert.equal(validateAge('18').value, 18);
    assert.equal(validateAge(' 42 ').value, 42);
    assert.match(validateAge(17).error, /18 or older/);
    assert.match(validateAge('17').error, /18 or older/);
    assert.match(validateAge(0).error, /18 or older/);
    assert.match(validateAge(-20).error, /18 or older/);
    assert.match(validateAge(18.5).error, /whole number/);
    assert.match(validateAge('18.5').error, /whole number/);
    assert.match(validateAge('1e2').error, /whole number/);
    assert.match(validateAge(NaN).error, /whole number/);
    assert.match(validateAge('').error, /Enter/);
    assert.match(validateAge(undefined).error, /Enter/);
    assert.match(validateAge(121).error, /valid age/);
    assert.ok(validateAge(true).error);
    assert.ok(validateAge({}).error);
  });

  test('full name needs first and last name', () => {
    assert.equal(validateName('  Jane   Doe ').value, 'Jane Doe');
    assert.equal(validateName("Seán O'Brien-Murphy").value, "Seán O'Brien-Murphy");
    assert.equal(validateName('José María López').value, 'José María López');
    assert.match(validateName('Jane').error, /first and last/);
    assert.match(validateName('').error, /full name/);
    assert.match(validateName(42).error, /full name/);
    assert.match(validateName('Jane <script>').error, /letters/);
    assert.match(validateName('Jane Doe2').error, /letters/);
    assert.match(validateName(`${'a'.repeat(60)} ${'b'.repeat(60)}`).error, /100 characters/);
  });

  test('candidate list size is enforced', () => {
    assert.equal(validateCandidates([]).ok, false);
    assert.equal(validateCandidates('nope').ok, false);
    const many = Array.from({ length: RULES.maxCandidates + 1 }, () => ({ fullName: 'Jane Doe', age: 30 }));
    assert.match(validateCandidates(many).formError, /up to 40/);
    assert.equal(validateCandidates(many.slice(1)).ok, true);
  });
});

describe('POST /api/checkout', () => {
  let srv, fake;
  before(async () => {
    fake = fakeStripe();
    srv = await serve({ stripe: fake.stripe, publicUrl: 'https://enroll.example.com' });
  });
  after(() => srv.close());

  test('creates a Checkout Session with one $150.92 line item per candidate', async () => {
    const res = await post(`${srv.base}/api/checkout`, {
      candidates: [
        { fullName: ' Jane  Doe ', age: '24' },
        { fullName: 'John Smith', age: 18 },
      ],
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.url, /^https:\/\/checkout\.stripe\.com\//);

    const params = fake.calls.create.at(-1);
    assert.equal(params.mode, 'payment');
    assert.equal(params.line_items.length, 2);
    for (const item of params.line_items) {
      assert.equal(item.quantity, 1);
      assert.equal(item.price_data.unit_amount, 15092);
      assert.equal(item.price_data.currency, 'usd');
      assert.equal(item.price_data.product_data.name, COURSE.name);
    }
    assert.equal(params.line_items[0].price_data.product_data.description, 'Candidate: Jane Doe, age 24');
    assert.deepEqual(params.metadata, {
      course: COURSE.id,
      candidate_count: '2',
      candidate_01: 'Jane Doe (24)',
      candidate_02: 'John Smith (18)',
    });
    assert.deepEqual(params.payment_intent_data.metadata, params.metadata);
    assert.equal(params.success_url, 'https://enroll.example.com/success?session_id={CHECKOUT_SESSION_ID}');
    assert.equal(params.cancel_url, 'https://enroll.example.com/?canceled=1');
  });

  test('ignores any price sent by the browser', async () => {
    await post(`${srv.base}/api/checkout`, {
      candidates: [{ fullName: 'Jane Doe', age: 30, price: 1 }],
      unit_amount: 1,
      feeCents: 1,
    });
    assert.equal(fake.calls.create.at(-1).line_items[0].price_data.unit_amount, 15092);
  });

  test('rejects candidates under 18 with a field error and does not call Stripe', async () => {
    const before = fake.calls.create.length;
    const res = await post(`${srv.base}/api/checkout`, {
      candidates: [{ fullName: 'Jane Doe', age: 30 }, { fullName: 'Kid Doe', age: 17 }],
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.deepEqual(body.fieldErrors, [{ index: 1, field: 'age', message: 'Must be 18 or older.' }]);
    assert.equal(fake.calls.create.length, before);
  });

  test('rejects empty, oversized and malformed bodies', async () => {
    assert.equal((await post(`${srv.base}/api/checkout`, { candidates: [] })).status, 422);
    assert.equal((await post(`${srv.base}/api/checkout`, {})).status, 422);
    const tooMany = Array.from({ length: 41 }, () => ({ fullName: 'Jane Doe', age: 30 }));
    assert.equal((await post(`${srv.base}/api/checkout`, { candidates: tooMany })).status, 422);
    const bad = await fetch(`${srv.base}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'Invalid request body.' });
  });

  test('accepts the maximum of 40 candidates within Stripe metadata limits', async () => {
    const candidates = Array.from({ length: 40 }, (_, i) => ({ fullName: `Person Number${'x'.repeat(i)}`, age: 18 + i }));
    const res = await post(`${srv.base}/api/checkout`, { candidates });
    assert.equal(res.status, 200);
    const { metadata, line_items } = fake.calls.create.at(-1);
    assert.equal(line_items.length, 40);
    assert.ok(Object.keys(metadata).length <= 50, 'Stripe allows at most 50 metadata keys');
    for (const [key, value] of Object.entries(metadata)) {
      assert.ok(key.length <= 40 && value.length <= 500);
    }
  });

  test('returns 502 without leaking Stripe errors', async () => {
    const original = fake.stripe.checkout.sessions.create;
    fake.stripe.checkout.sessions.create = async () => { throw new Error('Invalid API Key provided: sk_test_***'); };
    const res = await post(`${srv.base}/api/checkout`, { candidates: [{ fullName: 'Jane Doe', age: 30 }] });
    fake.stripe.checkout.sessions.create = original;
    assert.equal(res.status, 502);
    assert.doesNotMatch((await res.json()).error, /API Key/);
  });
});

describe('GET /api/checkout-session', () => {
  let srv, fake;
  before(async () => {
    fake = fakeStripe();
    srv = await serve({ stripe: fake.stripe });
  });
  after(() => srv.close());

  test('returns the paid session with candidates', async () => {
    const created = await (await post(`${srv.base}/api/checkout`, {
      candidates: [{ fullName: 'Jane Doe', age: 24 }, { fullName: 'John Smith', age: 31 }],
    })).json();
    const id = created.url.split('/').pop();
    const res = await fetch(`${srv.base}/api/checkout-session?session_id=${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), {
      status: 'complete',
      paymentStatus: 'paid',
      amountTotal: 30184,
      currency: 'usd',
      email: 'admin@example.com',
      candidates: [{ fullName: 'Jane Doe', age: 24 }, { fullName: 'John Smith', age: 31 }],
      testMode: true,
    });
  });

  test('validates the session id and hides other Stripe sessions', async () => {
    assert.equal((await fetch(`${srv.base}/api/checkout-session`)).status, 400);
    assert.equal((await fetch(`${srv.base}/api/checkout-session?session_id=../../v1/customers`)).status, 400);
    assert.equal((await fetch(`${srv.base}/api/checkout-session?session_id=cs_test_doesnotexist123`)).status, 404);

    fake.sessions.set('cs_test_otherproduct1234', { id: 'cs_test_otherproduct1234', metadata: { course: 'something-else' } });
    assert.equal((await fetch(`${srv.base}/api/checkout-session?session_id=cs_test_otherproduct1234`)).status, 404);
  });
});

describe('POST /api/webhook', () => {
  let srv, fake, dir, file;
  before(async () => {
    fake = fakeStripe();
    dir = await mkdtemp(path.join(tmpdir(), 'enroll-'));
    file = path.join(dir, 'nested', 'enrollments.jsonl');
    srv = await serve({ stripe: fake.stripe, webhookSecret: WEBHOOK_SECRET, enrollmentsFile: file, adminPassword: 'hunter2' });
  });
  after(async () => {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  });

  const sendEvent = (event, secret = WEBHOOK_SECRET) => {
    const payload = JSON.stringify(event);
    const signature = fake.stripe.webhooks.generateTestHeaderString({ payload, secret });
    return fetch(`${srv.base}/api/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
      body: payload,
    });
  };

  const paidEvent = (overrides = {}) => ({
    id: 'evt_test_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_paid1234567890',
        payment_status: 'paid',
        payment_intent: 'pi_test_123',
        amount_total: 15092,
        currency: 'usd',
        livemode: false,
        customer_details: { email: 'admin@example.com' },
        metadata: { course: COURSE.id, candidate_count: '1', candidate_01: 'Jane Doe (24)' },
        ...overrides,
      },
    },
  });

  test('records a paid enrollment (and is reachable without the admin password)', async () => {
    const res = await sendEvent(paidEvent());
    assert.equal(res.status, 200);
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].sessionId, 'cs_test_paid1234567890');
    assert.equal(lines[0].paymentIntent, 'pi_test_123');
    assert.deepEqual(lines[0].candidates, [{ fullName: 'Jane Doe', age: 24 }]);
  });

  test('ignores unpaid sessions and other products', async () => {
    assert.equal((await sendEvent(paidEvent({ payment_status: 'unpaid' }))).status, 200);
    assert.equal((await sendEvent(paidEvent({ metadata: { course: 'other' } }))).status, 200);
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
  });

  test('rejects bad signatures', async () => {
    assert.equal((await sendEvent(paidEvent(), 'whsec_wrong')).status, 400);
    const unsigned = await fetch(`${srv.base}/api/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(paidEvent()),
    });
    assert.equal(unsigned.status, 400);
  });
});

describe('admin password', () => {
  let srv;
  before(async () => {
    srv = await serve({ stripe: fakeStripe().stripe, adminPassword: 'correct horse' });
  });
  after(() => srv.close());

  const auth = (user, pass) => ({ Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` });

  test('protects pages and the API', async () => {
    const page = await fetch(`${srv.base}/`);
    assert.equal(page.status, 401);
    assert.match(page.headers.get('www-authenticate'), /^Basic /);
    assert.equal((await post(`${srv.base}/api/checkout`, { candidates: [] })).status, 401);
    assert.equal((await fetch(`${srv.base}/`, { headers: auth('admin', 'wrong') })).status, 401);
    assert.equal((await fetch(`${srv.base}/`, { headers: { Authorization: 'Basic !!!' } })).status, 401);
  });

  test('lets the admin in with the right password and any username', async () => {
    const page = await fetch(`${srv.base}/`, { headers: auth('admin', 'correct horse') });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Enroll candidates/);
    assert.equal((await fetch(`${srv.base}/success`, { headers: auth('', 'correct horse') })).status, 200);
  });

  test('leaves the health check open', async () => {
    assert.equal((await fetch(`${srv.base}/healthz`)).status, 200);
  });
});

describe('without Stripe configured', () => {
  let srv;
  before(async () => { srv = await serve({}); });
  after(() => srv.close());

  test('serves the form but explains payments are not set up', async () => {
    assert.equal((await fetch(`${srv.base}/`)).status, 200);
    const res = await post(`${srv.base}/api/checkout`, { candidates: [{ fullName: 'Jane Doe', age: 30 }] });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /Stripe secret key/);
    assert.equal((await fetch(`${srv.base}/api/webhook`, { method: 'POST' })).status, 503);
  });

  test('sets security headers', async () => {
    const res = await fetch(`${srv.base}/`);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});

test('candidatesFromMetadata keeps order and tolerates odd values', () => {
  assert.deepEqual(
    candidatesFromMetadata({ candidate_02: 'B Two (30)', course: 'x', candidate_01: 'A One (20)', candidate_10: 'weird' }),
    [{ fullName: 'A One', age: 20 }, { fullName: 'B Two', age: 30 }, { fullName: 'weird', age: null }],
  );
});
