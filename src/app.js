import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COURSE, validateCandidates } from '../public/shared.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,250}$/;
const CANDIDATE_KEY = /^candidate_\d{2}$/;
const PAID_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

export function createApp({
  stripe = null,
  webhookSecret = '',
  adminPassword = '',
  publicUrl = '',
  enrollmentsFile = '',
  logger = console,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Stripe calls this, so it sits before the admin password and needs the raw body
  // for signature verification.
  app.post('/api/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    if (!stripe || !webhookSecret) {
      return res.status(503).json({ error: 'Webhook is not configured.' });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature') ?? '', webhookSecret);
    } catch (err) {
      logger.warn(`Rejected webhook: ${err.message}`);
      return res.status(400).json({ error: 'Invalid signature.' });
    }

    if (PAID_EVENTS.has(event.type)) {
      const session = event.data.object;
      if (session.payment_status === 'paid' && session.metadata?.course === COURSE.id) {
        try {
          await recordEnrollment(session, { enrollmentsFile, logger });
        } catch (err) {
          logger.error(`Could not record enrollment for ${session.id}: ${err.message}`);
          return res.status(500).json({ error: 'Could not record enrollment.' });
        }
      }
    }

    res.json({ received: true });
  });

  if (adminPassword) app.use(requirePassword(adminPassword));

  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.post('/api/checkout', express.json({ limit: '32kb' }), async (req, res) => {
    if (!stripe) {
      return res.status(503).json({ error: 'Payments are not set up yet. Add your Stripe secret key to the server.' });
    }

    const result = validateCandidates(req.body?.candidates);
    if (!result.ok) {
      return res.status(422).json({
        error: result.formError ?? 'Please fix the highlighted fields.',
        fieldErrors: result.errors ?? [],
      });
    }

    const { candidates } = result;
    const metadata = { course: COURSE.id, candidate_count: String(candidates.length) };
    candidates.forEach((candidate, i) => {
      metadata[`candidate_${String(i + 1).padStart(2, '0')}`] = `${candidate.fullName} (${candidate.age})`;
    });

    const baseUrl = publicUrl || `${req.protocol}://${req.get('host')}`;
    const label = candidates.length === 1 ? '1 candidate' : `${candidates.length} candidates`;

    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: candidates.map((candidate) => ({
          quantity: 1,
          price_data: {
            currency: COURSE.currency,
            unit_amount: COURSE.feeCents,
            product_data: {
              name: COURSE.name,
              description: `Candidate: ${candidate.fullName}, age ${candidate.age}`,
            },
          },
        })),
        metadata,
        payment_intent_data: { description: `${COURSE.name} — ${label}`, metadata },
        success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/?canceled=1`,
      });
      res.json({ url: session.url });
    } catch (err) {
      logger.error(`Stripe checkout failed: ${err.type ?? 'Error'}: ${err.message}`);
      res.status(502).json({ error: 'Could not start the payment. Please try again in a moment.' });
    }
  });

  app.get('/api/checkout-session', async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Payments are not set up yet.' });

    const id = req.query.session_id;
    if (typeof id !== 'string' || !SESSION_ID.test(id)) {
      return res.status(400).json({ error: 'Missing or invalid session id.' });
    }

    try {
      const session = await stripe.checkout.sessions.retrieve(id);
      if (session.metadata?.course !== COURSE.id) {
        return res.status(404).json({ error: 'Payment not found.' });
      }
      res.json({
        status: session.status,
        paymentStatus: session.payment_status,
        amountTotal: session.amount_total,
        currency: session.currency,
        email: session.customer_details?.email ?? null,
        candidates: candidatesFromMetadata(session.metadata),
        testMode: !session.livemode,
      });
    } catch (err) {
      if (err.code === 'resource_missing') return res.status(404).json({ error: 'Payment not found.' });
      logger.error(`Stripe session lookup failed: ${err.type ?? 'Error'}: ${err.message}`);
      res.status(502).json({ error: 'Could not load the payment. Please refresh to try again.' });
    }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'], index: 'index.html' }));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) logger.error(err);
    const message = err.type === 'entity.parse.failed' ? 'Invalid request body.' : status >= 500 ? 'Something went wrong.' : err.message;
    res.status(status).json({ error: message });
  });

  return app;
}

export function candidatesFromMetadata(metadata = {}) {
  return Object.keys(metadata)
    .filter((key) => CANDIDATE_KEY.test(key))
    .sort()
    .map((key) => {
      const match = /^(.*) \((\d+)\)$/.exec(metadata[key]);
      return match ? { fullName: match[1], age: Number(match[2]) } : { fullName: metadata[key], age: null };
    });
}

async function recordEnrollment(session, { enrollmentsFile, logger }) {
  const record = {
    paidAt: new Date().toISOString(),
    sessionId: session.id,
    paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null,
    amountTotal: session.amount_total,
    currency: session.currency,
    email: session.customer_details?.email ?? null,
    testMode: !session.livemode,
    candidates: candidatesFromMetadata(session.metadata),
  };
  logger.info(`Enrollment paid: ${record.sessionId} — ${record.candidates.map((c) => c.fullName).join(', ')}`);
  if (enrollmentsFile) {
    await mkdir(path.dirname(enrollmentsFile), { recursive: true });
    await appendFile(enrollmentsFile, `${JSON.stringify(record)}\n`);
  }
}

function requirePassword(password) {
  const expected = digest(password);
  return (req, res, next) => {
    const [scheme, encoded] = (req.get('authorization') ?? '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const supplied = decoded.slice(decoded.indexOf(':') + 1);
      if (decoded.includes(':') && timingSafeEqual(digest(supplied), expected)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Course enrollment", charset="UTF-8"');
    res.status(401).send('Sign in with the admin password to use this site.');
  };
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}
