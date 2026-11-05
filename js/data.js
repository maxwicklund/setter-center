// Helpers over the endpoint payload. Every date is a 'YYYY-MM-DD' string in
// America/Chicago exactly as the server sent it; nothing here reads the browser clock.

export const DEPARTED_KEY = '__departed__';

export function rosterIndex(p) {
  const rows = new Map(p.roster.filter(r => r.status !== 'alias').map(r => [r.setter, r]));
  const status = name => (rows.get(name) || {}).status || 'unresolved';
  return {
    rows,
    status,
    isTeam: name => status(name) === 'live' || status(name) === 'onboarding',
    // The departed label is built here, never taken from sheet text.
    label: name => (name === DEPARTED_KEY ? `departed (${(rows.get(DEPARTED_KEY) || {}).departed_n || 0})` : name)
  };
}

export const sum = (arr, field, keep = () => true) => arr.reduce((t, r) => t + (keep(r) ? r[field] || 0 : 0), 0);

export const inMonth = (ymd, ym) => typeof ymd === 'string' && ymd.startsWith(ym + '-');

export const between = (ymd, from, to) => ymd >= from && ymd <= to;

export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Inclusive list of 'YYYY-MM-DD' dates from..to. */
export function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** [first, last] day of the month containing ymd, shifted by `offset` months. */
export function monthBounds(ymd, offset = 0) {
  const [y, m] = ymd.split('-').map(Number);
  const iso = t => new Date(t).toISOString().slice(0, 10);
  return [iso(Date.UTC(y, m - 1 + offset, 1)), iso(Date.UTC(y, m + offset, 0))];
}

// Date windows shared by the tabs. Every view defaults to a range, never "all time".
export const WINDOWS = [['14d', '14 days'], ['30d', '30 days'], ['this', 'This month'], ['last', 'Last month'], ['custom', 'Custom']];
export const MAX_CUSTOM_DAYS = 62;

/** {window, from, to} + today -> {from, to, days, capped}. Custom ranges cap at MAX_CUSTOM_DAYS. */
export function resolveWindow(view, today) {
  let from, to;
  if (view.window === '30d') [from, to] = [addDays(today, -29), today];
  else if (view.window === 'this') [from, to] = [monthBounds(today)[0], today];
  else if (view.window === 'last') [from, to] = monthBounds(today, -1);
  else if (view.window === 'custom' && view.from && view.to) [from, to] = view.from <= view.to ? [view.from, view.to] : [view.to, view.from];
  else [from, to] = [addDays(today, -13), today];
  if (to > today) to = today;
  let capped = false;
  if (daysBetween(from, to) >= MAX_CUSTOM_DAYS) { from = addDays(to, -(MAX_CUSTOM_DAYS - 1)); capped = true; }
  return { from, to, days: daysBetween(from, to) + 1, capped };
}

/**
 * How far through the current month the server's CT clock is, in days: at 7 PM on the
 * 2nd that's 1.8, not 2. Pace markers use elapsed / daysInMonth.
 */
export function monthElapsed(p) {
  const daysInMonth = Number(monthBounds(p.today_ct)[1].slice(8));
  const day = Number(p.today_ct.slice(8));
  const m = /T(\d{2}):(\d{2})/.exec(p.as_of_ct || '');
  const elapsed = day - 1 + (m ? (Number(m[1]) * 60 + Number(m[2])) / 1440 : 1);
  return { day, daysInMonth, elapsed };
}

/** Nearest-rank percentile of a list of numbers (q in 0..1). */
export function percentile(values, q) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)];
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
}

/** '2026-11-02T17:50:00-06:00' -> '5:50 PM CT', read off the server's string. */
export function ctClock(iso) {
  const m = /T(\d{2}):(\d{2})/.exec(iso || '');
  if (!m) return '—';
  const hour = Number(m[1]);
  return `${hour % 12 || 12}:${m[2]} ${hour < 12 ? 'AM' : 'PM'} CT`;
}

export const fmtInt = n => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));

/** Contacts (the dialer feed's Calls Over 60s) ride on dial rows only when the feed has that column. */
export const hasContacts = p => Boolean(p.health && p.health.contacts_col);

/** A share as '3.4%', one decimal: contact rates sit in single digits, where a whole percent is too coarse. */
export const fmtPct1 = v => (v == null ? '—' : `${(100 * v).toFixed(1)}%`);

/** Contacts ÷ dials, or '—' with no dials. */
export const contactRate = (contacts, dials) => (dials ? fmtPct1(contacts / dials) : '—');

/** Talk seconds -> '8m' / '4h 49m', formatted once, after summing. */
export function fmtDuration(seconds) {
  if (seconds == null) return '—';
  const mins = Math.round(seconds / 60);
  const hrs = Math.floor(mins / 60);
  return hrs ? `${hrs}h ${String(mins % 60).padStart(2, '0')}m` : `${mins}m`;
}

/** Sums one field per setter: Map(setter -> total). */
export function bySetter(arr, field) {
  const out = new Map();
  for (const r of arr) out.set(r.setter, (out.get(r.setter) || 0) + (r[field] || 0));
  return out;
}

/** '2026-11-02' -> 'Mon, Nov 2' without touching the browser's time zone. */
export function dayLabel(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
