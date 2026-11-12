import { h } from './dom.js';
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
  const form = h('form', { class: 'login-card', novalidate: true }, h('p', { class: 'eyebrow' }, 'RetireWell'),
    h('h1', null, 'Setter Center'),
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
  ui.refresh.textContent = busy ? 'Refreshing…' : 'Refresh';
  // Hold the previous render, dimmed, instead of flashing an empty page.
  ui.main.classList.toggle('is-refreshing', busy && !!state.payload);
}

function navLinks() {
  const active = SELFTEST ? null : currentTab()[0];
  return [
    ...TABS.map(([id, label, render]) => render
      ? h('a', { class: 'tab' + (id === active ? ' tab-active' : ''), href: SELFTEST ? `./#${id}` : `#${id}`, 'aria-current': id === active ? 'page' : null }, label)
      : h('span', { class: 'tab tab-soon', title: 'Not built yet' }, label, h('span', { class: 'soon' }, 'soon'))),
    h('a', { class: 'tab' + (SELFTEST ? ' tab-active' : ''), href: SELFTEST ? './' : '?selftest=1', 'aria-current': SELFTEST ? 'page' : null }, 'Self-test')
  ];
}

function renderShell() {
  const refreshBtn = h('button', { class: 'btn', type: 'button', onclick: () => (state.poller ? state.poller.now() : refresh()) }, 'Refresh');
  const fresh = h('p', { class: 'freshness', 'aria-live': 'polite' });
  const main = h('main', { class: 'content', id: 'content' });
  const nav = h('nav', { class: 'tabs', 'aria-label': 'Dashboard tabs' }, navLinks());
  const header = h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, h('span', { class: 'eyebrow' }, 'RetireWell'), h('span', { class: 'title' }, 'Setter Center')),
    fresh,
    h('div', { class: 'actions' },
      ADS_CENTER_URL ? h('a', { class: 'btn btn-quiet', href: ADS_CENTER_URL, rel: 'noopener noreferrer' }, 'Ads Center ↗') : null,
      refreshBtn,
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => applyTheme(toggleTheme()), 'aria-label': 'Switch light or dark theme' }, '◐'),
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => signOut() }, 'Sign out')));
  root.replaceChildren(header, nav, main);
  ui = { refresh: refreshBtn, fresh, main, nav };
  setBusy(state.busy);
}

function render() {
  if (!ui) return;
  const p = state.payload;
  ui.nav.replaceChildren(...navLinks());
  ui.fresh.replaceChildren(...freshness(p));
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

function freshness(p) {
  if (!p) return [];
  const router = p.sources.router || {};
  return [
    h('span', null, 'Fetched ', h('strong', null, ctClock(p.as_of_ct))),
    router.stamp_ct ? h('span', null, ' · routing sheet updated ', h('strong', null, ctClock(router.stamp_ct))) : null
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
