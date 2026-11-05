import { h, s } from '../dom.js';
import { DEPARTED_KEY, WINDOWS, MAX_CUSTOM_DAYS, fmtInt, fmtDuration, bySetter, dayLabel, addDays, dateRange, resolveWindow, percentile, hasContacts, fmtPct1 } from '../data.js';
import { tag, segmented, customRange, defLink } from '../ui.js';

// Tab 2, Dials & Activity: setters x days, one cell per day, on one sequential ramp
// anchored at 0 and the window's 95th percentile. A day the dialer has no row for is
// hatched "no data", never a 0. Counted by the dialer's date.

const METRICS = {
  dials: { label: 'Dials', of: r => r.dials, cell: v => fmtInt(v), long: v => `${fmtInt(v)} dials` },
  contacts: { label: 'Contacts', of: r => r.contacts, cell: v => fmtInt(v), long: v => `${fmtInt(v)} contacts (calls over 60s)`, needsContacts: true },
  rate: { label: 'Contact rate', of: r => (r.dials > 0 ? r.contacts / r.dials : null), cell: v => fmtPct1(v), long: v => `${fmtPct1(v)} of dials were contacts`,
    none: 'no contact rate', ratio: true, needsContacts: true },
  talk: { label: 'Talk time', of: r => r.talk_seconds, cell: v => shortDuration(v), long: v => `${fmtDuration(v)} talk` },
  spd: { label: 'Seconds per dial', of: r => (r.dials > 0 ? r.talk_seconds / r.dials : null), cell: v => `${Math.round(v)}s`, long: v => `${Math.round(v)} seconds per dial`,
    none: 'no seconds per dial', ratio: true }
};
const STEPS = 5;

// Kept across polls and tab switches so a refresh never resets what someone picked.
const view = { window: '14d', metric: 'dials', from: null, to: null };

export function renderDials(p, ix) {
  const root = h('div', { class: 'dials-tab' });
  const draw = () => {
    root.replaceChildren(...content(p, ix, draw));
    // On a narrow screen, open on the newest days rather than the oldest.
    requestAnimationFrame(() => {
      const box = root.querySelector('.heat-scroll');
      if (box && box.scrollWidth > box.clientWidth) box.scrollLeft = box.scrollWidth;
    });
  };
  draw();
  return root;
}

function content(p, ix, draw) {
  if (!p.sources.kpi.ok) {
    return [h('div', { class: 'banner banner-warn' }, "Sheet A couldn't be read, so there are no dial counts right now. The grid comes back on the next successful refresh.")];
  }
  const contactsOk = hasContacts(p);
  const metrics = Object.entries(METRICS).filter(([, m]) => contactsOk || !m.needsContacts);
  if (!metrics.some(([k]) => k === view.metric)) view.metric = 'dials';
  const M = METRICS[view.metric];
  const win = resolveWindow(view, p.today_ct);
  const dates = dateRange(win.from, win.to);
  const dates30 = dateRange(addDays(p.today_ct, -29), p.today_ct);
  const byKey = new Map(p.dials.map(r => [`${r.setter}|${r.date}`, r]));
  const covered = new Set(p.dials.map(r => r.setter));
  const booked = bySetter(p.booked.filter(r => r.date_booked >= win.from && r.date_booked <= win.to), 'booked');

  const withCoverage = [...covered].map(setter => {
    const days = dates.map(d => byKey.get(`${setter}|${d}`) || null);
    const present = days.filter(Boolean);
    const dials = present.reduce((t, r) => t + r.dials, 0);
    const talk = present.reduce((t, r) => t + r.talk_seconds, 0);
    const contacts = present.reduce((t, r) => t + (r.contacts || 0), 0);
    return {
      setter, days, dials, talk, contacts, booked: booked.get(setter) || 0,
      active: present.filter(r => r.dials > 0).length,
      trend: dates30.map(d => { const r = byKey.get(`${setter}|${d}`); return r ? M.of(r) : null; })
    };
  })
    // Departed people show (as one row) only in a window where they did something.
    .filter(r => r.setter !== DEPARTED_KEY || r.dials > 0 || r.booked > 0)
    .sort((a, b) => windowValue(b) - windowValue(a) || ix.label(a.setter).localeCompare(ix.label(b.setter)));

  // Rostered or appearing in the data, but never stored by the dialer: every cell hatched.
  const noCoverage = p.roster
    .filter(r => r.status !== 'alias' && !covered.has(r.setter) &&
      (r.setter === DEPARTED_KEY ? booked.get(DEPARTED_KEY) : r.active || r.in_appt_data))
    .map(r => ({ setter: r.setter, booked: booked.get(r.setter) || 0 }))
    .sort((a, b) => b.booked - a.booked || ix.label(a.setter).localeCompare(ix.label(b.setter)));

  // Colour scale: 0 to the 95th percentile of this window's cells, so one huge day
  // can't wash the grid out. Values above it share the darkest step.
  const cellValues = withCoverage.flatMap(r => r.days.filter(Boolean).map(M.of)).filter(v => v != null);
  const top = percentile(cellValues, 0.95) || 1;
  const step = v => (v === 0 ? 0 : 1 + Math.min(STEPS - 1, Math.floor((Math.min(v, top) / top) * STEPS - 1e-9)));

  const team = dates.map(d => {
    const rows = p.dials.filter(r => r.date === d);
    if (!rows.length) return null;
    const dials = rows.reduce((t, r) => t + r.dials, 0);
    const talk = rows.reduce((t, r) => t + r.talk_seconds, 0);
    const contacts = rows.reduce((t, r) => t + (r.contacts || 0), 0);
    return M.of({ dials, talk_seconds: talk, contacts });
  });
  const teamTotals = withCoverage.reduce((t, r) => ({ dials: t.dials + r.dials, talk: t.talk + r.talk, contacts: t.contacts + r.contacts, active: t.active + r.active }),
    { dials: 0, talk: 0, contacts: 0, active: 0 });

  const controls = h('div', { class: 'controls' },
    segmented('Window', WINDOWS, view.window, v => { view.window = v; draw(); }),
    view.window === 'custom' ? customRange(view, win, p.today_ct, draw) : null,
    h('span', { class: 'controls-gap' }),
    segmented('Cell shows', metrics.map(([k, m]) => [k, m.label]), view.metric, v => { view.metric = v; draw(); }));

  const notes = [];
  if (p.coverage.dials_from && win.from < p.coverage.dials_from) notes.push(`The dialer feed starts ${dayLabel(p.coverage.dials_from)}, ${p.coverage.dials_from.slice(0, 4)}; earlier days are hatched "no data", not zeros.`);
  if (win.capped) notes.push(`Custom ranges show at most ${MAX_CUSTOM_DAYS} days; this one was trimmed to end on ${dayLabel(win.to)}.`);

  return [
    controls,
    h('section', { class: 'card heat-card', 'aria-labelledby': 'heat-title' },
      h('div', { class: 'card-head' },
        h('h2', { id: 'heat-title' }, `${M.label} per setter per day`),
        h('p', { class: 'sub' }, `${dayLabel(win.from)} – ${dayLabel(win.to)} · ${win.days} days · by dialer date · booked by Date Booked`),
        h('p', { class: 'sub' }, `Everyone on the dialer: ${fmtInt(teamTotals.dials)} dials on ${fmtInt(teamTotals.active)} active setter-days ` +
          `(${teamTotals.active ? fmtInt(teamTotals.dials / teamTotals.active) : '—'} per active day)` +
          (contactsOk ? ` · ${fmtInt(teamTotals.contacts)} contacts (${teamTotals.dials ? fmtPct1(teamTotals.contacts / teamTotals.dials) : '—'} of dials)` : '') +
          ` · ${fmtDuration(teamTotals.talk)} talk` +
          (teamTotals.dials ? ` · ${Math.round(teamTotals.talk / teamTotals.dials)}s per dial` : '')),
        notes.map(n => h('p', { class: 'sub faint' }, n))),
      h('div', { class: 'heat-scroll' },
        heatTable(dates, p.today_ct, withCoverage, noCoverage, team, M, step, ix)),
      legend(M, top)),
    h('p', { class: 'sub faint' }, defLink('active-day', 'Active day'),
      ' = a day with dials > 0; per-day averages divide by active days, not calendar days. The dialer stores a row for every rostered setter every day, ' +
      "including days before they started, so a 0 doesn't prove anyone was working.",
      contactsOk ? [' ', defLink('contacts-60', 'Contacts'), ' = dialer calls over 60 seconds (voicemails that long included); contact rate = contacts ÷ dials.'] : null)
  ];

  function windowValue(r) {
    if (view.metric === 'dials') return r.dials;
    if (view.metric === 'contacts') return r.contacts;
    if (view.metric === 'talk') return r.talk;
    if (view.metric === 'rate') return r.dials ? r.contacts / r.dials : -1;
    return r.dials ? r.talk / r.dials : -1;
  }
}

function heatTable(dates, today, rows, noCoverage, team, M, step, ix) {
  const teamTop = Math.max(...team.filter(v => v != null), 1);
  const head = h('tr', null,
    h('th', { scope: 'col', class: 'who sticky' }, 'Setter'),
    dates.map((d, i) => {
      const day = Number(d.slice(8));
      const monthMark = i === 0 || day === 1 ? dayLabel(d).split(', ')[1].split(' ')[0] : '';
      return h('th', { scope: 'col', class: 'day' + (d === today ? ' is-today' : ''), title: dayLabel(d) + (d === today ? ' (today, so far)' : '') },
        h('span', { class: 'month' }, monthMark || ' '),
        h('span', { class: 'dow' }, dayLabel(d).slice(0, 1)),
        h('span', { class: 'dom' }, String(day)));
    }),
    h('th', { scope: 'col', class: 'num' }, M.ratio ? 'Window' : 'Total'),
    h('th', { scope: 'col', class: 'num' }, 'Active days'),
    h('th', { scope: 'col', class: 'num' }, 'Per active day'),
    h('th', { scope: 'col', class: 'num' }, 'Booked'),
    h('th', { scope: 'col', class: 'trend' }, '30-day trend'));

  const body = rows.map(r => h('tr', null,
    h('th', { scope: 'row', class: 'who sticky' }, ix.label(r.setter), tag(ix.status(r.setter))),
    r.days.map((row, i) => cell(row, dates[i], today, M, step, ix.label(r.setter))),
    h('td', { class: 'num strong' }, windowCell(r, M)),
    h('td', { class: 'num' }, fmtInt(r.active)),
    h('td', { class: 'num' }, perActiveDay(r)),
    h('td', { class: 'num' }, fmtInt(r.booked)),
    h('td', { class: 'trend' }, sparkline(r.trend, M))));

  const uncovered = noCoverage.length ? [
    h('tr', { class: 'heat-divider' }, h('th', { scope: 'rowgroup', colspan: dates.length + 6, class: 'sticky-label' },
      `No dial coverage (${noCoverage.length}): the dialer stores no rows for these names, so every day is "no data", not 0`)),
    ...noCoverage.map(r => h('tr', { class: 'is-uncovered' },
      h('th', { scope: 'row', class: 'who sticky' }, ix.label(r.setter), tag(ix.status(r.setter))),
      dates.map(d => noDataCell(d, ix.label(r.setter))),
      h('td', { class: 'faint uncovered-note', colspan: 3 }, 'no dial coverage'),
      h('td', { class: 'num' }, fmtInt(r.booked)),
      h('td', { class: 'trend' })))
  ] : [];

  const foot = h('tr', { class: 'team-row' },
    h('th', { scope: 'row', class: 'who sticky' }, 'Team', h('span', { class: 'faint team-sub' }, 'everyone on the dialer')),
    team.map((v, i) => {
      if (v == null) return h('td', { class: 'col-cell', title: `${dayLabel(dates[i])}: no data` }, h('span', { class: 'sr-only' }, 'no data'));
      const bar = h('div', { class: 'col-bar' });
      bar.style.height = `${Math.max(2, (34 * v) / teamTop).toFixed(1)}px`;
      return h('td', { class: 'col-cell', title: `${dayLabel(dates[i])}: ${M.long(v)}` },
        h('span', { class: 'col-val' }, compact(v, M)), h('div', { class: 'col-track' }, bar));
    }),
    h('td', { colspan: 5 }));

  return h('table', { class: 'heat' },
    h('thead', null, head),
    h('tbody', null, body, uncovered),
    h('tfoot', null, foot));
}

function cell(row, date, today, M, step, who) {
  if (!row) return noDataCell(date, who);
  const v = M.of(row);
  const isToday = date === today ? ' is-today' : '';
  if (v == null) return h('td', { class: 'hc s0' + isToday, title: `${who} · ${dayLabel(date)}: 0 dials, so ${M.none}` }, '–');
  return h('td', { class: `hc s${step(v)}${isToday}`, title: `${who} · ${dayLabel(date)}: ${M.long(v)}` }, M.cell(v));
}

function noDataCell(date, who) {
  return h('td', { class: 'hc nodata', title: `${who} · ${dayLabel(date)}: no data` }, h('span', { class: 'sr-only' }, 'no data'));
}

function windowCell(r, M) {
  if (view.metric === 'dials') return fmtInt(r.dials);
  if (view.metric === 'contacts') return fmtInt(r.contacts);
  if (view.metric === 'talk') return fmtDuration(r.talk);
  if (!r.dials) return '—';
  return M.cell(view.metric === 'rate' ? r.contacts / r.dials : r.talk / r.dials);
}

function perActiveDay(r) {
  if (!r.active || METRICS[view.metric].ratio) return '—';
  if (view.metric === 'talk') return fmtDuration(r.talk / r.active);
  return fmtInt((view.metric === 'contacts' ? r.contacts : r.dials) / r.active);
}

/** 30 days, the row's own scale; gaps where the dialer has no row. The latest day is the accent dot. */
function sparkline(values, M) {
  const W = 96, H = 24, pad = 3;
  const max = Math.max(...values.filter(v => v != null), 1);
  const x = i => pad + (i * (W - 2 * pad)) / (values.length - 1);
  const y = v => H - pad - (v / max) * (H - 2 * pad);
  const runs = [];
  let run = [];
  values.forEach((v, i) => {
    if (v == null) { if (run.length) runs.push(run); run = []; } else run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (run.length) runs.push(run);
  const lastIdx = values.length - 1;
  const last = values[lastIdx];
  const known = values.filter(v => v != null);
  return s('svg', { class: 'spark', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': known.length ? `Last 30 days, ${known.length} with data; latest ${last == null ? 'no data' : M.long(last)}` : 'No data in the last 30 days' },
  runs.map(pts => (pts.length > 1 ? s('polyline', { points: pts.join(' '), class: 'spark-line' }) : s('circle', { cx: pts[0].split(',')[0], cy: pts[0].split(',')[1], r: 1.5, class: 'spark-pt' }))),
  last != null ? s('circle', { cx: x(lastIdx).toFixed(1), cy: y(last).toFixed(1), r: 2.5, class: 'spark-now' }) : null);
}

function legend(M, top) {
  return h('div', { class: 'heat-legend', 'aria-label': 'Colour key' },
    h('span', { class: 'faint' }, 'Key'),
    h('span', { class: 'hc s0 key' }, '0'),
    [1, 2, 3, 4, 5].map(i => h('span', { class: `hc s${i} key` })),
    h('span', { class: 'faint' }, `${M.cell(top)}+ (95th percentile of this window)`),
    h('span', { class: 'hc nodata key' }),
    h('span', { class: 'faint' }, defLink('no-coverage', 'no data')));
}

function shortDuration(seconds) {
  const mins = Math.round(seconds / 60);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`;
}

function compact(v, M) {
  if (M === METRICS.talk) return `${Math.round(v / 3600)}h`;
  if (M === METRICS.spd) return `${Math.round(v)}s`;
  if (M === METRICS.rate) return `${Math.round(100 * v)}%`;
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}K` : String(Math.round(v));
}
