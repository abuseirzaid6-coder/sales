import Stripe from 'stripe';
import { createApp } from './src/app.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the host's environment variables.
}

const {
  STRIPE_SECRET_KEY = '',
  STRIPE_WEBHOOK_SECRET = '',
  ADMIN_PASSWORD = '',
  PUBLIC_URL = '',
  ENROLLMENTS_FILE = 'data/enrollments.jsonl',
  PORT = '3000',
} = process.env;

if (!STRIPE_SECRET_KEY) {
  console.warn('STRIPE_SECRET_KEY is not set: the form will load, but payments are disabled.');
} else if (!/^(sk|rk)_(test|live)_/.test(STRIPE_SECRET_KEY)) {
  console.warn('STRIPE_SECRET_KEY does not look like a Stripe secret key (it should start with sk_test_ or sk_live_).');
}
if (!ADMIN_PASSWORD) {
  console.warn('ADMIN_PASSWORD is not set: anyone with the link can open the enrollment form.');
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.warn('STRIPE_WEBHOOK_SECRET is not set: paid enrollments will not be recorded by the webhook.');
}

let publicUrl = '';
if (PUBLIC_URL) {
  try {
    const url = new URL(PUBLIC_URL);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('bad protocol');
    publicUrl = url.origin;
  } catch {
    console.warn(`PUBLIC_URL "${PUBLIC_URL}" is not a valid http(s) URL; using the request's host instead.`);
  }
}

const app = createApp({
  stripe: STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null,
  webhookSecret: STRIPE_WEBHOOK_SECRET,
  adminPassword: ADMIN_PASSWORD,
  publicUrl,
  enrollmentsFile: ENROLLMENTS_FILE,
});

app.listen(Number(PORT), () => {
  console.log(`Enrollment site running on http://localhost:${PORT}`);
});
