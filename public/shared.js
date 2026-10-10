// Shared between the browser (form) and the server (authoritative checks),
// so the rules the admin sees are exactly the rules the server enforces.

export const COURSE = Object.freeze({
  id: 'sales-course-certificate',
  name: 'Sales Course Certificate Fee',
  feeCents: 15092, // $150.92 per candidate
  currency: 'usd',
});

export const RULES = Object.freeze({
  minAge: 18,
  maxAge: 120,
  maxCandidates: 40,
  maxNameLength: 100,
});

const NAME_CHARS = /^[\p{L}\p{M}'’.\- ]+$/u;
const HAS_LETTER = /\p{L}/u;

export function normalizeName(value) {
  return typeof value === 'string' ? value.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
}

export function validateName(value) {
  const name = normalizeName(value);
  if (!name) return { error: 'Enter the candidate’s full name.' };
  if (name.length > RULES.maxNameLength) {
    return { error: `Name must be ${RULES.maxNameLength} characters or fewer.` };
  }
  if (!NAME_CHARS.test(name)) {
    return { error: 'Use letters, spaces, hyphens, apostrophes and periods only.' };
  }
  const words = name.split(' ').filter((word) => HAS_LETTER.test(word));
  if (words.length < 2) return { error: 'Enter first and last name.' };
  return { value: name };
}

export function validateAge(value) {
  let age;
  if (typeof value === 'number') age = value;
  else if (typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value)) age = Number(value);
  else if (typeof value === 'string' && value.trim() === '') return { error: 'Enter the candidate’s age.' };
  else if (value === undefined || value === null) return { error: 'Enter the candidate’s age.' };
  else return { error: 'Age must be a whole number.' };

  if (!Number.isInteger(age)) return { error: 'Age must be a whole number.' };
  if (age < RULES.minAge) return { error: `Must be ${RULES.minAge} or older.` };
  if (age > RULES.maxAge) return { error: 'Enter a valid age.' };
  return { value: age };
}

// Returns { ok: true, candidates } or { ok: false, formError?, errors? }
// where errors is [{ index, field, message }].
export function validateCandidates(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, formError: 'Add at least one candidate.' };
  }
  if (list.length > RULES.maxCandidates) {
    return { ok: false, formError: `You can enroll up to ${RULES.maxCandidates} candidates per payment.` };
  }

  const errors = [];
  const candidates = list.map((entry, index) => {
    const name = validateName(entry?.fullName);
    const age = validateAge(entry?.age);
    if (name.error) errors.push({ index, field: 'fullName', message: name.error });
    if (age.error) errors.push({ index, field: 'age', message: age.error });
    return { fullName: name.value, age: age.value };
  });

  return errors.length ? { ok: false, errors } : { ok: true, candidates };
}

export function totalCents(count) {
  return count * COURSE.feeCents;
}

export function formatMoney(cents, currency = COURSE.currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}
