import { h } from '../dom.js';
import { DEPARTED_KEY, fmtInt, fmtDuration, bySetter, dayLabel, hasContacts, contactRate } from '../data.js';
import { tag, defLink } from '../ui.js';
import { costTile } from '../cost.js';
import { DIAL_TARGET } from '../../config.js';

// Tab 1, Floor: today only, everyone, no filters. "Today" is the server's CT date.
// Built for a second monitor at ten feet, and for a setter checking their row on a phone.

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

  return h('div', { class: 'floor' },
    h('div', { class: 'floor-top' },
      hero(dialsOk, dialerReported, teamDials, rosterDials, offRosterDials, p),
      hasTarget && dialsOk && dialerReported ? pace(p, ix, dialRows) : null),
    h('div', { class: 'tiles' },
      tile(defLink('active-day', 'Setters dialing today'), dialsOk && dialerReported ? fmtInt(dialing) : '—', `with dials > 0, of ${fmtInt([...dialRows.keys()].filter(k => k !== DEPARTED_KEY).length)} on the dialer`, dialsOk),
      tile(defLink('contacts-60', 'Contacts today'), contactsOk && dialerReported ? fmtInt(contacts) : '—',
        `calls over 60s · ${contactRate(contacts, teamDials)} of dials`, contactsOk, dialsOk ? 'not in the dialer feed' : 'source unavailable'),
      tile(defLink('talk', 'Talk time today'), dialsOk && dialerReported ? fmtDuration(talk) : '—', 'dialer date', dialsOk),
      tile(defLink('new-leads', 'New leads today'), leadsOk ? fmtInt(teamLeads) : '—',
        [`${fmtInt(setterLeads)} to setters`, ...queueLeads.map(r => `${fmtInt(r.leads)} in ${r.queue}`)].join(' · '), leadsOk),
      tile(defLink('booked', 'Appointments entered today'), apptsOk ? fmtInt(bookedTotal) : '—', 'by Date Booked · entered so far', apptsOk),
      tile(defLink('qualified-show', 'Qualified shows today'), apptsOk ? fmtInt(qualifiedShows) : '—', 'by Appointment Date · Showed + Qualified', apptsOk),
      tile(defLink('pending', "Pending on today's calendar"), apptsOk ? fmtInt(pendingToday) : '—', 'by Appointment Date · no outcome yet', apptsOk),
      costTile(p)),
    setterTable(rows, ix, scaleMax, today, apptsOk, contactsOk, leadsOk, eodSent.size),
    strip(noCoverage, offRoster, booked, dialRows, leads, ix));
}

function hero(ok, reported, teamDials, rosterDials, offRosterDials, p) {
  let note;
  if (!ok) note = "Sheet A couldn't be read, so there are no dial counts right now.";
  else if (!reported) note = `The dialer feed has no rows for today yet. Latest day it reported: ${p.coverage.dials_to || '—'}.`;
  else note = offRosterDials ? `Roster setters ${fmtInt(rosterDials)} · names not on the roster ${fmtInt(offRosterDials)}` : 'Every dial today is from a roster setter.';
  return h('section', { class: 'hero card', 'aria-label': 'Team dials today' },
    h('p', { class: 'label' }, defLink('dials', 'Team dials today')),
    h('p', { class: 'hero-value' + (ok && reported ? '' : ' is-empty') }, ok && reported ? fmtInt(teamDials) : 'No data'),
    h('p', { class: 'sub' }, note),
    h('p', { class: 'sub faint' }, `${dayLabel(p.today_ct)} (Central) · dialer feed refreshes every 5 min`));
}

/** Team pace: live (non-onboarding) setters' dials against DIAL_TARGET x those setters. */
function pace(p, ix, dialRows) {
  const live = p.roster.filter(r => r.status === 'live');
  const counted = live.filter(r => r.on_dials_roster);
  const uncovered = live.filter(r => !r.on_dials_roster);
  const target = DIAL_TARGET * counted.length;
  const done = counted.reduce((t, r) => t + ((dialRows.get(r.setter) || {}).dials || 0), 0);
  const share = target ? done / target : 0;
  // Past the target the meter rescales to the total and a tick marks where the target sat.
  const scale = Math.max(target, done, 1);
  const fill = h('div', { class: 'meter-fill' });
  fill.style.width = `${((100 * done) / scale).toFixed(1)}%`;
  const tick = done > target ? h('div', { class: 'meter-tick' }) : null;
  if (tick) tick.style.left = `${((100 * target) / scale).toFixed(1)}%`;
  return h('section', { class: 'pace card', 'aria-label': 'Team pace' },
    h('p', { class: 'label' }, defLink('dial-target', 'Team pace · live setters')),
    h('p', { class: 'pace-value' }, h('span', null, fmtInt(done)), h('span', { class: 'of' }, ` of ${fmtInt(target)}`),
      h('span', { class: 'pct' }, ` ${Math.round(share * 100)}%`)),
    h('div', { class: 'meter', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': target, 'aria-valuenow': done, 'aria-label': `${done} of ${target} dials` }, fill, tick),
    h('p', { class: 'sub' }, `Target ${DIAL_TARGET} × ${counted.length} live setters with dial coverage${tick ? ' (dotted tick)' : ''}. Onboarding setters aren't in the target.`),
    uncovered.length ? h('p', { class: 'sub faint' },
      `Not in the target because the dialer has no rows for them: ${uncovered.map(r => r.setter).join(', ')}.`) : null);
}

function tile(label, value, sub, ok, offNote = 'source unavailable') {
  return h('section', { class: 'tile card' + (ok ? '' : ' is-unavailable') },
    h('p', { class: 'label' }, label),
    h('p', { class: 'tile-value' }, value),
    h('p', { class: 'sub' }, ok ? sub : offNote));
}

function setterTable(rows, ix, scaleMax, today, apptsOk, contactsOk, leadsOk, eodCount) {
  if (!rows.length) return null;
  const pct = v => `${Math.min(100, (100 * v) / scaleMax).toFixed(2)}%`;
  return h('section', { class: 'card floor-table-card', 'aria-labelledby': 'floor-table-title' },
    h('div', { class: 'card-head' },
      h('h2', { id: 'floor-table-title' }, 'By setter, today'),
      h('p', { class: 'sub' }, `Dials, contacts and talk time by dialer date · contacts = calls over 60s, with their share of dials · leads = new leads routed to them, by the lead's date · appointments by Date Booked, entered so far · EOD by Report Date${hasTarget ? ` · dotted tick = ${DIAL_TARGET} dials` : ''}`)),
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

function strip(noCoverage, offRoster, booked, dialRows, leads, ix) {
  const item = (r, extra) => h('li', null, ix.label(r.setter), extra ? h('span', { class: 'faint' }, ` · ${extra}`) : null);
  const bookedNote = r => (booked.get(r.setter) ? `${booked.get(r.setter)} booked today` : null);
  return h('section', { class: 'strip', 'aria-label': 'Coverage notes' },
    h('div', null,
      h('p', { class: 'label' }, defLink('no-coverage', `Rostered, no dial coverage (${noCoverage.length})`)),
      noCoverage.length ? h('ul', null, noCoverage.map(r => item(r, bookedNote(r)))) : h('p', { class: 'faint' }, 'None'),
      h('p', { class: 'faint' }, 'The dialer stores no rows for them, so no dial count is shown. That is not the same as 0.')),
    h('div', null,
      h('p', { class: 'label' }, defLink('roster', `In the data, not on the roster (${offRoster.length})`)),
      offRoster.length ? h('ul', null, offRoster.map(r => item(r, [
        dialRows.has(r.setter) ? `${fmtInt(dialRows.get(r.setter).dials)} dials today` : null,
        leads.get(r.setter) ? `${fmtInt(leads.get(r.setter))} new leads today` : null, bookedNote(r)
      ].filter(Boolean).join(', ') || null))) : h('p', { class: 'faint' }, 'None'),
      h('p', { class: 'faint' }, 'Shown as their own flagged rows, never merged into a similar name.')));
}
