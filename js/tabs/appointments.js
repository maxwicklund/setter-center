import { h } from '../dom.js';
import { WINDOWS, fmtInt, bySetter, dayLabel, addDays, resolveWindow } from '../data.js';
import { tag, segmented, customRange, defLink } from '../ui.js';

// Tab 3, Appointments & Show Quality. Two panels that must never be read as one table:
// Booked is counted by Date Booked, outcomes by Appointment Date. Same rows, different
// date column, different population, so the divider between them is the design.

const MIN_RESOLVED = 10; // below this a rate is a greyed raw fraction, and unranked
const MATURE = 0.95;

const view = { window: '30d', from: null, to: null };

export function renderAppointments(p, ix) {
  const root = h('div', { class: 'appts-tab' });
  const draw = () => root.replaceChildren(...content(p, ix, draw));
  draw();
  return root;
}

function content(p, ix, draw) {
  if (!p.sources.tracker.ok) {
    return [h('div', { class: 'banner banner-warn' }, "Sheet B (the appointment tracker) couldn't be read, so there are no appointment numbers right now.")];
  }
  const win = resolveWindow(view, p.today_ct);
  const inWin = d => d && d >= win.from && d <= win.to;

  // Left: by Date Booked.
  const booked = bySetter(p.booked.filter(r => inWin(r.date_booked)), 'booked');
  const bookedRows = [...booked].map(([setter, n]) => ({ setter, n })).filter(r => r.n > 0)
    .sort((a, b) => b.n - a.n || ix.label(a.setter).localeCompare(ix.label(b.setter)));
  const bookedTotal = bookedRows.reduce((t, r) => t + r.n, 0);

  // Right: by Appointment Date.
  const out = new Map();
  const row = s => out.get(s) || out.set(s, { setter: s, showed: 0, no_show: 0, rescheduled: 0, canceled: 0, other: 0, pending: 0, pendingDue: 0, qs: 0 }).get(s);
  for (const r of p.outcomes.filter(r => inWin(r.appt_date))) {
    const o = row(r.setter);
    o.showed += r.showed; o.no_show += r.no_show; o.rescheduled += r.rescheduled;
    o.canceled += r.canceled; o.other += r.other_status; o.qs += r.qualified_show;
  }
  for (const r of p.pending.filter(r => inWin(r.appt_date))) {
    const o = row(r.setter);
    o.pending += r.pending;
    if (r.appt_date < p.today_ct) o.pendingDue += r.pending;
  }
  const outRows = [...out.values()].map(o => ({ ...o, resolved: o.showed + o.no_show + o.rescheduled }))
    .filter(o => o.resolved + o.pending + o.canceled + o.other > 0)
    .sort((a, b) => b.resolved + b.pending + b.canceled - (a.resolved + a.pending + a.canceled) || ix.label(a.setter).localeCompare(ix.label(b.setter)));
  const team = outRows.reduce((t, o) => {
    for (const k of ['showed', 'no_show', 'rescheduled', 'canceled', 'other', 'pending', 'pendingDue', 'qs', 'resolved']) t[k] += o[k];
    return t;
  }, { showed: 0, no_show: 0, rescheduled: 0, canceled: 0, other: 0, pending: 0, pendingDue: 0, qs: 0, resolved: 0 });
  // Maturity: of the appointments dated before today, how many have an outcome.
  const settled = team.resolved + team.canceled + team.other;
  const maturity = settled + team.pendingDue ? settled / (settled + team.pendingDue) : 1;
  const ahead = p.pending.filter(r => r.appt_date > p.today_ct).reduce((t, r) => t + r.pending, 0);

  const windowText = `${dayLabel(win.from)} – ${dayLabel(win.to)} · ${win.days} days`;
  return [
    h('div', { class: 'controls' },
      segmented('Window', WINDOWS, view.window, v => { view.window = v; draw(); }),
      view.window === 'custom' ? customRange(view, win, p.today_ct, draw) : null,
      h('span', { class: 'controls-gap' }),
      h('span', { class: 'mix-label', title: 'The tracker has no column that separates the two lead sources, so every figure here includes both.' },
        defLink('client-mix', 'RetireWell + Funnel client — mixed'))),
    maturity < MATURE ? h('div', { class: 'banner banner-warn', role: 'status' },
      `This window is ${pct(maturity)} resolved: ${fmtInt(team.pendingDue)} appointments dated before today still have no outcome. ` +
      'Show rates will move as those land, and a fresh window reads low until they do. ', defLink('maturity', 'About maturity')) : null,
    h('div', { class: 'split' },
      bookedPanel(bookedRows, bookedTotal, p, ix, windowText),
      h('div', { class: 'split-divider', role: 'separator', 'aria-orientation': 'vertical' }),
      outcomesPanel(outRows, team, maturity, ahead, ix, windowText))
  ];
}

// ---------------------------------------------------------------- Booked

function bookedPanel(rows, total, p, ix, windowText) {
  const max = Math.max(...rows.map(r => r.n), 1);
  return h('section', { class: 'panel panel-booked', 'aria-labelledby': 'booked-title' },
    h('h2', { id: 'booked-title', class: 'panel-title' }, defLink('booked', 'Booked — counted by the day the setter booked it')),
    h('p', { class: 'sub' }, `${windowText} · by Date Booked · entered so far`),
    h('p', { class: 'panel-total' }, h('span', { class: 'big' }, fmtInt(total)), ' booked'),
    rows.length ? h('div', { class: 'hbars' }, rows.map(r => {
      const fill = h('div', { class: 'hbar-fill booked-fill' });
      fill.style.width = `${((100 * r.n) / max).toFixed(1)}%`;
      return h('div', { class: 'hbar-row', title: `${ix.label(r.setter)}: ${r.n} booked` },
        h('span', { class: 'hbar-name' }, ix.label(r.setter), tag(ix.status(r.setter))),
        h('div', { class: 'hbar-track' }, fill),
        h('span', { class: 'hbar-val' }, fmtInt(r.n)));
    })) : h('p', { class: 'faint' }, 'Nothing booked in this window.'),
    weeklyTrend(p),
    h('p', { class: 'sub faint' }, 'The tracker often trails the floor: today is always "entered so far", and a gap means rows still to be entered.'));
}

/** Six Monday-to-Sunday weeks of team bookings ending with this (partial) week. */
function weeklyTrend(p) {
  const dow = (new Date(p.today_ct + 'T00:00:00Z').getUTCDay() + 6) % 7; // Monday = 0
  const thisMonday = addDays(p.today_ct, -dow);
  const weeks = [5, 4, 3, 2, 1, 0].map(k => {
    const from = addDays(thisMonday, -7 * k);
    const to = addDays(from, 6);
    const n = p.booked.filter(r => r.date_booked >= from && r.date_booked <= to).reduce((t, r) => t + r.booked, 0);
    return { from, n, current: k === 0 };
  });
  const max = Math.max(...weeks.map(w => w.n), 1);
  return h('div', { class: 'trend6' },
    h('p', { class: 'label' }, 'Team, last 6 weeks · by Date Booked'),
    h('div', { class: 'trend6-cols', role: 'img', 'aria-label': weeks.map(w => `week of ${dayLabel(w.from)}: ${w.n}`).join('; ') },
      weeks.map(w => {
        const bar = h('div', { class: 'trend6-bar booked-fill' + (w.current ? ' is-partial' : '') });
        bar.style.height = `${Math.max(2, (64 * w.n) / max).toFixed(1)}px`;
        return h('div', { class: 'trend6-col', title: `Week of ${dayLabel(w.from)}${w.current ? ' (so far)' : ''}: ${w.n} booked` },
          h('span', { class: 'trend6-val' }, fmtInt(w.n)),
          h('div', { class: 'trend6-track' }, bar),
          h('span', { class: 'trend6-lbl' }, w.current ? 'This wk' : dayLabel(w.from).split(', ')[1]));
      })));
}

// ---------------------------------------------------------------- Outcomes

function outcomesPanel(rows, team, maturity, ahead, ix, windowText) {
  const scale = Math.max(...rows.map(o => o.resolved + o.pending + o.canceled + o.other), 1);
  const w = n => `${((92 * n) / scale).toFixed(2)}%`;
  const seg = (cls, n, label, who) => {
    if (!n) return null;
    const el = h('span', { class: `seg-${cls}`, title: `${who}: ${n} ${label}` });
    el.style.width = w(n);
    return el;
  };
  return h('section', { class: 'panel panel-outcomes', 'aria-labelledby': 'outcomes-title' },
    h('h2', { id: 'outcomes-title', class: 'panel-title' }, defLink('outcomes', 'Outcomes — counted by the day of the appointment')),
    h('p', { class: 'sub' }, `${windowText} · by Appointment Date · ${pct(maturity)} resolved` +
      (ahead ? ` · ${fmtInt(ahead)} more still ahead on the calendar, not counted` : '')),
    h('p', { class: 'panel-total' },
      h('span', { class: 'big' }, fmtInt(team.showed)), ' showed · ',
      h('strong', null, fmtInt(team.qs)), ' qualified shows · ',
      `${fmtInt(team.no_show)} no show · ${fmtInt(team.rescheduled)} rescheduled · ${fmtInt(team.pending)} pending · ${fmtInt(team.canceled)} canceled` +
      (team.other ? ` · ${fmtInt(team.other)} other status` : '')),
    h('div', { class: 'legend' },
      key('k-showed', 'Showed'), key('k-noshow', 'No Show'), key('k-resched', 'Rescheduled'),
      h('span', { class: 'legend-gap' }, '|'), key('k-pending', 'Pending'), key('k-canceled', 'Canceled'),
      team.other ? key('k-other', 'Other status') : null),
    rows.length ? h('div', { class: 'stack-rows' }, rows.map(o => {
      const who = ix.label(o.setter);
      // The resolved stack, then Pending, Canceled and Other each after a visible gap,
      // so none of them reads as part of the rate.
      const stack = [seg('showed', o.showed, 'showed', who), seg('noshow', o.no_show, 'no show', who), seg('resched', o.rescheduled, 'rescheduled', who)].filter(Boolean);
      if (stack.length) stack[stack.length - 1].classList.add('end');
      const apart = [seg('pending', o.pending, 'pending', who), seg('canceled', o.canceled, 'canceled', who), seg('other', o.other, 'other status', who)].filter(Boolean);
      apart.forEach(el => el.classList.add('apart'));
      return h('div', { class: 'stack-row' },
        h('span', { class: 'hbar-name' }, who, tag(ix.status(o.setter))),
        h('div', { class: 'stack' }, stack, apart),
        h('span', { class: 'stack-nums' },
          `${o.showed} showed (${o.qs} qualified) · ${o.no_show} no show · ${o.pending} pending · ${o.canceled} canceled` +
          (o.rescheduled ? ` · ${o.rescheduled} rescheduled` : '') + (o.other ? ` · ${o.other} other` : '')));
    })) : h('p', { class: 'faint' }, 'No appointments dated in this window.'),
    showRatePlot(rows, team, maturity, ix),
    h('p', { class: 'sub faint footnote' },
      'True Show Rate = Showed ÷ (Showed + No Show + Rescheduled). Qualified Show Rate uses the same denominator. ' +
      'Pending and Canceled are drawn apart from the stack and are excluded from both rates. Rescheduled has never occurred in the data.'));
}

/** Rates as dots on a 0-100% axis, never as bars. Under MIN_RESOLVED: a greyed fraction, unranked. */
function showRatePlot(rows, team, maturity, ix) {
  const ranked = rows.filter(o => o.resolved >= MIN_RESOLVED)
    .map(o => ({ ...o, rate: o.showed / o.resolved, qrate: o.qs / o.resolved }))
    .sort((a, b) => b.rate - a.rate || b.resolved - a.resolved);
  const small = rows.filter(o => o.resolved < MIN_RESOLVED);
  const teamRate = team.resolved ? team.showed / team.resolved : null;
  const teamQ = team.resolved ? team.qs / team.resolved : null;
  const at = v => `${(100 * v).toFixed(2)}%`;
  const axis = h('div', { class: 'dot-axis', 'aria-hidden': 'true' },
    [0, 25, 50, 75, 100].map(t => { const tk = h('span', { class: 'dot-tick' }, `${t}%`); tk.style.left = `${t}%`; return tk; }));
  const teamLine = (cls, v) => { if (v == null) return null; const l = h('span', { class: cls }); l.style.left = at(v); return l; };

  return h('div', { class: 'dotplot' },
    h('div', { class: 'dotplot-head' },
      h('p', { class: 'label' }, defLink('show-rate', 'True Show Rate'), ` by setter · ${pct(maturity)} resolved`),
      h('div', { class: 'legend' },
        h('span', { class: 'legend-item' }, h('span', { class: 'dot dot-show static' }), 'True Show Rate'),
        h('span', { class: 'legend-item' }, h('span', { class: 'dot dot-q static' }), 'Qualified Show Rate'),
        teamRate != null ? h('span', { class: 'legend-item' }, h('span', { class: 'team-key' }), `Team ${pct(teamRate)} · qualified ${pct(teamQ)} (n = ${fmtInt(team.resolved)})`) : null)),
    ranked.length ? h('div', { class: 'dot-rows' },
      ranked.map(o => {
        const dot = h('span', { class: 'dot dot-show', title: `True Show Rate ${pct(o.rate)} (${o.showed}/${o.resolved})` });
        dot.style.left = at(o.rate);
        const q = h('span', { class: 'dot dot-q', title: `Qualified Show Rate ${pct(o.qrate)} (${o.qs}/${o.resolved})` });
        q.style.left = at(o.qrate);
        return h('div', { class: 'dot-row' },
          h('span', { class: 'hbar-name' }, ix.label(o.setter), tag(ix.status(o.setter))),
          h('div', { class: 'dot-track' }, teamLine('team-line', teamRate), q, dot),
          h('span', { class: 'dot-val' }, `${pct(o.rate)} · Q ${pct(o.qrate)}`, h('span', { class: 'faint' }, ` n=${o.resolved}`)));
      }),
      h('div', { class: 'dot-row dot-axis-row' }, h('span'), axis, h('span'))) : h('p', { class: 'faint' }, `Nobody has ${MIN_RESOLVED} or more resolved appointments in this window.`),
    small.length ? h('div', { class: 'small-n' },
      h('p', { class: 'label' }, `Fewer than ${MIN_RESOLVED} resolved — shown as shows/resolved, not ranked`),
      h('ul', null, small.map(o => h('li', null, ix.label(o.setter), ' ',
        h('span', { class: 'fraction' }, o.resolved ? `${o.showed}/${o.resolved}` : 'none resolved yet'))))) : null);
}

function key(cls, label) {
  return h('span', { class: 'legend-item' }, h('span', { class: `swatch ${cls}` }), label);
}

const pct = v => (v == null ? '—' : `${Math.round(100 * v)}%`);
