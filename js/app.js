import { h, s } from './dom.js';
import { token, fetchPayload, startPolling } from './api.js';
import { runChecks, renderSelftest } from './selftest.js';
import { ctClock, rosterIndex } from './data.js';
import { renderFloor } from './tabs/floor.js';
import { renderDials } from './tabs/dials.js';
import { renderAppointments } from './tabs/appointments.js';
import { renderSetter } from './tabs/setter.js';
import { renderSpeed } from './tabs/speed.js';
import { renderGoals } from './tabs/goals.js';
import { renderHealth } from './tabs/health.js';
import { ADS_CENTER_URL } from '../config.js';

// The page ships with zero data. Everything below the login comes from the endpoint,
// and only after the team password (the endpoint token) is accepted.

const SELFTEST = new URLSearchParams(location.search).get('selftest') === '1';
// [hash, label, renderer]; a tab without a renderer is not built yet.
const TABS = [
  ['floor', 'Floor', renderFloor], ['dials', 'Dials & Activity', renderDials], ['appointments', 'Appointments', renderAppointments], ['setter', 'Setter Deep Dive', renderSetter],
  ['speed', 'Speed to Lead', renderSpeed], ['goals', 'Goals & Leaderboard', renderGoals], ['health', 'Data Health', renderHealth]
];
// '#health:def-booked' = the Data Health tab, scrolled to that definition.
const currentTab = () => {
  const id = location.hash.slice(1).split(':')[0];
  return TABS.find(t => t[0] === id && t[2]) || TABS[0];
};
const hashAnchor = () => location.hash.split(':')[1] || null;
const THEME_KEY = 'rwsc.theme';
// Stroke icons on a 24-unit grid: one path each.
const ICONS = {
  floor: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  dials: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z',
  appointments: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  setter: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  speed: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  goals: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  health: 'M22 12h-4l-3 9L9 3l-3 9H2',
  selftest: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  brand: 'M12 3l7 3v5c0 4.4-3 8.3-7 9.6-4-1.3-7-5.2-7-9.6V6l7-3zM9 12l2 2 4-4',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
  theme: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3'
};
const icon = (name, cls = 'ico') => s('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, s('path', { d: ICONS[name] }));
const brandTile = () => h('span', { class: 'brand-tile', 'aria-hidden': 'true' }, icon('brand', 'brand-icon'));
const SHEET_LABELS = { kpi: 'Sheet A (KPI dashboard)', tracker: 'Sheet B (appointment tracker)', router: 'Sheet C (setter routing)', ads: 'Sheet D (lead router: ad spend)' };

const root = document.getElementById('app');
const state = { payload: null, text: '', error: null, busy: false, poller: null, checks: null };
let ui = null;

applyTheme(readTheme());
state.anchor = hashAnchor();
window.addEventListener('hashchange', () => {
  state.anchor = hashAnchor();
  if (!state.anchor) window.scrollTo(0, 0);
  render();
});
if (token.get()) openDashboard();
else showLogin();

// ---------------------------------------------------------------- login

function showLogin(message) {
  const input = h('input', { type: 'password', id: 'token', name: 'password', autocomplete: 'current-password', required: true, spellcheck: 'false', autocapitalize: 'off' });
  const error = h('p', { class: 'login-error', role: 'alert' }, message || '');
  const button = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Open dashboard');
  const form = h('form', { class: 'login-card', novalidate: true }, brandTile(),
    h('h1', { class: 'login-title' }, 'RetireWell — Setter Center'),
    h('p', { class: 'login-sub' }, 'Live setter floor · RetireWell Annuities'),
    // Lets password managers file the shared password under one name.
    h('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'RetireWell team', hidden: true, readonly: true }),
    h('label', { for: 'token' }, 'Team password'), input, error, button,
    h('p', { class: 'login-note' }, "One shared password for the whole team. Ask Max if you don't have it, and keep it out of group chats."));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) { error.textContent = 'Enter the team password.'; return; }
    button.disabled = true;
    button.textContent = 'Checking…';
    error.textContent = '';
    try {
      const res = await fetchPayload(value);
      token.set(value);
      openDashboard(res);
    } catch (err) {
      error.textContent = err.code === 'unauthorized' ? "That password didn't work." : errorText(err);
      button.disabled = false;
      button.textContent = 'Open dashboard';
      input.select();
    }
  });
  root.replaceChildren(h('main', { class: 'login' }, form));
  input.focus();
}

function signOut(message) {
  if (state.poller) state.poller.stop();
  token.clear();
  Object.assign(state, { payload: null, text: '', error: null, poller: null, checks: null });
  ui = null;
  showLogin(message);
}

// ---------------------------------------------------------------- dashboard

async function openDashboard(prefetched) {
  renderShell();
  render();
  if (prefetched) accept(prefetched);
  else await refresh();
  // The self-test makes three extra unauthorized calls per run, so it never auto-polls.
  if (!SELFTEST && token.get()) state.poller = startPolling(refresh);
}

async function refresh() {
  setBusy(true);
  try {
    accept(await fetchPayload(token.get()));
  } catch (err) {
    if (err.code === 'unauthorized') return signOut('That team password no longer works. It may have been changed: ask Max for the new one.');
    state.error = err;
    render();
  } finally {
    setBusy(false);
  }
}

function accept(res) {
  state.payload = res.payload;
  state.text = res.text;
  state.error = null;
  state.checks = null;
  render();
}

function setBusy(busy) {
  state.busy = busy;
  if (!ui) return;
  ui.refresh.disabled = busy;
  ui.refreshLabel.textContent = busy ? 'Refreshing…' : 'Refresh';
  // Hold the previous render, dimmed, instead of flashing an empty page.
  ui.main.classList.toggle('is-refreshing', busy && !!state.payload);
}

function navLinks() {
  const active = SELFTEST ? null : currentTab()[0];
  const link = (id, label, href, on, cls = '') => h('a', { class: 'rail-tab' + cls, href, 'aria-current': on ? 'page' : null }, icon(id, 'rail-icon'), h('span', null, label));
  return [
    ...TABS.filter(t => t[2]).map(([id, label]) => link(id, label, SELFTEST ? `./#${id}` : `#${id}`, id === active)),
    link('selftest', 'Self-test', SELFTEST ? './' : '?selftest=1', SELFTEST, ' is-quiet')
  ];
}

function renderShell() {
  const refreshLabel = h('span', null, 'Refresh');
  const refreshBtn = h('button', { class: 'btn btn-outline', type: 'button', onclick: () => (state.poller ? state.poller.now() : refresh()) }, icon('refresh'), refreshLabel);
  const fresh = h('div', { class: 'status-pill', 'data-state': 'loading', 'aria-live': 'polite' });
  const main = h('main', { class: 'content', id: 'content' });
  const nav = h('div', { class: 'rail-inner' }, navLinks());
  const header = h('header', { class: 'desk' }, h('div', { class: 'desk-inner' },
    h('div', { class: 'desk-id' }, brandTile(),
      h('div', { class: 'desk-titles' },
        h('p', { class: 'desk-name' }, 'RetireWell — Setter Center'),
        h('p', { class: 'desk-sub' }, 'Live setter floor · RetireWell Annuities'))),
    h('div', { class: 'desk-status' },
      fresh,
      h('div', { class: 'desk-actions' },
        ADS_CENTER_URL ? h('a', { class: 'btn btn-quiet', href: ADS_CENTER_URL, rel: 'noopener noreferrer' }, h('span', null, 'Ads Center'), icon('external')) : null,
        refreshBtn,
        h('button', { class: 'btn btn-quiet btn-icon', type: 'button', onclick: () => applyTheme(toggleTheme()), 'aria-label': 'Switch light or dark theme', title: 'Light or dark theme' }, icon('theme')),
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => signOut() }, icon('out'), h('span', null, 'Sign out'))))));
  root.replaceChildren(header, h('nav', { class: 'rail', 'aria-label': 'Dashboard tabs' }, nav), main);
  ui = { refresh: refreshBtn, refreshLabel, fresh, main, nav };
  setBusy(state.busy);
}

function render() {
  if (!ui) return;
  const p = state.payload;
  ui.nav.replaceChildren(...navLinks());
  ui.fresh.replaceChildren(...freshness(p));
  ui.fresh.dataset.state = state.error ? 'error' : !p ? 'loading' : Object.values(p.sources).some(src => !src.ok) ? 'stale' : 'fresh';
  const parts = [];
  if (state.error) {
    parts.push(h('div', { class: 'banner banner-bad', role: 'alert' },
      p ? `Refresh failed, showing data fetched at ${ctClock(p.as_of_ct)}. ` : '', errorText(state.error)));
  }
  if (p) {
    const lost = Object.entries(p.sources).filter(([, s]) => !s.ok);
    if (lost.length) {
      parts.push(h('div', { class: 'banner banner-warn', role: 'status' },
        `Couldn't read ${lost.map(([k]) => SHEET_LABELS[k]).join(' and ')}. Tabs that depend on it are greyed out; everything else is current. `,
        lost.map(([, s]) => s.error).join(' · ')));
    }
    parts.push(SELFTEST ? selftestView() : currentTab()[2](p, rosterIndex(p)));
  } else if (!state.error) {
    parts.push(h('p', { class: 'muted loading' }, 'Loading…'));
  }
  ui.main.replaceChildren(...parts);
  if (state.anchor && p) {
    const target = document.getElementById(state.anchor);
    if (target) { target.scrollIntoView({ block: 'start' }); target.classList.add('is-target'); state.anchor = null; }
  }
}

/** The header's status pill: one dot for the page, when it was fetched, then the routing sheet's own stamp. */
function freshness(p) {
  const dot = h('span', { class: 'status-dot', 'aria-hidden': 'true' });
  if (!p) return [h('span', { class: 'status-main' }, dot, h('span', { class: 'status-text' }, state.error ? 'Not connected' : 'Connecting…'))];
  const router = p.sources.router || {};
  return [
    h('span', { class: 'status-main' }, dot, h('span', { class: 'status-text' }, state.error ? 'Refresh failed · ' : 'Updated ', ctClock(p.as_of_ct))),
    router.stamp_ct ? h('span', { class: 'status-srcs' }, h('span', { class: 'fresh-label' }, 'Routing sheet'), ' ', ctClock(router.stamp_ct)) : null
  ];
}

function selftestView() {
  const holder = h('div', null, h('p', { class: 'muted loading' }, 'Running checks against the live payload…'));
  const run = state.checks || runChecks({ payload: state.payload, text: state.text });
  state.checks = run;
  run.then(rows => holder.replaceChildren(renderSelftest(rows, { onRerun: () => refresh() })))
    .catch(err => holder.replaceChildren(h('div', { class: 'banner banner-bad' }, `The self-test itself failed: ${err.message}`)));
  return holder;
}

function errorText(err) {
  switch (err.code) {
    case 'payload_guard': return `The server withheld the data because a privacy check tripped (${err.detail}). Nothing was sent. Tell Max.`;
    case 'internal': return `The data service hit an error: ${err.detail || 'no detail'}.`;
    default: return err.detail || err.message || String(err);
  }
}

// ---------------------------------------------------------------- theme (a per-viewer preference)

function readTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, next); } catch { /* not remembered; still switches */ }
  return next;
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}
