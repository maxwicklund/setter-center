import { h } from './dom.js';

// Small pieces shared by the tabs.

/** Roster status beside a name: nothing for live setters. */
export function tag(status) {
  if (status === 'onboarding') return h('span', { class: 'tag' }, 'onboarding');
  if (status === 'unresolved') return h('span', { class: 'tag tag-flag', title: 'In the data but not on the live roster or the departed list. See Data Health.' }, '⚑ not on roster');
  return null;
}

/**
 * One headline number: label, value, one plain line under it. Greyed with `off` when its
 * source is down. kind ('count', 'money' or 'accent') colours the tile's top line; count
 * and money colour the figure too. `extra` sits between the figure and the line under it.
 */
export function tile(label, value, sub, ok, { off = 'source unavailable', kind = null, extra = null } = {}) {
  return h('section', { class: 'tile card' + (kind ? ` kind-${kind}` : '') + (ok ? '' : ' is-unavailable') },
    h('p', { class: 'label' }, label),
    h('p', { class: 'tile-value' }, value),
    ok ? extra : null,
    h('p', { class: 'sub' }, ok ? sub : off));
}

/** A rate on a short inline bar: the bar fills value ÷ scale (capped at full), the label is the figure. */
export function rateBar(value, label, scale = 1) {
  const fill = h('span', { class: 'pbar-fill' });
  fill.style.width = `${(100 * Math.min(1, Math.max(0, value / scale))).toFixed(1)}%`;
  return h('span', { class: 'pbar' }, h('span', { class: 'pbar-track', 'aria-hidden': 'true' }, fill), h('span', { class: 'pbar-label' }, label));
}

/** A metric label that links to its definition on the Data Health tab. */
export function defLink(key, ...children) {
  return h('a', { class: 'deflink', href: `#health:def-${key}`, title: 'What this means' }, ...children);
}

/** Two date inputs for a "Custom" window; writes view.from / view.to, then redraws. */
export function customRange(view, win, today, draw) {
  const input = (value, onSet) => h('input', {
    type: 'date', value, min: '2026-01-01', max: today, class: 'date-input',
    onchange: e => { if (e.target.value) { onSet(e.target.value); draw(); } }
  });
  return h('div', { class: 'custom-range' },
    input(view.from || win.from, v => { view.from = v; view.to = view.to || win.to; }),
    h('span', { class: 'faint' }, 'to'),
    input(view.to || win.to, v => { view.to = v; view.from = view.from || win.from; }));
}

/** A one-row segmented control. options: [[value, label], ...] */
export function segmented(label, options, value, onChange) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': label },
    options.map(([v, text]) => h('button', {
      type: 'button', class: 'seg-btn', 'aria-pressed': String(v === value), onclick: () => v !== value && onChange(v)
    }, text)));
}
