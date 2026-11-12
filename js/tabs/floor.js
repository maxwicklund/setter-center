import { h } from '../dom.js';
import { DEPARTED_KEY, fmtInt, fmtDuration, bySetter, hasContacts, contactRate } from '../data.js';
import { tag, defLink, tile } from '../ui.js';
import { costTile } from '../cost.js';
import { DIAL_TARGET } from '../../config.js';

// Tab 1, Floor: today only, everyone, no filters. "Today" is the server's CT date.
// Built for a second monitor at ten feet, and for a setter checking their row on a phone:
// four headline numbers, one strip of the rest, then everyone's row.

const hasTarget = typeof DIAL_TARGET === 'number' && DIAL_TARGET > 0;

export function renderFloor(p, ix) {
  const today = p.today_ct;
  const dialsOk = p.sources.kpi.ok;
  const apptsOk = p.sources.tracker.ok;
  const contactsOk = dialsOk && hasContacts(p);
  const leadsOk = p.sources.router.ok;

  const dialRows = new Map(p.dials.filter(r => r.date === today).map(r => [r.setter, r]));
  const dialerReported = dialRows.size > 0;
  const booked = bySetter(p.booked.filter(r => r.date_booked === today), 'booked');
  const eodSent = new Set(p.eod.filter(r => r.report_date === today).map(r => r.setter));
  // New leads by the lead's date, credited to the setter the router assigned them to.
  const leads = leadsOk ? bySetter(p.speed_daily.filter(r => r.date === today), 'leads') : new Map();
  const queueLeads = leadsOk ? p.speed_daily_queues.filter(r => r.date === today && r.leads > 0) : [];
  const total = (map, keep = () => true) => [...map].reduce((t, [k, v]) => t + (keep(k) ? (typeof v === 'number' ? v : v.dials) : 0), 0);

  const teamDials = total(dialRows);
  const rosterDials = total(dialRows, k => ix.isTeam(k));
  const offRosterDials = total(dialRows, k => ix.status(k) === 'unresolved');
  const talk = [...dialRows.values()].reduce((t, r) => t + r.talk_seconds, 0);
  const contacts = [...dialRows.values()].reduce((t, r) => t + (r.contacts || 0), 0);
  const dialing = [...dialRows.values()].filter(r => r.dials > 0 && r.setter !== DEPARTED_KEY).length;
  const bookedTotal = total(booked);
  const qualifiedShows = p.outcomes.filter(r => r.appt_date === today).reduce((t, r) => t + r.qualified_show, 0);
  const pendingToday = p.pending.filter(r => r.appt_date === today).reduce((t, r) => t + r.pending, 0);
  const setterLeads = total(leads);
  const teamLeads = setterLeads + queueLeads.reduce((t, r) => t + r.leads, 0);

  // Everyone on the dialer today, plus anyone routed a lead today. Someone with leads but no
  // dialer row gets dashes for dials, never 0. Departed people only get a (collapsed) row on
  // a day they actually did something.
  const keys = new Set([...dialRows.keys(), ...[...leads].filter(([, n]) => n > 0).map(([k]) => k)]);
  const rows = [...keys]
    .filter(k => k !== DEPARTED_KEY || (dialRows.get(k) || {}).dials > 0 || booked.get(k) || leads.get(k))
    .map(k => {
      const d = dialRows.get(k);
      return { setter: k, dials: d ? d.dials : null, contacts: d ? d.contacts : null, talk: d ? d.talk_seconds : null,
        leads: leads.get(k) || 0, booked: booked.get(k) || 0, eod: eodSent.has(k) };
    })
    .sort((a, b) => (b.dials ?? -1) - (a.dials ?? -1) || ix.label(a.setter).localeCompare(ix.label(b.setter)));
  const scaleMax = Math.max(hasTarget ? DIAL_TARGET * 1.25 : 0, ...rows.map(r => r.dials || 0), 1);

  const roster = p.roster.filter(r => r.status !== 'alias');
  const noCoverage = roster.filter(r => r.active && !r.on_dials_roster);
  const offRoster = roster.filter(r => r.status === 'unresolved');

  const onDialer = [...dialRows.keys()].filter(k => k !== DEPARTED_KEY).length;
  const dialedToday = dialsOk && dialerReported;

  return h('div', { class: 'floor' },
    h('div', { class: 'tiles tiles-4' },
      dialsTile(dialsOk, dialerReported, teamDials, offRosterDials, dialRows, p),
      tile(defLink('contacts-60', 'Contacts today'), contactsOk && dialerReported ? fmtInt(contacts) : '—',
        `calls over 60s · ${contactRate(contacts, teamDials)} of dials`, contactsOk, dialsOk ? 'not in the dialer feed' : 'source unavailable'),
      tile(defLink('booked', 'Booked today'), apptsOk ? fmtInt(bookedTotal) : '—', 'entered on the tracker so far', apptsOk),
      costTile(p)),
    h('section', { class: 'card stat-strip', 'aria-label': 'More for today' },
      stat(defLink('new-leads', 'New leads'), leadsOk ? fmtInt(teamLeads) : '—',
        leadsOk ? [`${fmtInt(setterLeads)} to setters`, ...queueLeads.map(r => `${fmtInt(r.leads)} in ${r.queue}`)].join(' · ') : 'source unavailable'),
      stat(defLink('active-day', 'Setters dialing'), dialedToday ? `${fmtInt(dialing)} of ${fmtInt(onDialer)}` : '—', 'with at least one dial'),
      stat(defLink('talk', 'Talk time'), dialedToday ? fmtDuration(talk) : '—', dialedToday && teamDials ? `${Math.round(talk / teamDials)}s per dial` : ''),
      stat(defLink('qualified-show', 'Qualified shows'), apptsOk ? fmtInt(qualifiedShows) : '—', 'showed and qualified today'),
      stat(defLink('pending', 'Still pending'), apptsOk ? fmtInt(pendingToday) : '—', "on today's calendar, no outcome yet")),
    setterTable(rows, ix, scaleMax, today, apptsOk, contactsOk, leadsOk, eodSent.size),
    rosterLine(noCoverage, offRoster, booked, dialRows, leads, ix));
}

function dialsTile(ok, reported, teamDials, offRosterDials, dialRows, p) {
  const note = !ok ? "Sheet A couldn't be read, so there are no dial counts right now."
    : !reported ? `The dialer has no rows for today yet. Latest day it reported: ${p.coverage.dials_to || '—'}.`
      : offRosterDials ? `${fmtInt(offRosterDials)} of them from names not on the roster` : 'updates every 5 minutes';
  return tile(defLink('dials', 'Dials today'), ok && reported ? fmtInt(teamDials) : '—', note, ok && reported, note,
    hasTarget && ok && reported ? pace(p, dialRows) : null);
}

/** Team pace: live (non-onboarding) setters' dials against DIAL_TARGET x those setters. */
function pace(p, dialRows) {
  const live = p.roster.filter(r => r.status === 'live');
  const counted = live.filter(r => r.on_dials_roster);
  const uncovered = live.filter(r => !r.on_dials_roster);
  const target = DIAL_TARGET * counted.length;
  const done = counted.reduce((t, r) => t + ((dialRows.get(r.setter) || {}).dials || 0), 0);
  // Past the target the meter rescales to the total and a tick marks where the target sat.
  const scale = Math.max(target, done, 1);
  const fill = h('div', { class: 'meter-fill' });
  fill.style.width = `${((100 * done) / scale).toFixed(1)}%`;
  const tick = done > target ? h('div', { class: 'meter-tick' }) : null;
  if (tick) tick.style.left = `${((100 * target) / scale).toFixed(1)}%`;
  const why = `Target: ${DIAL_TARGET} dials a day × ${counted.length} live setters on the dialer. Onboarding setters aren't in it` +
    (uncovered.length ? `, and neither are ${uncovered.map(r => r.setter).join(', ')}, who have no dialer data.` : '.');
  return h('div', { class: 'tile-pace', title: why },
    h('div', { class: 'meter meter-thin', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': target, 'aria-valuenow': done, 'aria-label': `${done} of ${target} dials` }, fill, tick),
    h('p', { class: 'sub' }, defLink('dial-target', `Live setters: ${fmtInt(done)} of ${fmtInt(target)} target`),
      target ? ` · ${Math.round((100 * done) / target)}%` : ''));
}

function stat(label, value, sub) {
  return h('div', { class: 'stat' }, h('p', { class: 'label' }, label), h('p', { class: 'stat-value' }, value), sub ? h('p', { class: 'sub' }, sub) : null);
}

function setterTable(rows, ix, scaleMax, today, apptsOk, contactsOk, leadsOk, eodCount) {
  if (!rows.length) return null;
  const pct = v => `${Math.min(100, (100 * v) / scaleMax).toFixed(2)}%`;
  return h('section', { class: 'card floor-table-card', 'aria-labelledby': 'floor-table-title' },
    h('div', { class: 'card-head' },
      h('h2', { id: 'floor-table-title' }, 'By setter, today'),
      h('p', { class: 'sub' }, `Contacts = calls over 60s, with their share of dials · Leads = new leads routed to them today${hasTarget ? ` · dotted line = ${DIAL_TARGET} dials` : ''}`)),
    h('table', { class: 'floor-table' },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, 'Setter'),
        h('th', { scope: 'col', class: 'num' }, 'Dials'),
        h('th', { scope: 'col', class: 'bar-col' }, h('span', { class: 'sr-only' }, 'Dials bar')),
        h('th', { scope: 'col', class: 'num' }, 'Contacts'),
        h('th', { scope: 'col', class: 'num' }, 'Talk'),
        h('th', { scope: 'col', class: 'num' }, 'Leads'),
        h('th', { scope: 'col', class: 'num' }, 'Booked'),
        h('th', { scope: 'col' }, `EOD (${eodCount})`))),
      h('tbody', null, rows.map(r => {
        const status = ix.status(r.setter);
        const onDialer = r.dials != null;
        const fill = h('div', { class: 'bar-fill' });
        fill.style.width = pct(r.dials);
        const tick = hasTarget ? h('div', { class: 'bar-tick' }) : null;
        if (tick) tick.style.left = pct(DIAL_TARGET);
        const rate = contactRate(r.contacts, r.dials);
        const title = [onDialer ? `${r.dials} dials today` : 'no dialer row today',
          onDialer && contactsOk ? `${r.contacts} contacts (${rate})` : null,
          leadsOk ? `${r.leads} new leads` : null].filter(Boolean).join(', ');
        return h('tr', { class: 'floor-row' + (status === 'unresolved' ? ' is-flagged' : ''), title: `${ix.label(r.setter)}: ${title}` },
          h('th', { scope: 'row', class: 'who' }, ix.label(r.setter), tag(status)),
          h('td', { class: 'num dials' }, onDialer ? fmtInt(r.dials) : '—'),
          h('td', { class: 'bar-col' }, onDialer ? h('div', { class: 'bar', role: 'img', 'aria-label': `${r.dials} dials${hasTarget ? ` against ${DIAL_TARGET}` : ''}` }, fill, tick) : null),
          h('td', { class: 'num contacts' }, onDialer && contactsOk ? [fmtInt(r.contacts), r.dials ? [' ', h('span', { class: 'rate' }, rate)] : null] : '—'),
          h('td', { class: 'num talk' }, onDialer ? fmtDuration(r.talk) : '—'),
          h('td', { class: 'num leads' }, leadsOk ? fmtInt(r.leads) : '—'),
          h('td', { class: 'num booked' }, apptsOk ? fmtInt(r.booked) : '—'),
          h('td', { class: 'eod' }, r.eod ? h('span', { class: 'state state-good' }, '✓ Sent') : h('span', { class: 'state state-muted' }, 'Not yet')));
      }))));
}

function rosterLine(noCoverage, offRoster, booked, dialRows, leads, ix) {
  if (!noCoverage.length && !offRoster.length) return null;
  const today = r => [
    dialRows.has(r.setter) ? `${fmtInt(dialRows.get(r.setter).dials)} dials` : null,
    leads.get(r.setter) ? `${fmtInt(leads.get(r.setter))} leads` : null,
    booked.get(r.setter) ? `${fmtInt(booked.get(r.setter))} booked` : null
  ].filter(Boolean).join(', ');
  const names = list => list.map((r, i) => [i ? ', ' : '', ix.label(r.setter), today(r) ? ` (${today(r)})` : '']);
  return h('p', { class: 'sub faint roster-line' },
    noCoverage.length ? [defLink('no-coverage', 'No dialer data'), ': ', names(noCoverage), ' (no dial count shown, which is not the same as 0)'] : null,
    noCoverage.length && offRoster.length ? h('br') : null,
    offRoster.length ? [defLink('roster', 'Not on the roster'), ': ', names(offRoster), ' (their own flagged rows, never merged into a similar name)'] : null);
}
