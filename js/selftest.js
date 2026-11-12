import { h } from './dom.js';
import { post } from './api.js';
import { rosterIndex, sum, inMonth, daysBetween, fmtInt, DEPARTED_KEY } from './data.js';

// The ?selftest=1 panel: every row is a computed figure beside an expected one, run
// against the live payload. Golden figures are the build spec's, measured on GOLDEN_DATE;
// figures that grow every day show "changed" (not "fail") once that date has passed.
const GOLDEN_DATE = '2026-11-02';
const FORBIDDEN = ['Prospect', 'Notes', 'CRM', 'Base Pay', 'Amount Due', 'Pay Rule', 'Payroll', '$'];

// Every array the payload may carry: [dimension keys, measure keys]. A row-level array
// would repeat a dimension tuple or carry a key outside these lists.
const SPEED_FIELDS = ['leads', 'touched', 'untouched', 'within_1h', 'booked', 'median_min'];
const FT_FIELDS = ['first_touches', 'own', 'house', 'other', 'by_call', 'by_text', 'within_1h', 'booked', 'median_min'];
const ARRAYS = {
  dials: [['date', 'setter'], ['dials', 'talk_seconds', 'contacts']],
  booked: [['date_booked', 'setter'], ['booked']],
  outcomes: [['appt_date', 'setter'], ['showed', 'no_show', 'rescheduled', 'canceled', 'other_status', 'qualified_show', 'pay_eligible']],
  pending: [['appt_date', 'setter'], ['pending']],
  cohort: [['date_booked', 'setter'], ['booked', 'showed', 'no_show', 'rescheduled', 'canceled', 'other_status', 'pending', 'qualified_show', 'pay_eligible']],
  eod: [['report_date', 'setter'], ['submitted', 'contacts', 'not_qualified', 'reported_booked', 'appointments_added', 'status_updates', 'qualified_no_book', 'booking_difference', 'closed_deals']],
  goals: [['setter'], ['monthly_booked_goal', 'monthly_showed_goal']],
  roster: [['setter'], ['status', 'active', 'on_dials_roster', 'in_appt_data', 'in_eod', 'in_router', 'in_goals', 'alias_of', 'departed_n', 'flag_reason', 'seen_in']],
  speed_daily: [['date', 'setter'], SPEED_FIELDS],
  speed_daily_queues: [['date', 'queue'], SPEED_FIELDS],
  first_touch: [['date', 'setter'], FT_FIELDS],
  first_touch_queues: [['date', 'queue'], FT_FIELDS],
  speed_buckets: [['bucket', 'routed_by'], ['leads', 'booked']],
  speed_window: [['who', 'by', 'routed_by'], ['kind', 'leads', 'touched', 'within_1h', 'booked', 'median_min']],
  unworked_age: [['age', 'routed_by'], ['leads']],
  spend_daily: [['date'], ['rw_spend', 'total_spend']]
};
const SCALARS = ['version', 'as_of_ct', 'today_ct', 'client_mix', 'sources', 'coverage', 'health', 'speed_window_median_min'];

export async function runChecks({ payload: p, text }) {
  const rows = [];
  const add = (group, check, computed, expected, status, note = '') =>
    rows.push({ group, check, computed: String(computed), expected: String(expected), status, note });
  const golden = (actual, expected) => (actual === expected ? 'pass' : p.today_ct === GOLDEN_DATE ? 'fail' : 'changed');
  const h = p.health;
  const ix = rosterIndex(p);

  // Sources
  const sheetNames = { kpi: 'Sheet A (KPI dashboard)', tracker: 'Sheet B (appointment tracker)', router: 'Sheet C (setter routing)', ads: 'Sheet D (lead router: ad spend)' };
  for (const [key, label] of Object.entries(sheetNames)) {
    const src = p.sources[key] || {};
    add('Sources', `${label} read`, src.ok ? 'read' : 'failed', 'read', src.ok ? 'pass' : 'fail',
      src.error || (key === 'router' ? `A1 refresh note: ${src.stamp}` : `fetched ${p.as_of_ct} (no stamp of its own)`));
  }

  // Row extents
  add('Row extents', '_Dials last populated row', `${h.last_row.dials} (${fmtInt(h.data_rows.dials)} rows)`, '1009 (1,008 rows)',
    golden(h.last_row.dials, 1009), `Golden figure from ${GOLDEN_DATE}; the feed adds one row per stored setter per day.`);
  const days = daysBetween(p.coverage.dials_from, p.coverage.dials_to) + 1;
  add('Row extents', '_Dials rows = days covered × setters stored', `${fmtInt(h.data_rows.dials)} vs ${days} × ${h.distinct_names.dials} = ${fmtInt(days * h.distinct_names.dials)}`,
    'equal', h.data_rows.dials === days * h.distinct_names.dials ? 'pass' : 'fail', `Coverage ${p.coverage.dials_from} → ${p.coverage.dials_to}. Holds every day, unlike the golden row count.`);
  add('Row extents', '_Dials Calls Over 60s: setter-days with more contacts than dials', h.contacts_col ? fmtInt(h.contacts_over_dials) : 'column not found', '0',
    h.contacts_col && h.contacts_over_dials === 0 ? 'pass' : 'fail', h.contacts_col ? `Read from column ${h.contacts_col}. Contacts are a subset of dials.` : 'Without the column, contacts are hidden everywhere.');
  add('Row extents', 'B · Appointment Tracker last populated row', `${h.last_row.tracker} (${fmtInt(h.data_rows.tracker)} rows)`, '1186 (1,182 rows)',
    golden(h.last_row.tracker, 1186), `Headers on row 4, data from row 5. The tab's grid is ${fmtInt(h.grid_rows.tracker)} rows.`);
  const a = h.a_appt_rows;
  const b = h.b_appt_rows;
  add('Row extents', 'A · _Appointments rows vs B · Appointment Tracker rows', `${fmtInt(a)} vs ${fmtInt(b)} (A is ${fmtInt(b - a)} short)`, '994 vs 1,182 — report the gap',
    'report', a < b ? 'A is still truncated, so appointments keep coming from B.' : 'A now holds as many rows as B: it may have stopped truncating.');
  add('Row extents', '_EOD last populated row', `${h.last_row.eod} (${fmtInt(h.data_rows.eod)} rows)`, '243', golden(h.last_row.eod, 243));
  add('Row extents', 'Distinct setter names in the appointment data', h.distinct_names.appts, '16', golden(h.distinct_names.appts, 16), 'Raw sheet text, before aliases.');
  add('Row extents', 'Distinct setter names in _Dials', h.distinct_names.dials, '9', golden(h.distinct_names.dials, 9));
  const noCoverage = p.roster.filter(r => r.active && !r.on_dials_roster).map(r => r.setter);
  add('Row extents', 'Live-roster setters with zero _Dials coverage', `${noCoverage.length}: ${noCoverage.join(', ') || '—'}`, '3',
    noCoverage.length === 3 ? 'pass' : 'fail', 'They render as "no dial coverage", never as 0 dials.');
  const departed = ix.rows.get(DEPARTED_KEY);
  add('Row extents', 'Departed setters with rows (one "departed (n)" line)', departed ? departed.departed_n : 0, '7',
    (departed ? departed.departed_n : 0) === 7 ? 'pass' : 'fail');

  // Privacy
  const leaked = p.roster.filter(r => r.status === 'departed' && r.setter !== DEPARTED_KEY).length;
  add('Privacy', 'Departed names rendered anywhere in the output', leaked, '0', leaked === 0 ? 'pass' : 'fail',
    'Replaced on the server before the payload is built; the server refuses to send any payload that contains one. This page holds no names of its own.');
  const lower = text.toLowerCase();
  const hits = FORBIDDEN.filter(t => lower.includes(t.toLowerCase()));
  add('Privacy', `Payload grep: ${FORBIDDEN.join(', ')}`, hits.length ? hits.join(', ') : 'none present', 'none present', hits.length ? 'fail' : 'pass',
    `Searched the raw response text (${fmtInt(text.length / 1024)} KB).`);
  const problems = schemaProblems(p);
  add('Privacy', 'Payload: any array of per-appointment or per-lead records', problems.length ? problems.slice(0, 4).join('; ') : 'none',
    'none — aggregates only', problems.length ? 'fail' : 'pass',
    `${Object.keys(ARRAYS).length} arrays checked: only known count fields, and no two rows share a date/setter key.`);
  const auth = await unauthorizedChecks();
  add('Privacy', 'Endpoint with no token / wrong token / empty token', auth.map(r => r.got).join(' · '), 'unauthorized ×3, no data',
    auth.every(r => r.ok) ? 'pass' : 'fail', 'Three live calls made just now from this page.');
  add('Privacy', 'Advisor Result values other than "Pending"', 'not checked', '0', 'na',
    'Advisor Result is outside the allowlist (trap 10), so the endpoint never reads it. Needs a manual look or an allowlist change.');

  // Definitions
  const oct = r => inMonth(r.appt_date, '2026-10');
  const octQs = sum(p.outcomes, 'qualified_show', oct);
  const octShowed = sum(p.outcomes, 'showed', oct);
  const octBooked = sum(p.booked, 'booked', r => inMonth(r.date_booked, '2026-10'));
  add('Definitions', 'October 2026 Qualified Shows, by Appointment Date, all-client', octQs, '185', octQs === 185 ? 'pass' : 'fail',
    `As of ${p.today_ct}. RetireWell + Funnel client, mixed.`);
  add('Definitions', 'October 2026 Showed, by Appointment Date, all-client', octShowed, '~209 (209 on 10/30; 211–212 by 11/02)',
    octShowed >= 209 && octShowed <= 212 ? 'pass' : 'fail', `As of ${p.today_ct}.`);
  add('Definitions', 'October 2026 Booked, by Date Booked', `${octBooked} (Showed: ${octShowed})`, 'report it — must differ from Showed',
    octBooked !== octShowed ? 'pass' : 'fail', 'Different date column, different population.');

  const nonPeople = nonPeopleInSetterTables(p);
  add('Definitions', 'Rows with Setter = All, a queue, or the agency login in any per-setter total', nonPeople.length ? nonPeople.slice(0, 4).join('; ') : '0', '0',
    nonPeople.length ? 'fail' : 'pass', `Queues seen, kept in their own arrays: ${queueLabels(p).join(', ') || 'none'}.`);
  const badGoals = p.goals.filter(g => !ix.isTeam(g.setter));
  add('Definitions', 'Goal rows belonging to a departed (or off-roster) setter', badGoals.length, '0', badGoals.length ? 'fail' : 'pass',
    `${h.goals.dropped_departed} departed and ${h.goals.dropped_unresolved.length} off-roster goal rows dropped on the server. Live with no goal: ${h.goals.live_without_goal.join(', ') || 'none'}.`);

  const S = sum(p.outcomes, 'showed'), NS = sum(p.outcomes, 'no_show'), R = sum(p.outcomes, 'rescheduled');
  const C = sum(p.outcomes, 'canceled'), O = sum(p.outcomes, 'other_status'), P = sum(p.pending, 'pending');
  const B = sum(p.booked, 'booked');
  const gap = B + h.unkeyed.date_booked - (S + NS + R + C + O + P + h.unkeyed.appt_date);
  add('Definitions', 'Booked − (Showed + No Show + Rescheduled + Canceled + Pending), all time', gap, '0', gap === 0 ? 'pass' : 'fail',
    `Booked ${fmtInt(B)} = Showed ${fmtInt(S)} + No Show ${fmtInt(NS)} + Rescheduled ${R} + Canceled ${fmtInt(C)} + Pending ${fmtInt(P)}` +
    (O ? ` + other status ${O}` : '') + (h.unkeyed.appt_date ? ` + no usable appointment date ${h.unkeyed.appt_date}` : '') +
    (h.unkeyed.date_booked ? `; ${h.unkeyed.date_booked} rows with no usable Date Booked` : '') + '. After de-duplicating on Appointment ID.');
  add('Definitions', 'Rescheduled count, all time', R, '0', R === 0 ? 'pass' : 'fail', R ? 'The status now occurs: the sheet changed.' : 'The status never occurs.');
  add('Definitions', 'Unparseable dates', h.unparsed_total, 'report the count and list them', 'report',
    h.unparsed_dates.map(d => `${d.tab}!${d.cell} "${d.value}"`).join(', ') || 'none');
  add('Definitions', 'Dates in an off-format shape (parsed, listed)', h.nonstandard_total, 'report', 'report',
    h.nonstandard_dates.map(d => `${d.tab}!${d.cell} "${d.value}" → ${d.parsed_as}`).join(', ') || 'none');
  add('Definitions', 'EOD leftover test row (row 2) filtered', h.eod_test_row.dropped ? 'dropped' : 'not found at row 2', 'dropped',
    h.eod_test_row.dropped ? 'pass' : 'fail', h.eod_test_row.dropped ? '' : 'The row 2 signature no longer matches; nothing was dropped.');
  add('Definitions', 'Status values in the tracker', h.status_inventory.map(s => `${s.status} ${fmtInt(s.n)}`).join(', '), 'Booked, Showed, No Show, Canceled',
    h.status_inventory.every(s => ['Booked', 'Showed', 'No Show', 'Canceled', '(blank)'].includes(s.status)) ? 'pass' : 'report');

  // Cross-checks
  const rc = h.router_recon;
  const recOk = rc.dates_compared > 0 && [rc.leads_equal, rc.touched_equal, rc.within_1h_equal, rc.booked_equal, rc.median_within_1].every(n => n === rc.dates_compared);
  add('Cross-checks', "Per-lead figures (Leads B–K + O) vs sheet C's own 'All' rows, date by date",
    `${rc.leads_equal}/${rc.dates_compared} leads · ${rc.touched_equal} touched · ${rc.within_1h_equal} within 1h · ${rc.booked_equal} booked · ${rc.median_within_1} medians ±1 min`,
    'all dates agree', recOk ? 'pass' : 'fail',
    rc.mismatches.length ? 'First mismatches: ' + rc.mismatches.map(m => `${m.date} ${m.field} ours ${m.ours} / sheet ${m.sheet}`).join(', ') : 'Confirms the median definition matches the sheet (touched leads only).');
  add('Cross-checks', 'Team totals: roster-joined vs raw scan, all time',
    ['dials', 'booked', 'showed', 'qualified_show'].map(k => `${k} ${fmtInt(h.roster_total[k])} / ${fmtInt(h.rawscan_total[k])}`).join(' · '), 'report', 'report',
    'Raw scan includes departed and flagged names; the difference is shown on Data Health.');
  add('Cross-checks', 'Duplicate Appointment IDs', `${h.dup_appt_ids.rows_dropped} rows dropped (${h.dup_appt_ids.ids} IDs)`, 'report', 'report',
    `${fmtInt(h.blank_appt_ids)} rows have no Appointment ID and can't be de-duplicated.`);
  add('Cross-checks', 'Advisor + Date + Time duplicates', 'not computed', 'flag count', 'na', h.dup_advisor_slot_reason);
  add('Cross-checks', 'Pay Eligible flag vs Qualified Show', `${h.pay_vs_qshow.pe_not_qs} flagged without a qualified show · ${h.pay_vs_qshow.qs_not_pe} qualified shows not flagged`,
    'report', 'report', "The sheet's flag wins; disagreements belong on Data Health.");
  add('Cross-checks', 'Column headers dropped by the allowlist', h.headers_dropped.length, '0', h.headers_dropped.length ? 'fail' : 'pass',
    h.headers_dropped.map(d => `${d.tab} ${d.col}`).join(', ') || 'Every column read has an allowed header.');
  add('Cross-checks', 'Today, per the server', `${p.today_ct} (snapshot ${p.as_of_ct})`, 'America/Chicago', 'report', 'Never the browser clock.');
  return rows;
}

function schemaProblems(p) {
  const out = [];
  for (const key of Object.keys(p)) {
    if (!ARRAYS[key] && !SCALARS.includes(key)) out.push(`unexpected top-level key "${key}"`);
  }
  for (const [key, [dims, fields]] of Object.entries(ARRAYS)) {
    const arr = p[key];
    if (!Array.isArray(arr)) { out.push(`${key} missing`); continue; }
    const seen = new Set();
    for (const r of arr) {
      const extra = Object.keys(r).filter(k => !dims.includes(k) && !fields.includes(k));
      if (extra.length) { out.push(`${key} carries ${extra.join(', ')}`); break; }
      const id = dims.map(d => r[d]).join('|');
      if (seen.has(id)) { out.push(`${key} repeats ${dims.join('+')}`); break; }
      seen.add(id);
      if (key !== 'roster' && fields.some(f => r[f] != null && typeof r[f] !== 'number' && f !== 'kind')) { out.push(`${key} has a non-numeric count`); break; }
    }
  }
  return out;
}

function queueLabels(p) {
  return [...new Set([...p.speed_daily_queues.map(r => r.queue), ...p.first_touch_queues.map(r => r.queue),
    ...p.speed_window.filter(r => r.kind === 'queue').map(r => r.who)])];
}

function nonPeopleInSetterTables(p) {
  const known = new Set(queueLabels(p).concat('All'));
  const looksLikeQueue = name => known.has(name) || /\(.*\)/.test(name) || /^all$/i.test(name);
  const out = [];
  for (const key of ['dials', 'booked', 'outcomes', 'pending', 'cohort', 'eod', 'goals', 'speed_daily', 'first_touch', 'roster']) {
    const bad = p[key].filter(r => r.setter !== DEPARTED_KEY && r.status !== 'alias' && looksLikeQueue(r.setter));
    if (bad.length) out.push(`${key}: ${[...new Set(bad.map(r => r.setter))].join(', ')}`);
  }
  const win = p.speed_window.filter(r => r.kind === 'setter' && looksLikeQueue(r.who));
  if (win.length) out.push(`speed_window: ${[...new Set(win.map(r => r.who))].join(', ')}`);
  return out;
}

async function unauthorizedChecks() {
  const bodies = [{}, { token: 'not-the-password-' + Math.random().toString(36).slice(2).padEnd(27, 'x') }, { token: '' }];
  return Promise.all(bodies.map(async body => {
    try {
      const { data } = await post(body);
      const ok = JSON.stringify(data) === '{"error":"unauthorized"}';
      return { ok, got: ok ? 'unauthorized' : 'DATA RETURNED' };
    } catch (err) {
      return { ok: false, got: err.code || 'error' };
    }
  }));
}

const STATUS_TEXT = { pass: 'Pass', fail: 'Fail', changed: 'Changed', report: 'Report', na: 'N/A' };

export function renderSelftest(rows, { onRerun }) {
  const counts = {};
  rows.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const copy = h('button', { class: 'btn', type: 'button', onclick: async () => {
    const tsv = [['Group', 'Check', 'Computed', 'Expected', 'Result', 'Note'], ...rows.map(r => [r.group, r.check, r.computed, r.expected, STATUS_TEXT[r.status], r.note])]
      .map(line => line.join('\t')).join('\n');
    try { await navigator.clipboard.writeText(tsv); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy failed'; }
    setTimeout(() => { copy.textContent = 'Copy results'; }, 1600);
  } }, 'Copy results');

  const body = [];
  let group = null;
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group;
      body.push(h('tr', { class: 'st-group' }, h('th', { colspan: 4, scope: 'colgroup' }, group)));
    }
    body.push(h('tr', { class: `st-row st-${r.status}` },
      h('td', { class: 'st-check' }, h('div', null, r.check), r.note ? h('div', { class: 'st-note' }, r.note) : null),
      h('td', { class: 'num st-computed' }, r.computed),
      h('td', { class: 'num st-expected' }, r.expected),
      h('td', { class: 'st-result' }, h('span', { class: `pill pill-${r.status}` }, STATUS_TEXT[r.status]))));
  }

  return h('section', { class: 'selftest', 'aria-labelledby': 'st-title' },
    h('div', { class: 'st-head' },
      h('div', null,
        h('h1', { id: 'st-title' }, 'Self-test'),
        h('p', { class: 'muted' }, `Live payload, computed in this browser just now. Golden figures measured ${GOLDEN_DATE}.`)),
      h('div', { class: 'st-summary' },
        ['pass', 'fail', 'changed', 'report', 'na'].filter(k => counts[k]).map(k => h('span', { class: `pill pill-${k}` }, `${counts[k]} ${STATUS_TEXT[k]}`)),
        h('button', { class: 'btn', type: 'button', onclick: onRerun }, 'Run again'),
        copy)),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'st-table' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Check'), h('th', { scope: 'col', class: 'num' }, 'Computed'),
          h('th', { scope: 'col', class: 'num' }, 'Expected'), h('th', { scope: 'col' }, 'Result'))),
        h('tbody', null, body))));
}
