import { h, s } from '../dom.js';
import { DEPARTED_KEY, WINDOWS, MAX_CUSTOM_DAYS, fmtInt, fmtDuration, bySetter, dayLabel, addDays, dateRange, resolveWindow, percentile, hasContacts, fmtPct1, contactToBooking } from '../data.js';
import { tag, segmented, customRange, defLink } from '../ui.js';

// Tab 2, Dials & Activity: setters x days, one cell per day, on one sequential ramp
// anchored at 0 and the window's 95th percentile. A day the dialer has no row for is
// hatched "no data", never a 0. Counted by the dialer's date. Below it, the same window
// for new leads per setter, from the routing sheet's Daily tab by the lead's own date.

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
      for (const box of root.querySelectorAll('.heat-scroll')) if (box.scrollWidth > box.clientWidth) box.scrollLeft = box.scrollWidth;
    });
  };
  draw();
  return root;
}

function content(p, ix, draw) {
  if (!p.sources.kpi.ok) {
    const win = resolveWindow(view, p.today_ct);
    return [
      h('div', { class: 'controls' },
        segmented('Window', WINDOWS, view.window, v => { view.window = v; draw(); }),
        view.window === 'custom' ? customRange(view, win, p.today_ct, draw) : null),
      h('div', { class: 'banner banner-warn' }, "Sheet A couldn't be read, so there are no dial counts right now. The grid comes back on the next successful refresh."),
      leadsCard(p, ix, win)];
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
  const step = stepper(top);

  const team = dates.map(d => {
    const rows = p.dials.filter(r => r.date === d);
    if (!rows.length) return null;
    const dials = rows.reduce((t, r) => t + r.dials, 0);
    const talk = rows.reduce((t, r) => t + r.talk_seconds, 0);
    const contacts = rows.reduce((t, r) => t + (r.contacts || 0), 0);
    return M.of({ dials, talk_seconds: talk, contacts });
  });
  const teamTotals = withCoverage.reduce((t, r) => ({ dials: t.dials + r.dials, talk: t.talk + r.talk, contacts: t.contacts + r.contacts, active: t.active + r.active, booked: t.booked + r.booked }),
    { dials: 0, talk: 0, contacts: 0, active: 0, booked: 0 });

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
          (contactsOk ? ` · ${fmtInt(teamTotals.contacts)} contacts (${teamTotals.dials ? fmtPct1(teamTotals.contacts / teamTotals.dials) : '—'} of dials)` +
            ` · ${fmtInt(teamTotals.booked)} booked, ${contactToBooking(teamTotals.booked, teamTotals.contacts)} contact to booking` : '') +
          ` · ${fmtDuration(teamTotals.talk)} talk` +
          (teamTotals.dials ? ` · ${Math.round(teamTotals.talk / teamTotals.dials)}s per dial` : '')),
        notes.map(n => h('p', { class: 'sub faint' }, n))),
      h('div', { class: 'heat-scroll' },
        heatTable(dates, p.today_ct, withCoverage, noCoverage, team, M, step, ix, contactsOk)),
      legend(M.cell(top))),
    h('p', { class: 'sub faint' }, defLink('active-day', 'Active day'),
      ' = a day with dials > 0; per-day averages divide by active days, not calendar days. The dialer stores a row for every rostered setter every day, ' +
      "including days before they started, so a 0 doesn't prove anyone was working.",
      contactsOk ? [' ', defLink('contacts-60', 'Contacts'), ' = dialer calls over 60 seconds (voicemails that long included); contact rate = contacts ÷ dials; ',
        defLink('contact-to-booking', 'contact to booking'), ' = booked ÷ contacts.'] : null),
    leadsCard(p, ix, win)
  ];

  function windowValue(r) {
    if (view.metric === 'dials') return r.dials;
    if (view.metric === 'contacts') return r.contacts;
    if (view.metric === 'talk') return r.talk;
    if (view.metric === 'rate') return r.dials ? r.contacts / r.dials : -1;
    return r.dials ? r.talk / r.dials : -1;
  }
}

function heatTable(dates, today, rows, noCoverage, team, M, step, ix, contactsOk) {
  const extra = contactsOk ? 1 : 0;
  const teamTop = Math.max(...team.filter(v => v != null), 1);
  const head = h('tr', null,
    h('th', { scope: 'col', class: 'who sticky' }, 'Setter'),
    dayHeads(dates, today),
    h('th', { scope: 'col', class: 'num' }, M.ratio ? 'Window' : 'Total'),
    h('th', { scope: 'col', class: 'num' }, 'Active days'),
    h('th', { scope: 'col', class: 'num' }, 'Per active day'),
    h('th', { scope: 'col', class: 'num' }, 'Booked'),
    contactsOk ? h('th', { scope: 'col', class: 'num', title: 'Booked ÷ contacts (calls over 60s)' }, 'Contact → booking') : null,
    h('th', { scope: 'col', class: 'trend' }, '30-day trend'));

  const body = rows.map(r => h('tr', null,
    h('th', { scope: 'row', class: 'who sticky' }, ix.label(r.setter), tag(ix.status(r.setter))),
    r.days.map((row, i) => cell(row, dates[i], today, M, step, ix.label(r.setter))),
    h('td', { class: 'num strong' }, windowCell(r, M)),
    h('td', { class: 'num' }, fmtInt(r.active)),
    h('td', { class: 'num' }, perActiveDay(r)),
    h('td', { class: 'num' }, fmtInt(r.booked)),
    contactsOk ? h('td', { class: 'num', title: `${ix.label(r.setter)}: ${fmtInt(r.booked)} booked ÷ ${fmtInt(r.contacts)} contacts` }, contactToBooking(r.booked, r.contacts)) : null,
    h('td', { class: 'trend' }, sparkline(r.trend, M))));

  const uncovered = noCoverage.length ? [
    h('tr', { class: 'heat-divider' }, h('th', { scope: 'rowgroup', colspan: dates.length + 6 + extra }, h('span', { class: 'sticky-label' },
      `No dial coverage (${noCoverage.length}): the dialer stores no rows for these names, so every day is "no data", not 0`))),
    ...noCoverage.map(r => h('tr', { class: 'is-uncovered' },
      h('th', { scope: 'row', class: 'who sticky' }, ix.label(r.setter), tag(ix.status(r.setter))),
      dates.map(d => noDataCell(d, ix.label(r.setter))),
      h('td', { class: 'faint uncovered-note', colspan: 3 }, 'no dial coverage'),
      h('td', { class: 'num' }, fmtInt(r.booked)),
      contactsOk ? h('td', { class: 'num faint' }, '—') : null,
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
    h('td', { colspan: 5 + extra }));

  return h('table', { class: 'heat' },
    h('thead', null, head),
    h('tbody', null, body, uncovered),
    h('tfoot', null, foot));
}

function dayHeads(dates, today) {
  return dates.map((d, i) => {
    const day = Number(d.slice(8));
    const monthMark = i === 0 || day === 1 ? dayLabel(d).split(', ')[1].split(' ')[0] : '';
    return h('th', { scope: 'col', class: 'day' + (d === today ? ' is-today' : ''), title: dayLabel(d) + (d === today ? ' (today, so far)' : '') },
      h('span', { class: 'month' }, monthMark || ' '),
      h('span', { class: 'dow' }, dayLabel(d).slice(0, 1)),
      h('span', { class: 'dom' }, String(day)));
  });
}

/** Colour step 0-5: 0 to `top` (the window's 95th percentile); values above it share the darkest step. */
function stepper(top) {
  return v => (v === 0 ? 0 : 1 + Math.min(STEPS - 1, Math.floor((Math.min(v, top) / top) * STEPS - 1e-9)));
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

function legend(topText, noData = defLink('no-coverage', 'no data')) {
  return h('div', { class: 'heat-legend', 'aria-label': 'Colour key' },
    h('span', { class: 'faint' }, 'Key'),
    h('span', { class: 'hc s0 key' }, '0'),
    [1, 2, 3, 4, 5].map(i => h('span', { class: `hc s${i} key` })),
    h('span', { class: 'faint' }, `${topText}+ (95th percentile of this window)`),
    h('span', { class: 'hc nodata key' }),
    h('span', { class: 'faint' }, noData));
}

// ---------------------------------------------------------------- new leads per setter per day

/**
 * Sheet C's Daily tab: leads by the lead's own date, credited to the setter the router assigned
 * (its Setter column). From the sheet's first day on, no row means 0 leads; before it, "no data".
 */
function leadsCard(p, ix, win) {
  const title = h('h2', { id: 'leads-title' }, defLink('new-leads', 'New leads per setter per day'));
  if (!p.sources.router.ok) {
    return h('section', { class: 'card heat-card' }, title,
      h('p', { class: 'faint' }, "Sheet C (setter routing) couldn't be read, so there are no lead counts right now."));
  }
  const today = p.today_ct;
  const start = p.coverage.daily_from;
  const dates = dateRange(win.from, win.to);
  const covered = dates.map(d => Boolean(start) && d >= start);
  const inWin = r => r.date >= win.from && r.date <= win.to;
  const tally = (arr, key) => {
    const m = new Map();
    for (const r of arr) if (inWin(r)) m.set(`${r[key]}|${r.date}`, (m.get(`${r[key]}|${r.date}`) || 0) + r.leads);
    return m;
  };
  const row = (name, days) => {
    const vals = dates.map((d, i) => (covered[i] ? days.get(`${name}|${d}`) || 0 : null));
    return { name, vals, total: vals.reduce((t, v) => t + (v || 0), 0) };
  };
  const byTotal = label => (a, b) => b.total - a.total || label(a.name).localeCompare(label(b.name));

  // A row for anyone the router sent leads to in the window (departed people as one row);
  // live-roster setters who got none are listed in one line under the grid.
  const setterDays = tally(p.speed_daily, 'setter');
  const setters = [...new Set(p.speed_daily.filter(r => inWin(r) && r.leads > 0).map(r => r.setter))].map(n => row(n, setterDays)).sort(byTotal(ix.label));
  const none = covered.some(Boolean) ? p.roster.filter(r => r.active && !setters.some(x => x.name === r.setter)).map(r => ix.label(r.setter)).sort() : [];
  const queueDays = tally(p.speed_daily_queues, 'queue');
  const queues = [...new Set(p.speed_daily_queues.filter(r => inWin(r) && r.leads > 0).map(r => r.queue))].map(n => row(n, queueDays)).sort(byTotal(n => n));
  const everyone = setters.concat(queues);
  const toSetters = setters.reduce((t, r) => t + r.total, 0);
  const all = everyone.reduce((t, r) => t + r.total, 0);
  const team = dates.map((d, i) => (covered[i] ? everyone.reduce((t, r) => t + r.vals[i], 0) : null));
  const top = percentile(everyone.flatMap(r => r.vals).filter(v => v != null), 0.95) || 1;
  const step = stepper(top);

  const leads = n => (n === 1 ? '1 new lead' : `${fmtInt(n)} new leads`);
  const share = n => (all ? `${Math.round((100 * n) / all)}%` : '—');
  const line = (r, label, mark, cls) => h('tr', { class: cls },
    h('th', { scope: 'row', class: 'who sticky' }, label, mark),
    r.vals.map((v, i) => (v == null ? noDataCell(dates[i], label)
      : h('td', { class: `hc s${step(v)}${dates[i] === today ? ' is-today' : ''}`, title: `${label} · ${dayLabel(dates[i])}: ${leads(v)}${dates[i] === today ? ' so far' : ''}` }, fmtInt(v)))),
    h('td', { class: 'num strong' }, fmtInt(r.total)),
    h('td', { class: 'num' }, share(r.total)));
  const teamTop = Math.max(...team.filter(v => v != null), 1);
  const foot = h('tr', { class: 'team-row' },
    h('th', { scope: 'row', class: 'who sticky' }, 'All leads', h('span', { class: 'faint team-sub' }, 'setters and queues')),
    team.map((v, i) => {
      if (v == null) return h('td', { class: 'col-cell', title: `${dayLabel(dates[i])}: no data` }, h('span', { class: 'sr-only' }, 'no data'));
      const bar = h('div', { class: 'col-bar' });
      bar.style.height = `${Math.max(2, (34 * v) / teamTop).toFixed(1)}px`;
      return h('td', { class: 'col-cell', title: `${dayLabel(dates[i])}: ${leads(v)}${dates[i] === today ? ' so far' : ''}` },
        h('span', { class: 'col-val' }, String(v)), h('div', { class: 'col-track' }, bar));
    }),
    h('td', { class: 'num strong' }, fmtInt(all)),
    h('td'));

  const notes = [];
  if (!start) notes.push('The routing sheet has no daily rows yet, so every day is "no data".');
  else if (win.from < start) notes.push(`The routing sheet starts ${dayLabel(start)}, ${start.slice(0, 4)}; earlier days are hatched "no data", not zeros.`);

  return h('section', { class: 'card heat-card', 'aria-labelledby': 'leads-title' },
    h('div', { class: 'card-head' },
      title,
      h('p', { class: 'sub' }, `${dayLabel(win.from)} – ${dayLabel(win.to)} · ${win.days} days · by the lead's date · same window as the dials grid`),
      h('p', { class: 'sub' }, [`${leads(all)} in the window: ${fmtInt(toSetters)} to setters`, ...queues.map(q => `${fmtInt(q.total)} in ${q.name}`)].join(' · ')),
      notes.map(n => h('p', { class: 'sub faint' }, n))),
    h('div', { class: 'heat-scroll' },
      h('table', { class: 'heat' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col', class: 'who sticky' }, 'Setter'),
          dayHeads(dates, today),
          h('th', { scope: 'col', class: 'num' }, 'Total'),
          h('th', { scope: 'col', class: 'num', title: 'Share of every new lead in the window, queues included' }, 'Share'))),
        h('tbody', null,
          setters.map(r => line(r, ix.label(r.name), tag(ix.status(r.name)))),
          queues.length ? [
            h('tr', { class: 'heat-divider' }, h('th', { scope: 'rowgroup', colspan: dates.length + 3 }, h('span', { class: 'sticky-label' }, 'Queues: leads not assigned to a setter'))),
            ...queues.map(r => line(r, r.name, h('span', { class: 'tag' }, 'queue'), 'is-queue'))
          ] : []),
        h('tfoot', null, foot))),
    none.length ? h('p', { class: 'sub' }, `No new leads in this window (${none.length}): ${none.join(', ')}`) : null,
    legend(fmtInt(top), 'before the routing sheet starts'),
    h('p', { class: 'sub faint' }, "Credited to the setter the router assigned (its Setter column), by rotation or by hand; that never changes when someone else picks the lead up. " +
      'Share = their leads ÷ every new lead in the window, queues included.'));
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
