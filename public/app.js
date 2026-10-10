import { COURSE, RULES, formatMoney, totalCents, validateAge, validateName } from './shared.js';

const DRAFT_KEY = 'enrollment-draft';

const form = document.getElementById('enroll-form');
const countInput = document.getElementById('count');
const list = document.getElementById('candidate-list');
const rowTemplate = document.getElementById('candidate-row');
const submitBtn = document.getElementById('submit');
const formError = document.getElementById('form-error');
const notice = document.getElementById('notice');

// Values are kept for every row ever shown, so lowering the count and raising it
// again doesn't wipe what was typed.
let state = loadDraft();
let count = clampCount(state.count);

countInput.max = String(RULES.maxCandidates);
countInput.value = String(count);
document.querySelectorAll('[data-max-candidates]').forEach((el) => { el.textContent = RULES.maxCandidates; });
document.querySelectorAll('[data-fee]').forEach((el) => { el.textContent = formatMoney(COURSE.feeCents); });

const params = new URLSearchParams(location.search);
if (params.has('canceled')) {
  showNotice('Payment was canceled — nothing was charged. Your candidates are still here.');
  history.replaceState(null, '', location.pathname);
}

renderRows();

countInput.addEventListener('input', () => {
  if (countInput.value === '') return; // let the admin clear the box while typing
  setCount(Number(countInput.value), { keepInput: true });
});
countInput.addEventListener('blur', () => { countInput.value = String(count); });
form.querySelectorAll('[data-step]').forEach((btn) => {
  btn.addEventListener('click', () => setCount(count + Number(btn.dataset.step)));
});

list.addEventListener('input', (event) => {
  const row = event.target.closest('.candidate');
  if (!row) return;
  const index = Number(row.dataset.index);
  state.rows[index] = { ...state.rows[index], [event.target.name]: event.target.value };
  if (event.target.getAttribute('aria-invalid') === 'true') validateField(event.target);
  saveDraft();
});
list.addEventListener('focusout', (event) => {
  if (event.target.matches('input') && event.target.value !== '') validateField(event.target);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideFormError();

  const inputs = [...list.querySelectorAll('input')];
  const invalid = inputs.filter((input) => !validateField(input));
  if (invalid.length) {
    showFormError(invalid.length === 1 ? 'Please fix the highlighted field.' : `Please fix the ${invalid.length} highlighted fields.`);
    invalid[0].focus();
    return;
  }

  const candidates = state.rows.slice(0, count).map((row) => ({
    fullName: validateName(row.fullName).value,
    age: validateAge(row.age).value,
  }));

  setBusy(true);
  try {
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidates }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.url) {
      location.assign(data.url);
      return;
    }
    applyServerErrors(data.fieldErrors);
    showFormError(data.error || 'Could not start the payment. Please try again.');
  } catch {
    showFormError('Could not reach the server. Check your connection and try again.');
  }
  setBusy(false);
});

// Coming back from Stripe with the browser's Back button restores this page from cache.
window.addEventListener('pageshow', (event) => { if (event.persisted) setBusy(false); });

function setCount(next, { keepInput = false } = {}) {
  count = clampCount(next);
  state.count = count;
  if (!keepInput || Number(countInput.value) !== count) countInput.value = String(count);
  renderRows();
  saveDraft();
}

function renderRows() {
  while (state.rows.length < count) state.rows.push({ fullName: '', age: '' });

  const existing = list.children.length;
  for (let i = existing; i < count; i++) list.append(buildRow(i));
  while (list.children.length > count) list.lastElementChild.remove();

  document.getElementById('summary-count').textContent = String(count);
  document.getElementById('summary-total').textContent = formatMoney(totalCents(count));
  submitBtn.textContent = 'Continue to payment';
}

function buildRow(index) {
  const row = rowTemplate.content.firstElementChild.cloneNode(true);
  row.dataset.index = String(index);
  row.querySelector('.candidate-num').textContent = String(index + 1);

  for (const field of row.querySelectorAll('.field')) {
    const input = field.querySelector('input');
    const label = field.querySelector('label');
    const error = field.querySelector('.field-error');
    const id = `c${index}-${input.name}`;
    input.id = id;
    label.htmlFor = id;
    label.textContent = input.name === 'fullName' ? `Candidate ${index + 1} full name` : 'Age';
    error.id = `${id}-error`;
    input.setAttribute('aria-describedby', error.id);
    input.value = state.rows[index]?.[input.name] ?? '';
  }
  row.querySelector('[name="age"]').min = String(RULES.minAge);
  row.querySelector('[name="age"]').max = String(RULES.maxAge);
  row.querySelector('[name="fullName"]').maxLength = RULES.maxNameLength;
  return row;
}

function validateField(input) {
  const result = input.name === 'fullName' ? validateName(input.value) : validateAge(input.value);
  setFieldError(input, result.error);
  return !result.error;
}

function setFieldError(input, message) {
  const error = document.getElementById(`${input.id}-error`);
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
  error.textContent = message ?? '';
  error.hidden = !message;
}

function applyServerErrors(fieldErrors) {
  if (!Array.isArray(fieldErrors)) return;
  let first;
  for (const { index, field, message } of fieldErrors) {
    const input = document.getElementById(`c${index}-${field}`);
    if (!input) continue;
    setFieldError(input, message);
    first ??= input;
  }
  first?.focus();
}

function setBusy(busy) {
  submitBtn.disabled = busy;
  submitBtn.setAttribute('aria-busy', String(busy));
  if (busy) submitBtn.textContent = 'Opening secure checkout…';
  else renderRows();
}

function showFormError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function hideFormError() {
  formError.hidden = true;
  formError.textContent = '';
}

function showNotice(message) {
  notice.textContent = message;
  notice.hidden = false;
}

function clampCount(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, RULES.maxCandidates);
}

function loadDraft() {
  try {
    const draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY));
    if (draft && Array.isArray(draft.rows)) {
      return {
        count: draft.count,
        rows: draft.rows.slice(0, RULES.maxCandidates).map((row) => ({
          fullName: typeof row?.fullName === 'string' ? row.fullName : '',
          age: typeof row?.age === 'string' || typeof row?.age === 'number' ? String(row.age) : '',
        })),
      };
    }
  } catch {
    // Storage unavailable or corrupt: start fresh.
  }
  return { count: 1, rows: [] };
}

function saveDraft() {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ count, rows: state.rows }));
  } catch {
    // Private mode or storage full: the form still works, it just won't survive a reload.
  }
}
