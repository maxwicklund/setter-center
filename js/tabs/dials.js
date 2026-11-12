import { h } from '../dom.js';
import { DEPARTED_KEY, WINDOWS, MAX_CUSTOM_DAYS, fmtInt, fmtDuration, bySetter, dayLabel, dateRange, resolveWindow, percentile, hasContacts, fmtPct1, contactRate, contactToBooking, sum } from '../data.js';
import { tag, segmented, customRange, defLink, tile, rateBar } from '../ui.js';

// Tab 2, Dials & Activity, read top to bottom: the window's totals, one row per setter for
// the window, then the same people day by day. The day grid is one sequential ramp anchored
// at 0 and the window's 95th percentile; a day the dialer has no row for is hatched "no
// data", never a 0. Counted by the dialer's date. Last, new leads per setter per day, from
// the routing sheet's Daily tab by the lead's own date.

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
const RATE_MIN_LEADS = 20; // fewer new leads than this in the window: the lead → booking rate is faded, not ranked
const RATE_BAR = 0.5;      // lead → booking bars share one 0–50% scale

// Kept across polls and tab switches so a refresh never resets what someone picked.
const view = { window: '14d', metric: 'dials', from: null, to: null };

export function renderDials(p, ix) {
  const root = h('div', { class: 'dials-tab' });
  const draw = () => {
    root.replaceChildren(...content(p, ix, draw).filter(Boolean));
    // On a narrow screen, open on the newest days rather than the oldest.
    requestAnimationFrame(() => {
      for (const box of root.querySelectorAll('.heat-scroll')) if (box.scrollWidth > box.clientWidth) box.scrollLeft = box.scrollWidth;
    });
  };
  draw();
  return root;
}

function content(p, ix, draw) {
  const win = resolveWindow(view, p.today_ct);
  const controls = h('div', { class: 'controls' },
    segmented('Window', WINDOWS, view.window, v => { view.window = v; draw(); }),
    view.window === 'custom' ? customRange(view, win, p.today_ct, draw) : null,
    h('span', { class: 'controls-gap' }),
    h('span', { class: 'win-range' }, `${dayLabel(win.from)} – ${dayLabel(win.to)}`, h('span', { class: 'win-days' }, ` · ${win.days} days`)));
  if (!p.sources.kpi.ok) {
    return [controls,
      h('div', { class: 'banner banner-warn' }, "Sheet A couldn't be read, so there are no dial counts right now. They come back on the next successful refresh."),
      leadBookCard(p, ix, win),
      leadsCard(p, ix, win)];
  }
  const contactsOk = hasContacts(p);
  const dates = dateRange(win.from, win.to);
  const byKey = new Map(p.dials.map(r => [`${r.setter}|${r.date}`, r]));
  const covered = new Set(p.dials.map(r => r.setter));
  const inWin = d => d >= win.from && d <= win.to;
  const booked = bySetter(p.booked.filter(r => inWin(r.date_booked)), 'booked');

  const people = [...covered].map(setter => {
    const days = dates.map(d => byKey.get(`${setter}|${d}`) || null);
    const present = days.filter(Boolean);
    return {
      setter, days, booked: booked.get(setter) || 0,
      dials: sum(present, 'dials'), talk: sum(present, 'talk_seconds'), contacts: sum(present, 'contacts'),
      active: present.filter(r => r.dials > 0).length
    };
  })
    // Departed people show (as one row) only in a window where they did something.
    .filter(r => r.setter !== DEPARTED_KEY || r.dials > 0 || r.booked > 0)
    .sort((a, b) => b.dials - a.dials || b.booked - a.booked || ix.label(a.setter).localeCompare(ix.label(b.setter)));

  // Rostered or in the appointment data, but never stored by the dialer: listed with their
  // bookings and no dial numbers at all, so nobody reads them as 0 dials.
  const noCoverage = p.roster
    .filter(r => r.status !== 'alias' && !covered.has(r.setter) &&
      (r.setter === DEPARTED_KEY ? booked.get(DEPARTED_KEY) : r.active || r.in_appt_data))
    .map(r => ({ setter: r.setter, booked: booked.get(r.setter) || 0 }))
    .sort((a, b) => b.booked - a.booked || ix.label(a.setter).localeCompare(ix.label(b.setter)));

  const team = people.reduce((t, r) => ({ dials: t.dials + r.dials, talk: t.talk + r.talk, contacts: t.contacts + r.contacts, active: t.active + r.active, booked: t.booked + r.booked }),
    { dials: 0, talk: 0, contacts: 0, active: 0, booked: 0 });
  const allBooked = sum(p.booked.filter(r => inWin(r.date_booked)), 'booked');

  const notes = [];
  if (p.coverage.dials_from && win.from < p.coverage.dials_from) notes.push(`The dialer feed starts ${dayLabel(p.coverage.dials_from)}, ${p.coverage.dials_from.slice(0, 4)}; earlier days are hatched "no data", not zeros.`);
  if (win.capped) notes.push(`Custom ranges show at most ${MAX_CUSTOM_DAYS} days; this one was trimmed to end on ${dayLabel(win.to)}.`);

  return [
    controls,
    notes.length ? h('div', { class: 'banner banner-warn' }, notes.join(' ')) : null,
    h('div', { class: 'tiles tiles-4' },
      tile(defLink('dials', 'Dials'), fmtInt(team.dials), `${team.active ? fmtInt(team.dials / team.active) : '—'} per setter per active day`, true, { kind: 'count' }),
      tile(defLink('contacts-60', 'Contacts'), contactsOk ? fmtInt(team.contacts) : '—', `calls over 60s · ${contactRate(team.contacts, team.dials)} of dials`, contactsOk,
        { off: 'not in the dialer feed', kind: 'count' }),
      tile(defLink('booked', 'Booked'), p.sources.tracker.ok ? fmtInt(allBooked) : '—',
        contactsOk ? `${contactToBooking(team.booked, team.contacts)} contact to booking` : 'by Date Booked', p.sources.tracker.ok, { kind: 'count' }),
      tile(defLink('talk', 'Talk time'), fmtDuration(team.talk), team.dials ? `${Math.round(team.talk / team.dials)}s per dial` : '—', true)),
    setterBoard(people, noCoverage, ix, contactsOk, p.sources.tracker.ok),
    leadBookCard(p, ix, win),
    dayGrid(p, ix, dates, people, byKey, contactsOk, draw),
    leadsCard(p, ix, win)
  ];
}

// ---------------------------------------------------------------- new lead to booking

/**
 * Of the new leads the router assigned each setter in the window (by the lead's date), the
 * share the routing sheet marks Booked. Credited to the assigned setter, like the lead grid
 * below. The bar is on one fixed 0–50% scale so a column reads down at a glance.
 */
function leadBookCard(p, ix, win) {
  const title = h('h2', { id: 'l2b-title' }, defLink('lead-to-booking', 'New lead → booking'));
  if (!p.sources.router.ok) {
    return h('section', { class: 'card' }, title,
      h('p', { class: 'faint' }, "Sheet C (setter routing) couldn't be read, so there are no lead counts right now."));
  }
  const inWin = r => r.date >= win.from && r.date <= win.to;
  const roll = (arr, key) => {
    const m = new Map();
    for (const r of arr) {
      if (!inWin(r)) continue;
      const t = m.get(r[key]) || { name: r[key], leads: 0, booked: 0 };
      t.leads += r.leads;
      t.booked += r.booked;
      m.set(r[key], t);
    }
    return [...m.values()].filter(r => r.leads > 0);
  };
  const rate = r => r.booked / r.leads;
  const rated = r => r.leads >= RATE_MIN_LEADS;
  const setters = roll(p.speed_daily, 'setter')
    .sort((a, b) => rated(b) - rated(a) || (rated(a) ? rate(b) - rate(a) : 0) || b.leads - a.leads || ix.label(a.name).localeCompare(ix.label(b.name)));
  const queues = roll(p.speed_daily_queues, 'queue').sort((a, b) => b.leads - a.leads);
  const add = rows => rows.reduce((t, r) => ({ leads: t.leads + r.leads, booked: t.booked + r.booked }), { leads: 0, booked: 0 });
  const toSetters = add(setters);
  const all = add(setters.concat(queues));
  const start = p.coverage.daily_from;

  const cells = r => [
    h('td', { class: 'num' }, fmtInt(r.leads)),
    h('td', { class: 'num' }, fmtInt(r.booked)),
    h('td', { class: 'num rate-cell' }, rateBar(rate(r), fmtPct1(rate(r)), RATE_BAR))];
  const row = (r, label, mark, cls = '') => h('tr', {
    class: (cls + (rated(r) ? '' : ' is-small')).trim() || null,
    title: `${label}: ${fmtInt(r.booked)} of ${fmtInt(r.leads)} new leads booked${rated(r) ? '' : ` (under ${RATE_MIN_LEADS} leads, so not ranked)`}`
  }, h('th', { scope: 'row' }, label, mark), cells(r));

  return h('section', { class: 'card', 'aria-labelledby': 'l2b-title' },
    h('div', { class: 'card-head' },
      title,
      h('p', { class: 'sub' }, 'Of the new leads routed to each setter in this window, the share that booked. Highest rate first.')),
    !start ? h('p', { class: 'faint' }, 'The routing sheet has no daily rows yet.')
      : setters.length || queues.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'data-table l2b-table' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, 'Setter'),
          h('th', { scope: 'col', class: 'num' }, 'New leads'),
          h('th', { scope: 'col', class: 'num' }, 'Booked'),
          h('th', { scope: 'col', class: 'num' }, 'Lead → booking'))),
        h('tbody', null,
          setters.map(r => row(r, ix.label(r.name), tag(ix.status(r.name)))),
          queues.length ? [
            h('tr', { class: 'group-row' }, h('th', { scope: 'rowgroup', colspan: 4 }, 'Not assigned to a setter')),
            ...queues.map(r => row(r, r.name, h('span', { class: 'tag' }, 'queue'), 'is-queue'))
          ] : []),
        h('tfoot', null,
          setters.length ? h('tr', null, h('th', { scope: 'row' }, 'All setters'), cells(toSetters)) : null,
          queues.length ? h('tr', null, h('th', { scope: 'row' }, 'All new leads'), cells(all)) : null)))
        : h('p', { class: 'faint' }, 'No new leads in this window.'),
    start && win.from < start ? h('p', { class: 'sub faint' }, `The routing sheet starts ${dayLabel(start)}, ${start.slice(0, 4)}; earlier days have no lead data.`) : null,
    h('p', { class: 'sub faint footnote' },
      `Booked = the routing sheet marks the lead booked, credited to the setter it was assigned to. Leads from the last few days are still being worked, so recent windows read low. ` +
      `Faded rows have under ${RATE_MIN_LEADS} new leads and aren't ranked. Lead type changes the rate a lot; `,
      h('a', { href: '#speed' }, 'Speed to Lead'), ' compares setters on rotation leads only. Bars run 0–50%.'));
}

// ---------------------------------------------------------------- by setter, the whole window

function setterBoard(rows, noCoverage, ix, contactsOk, apptsOk) {
  const max = Math.max(...rows.map(r => r.dials), 1);
  const head = (label, cls = 'num', title) => h('th', { scope: 'col', class: cls, title }, label);
  return h('section', { class: 'card floor-table-card', 'aria-labelledby': 'board-title' },
    h('div', { class: 'card-head' },
      h('h2', { id: 'board-title' }, 'By setter'),
      h('p', { class: 'sub' }, 'Highest dials first. Per day counts only days they dialed.')),
    h('table', { class: 'floor-table board-table' },
      h('thead', null, h('tr', null,
        head('Setter', ''),
        head('Dials'),
        head(h('span', { class: 'sr-only' }, 'Dials bar'), 'bar-col'),
        head('Per day', 'num', 'Dials per active dialing day'),
        contactsOk ? head('Contacts') : null,
        head('Booked'),
        contactsOk ? head('Contact → booking', 'num', 'Booked ÷ contacts') : null,
        head('Talk'))),
      h('tbody', null,
        rows.map(r => {
          const fill = h('div', { class: 'bar-fill' });
          fill.style.width = `${((100 * r.dials) / max).toFixed(2)}%`;
          const who = ix.label(r.setter);
          return h('tr', { class: 'floor-row' + (ix.status(r.setter) === 'unresolved' ? ' is-flagged' : '') },
            h('th', { scope: 'row', class: 'who' }, who, tag(ix.status(r.setter))),
            h('td', { class: 'num dials' }, fmtInt(r.dials)),
            h('td', { class: 'bar-col' }, h('div', { class: 'bar', role: 'img', 'aria-label': `${r.dials} dials` }, fill)),
            h('td', { class: 'num perday', title: `${fmtInt(r.dials)} dials over ${r.active} active days` }, r.active ? fmtInt(r.dials / r.active) : '—'),
            contactsOk ? h('td', { class: 'num contacts' }, fmtInt(r.contacts), r.dials ? [' ', h('span', { class: 'rate' }, contactRate(r.contacts, r.dials))] : null) : null,
            h('td', { class: 'num booked' }, apptsOk ? fmtInt(r.booked) : '—'),
            contactsOk ? h('td', { class: 'num c2b', title: `${who}: ${fmtInt(r.booked)} booked ÷ ${fmtInt(r.contacts)} contacts` }, contactToBooking(r.booked, r.contacts)) : null,
            h('td', { class: 'num talk' }, fmtDuration(r.talk)));
        }),
        noCoverage.length ? h('tr', { class: 'board-uncovered' },
          h('td', { colspan: contactsOk ? 8 : 6 },
            defLink('no-coverage', `No dialer data (${noCoverage.length})`), ': ',
            noCoverage.map((r, i) => [i ? ', ' : '', ix.label(r.setter), r.booked ? ` (${fmtInt(r.booked)} booked)` : '']))) : null)),
    h('p', { class: 'sub faint' },
      defLink('contacts-60', 'Contacts'), ' = calls over 60 seconds, with their share of dials. ',
      defLink('contact-to-booking', 'Contact → booking'), ' = booked ÷ contacts.'));
}

// ---------------------------------------------------------------- day by day

function dayGrid(p, ix, dates, rows, byKey, contactsOk, draw) {
  const metrics = Object.entries(METRICS).filter(([, m]) => contactsOk || !m.needsContacts);
  if (!metrics.some(([k]) => k === view.metric)) view.metric = 'dials';
  const M = METRICS[view.metric];
  const today = p.today_ct;
  // Colour scale: 0 to the 95th percentile of this window's cells, so one huge day
  // can't wash the grid out. Values above it share the darkest step.
  const top = percentile(rows.flatMap(r => r.days.filter(Boolean).map(M.of)).filter(v => v != null), 0.95) || 1;
  const step = stepper(top);
  const team = dates.map(d => {
    const day = p.dials.filter(r => r.date === d);
    return day.length ? M.of({ dials: sum(day, 'dials'), talk_seconds: sum(day, 'talk_seconds'), contacts: sum(day, 'contacts') }) : null;
  });
  const teamWindow = rows.reduce((t, r) => ({ dials: t.dials + r.dials, talk: t.talk + r.talk, contacts: t.contacts + r.contacts }), { dials: 0, talk: 0, contacts: 0 });

  return h('section', { class: 'card heat-card', 'aria-labelledby': 'heat-title' },
    h('div', { class: 'card-head card-head-row' },
      h('div', null,
        h('h2', { id: 'heat-title' }, 'Day by day'),
        h('p', { class: 'sub' }, `${M.label} per setter per day · by dialer date`)),
      segmented('Show', metrics.map(([k, m]) => [k, m.label]), view.metric, v => { view.metric = v; draw(); })),
    h('div', { class: 'heat-scroll' },
      h('table', { class: 'heat' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col', class: 'who sticky' }, 'Setter'),
          dayHeads(dates, today),
          h('th', { scope: 'col', class: 'num' }, M.ratio ? 'Window' : 'Total'))),
        h('tbody', null, rows.map(r => h('tr', null,
          h('th', { scope: 'row', class: 'who sticky' }, ix.label(r.setter), tag(ix.status(r.setter))),
          r.days.map((row, i) => cell(row, dates[i], today, M, step, ix.label(r.setter))),
          h('td', { class: 'num strong' }, windowCell(r, M))))),
        h('tfoot', null, h('tr', { class: 'team-row' },
          h('th', { scope: 'row', class: 'who sticky' }, 'Team'),
          team.map((v, i) => h('td', { class: 'team-cell' + (dates[i] === today ? ' is-today' : ''), title: `${dayLabel(dates[i])}: ${v == null ? 'no data' : M.long(v)}` },
            v == null ? h('span', { class: 'sr-only' }, 'no data') : M.cell(v))),
          h('td', { class: 'num strong' }, windowCell(teamWindow, M)))))),
    legend(M.cell(top)));
}

function dayHeads(dates, today) {
  return dates.map((d, i) => {
    const day = Number(d.slice(8));
    const monthMark = i === 0 || day === 1 ? dayLabel(d).split(', ')[1].split(' ')[0] : '';
    return h('th', { scope: 'col', class: 'day' + (d === today ? ' is-today' : ''), title: dayLabel(d) + (d === today ? ' (today, so far)' : '') },
      h('span', { class: 'month' }, monthMark || ' '),
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

/** The window's value for a row of totals {dials, talk, contacts}, in the grid's metric. */
function windowCell(r, M) {
  if (view.metric === 'dials') return fmtInt(r.dials);
  if (view.metric === 'contacts') return fmtInt(r.contacts);
  if (view.metric === 'talk') return fmtDuration(r.talk);
  if (!r.dials) return '—';
  return M.cell(view.metric === 'rate' ? r.contacts / r.dials : r.talk / r.dials);
}

function legend(topText, noData = defLink('no-coverage', 'no data')) {
  return h('div', { class: 'heat-legend', 'aria-label': 'Colour key' },
    h('span', { class: 'hc s0 key' }, '0'),
    [1, 2, 3, 4, 5].map(i => h('span', { class: `hc s${i} key` })),
    h('span', { class: 'faint' }, `${topText}+`),
    h('span', { class: 'heat-legend-gap' }),
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
  const foot = h('tr', { class: 'team-row' },
    h('th', { scope: 'row', class: 'who sticky' }, 'All leads'),
    team.map((v, i) => h('td', { class: 'team-cell' + (dates[i] === today ? ' is-today' : ''), title: `${dayLabel(dates[i])}: ${v == null ? 'no data' : leads(v) + (dates[i] === today ? ' so far' : '')}` },
      v == null ? h('span', { class: 'sr-only' }, 'no data') : fmtInt(v))),
    h('td', { class: 'num strong' }, fmtInt(all)),
    h('td'));

  const notes = [];
  if (!start) notes.push('The routing sheet has no daily rows yet, so every day is "no data".');
  else if (win.from < start) notes.push(`The routing sheet starts ${dayLabel(start)}, ${start.slice(0, 4)}; earlier days are hatched "no data", not zeros.`);

  return h('section', { class: 'card heat-card', 'aria-labelledby': 'leads-title' },
    h('div', { class: 'card-head' },
      title,
      h('p', { class: 'sub' }, [`${leads(all)} by the lead's date: ${fmtInt(toSetters)} to setters`, ...queues.map(q => `${fmtInt(q.total)} in ${q.name}`)].join(' · ')),
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
            h('tr', { class: 'heat-divider' }, h('th', { scope: 'rowgroup', colspan: dates.length + 3 }, h('span', { class: 'sticky-label' }, 'Not assigned to a setter'))),
            ...queues.map(r => line(r, r.name, h('span', { class: 'tag' }, 'queue'), 'is-queue'))
          ] : []),
        h('tfoot', null, foot))),
    none.length ? h('p', { class: 'sub' }, `No new leads in this window (${none.length}): ${none.join(', ')}`) : null,
    legend(fmtInt(top), 'before the routing sheet starts'),
    h('p', { class: 'sub faint' }, 'Credited to the setter the router assigned, even if someone else picked the lead up. Share = their leads ÷ all new leads.'));
}

function shortDuration(seconds) {
  const mins = Math.round(seconds / 60);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`;
}
