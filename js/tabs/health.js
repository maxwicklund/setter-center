import { h } from '../dom.js';
import { DEPARTED_KEY, fmtInt, dayLabel, addDays, dateRange, monthBounds, ctClock, hasContacts } from '../data.js';
import { tag, defLink } from '../ui.js';
import { DIAL_TARGET } from '../../config.js';

// Tab 7, Data Health & Definitions: every disagreement made cheap to settle, then the
// glossary that every metric label on the site links into (#health:def-<key>).

export function renderHealth(p, ix) {
  const h_ = p.health;
  return h('div', { class: 'health-tab' },
    h('div', { class: 'health-grid' },
      sources(p),
      totals(p, ix),
      extents(p),
      rosterCard(p, ix),
      appointmentsHealth(p),
      datesCard(h_),
      eodGrid(p, ix),
      bookingDifference(p, ix),
      speedHealth(p),
      security()),
    glossary());
}

const card = (title, ...body) => h('section', { class: 'card health-card' }, h('h2', null, title), ...body);
const kv = rows => h('dl', { class: 'kv' }, rows.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));

// ---------------------------------------------------------------- sources and coverage

function sources(p) {
  const s = p.sources;
  const stamp = tab => (s.router.stamps || {})[tab] || '—';
  const ok = src => (src.ok ? h('span', { class: 'state state-good' }, '✓ read') : h('span', { class: 'state st-behind' }, `✗ ${src.error}`));
  const c = p.coverage;
  const span = (a, b) => (a ? `${a} → ${b}` : '—');
  return card('Sources and coverage',
    h('p', { class: 'sub' }, `Snapshot fetched ${ctClock(p.as_of_ct)} for ${p.today_ct}. Sheets A and B carry no refresh stamp of their own, so they show when they were fetched; sheet C stamps itself.`),
    h('table', { class: 'mini-table' },
      h('thead', null, h('tr', null, ['Source', 'Read', 'Covers', 'Freshness'].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', null,
        h('tr', null, h('th', { scope: 'row' }, 'A · dialer feed (_Dials)'), h('td', null, ok(s.kpi)), h('td', null, span(c.dials_from, c.dials_to)), h('td', null, 'refreshes every 5 min; fetched ' + ctClock(p.as_of_ct))),
        h('tr', null, h('th', { scope: 'row' }, 'A · EOD reports (_EOD)'), h('td', null, ok(s.kpi)), h('td', null, span(c.eod_from, c.eod_to)), h('td', null, 'fetched ' + ctClock(p.as_of_ct))),
        h('tr', null, h('th', { scope: 'row' }, 'B · appointment tracker'), h('td', null, ok(s.tracker)), h('td', null, `booked ${span(c.appts_from, c.appts_to)} · dated ${span(c.appt_dates_from, c.appt_dates_to)}`), h('td', null, 'fetched ' + ctClock(p.as_of_ct))),
        h('tr', null, h('th', { scope: 'row' }, 'C · routing: Leads'), h('td', null, ok(s.router)), h('td', null, span(c.leads_from, c.leads_to)), h('td', null, stamp('Leads'))),
        h('tr', null, h('th', { scope: 'row' }, 'C · routing: Daily'), h('td', null, ok(s.router)), h('td', null, span(c.daily_from, c.daily_to)), h('td', null, stamp('Daily'))),
        h('tr', null, h('th', { scope: 'row' }, 'C · routing: First touch by'), h('td', null, ok(s.router)), h('td', null, '—'), h('td', null, stamp('First touch by'))))),
    contactsLine(p),
    h('p', { class: 'sub faint' }, 'Any window that reaches before a source starts shows "no data", never 0. Every view defaults to a date range, never all time.'));
}

function contactsLine(p) {
  const x = p.health;
  if (!p.sources.kpi.ok) return null;
  if (!x.contacts_col) return h('p', { class: 'sub' }, h('span', { class: 'state st-behind' }, '✗'), ' Contacts: the dialer feed has no "Calls Over 60s" column right now, so contacts are hidden everywhere (not shown as 0).');
  return h('p', { class: 'sub' }, defLink('contacts-60', 'Contacts'), ` come from _Dials column ${x.contacts_col} (Calls Over 60s). Setter-days with more contacts than dials: `,
    x.contacts_over_dials ? h('strong', null, fmtInt(x.contacts_over_dials)) : '0', x.contacts_over_dials ? ' (should never happen; worth asking whoever runs the feed).' : '.');
}

function extents(p) {
  const x = p.health;
  const row = (label, key) => h('tr', null, h('th', { scope: 'row' }, label),
    h('td', { class: 'num' }, fmtInt(x.data_rows[key])), h('td', { class: 'num' }, fmtInt(x.last_row[key])),
    h('td', { class: 'num' }, fmtInt(x.grid_rows[key])), h('td', { class: 'num' }, fmtInt(x.gap_rows[key])));
  return card('Row counts: measured, not trusted',
    h('p', { class: 'sub' }, "A sheet's size (its grid) is not how much data it holds, so every source is scanned for its last populated row on each refresh."),
    h('table', { class: 'mini-table' },
      h('thead', null, h('tr', null, ['Tab', 'Data rows', 'Last row', 'Grid rows', 'Blank rows inside'].map((t, i) => h('th', { scope: 'col', class: i ? 'num' : null }, t)))),
      h('tbody', null,
        row('A · _Dials', 'dials'), row('A · _EOD', 'eod'), row('A · _Appointments (count only)', 'a_appts'),
        row('B · Appointment Tracker', 'tracker'), row('B · goals (rows 5–19 only)', 'goals'),
        row('C · Daily', 'daily'), row('C · First touch by', 'first_touch'), row('C · Leads', 'leads'))),
    h('div', { class: 'callout' },
      h('p', null, h('strong', null, `A's appointment mirror holds ${fmtInt(x.a_appt_rows)} rows; the tracker (B) holds ${fmtInt(x.b_appt_rows)}. `),
        x.a_appt_rows < x.b_appt_rows
          ? `A is ${fmtInt(x.b_appt_rows - x.a_appt_rows)} short (it drops the oldest rows), which is why appointments are read from B only.`
          : 'They now match: A may have stopped truncating. Worth a look before changing anything.')),
    x.headers_dropped.length ? h('p', { class: 'sub' }, `Columns read but dropped by the allowlist: ${x.headers_dropped.map(d => `${d.tab} ${d.col}`).join(', ')}`) : null);
}

// ---------------------------------------------------------------- team totals both ways

function totals(p, ix) {
  const [mFrom] = monthBounds(p.today_ct);
  const metrics = [
    ['Dials', p.dials, 'date', 'dials'],
    hasContacts(p) ? ['Contacts', p.dials, 'date', 'contacts'] : null,
    ['Booked', p.booked, 'date_booked', 'booked'],
    ['Showed', p.outcomes, 'appt_date', 'showed'],
    ['Qualified shows', p.outcomes, 'appt_date', 'qualified_show'],
    ['Pending', p.pending, 'appt_date', 'pending']
  ].filter(Boolean);
  const group = name => (ix.isTeam(name) ? 'team' : name === DEPARTED_KEY ? 'departed' : 'other');
  const sums = (arr, dateKey, field, from) => {
    const t = { team: 0, departed: 0, other: 0 };
    for (const r of arr) if (!from || r[dateKey] >= from) t[group(r.setter)] += r[field] || 0;
    return t;
  };
  const departedN = (ix.rows.get(DEPARTED_KEY) || {}).departed_n || 0;
  return card('Team totals, both ways',
    h('p', { class: 'sub' }, 'Roster-joined counts only the live roster. Raw scan counts every row in the data. The difference is departed setters and names not on the roster; nothing is dropped.'),
    h('table', { class: 'mini-table' },
      h('thead', null, h('tr', null, ['', 'This month: roster', 'raw scan', 'difference', 'All time: roster', 'raw scan', 'difference'].map((t, i) => h('th', { scope: 'col', class: i ? 'num' : null }, t)))),
      h('tbody', null, metrics.map(([label, arr, dk, f]) => {
        const m = sums(arr, dk, f, mFrom);
        const a = sums(arr, dk, f, null);
        const raw = t => t.team + t.departed + t.other;
        const diff = t => h('span', { title: `departed (${departedN}) ${fmtInt(t.departed)} · not on the roster ${fmtInt(t.other)}` }, fmtInt(raw(t) - t.team));
        return h('tr', null, h('th', { scope: 'row' }, label),
          h('td', { class: 'num' }, fmtInt(m.team)), h('td', { class: 'num' }, fmtInt(raw(m))), h('td', { class: 'num' }, diff(m)),
          h('td', { class: 'num' }, fmtInt(a.team)), h('td', { class: 'num' }, fmtInt(raw(a))), h('td', { class: 'num' }, diff(a)));
      }))),
    h('p', { class: 'sub faint' }, 'Hover a difference to split it into departed and not-on-roster. Booked by Date Booked; Showed, Qualified shows and Pending by Appointment Date; Dials and Contacts by dialer date.'));
}

// ---------------------------------------------------------------- roster and aliases

function rosterCard(p, ix) {
  const rows = p.roster.filter(r => r.status !== 'alias');
  const order = { live: 0, onboarding: 1, unresolved: 2, departed: 3 };
  rows.sort((a, b) => order[a.status] - order[b.status] || ix.label(a.setter).localeCompare(ix.label(b.setter)));
  const mark = v => (v ? '✓' : '·');
  const aliases = p.roster.filter(r => r.status === 'alias');
  return card('Roster and name spellings',
    h('p', { class: 'sub' }, "The roster is Max's list, not derived from any sheet. Departed setters are collapsed into one line and never named. Names on neither list are shown as their own flagged rows, never merged into a similar name."),
    h('div', { class: 'table-scroll' }, h('table', { class: 'mini-table roster-table' },
      h('thead', null, h('tr', null, ['Name', 'Status', 'Dialer', 'Tracker', 'EOD', 'Routing', 'Goal row'].map((t, i) => h('th', { scope: 'col', class: i > 1 ? 'num' : null }, t)))),
      h('tbody', null, rows.map(r => h('tr', null,
        h('th', { scope: 'row' }, ix.label(r.setter), tag(r.status)),
        h('td', null, r.status === 'unresolved' ? h('span', { class: 'faint' }, r.flag_reason) : r.status),
        h('td', { class: 'num' }, mark(r.on_dials_roster)), h('td', { class: 'num' }, mark(r.in_appt_data)), h('td', { class: 'num' }, mark(r.in_eod)),
        h('td', { class: 'num' }, mark(r.in_router)), h('td', { class: 'num' }, mark(r.in_goals))))))),
    h('h3', null, 'Alias map'),
    h('table', { class: 'mini-table' },
      h('thead', null, h('tr', null, ['Sheet spelling', 'Counted as', 'Seen in'].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', null, aliases.map(a => h('tr', null, h('th', { scope: 'row' }, a.setter), h('td', null, a.alias_of),
        h('td', null, a.seen_in.length ? a.seen_in.join(', ') : h('span', { class: 'faint' }, 'not seen in any sheet right now')))))),
    h('p', { class: 'sub faint' }, 'Only confirmed spellings are aliased. Any other spelling stays its own flagged row until Max rules on it.'),
    p.health.goals ? h('p', { class: 'sub' }, `Goal rows: ${p.health.goals.kept} kept for the live roster; ${p.health.goals.dropped_departed} departed and ${p.health.goals.dropped_unresolved.length} not-on-roster rows dropped` +
      (p.health.goals.dropped_unresolved.length ? ` (${p.health.goals.dropped_unresolved.join(', ')})` : '') +
      `. Live with no goal row: ${p.health.goals.live_without_goal.join(', ') || 'none'}. The sheet's "Active?" column reads Yes on ${p.health.goals.active_yes} of ${p.health.goals.rows_read} rows, so it can't identify a departure.`) : null);
}

// ---------------------------------------------------------------- appointments

function appointmentsHealth(p) {
  const x = p.health;
  const canceled = p.outcomes.reduce((t, r) => t + r.canceled, 0);
  const other = p.outcomes.reduce((t, r) => t + r.other_status, 0);
  return card('Appointment tracker checks',
    kv([
      ['Duplicate Appointment IDs', `${fmtInt(x.dup_appt_ids.rows_dropped)} extra rows dropped (${fmtInt(x.dup_appt_ids.ids)} IDs) · ${fmtInt(x.blank_appt_ids)} rows have no ID`],
      ['Same advisor, date and time', `not checked: ${x.dup_advisor_slot_reason}`],
      ['Status values', x.status_inventory.map(s => `${s.status} ${fmtInt(s.n)}`).join(' · ')],
      ['Canceled, all time', `${fmtInt(canceled)} · excluded from show rate, shown on its own bar`],
      other ? ['Unknown status values', `${fmtInt(other)} rows, kept in their own "other status" bucket`] : null,
      ['Outcome on a future date', `${fmtInt(x.future_with_outcome)} rows marked Showed / No Show but dated after today; counted as Pending`],
      ['Pay Eligible vs Qualified Show', `${fmtInt(x.pay_vs_qshow.pe_not_qs)} flagged Pay Eligible without a qualified show · ${fmtInt(x.pay_vs_qshow.qs_not_pe)} qualified shows not flagged. The sheet's flag wins.`],
      ['Time zones', x.tz_counts.map(t => `${t.tz} ${fmtInt(t.n)}`).join(' · ')],
      ['Distinct setter spellings', `tracker ${x.distinct_names.appts} · dialer ${x.distinct_names.dials} · EOD ${x.distinct_names.eod}`],
      ['Lead sources', 'RetireWell paid ads and the Funnel client share the tracker with no column to tell them apart, so every figure is both, labelled "mixed".']
    ]),
    h('p', { class: 'sub faint' }, `Advisor Result reads "Pending" on every row and is never read, so there are no close or closed-asset figures anywhere.`));
}

function datesCard(x) {
  const list = items => (items.length ? h('ul', { class: 'plain' }, items.map(d => h('li', null, `${d.tab} ${d.cell}: "${d.value}"`, d.parsed_as ? ` → read as ${d.parsed_as}` : ''))) : h('p', { class: 'faint' }, 'None.'));
  const blanks = Object.entries(x.blank_dates);
  return card('Dates that needed attention',
    h('p', { class: 'sub' }, 'Five date formats arrive as display text. Anything that can\'t be read is listed here rather than silently dropped.'),
    h('h3', null, `Couldn't be read (${fmtInt(x.unparsed_total)})`), list(x.unparsed_dates),
    h('h3', null, `Read, but typed in an odd format (${fmtInt(x.nonstandard_total)})`), list(x.nonstandard_dates),
    blanks.length ? h('p', { class: 'sub' }, 'Blank date cells: ' + blanks.map(([k, n]) => `${k} ${n}`).join(' · ')) : null,
    x.unkeyed.date_booked || x.unkeyed.appt_date ? h('p', { class: 'sub' }, `Appointment rows kept out of date-based counts: ${x.unkeyed.date_booked} with no usable Date Booked, ${x.unkeyed.appt_date} with no usable Appointment Date.`) : null);
}

// ---------------------------------------------------------------- EOD

function eodGrid(p, ix) {
  const dates = dateRange(addDays(p.today_ct, -13), p.today_ct);
  const team = p.roster.filter(r => r.active);
  const sent = new Set(p.eod.map(r => `${r.setter}|${r.report_date}`));
  const active = new Set(p.dials.filter(r => r.dials > 0).map(r => `${r.setter}|${r.date}`));
  return card('EOD compliance, last 14 days',
    h('p', { class: 'sub' }, `By Report Date. ${p.health.eod_test_row.dropped ? 'The leftover test submission in row 2 is filtered out.' : 'The row-2 test submission was not found where expected; nothing was filtered.'} ` +
      `${fmtInt(p.health.eod_multi_submissions)} setter-days have more than one EOD; the later one counts.`),
    h('div', { class: 'table-scroll' }, h('table', { class: 'eod-grid' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Setter'), dates.map(d => h('th', { scope: 'col', title: dayLabel(d) }, String(Number(d.slice(8))))), h('th', { scope: 'col', class: 'num' }, 'Sent / active'))),
      h('tbody', null, team.map(r => {
        const act = dates.filter(d => active.has(`${r.setter}|${d}`));
        const ok = act.filter(d => sent.has(`${r.setter}|${d}`)).length;
        return h('tr', null,
          h('th', { scope: 'row' }, ix.label(r.setter), tag(r.status)),
          dates.map(d => {
            const k = `${r.setter}|${d}`;
            const cls = sent.has(k) ? 'is-sent' : !r.on_dials_roster ? 'is-nocov' : active.has(k) ? 'is-missing' : 'is-off';
            return h('td', null, h('span', { class: `eod-day ${cls}`, title: `${dayLabel(d)}: ${sent.has(k) ? 'EOD sent' : cls === 'is-nocov' ? 'no EOD; no dial coverage' : cls === 'is-missing' ? 'dialed, no EOD' : 'no dials, no EOD'}` }));
          }),
          h('td', { class: 'num' }, r.on_dials_roster ? `${ok} / ${act.length}` : `${dates.filter(d => sent.has(`${r.setter}|${d}`)).length} sent`));
      })))),
    h('div', { class: 'legend' },
      h('span', { class: 'legend-item' }, h('span', { class: 'eod-day is-sent' }), 'sent'),
      h('span', { class: 'legend-item' }, h('span', { class: 'eod-day is-missing' }), 'dialed, no EOD'),
      h('span', { class: 'legend-item' }, h('span', { class: 'eod-day is-off' }), 'no dials'),
      h('span', { class: 'legend-item' }, h('span', { class: 'eod-day is-nocov' }), 'no dial coverage')));
}

function bookingDifference(p, ix) {
  const from30 = addDays(p.today_ct, -29);
  const per = new Map();
  for (const r of p.eod) {
    if (r.booking_difference == null) continue;
    const x = per.get(r.setter) || { d30: 0, all: 0 };
    x.all += r.booking_difference;
    if (r.report_date >= from30) x.d30 += r.booking_difference;
    per.set(r.setter, x);
  }
  const rows = [...per].filter(([, v]) => v.d30 || v.all).sort((a, b) => Math.abs(b[1].d30) - Math.abs(a[1].d30));
  const total = rows.reduce((t, [, v]) => t + v.d30, 0);
  return card('Booking Difference: rows still to be entered',
    h('p', { class: 'sub' }, "What setters reported booked on their EOD minus what the tracker actually has. It's a data-entry gap, not a performance number: usually the tracker is the one that's behind."),
    h('p', { class: 'tile-value' }, fmtInt(total), h('span', { class: 'unit' }, ' over the last 30 days')),
    rows.length ? h('table', { class: 'mini-table' },
      h('thead', null, h('tr', null, ['Setter', 'Last 30 days', 'All time'].map((t, i) => h('th', { scope: 'col', class: i ? 'num' : null }, t)))),
      h('tbody', null, rows.map(([who, v]) => h('tr', null, h('th', { scope: 'row' }, ix.label(who), tag(ix.status(who))),
        h('td', { class: 'num' }, fmtInt(v.d30)), h('td', { class: 'num' }, fmtInt(v.all)))))) : h('p', { class: 'faint' }, 'No differences reported.'),
    h('p', { class: 'sub faint' }, 'Positive = more reported than entered. By Report Date.'));
}

// ---------------------------------------------------------------- speed data

function speedHealth(p) {
  const x = p.health;
  const rc = x.router_recon;
  const allAgree = rc && rc.dates_compared && [rc.leads_equal, rc.touched_equal, rc.within_1h_equal, rc.booked_equal, rc.median_within_1].every(n => n === rc.dates_compared);
  return card('Routing-sheet checks',
    kv([
      ['Per-lead vs daily totals', rc ? `${allAgree ? '✓ ' : ''}${rc.leads_equal}/${rc.dates_compared} days agree on leads, ${rc.median_within_1}/${rc.dates_compared} on the median` : '—'],
      rc && rc.mismatches.length ? ['First mismatches', rc.mismatches.map(m => `${m.date} ${m.field}: ours ${m.ours}, sheet ${m.sheet}`).join(' · ')] : null,
      ["'All' roll-up rows filtered", `${x.all_rows_filtered.daily} daily · ${x.all_rows_filtered.first_touch} first-touch`],
      ['Touched with no time recorded', fmtInt(x.speed_unusable.touched_no_time)],
      ['Untouched with no readable arrival time', fmtInt(x.speed_unusable.untouched_no_age)],
      x.leads_values ? ['Routed by values', x.leads_values.routed_by.map(v => `${v.value} ${fmtInt(v.n)}`).join(' · ')] : null,
      x.leads_values ? ['Touched / Booked values', `${x.leads_values.touched.map(v => `${v.value} ${v.n}`).join(', ')} / ${x.leads_values.booked.map(v => `${v.value} ${v.n}`).join(', ')}`] : null
    ]));
}

// ---------------------------------------------------------------- security and known gaps

function security() {
  return card('Access, and what is deliberately not shown',
    h('div', { class: 'callout' },
      h('p', null, h('strong', null, 'Rotate the team password'), ' whenever someone leaves the team, and every 90 days otherwise.'),
      h('p', { class: 'sub' }, 'In Apps Script: Project Settings → Script Properties → DASH_TOKEN → edit → Save. It takes effect on the next refresh, no redeploy; everyone is signed out until they get the new one. It is one shared password: no per-person access, no sign-in log.')),
    kv([
      ['Answered', 'Collected by the dialer but not shown anywhere: it counts pickups by a person or a voicemail, which the phone system can’t tell apart, so it has no usable definition yet.'],
      ['Other targets in the sheets', `The KPI sheet's own Goals & Definitions tab lists a 150 dials/day minimum, a 75% show-rate goal and weekly booked goals. They are not used here: the only dial target is ${DIAL_TARGET ?? 'none'} a day, and goals come from the tracker's goals tab.`],
      ['Not on this dashboard', 'Pay, commission and payroll; prospect names, contact details, notes and CRM links; closes and closed assets; ad spend and campaign attribution (that is the Ads Center).']
    ]),
    h('p', { class: 'sub' }, h('a', { href: '?selftest=1' }, 'Open the self-test'), ' to re-run every acceptance check against the live data.'));
}

// ---------------------------------------------------------------- glossary

export const GLOSSARY = [
  ['today', 'Today', 'Always the server’s America/Chicago date, sent with every refresh, never your device’s clock. The wall monitor, a phone in another time zone and a laptop on the road all agree on what “today” means.'],
  ['dials', 'Dials', 'The dialer’s Dials column summed for the setter and dates, counted by the dialer’s date. The feed refreshes every 5 minutes and starts 2026-07-14. It writes a row for every rostered setter every day, even before they started, so a 0 on its own proves nothing; only Dials > 0 does.'],
  ['active-day', 'Active dialing day', 'A setter-day with Dials > 0. Every per-day average and every leaderboard rate divides by active dialing days, not calendar days, so part-timers and new starts aren’t made to look like a performance problem.'],
  ['no-coverage', 'No dial coverage', 'The dialer stores no rows at all for this name. Shown as hatched “no data”, never as 0 dials.'],
  ['dial-target', 'Dial target', `${DIAL_TARGET ?? 'No'} dials per setter per day: the dotted tick on dial bars. The team pace bar fills toward that × the live (non-onboarding) setters who have dial coverage. There is no separate team target.`],
  ['talk', 'Talk time and seconds per dial', 'Summed from the dialer’s Talk Seconds and formatted once at the end. Seconds per dial = talk seconds ÷ dials. The sheet’s own Talk Time text column is never added up.'],
  ['contacts-60', 'Contacts and contact rate', 'Dialer calls that were picked up and lasted 61 seconds or longer, from the dialer feed’s Calls Over 60s column, counted by the dialer’s date and refreshed every 5 minutes (today’s number grows during the day). A voicemail that ran past 60 seconds counts too: the phone system can’t tell a person from a voicemail. Contact rate = contacts ÷ dials. Filled back to 2026-07-14.'],
  ['answered', 'Answered (not shown)', 'The dialer’s own footnote: Answered is “the number picked up — a person OR a voicemail; the phone system cannot tell them apart.” Collected, not shown, pending a definition.'],
  ['booked', 'Booked', 'Appointment rows counted by Date Booked. Credit lands on the day the booking was made: a booking made on the 30th for a meeting on the 5th belongs to the 30th. Today’s figure is always “entered so far”: the tracker often trails the floor.'],
  ['outcomes', 'Showed · No Show · Rescheduled', 'Counted by Appointment Date, from Status. Same rows as Booked, different date column, so they are never put in one table under one date filter. Rescheduled has never occurred in the data.'],
  ['pending', 'Pending', 'An appointment dated after today, or dated in the past and still marked Booked or blank. Shown on its own, excluded from every rate.'],
  ['canceled', 'Canceled', 'A resolved outcome that is not Pending and not in the show-rate denominator. Counted and drawn on its own bar, apart from the stack.'],
  ['show-rate', 'True Show Rate', 'Showed ÷ (Showed + No Show + Rescheduled). Pending and Canceled are excluded. Under 10 resolved appointments it appears as a greyed raw fraction (“3/5”) and is never ranked.'],
  ['qualified-show', 'Qualified Show', 'Status = Showed and Qualified? = Yes, by Appointment Date: the unit the business is paid on. Never approximated from Shows, asset amounts or notes. Qualified Show Rate uses the True Show Rate denominator.'],
  ['pay-eligible', 'Pay Eligible', 'The tracker’s own flag, read as-is and never recomputed. It doesn’t always agree with Qualified Show; the sheet’s flag wins, and disagreements are counted on this page, not on anyone’s card.'],
  ['maturity', 'Maturity', 'Of the appointments dated before today in a window, the share that has an outcome. Outcomes land late (about a third the same day, most within a week), so a window under 95% resolved reads low and carries a banner.'],
  ['cohort', 'Booking cohort (Deep Dive funnel)', 'The appointments booked in a window, followed to their outcome whenever it lands. One population, so each funnel step converts from the step above.'],
  ['contacts', 'EOD contacts (self-reported)', 'The setter’s own conversation count from their EOD: a trend and compliance signal, not a system metric, and not the same as the dialer’s Contacts above. Never divided by a dialer figure, never backfilled.'],
  ['eod', 'EOD compliance', 'Active dialing days that have an EOD for that Report Date. The leftover test submission in row 2 is filtered out.'],
  ['booking-difference', 'Booking Difference', 'Reported booked minus what the tracker has: rows somebody still has to enter. A data-entry gap, not a performance metric; it never appears on a leaderboard.'],
  ['min-touch', 'Minutes to first touch', 'Reported as a median and a bucket distribution, never a mean (the never-touched tail wrecks a mean). Medians are computed over raw per-lead values, never averaged from daily medians. An untouched lead’s age is measured against the routing sheet’s own refresh stamp.'],
  ['worked', 'Worked, assigned and first touch', '“Touched” says whether anyone worked a lead; “First touch by” says who actually did; the Setter column says only who it was assigned to and never updates when someone else picks it up. Both views are shown side by side.'],
  ['routed-by', 'Routed by', 'rotation, house, manual or reassigned. Lead type drives book rate far more than setter skill, so setter-vs-setter comparisons use rotation leads only.'],
  ['speed-target', 'No speed target', 'There is no speed-to-lead target. The 1-hour mark is a reference line, not a goal.'],
  ['queues', 'Queues and roll-ups', 'The routing sheet’s “All” rows, “House (unassigned)” and the agency login are not people. They are kept out of every per-setter table, total and ranking, and shown as queues under the sheet’s own text.'],
  ['pace', 'Goals and pace', 'Monthly goals come from the tracker’s goals tab, live roster only. No goal row means “no goal set”: never paced against 0. The pace marker is the goal × the share of the month elapsed (to the server’s CT time). Ahead or behind means more than 10% or 2 (whichever is larger) off that marker.'],
  ['ramping', 'Part-time / ramping', 'Anyone with fewer than 5 active dialing days in the month: listed with their numbers, not ranked.'],
  ['roster', 'Roster, departed and not on the roster', 'The live roster is Max’s list. Departed setters are collapsed into one “departed (n)” line and never named; their numbers still count in the raw-scan totals. Names on neither list stay as their own flagged rows until resolved.'],
  ['team-totals', 'Roster-joined vs raw scan', 'Every team total exists both ways: live roster only, and every row in the data. The difference (departed plus not-on-roster names) is shown on this page.'],
  ['client-mix', 'RetireWell + Funnel client, mixed', 'Appointments from RetireWell ads and from a separate Funnel client share the tracker with no column telling them apart, so every appointment figure includes both.']
];

/** The sheet's own wording, from the KPI sheet's Goals & Definitions tab. */
const SHEET_WORDING = [
  ['Contacts', 'Prospects reached, from the EOD Log.'],
  ['Qualified No Book', 'Qualified prospects who did not book, from the EOD Log.'],
  ['Not Qualified', 'Contacts that did not meet qualification requirements.'],
  ['Booked', 'Appointments counted by Date Booked in Appointment Tracker.'],
  ['Qualified Show', 'Status = Showed and Qualified? = Yes.'],
  ['True Show Rate', 'Showed ÷ (Showed + No Show + Rescheduled). Future pending appointments are excluded.']
];

function glossary() {
  return h('section', { class: 'card glossary', id: 'glossary', 'aria-labelledby': 'glossary-title' },
    h('h2', { id: 'glossary-title' }, 'Definitions'),
    h('p', { class: 'sub' }, 'Every metric label on the dashboard links here. These are the rules the numbers are built on.'),
    h('dl', { class: 'gloss' }, GLOSSARY.map(([key, term, text]) => [
      h('dt', { id: `def-${key}` }, h('a', { href: `#health:def-${key}`, class: 'gloss-anchor', 'aria-label': `Link to ${term}` }, '#'), term),
      h('dd', null, text)])),
    h('h3', null, 'In the sheets’ own words'),
    h('p', { class: 'sub faint' }, 'From the KPI sheet’s Goals & Definitions tab. Its Dials wording predates the dialer feed, and its Contact Rate and Booking Rate mix self-reported and system counts, so those three aren’t used here.'),
    h('dl', { class: 'gloss gloss-sheet' }, SHEET_WORDING.map(([term, text]) => [h('dt', null, term), h('dd', null, text)])));
}
