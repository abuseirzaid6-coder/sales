import { formatMoney } from './shared.js';

const title = document.getElementById('result-title');
const text = document.getElementById('result-text');
const icon = document.getElementById('result-icon');

const sessionId = new URLSearchParams(location.search).get('session_id');
if (!sessionId) {
  show('error', 'No payment to show', 'Open this page from the link Stripe sends you back to after checkout.');
} else {
  load(sessionId);
}

async function load(id) {
  try {
    const res = await fetch(`/api/checkout-session?session_id=${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      show('error', 'We couldn’t load this payment', data.error || 'Please refresh the page to try again.');
      return;
    }

    if (data.paymentStatus === 'paid') {
      show('ok', 'Payment received', 'The candidates below are enrolled in the Sales Course. Stripe has emailed a receipt.');
      clearDraft();
    } else if (data.status === 'complete') {
      show('pending', 'Payment processing', 'Stripe is still confirming this payment. The candidates are enrolled once it clears.');
      clearDraft();
    } else {
      show('error', 'Payment not completed', 'This checkout wasn’t paid. Go back to the form to try again — your candidates are saved.');
      return;
    }
    renderReceipt(data);
  } catch {
    show('error', 'We couldn’t load this payment', 'Check your connection and refresh the page.');
  }
}

function renderReceipt(data) {
  const list = document.getElementById('receipt-list');
  for (const candidate of data.candidates ?? []) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = candidate.fullName;
    const age = document.createElement('span');
    age.className = 'muted';
    age.textContent = candidate.age == null ? '' : `Age ${candidate.age}`;
    item.append(name, age);
    list.append(item);
  }
  document.getElementById('receipt-email').textContent = data.email || '—';
  if (typeof data.amountTotal === 'number') {
    document.getElementById('receipt-total').textContent = formatMoney(data.amountTotal, data.currency || 'usd');
  }
  document.getElementById('test-badge').hidden = !data.testMode;
  document.getElementById('receipt').hidden = false;
}

function show(kind, heading, body) {
  icon.dataset.kind = kind;
  icon.textContent = kind === 'ok' ? '✓' : kind === 'pending' ? '…' : '!';
  title.textContent = heading;
  text.textContent = body;
  document.title = heading;
}

function clearDraft() {
  try {
    sessionStorage.removeItem('enrollment-draft');
  } catch {
    // Storage unavailable: nothing to clear.
  }
}
