// Runs apps-script/Code.gs locally against FAKE sheets (see fake-endpoint.mjs).
// Every name, ID and number is made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { TOKEN, S, CODE, inCtx, post, sum, makeContext, fakeWorld } from './fake-endpoint.mjs';

const root = new URL('../', import.meta.url);

// ---------------------------------------------------------------- tests

test('doGet is a data-free health check', () => {
  const { ctx } = makeContext({ spreadsheets: fakeWorld() });
  const res = JSON.parse(ctx.doGet({}).getContent());
  assert.equal(res.ok, true);
  assert.equal(res.configured, true);
  assert.deepEqual(Object.keys(res).sort(), ['configured', 'ok', 'service', 'version']);
  const bare = makeContext({ spreadsheets: fakeWorld(), props: {} });
  assert.equal(JSON.parse(bare.ctx.doGet({}).getContent()).configured, false);
});

test('selfCheck runs from the editor and logs counts, not data', () => {
  const { ctx } = makeContext({ spreadsheets: fakeWorld() });
  const logged = [];
  ctx.console = { log: s => logged.push(s), warn() {} };
  ctx.selfCheck();
  assert.equal(logged.length, 1);
  assert.ok(!logged[0].includes(S));
  assert.equal(JSON.parse(logged[0]).payload_guard, 'ok');
});

test('a project pasted without Config.gs answers in JSON, never an HTML error page', () => {
  const { ctx } = makeContext({ spreadsheets: fakeWorld() });
  vm.runInContext('CONFIG = undefined;', ctx);
  const res = post(ctx, { token: TOKEN });
  assert.equal(res.error, 'internal');
  assert.match(res.detail, /CONFIG/);
});

test('no token, wrong token, empty token: unauthorized, no data, nothing opened', () => {
  const world = fakeWorld();
  const { ctx, stats } = makeContext({ spreadsheets: world });
  for (const body of [{}, { token: 'nope' }, { token: '' }, 'not json', { token: TOKEN + 'x' }]) {
    assert.deepEqual(post(ctx, body), { error: 'unauthorized' });
  }
  assert.equal(stats.opens, 0);
});

test('an unset or short DASH_TOKEN never authorizes, not even an empty token', () => {
  for (const props of [{}, { DASH_TOKEN: '' }, { DASH_TOKEN: 'short' }]) {
    const { ctx } = makeContext({ spreadsheets: fakeWorld(), props });
    assert.deepEqual(post(ctx, { token: '' }), { error: 'unauthorized' });
    assert.deepEqual(post(ctx, { token: props.DASH_TOKEN || '' }), { error: 'unauthorized' });
  }
});

test('authorized payload: aggregates only, and nothing forbidden is read or shipped', () => {
  const world = fakeWorld();
  const { ctx } = makeContext({ spreadsheets: world });
  const raw = ctx.doPost({ postData: { contents: JSON.stringify({ token: ` ${TOKEN}\n` }) } }).getContent();
  const p = JSON.parse(raw);
  assert.equal(p.error, undefined, raw.slice(0, 300));

  // Shipped: no planted value, no forbidden word, no appointment ID, no departed name.
  assert.ok(!raw.includes(S), 'a never-read column leaked into the payload');
  assert.deepEqual(inCtx(ctx, `guardPayload_(${JSON.stringify(raw)}, CONFIG)`), []);
  for (const name of ['Xena', 'Formerly', 'Yuri', 'Pastdue']) assert.ok(!raw.includes(name), `departed name leaked: ${name}`);
  assert.ok(!/APT-/.test(raw));

  // Read: only the allowed columns and rows, values via getDisplayValues, A1 of Leads as a note only.
  const allowedCols = {
    '_Dials': [1, 2, 3, 5], '_EOD': [3, 4, 5, 6, 7, 8, 9, 10, 12, 14], '_Appointments': [1],
    'Appointment Tracker': [1, 2, 5, 7, 8, 10, 13, 15], 'Goals & Payroll': [1, 2, 3, 5],
    'Daily': [1, 2, 3, 4, 5, 6, 7, 8, 9], 'First touch by': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    'Leads': [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 15]
  };
  for (const ss of Object.values(world)) {
    for (const sheet of ss.sheets) {
      for (const read of sheet.log) {
        const allowed = allowedCols[sheet.name];
        assert.ok(allowed, `read a tab that is never to be read: ${sheet.name}`);
        if (read.note) { assert.ok(sheet.name in { Leads: 1, Daily: 1, 'First touch by': 1 } && read.row === 1 && read.col === 1); continue; }
        for (let c = read.col; c < read.col + read.nc; c++) assert.ok(allowed.includes(c), `${sheet.name} column ${c} was read`);
        if (sheet.name === 'Goals & Payroll') assert.ok(read.row + read.nr - 1 <= 19, 'Goals & Payroll read past row 19');
      }
    }
  }
  // Every array is a count keyed by date and/or setter: no row-level record shape.
  for (const k of ['dials', 'booked', 'outcomes', 'pending', 'cohort', 'eod', 'speed_daily', 'first_touch', 'speed_buckets', 'speed_window', 'unworked_age']) {
    for (const r of p[k]) for (const v of Object.values(r)) assert.ok(v == null || typeof v === 'number' || typeof v === 'string', k);
  }
});

test('today is the server CT date; DST and year-less clocks parse right', () => {
  const { ctx } = makeContext({ spreadsheets: fakeWorld() });
  const p = post(ctx, { token: TOKEN });
  assert.equal(p.today_ct, '2026-11-02');
  assert.equal(p.as_of_ct, '2026-11-02T17:50:00-06:00');
  const run = s => inCtx(ctx, s);
  assert.equal(run(`ctIso_(Date.UTC(2026, 9, 15, 4, 30))`), '2026-10-14T23:30:00-05:00'); // CDT, previous CT day
  assert.equal(run(`parseClock_('Nov 2, 4:43 PM CST', 2026, 11)`), Date.UTC(2026, 10, 2, 22, 43));
  assert.equal(run(`parseClock_('Oct 31, 10:00 AM CDT', 2026, 10)`), Date.UTC(2026, 9, 31, 15, 0));
  assert.equal(run(`parseClock_('Dec 31, 11:00 PM CST', 2027, 1)`), Date.UTC(2027, 0, 1, 5, 0));
  assert.equal(run(`parseStamp_('Updated Nov 2, 5:47 PM CT - refreshes every 5 min', '2026-11-02')`), Date.UTC(2026, 10, 2, 23, 47));
  assert.equal(run(`parseStamp_('Updated Jul 2, 5:47 PM CT - refreshes every 5 min', '2026-07-02')`), Date.UTC(2026, 6, 2, 22, 47));
  assert.deepEqual(run(`parseDay_('11/1/2026 12:00:00')`), { day: '2026-11-01', shape: 'mdy_time' });
  assert.deepEqual(run(`parseDay_('2026-11-02 (Mon)')`), { day: '2026-11-02', shape: 'iso_weekday' });
  assert.deepEqual(run(`parseDay_('Nov 2, 2026')`), { day: '2026-11-02', shape: 'mon_d_y' });
  assert.equal(run(`parseDay_('Feb 30, 2026')`), null);
});

test('appointments: booked by Date Booked, outcomes by Appointment Date, and they reconcile', () => {
  const { ctx } = makeContext({ spreadsheets: fakeWorld() });
  const p = post(ctx, { token: TOKEN });
  const h = p.health;
  assert.equal(h.b_appt_rows, 14);
  assert.equal(h.b_appt_rows_deduped, 13);
  assert.deepEqual(h.dup_appt_ids, { rows_dropped: 1, ids: 1 });
  assert.equal(h.blank_appt_ids, 1);
  assert.equal(h.distinct_names.appts, 7);
  assert.equal(h.a_appt_rows, 3);

  const resolved = ['showed', 'no_show', 'rescheduled', 'canceled', 'other_status'].reduce((t, f) => t + sum(p.outcomes, f), 0);
  assert.equal(sum(p.booked, 'booked') + h.unkeyed.date_booked, 13);
  assert.equal(resolved + sum(p.pending, 'pending') + h.unkeyed.appt_date, 13);
  assert.equal(sum(p.outcomes, 'showed'), 3);
  assert.equal(sum(p.outcomes, 'no_show'), 1);
  assert.equal(sum(p.outcomes, 'canceled'), 2);      // includes a future-dated cancel and the "Cancelled" spelling
  assert.equal(sum(p.outcomes, 'rescheduled'), 1);
  assert.equal(sum(p.outcomes, 'other_status'), 1);
  assert.equal(sum(p.pending, 'pending'), 4);
  assert.equal(h.unkeyed.appt_date, 1);
  assert.equal(sum(p.outcomes, 'qualified_show'), 3);
  assert.equal(sum(p.outcomes, 'pay_eligible'), 3);
  assert.deepEqual(h.pay_vs_qshow, { pe_not_qs: 1, qs_not_pe: 1 });
  assert.equal(h.future_with_outcome, 1);
  assert.deepEqual(p.pending.find(r => r.appt_date === '2026-11-02'), { appt_date: '2026-11-02', setter: 'Ava Testwell', pending: 1 });

  // Cohort rows add up to booked rows, bucket by bucket.
  for (const c of p.cohort) {
    assert.equal(c.booked, c.showed + c.no_show + c.rescheduled + c.canceled + c.other_status + c.pending);
  }
  assert.equal(sum(p.cohort, 'booked'), sum(p.booked, 'booked'));

  assert.equal(h.unparsed_total, 1);
  assert.equal(h.unparsed_dates[0].cell, 'E15');
  assert.equal(h.unparsed_dates[0].value, '(text, 3 chars)');
  assert.deepEqual(h.nonstandard_dates.map(d => d.cell).sort(), ['A16', 'E12']);
  assert.deepEqual(h.status_inventory.find(s => s.status === 'Left voicemail'), { n: 1, status: 'Left voicemail' });

  assert.deepEqual(h.roster_total, { dials: 432, booked: 10, showed: 2, qualified_show: 2, pending: 4 });
  assert.deepEqual(h.rawscan_total, { dials: 660, booked: 13, showed: 3, qualified_show: 3, pending: 4 });
});

test('roster: departed collapse, live with no data, aliases, unresolved names', () => {
  const { ctx } = makeContext({ spreadsheets: fakeWorld() });
  const p = post(ctx, { token: TOKEN });
  const by = Object.fromEntries(p.roster.map(r => [r.setter, r]));
  assert.equal(by.__departed__.status, 'departed');
  assert.equal(by.__departed__.departed_n, 2);
  assert.equal(by['Dot Nodata'].status, 'onboarding');
  assert.equal(by['Dot Nodata'].on_dials_roster, false);
  assert.equal(by['Dot Nodata'].in_appt_data, false);
  assert.equal(by['Quinn Unknown'].status, 'unresolved');
  assert.equal(by['Quinn Unknown'].flag_reason, 'Fake unresolved name for tests.');
  assert.equal(by['Eli Rotary'].on_dials_roster, true);
  assert.deepEqual(by['Ben Sampleton II'], { setter: 'Ben Sampleton II', status: 'alias', alias_of: 'Ben Sampleton', seen_in: ['appts', 'router'] });
  assert.ok(!p.dials.some(r => r.setter === 'Eli R'));
  assert.equal(p.health.distinct_names.dials, 6);
  assert.equal(p.health.rawscan_total.dials - p.health.roster_total.dials, sum(p.dials.filter(r => ['__departed__', 'Quinn Unknown'].includes(r.setter)), 'dials'));
});

test('EOD: test row dropped, latest submission stands', () => {
  const { ctx } = makeContext({ spreadsheets: fakeWorld() });
  const p = post(ctx, { token: TOKEN });
  assert.deepEqual(p.health.eod_test_row, { expected_row: 2, dropped: true });
  assert.ok(!p.eod.some(r => r.report_date === '2026-07-23'));
  const ava = p.eod.find(r => r.setter === 'Ava Testwell' && r.report_date === '2026-11-01');
  assert.equal(ava.contacts, 12);
  assert.equal(ava.submitted, 2);
  assert.equal(p.health.eod_multi_submissions, 1);
});

test('goals: live roster only, blank or zero is "no goal set", never 0', () => {
  const { ctx } = makeContext({ spreadsheets: fakeWorld() });
  const p = post(ctx, { token: TOKEN });
  assert.deepEqual(p.goals, [
    { setter: 'Ava Testwell', monthly_booked_goal: 100, monthly_showed_goal: 60 },
    { setter: 'Ben Sampleton', monthly_booked_goal: 80, monthly_showed_goal: null },
    { setter: 'Cal Dummond', monthly_booked_goal: null, monthly_showed_goal: null },
    { setter: 'Eli Rotary', monthly_booked_goal: 80, monthly_showed_goal: 60 }
  ]);
  assert.equal(p.health.goals.dropped_departed, 1);
  assert.deepEqual(p.health.goals.dropped_unresolved, ['Quinn Unknown']);
  assert.deepEqual(p.health.goals.live_without_goal, ['Dot Nodata']);
});

test('speed to lead: queues and roll-ups kept out of per-setter arrays; buckets, medians, ages', () => {
  const { ctx } = makeContext({ spreadsheets: fakeWorld() });
  const p = post(ctx, { token: TOKEN });
  const nonPeople = ['All', 'House (unassigned)', 'Ava (agency login)'];
  for (const k of ['speed_daily', 'first_touch']) assert.ok(!p[k].some(r => nonPeople.includes(r.setter)), k);
  assert.ok(!p.speed_window.some(r => r.kind === 'setter' && nonPeople.includes(r.who)));
  assert.deepEqual(p.speed_daily_queues.map(r => r.queue), ['House (unassigned)']);
  assert.deepEqual(p.first_touch_queues.map(r => r.queue), ['Ava (agency login)']);
  assert.deepEqual(p.health.all_rows_filtered, { daily: 4, first_touch: 3 });
  assert.ok(p.speed_daily.some(r => r.setter === 'Ben Sampleton'));

  const b = Object.fromEntries(['le5m', 'le15m', 'le1h', 'le4h', 'le24h', 'gt24h', 'never', 'touched_no_time']
    .map(k => [k, sum(p.speed_buckets.filter(r => r.bucket === k), 'leads')]));
  assert.deepEqual(b, { le5m: 1, le15m: 1, le1h: 2, le4h: 0, le24h: 1, gt24h: 1, never: 3, touched_no_time: 1 });
  assert.equal(p.speed_window_median_min, 47);
  const ages = Object.fromEntries(p.unworked_age.map(r => [r.age, r.leads]));
  assert.deepEqual(ages, { '1to4h': 1, '1to3d': 1, gt3d: 1 });

  const ava = p.speed_window.find(r => r.who === 'Ava Testwell' && r.by === 'assigned' && r.routed_by === '*');
  assert.deepEqual(ava, { who: 'Ava Testwell', kind: 'setter', by: 'assigned', routed_by: '*', leads: 3, touched: 3, within_1h: 3, booked: 1, median_min: 34 });
  assert.ok(p.speed_window.some(r => r.who === 'Ben Sampleton' && r.by === 'first_touch'));

  const recon = p.health.router_recon;
  assert.equal(recon.dates_compared, 4);
  assert.deepEqual([recon.leads_equal, recon.touched_equal, recon.within_1h_equal, recon.booked_equal, recon.median_within_1], [4, 4, 4, 4, 4]);
  assert.deepEqual(recon.mismatches, []);
  assert.equal(p.coverage.leads_from, '2026-10-30');
  assert.equal(p.sources.router.stamp, 'Updated Nov 2, 5:47 PM CT - refreshes every 5 min');
  assert.equal(p.sources.router.stamp_ct, '2026-11-02T17:47:00-06:00');
});

test('one lost spreadsheet greys out its own data only', () => {
  const world = fakeWorld();
  delete world['FAKE-TRACKER-SPREADSHEET-ID-00000000000000'];
  const { ctx } = makeContext({ spreadsheets: world });
  const p = post(ctx, { token: TOKEN });
  assert.equal(p.sources.tracker.ok, false);
  assert.ok(!p.sources.tracker.error.includes('FAKE-TRACKER'), 'error text must not echo a spreadsheet ID');
  assert.equal(p.booked.length, 0);
  assert.ok(p.dials.length > 0 && p.speed_daily.length > 0);
});

test('a column inserted inside a read window fails that source loudly', () => {
  const world = fakeWorld();
  const leads = world['FAKE-ROUTER-SPREADSHEET-ID-000000000000000'].getSheetByName('Leads');
  leads.grid = leads.grid.map((r, i) => [...r.slice(0, 3), i ? '555-0100' : 'Phone', ...r.slice(3)]);
  const { ctx } = makeContext({ spreadsheets: world });
  const p = post(ctx, { token: TOKEN });
  assert.equal(p.sources.router.ok, false);
  assert.match(p.sources.router.error, /header drift in Leads/);
  assert.ok(!JSON.stringify(p).includes('555-0100'));
});

test('cache: one shared gzipped entry, second call opens nothing', () => {
  const { ctx, stats } = makeContext({ spreadsheets: fakeWorld() });
  const first = post(ctx, { token: TOKEN });
  const opens = stats.opens;
  const second = post(ctx, { token: TOKEN });
  assert.equal(stats.opens, opens);
  assert.deepEqual(second, first);
});

test('payload guard fails closed', () => {
  const { ctx } = makeContext({ spreadsheets: fakeWorld() });
  const guard = s => inCtx(ctx, `guardPayload_(${JSON.stringify(s)}, CONFIG)`);
  assert.deepEqual(guard('{"a":"$5"}'), ['$']);
  assert.deepEqual(guard('{"a":"APT-F001"}'), ['appointment id']);
  assert.equal(guard('{"a":"X. Formerly"}').length, 1);
  assert.deepEqual(guard('{"a":"Prospect Notes"}'), ['prospect', 'notes']);
});

test('realistic volume fits the chunked cache', () => {
  // Fake volume at roughly the live sheets' size: 120 days x 10 setters of dials,
  // 1,300 appointments, 300 EODs, 2,400 leads.
  const world = fakeWorld();
  const kpi = world['FAKE-KPI-SPREADSHEET-ID-0000000000000000000'];
  const people = ['Ava Testwell', 'Ben Sampleton', 'Cal Dummond', 'Eli Rotary', 'Quinn Unknown', 'Xena Formerly', 'F1 Fake', 'F2 Fake', 'F3 Fake', 'F4 Fake'];
  const day = i => new Date(Date.UTC(2026, 6, 5) + i * 864e5).toISOString().slice(0, 10);
  const mon = i => { const d = new Date(Date.UTC(2026, 6, 5) + i * 864e5); return d.toUTCString().slice(8, 11) + ' ' + d.getUTCDate() + ', 2026'; };
  const dials = kpi.getSheetByName('_Dials');
  for (let i = 0; i < 120; i++) for (const p of people) dials.grid.push([day(i), p, String(i % 90), '0', String(i * 31), '0m']);
  const eod = kpi.getSheetByName('_EOD');
  for (let i = 0; i < 300; i++) eod.grid.push(['', '', `${1 + (i % 12)}/${1 + (i % 28)}/2026 12:00:00`, people[i % 10], '9', '1', '2', '2', '1', '0', '', '0', '', '0']);
  const tr = world['FAKE-TRACKER-SPREADSHEET-ID-00000000000000'].getSheetByName('Appointment Tracker');
  for (let i = 0; i < 1300; i++) tr.grid.push([mon(i % 120), people[i % 10], '', '', mon((i % 120) + 2), '', 'ET', ['Showed', 'No Show', 'Canceled', 'Booked'][i % 4], '', i % 3 ? 'Yes' : '', '', '', i % 5 ? '' : 'Yes', '', `APT-V${i}`]);
  const leads = world['FAKE-ROUTER-SPREADSHEET-ID-000000000000000'].getSheetByName('Leads');
  for (let i = 0; i < 2400; i++) leads.grid.push(['', 'Oct 5, 9:00 AM CDT', day(90 + (i % 30)) + ' (Mon)', people[i % 10], 'rotation', '', i % 4 ? 'Yes' : 'No', '', '', people[(i + 1) % 10], i % 4 ? String(i % 2000) : '', '', '', '', i % 9 ? 'No' : 'Yes']);
  const { ctx, stats } = makeContext({ spreadsheets: world });
  const raw = ctx.doPost({ postData: { contents: JSON.stringify({ token: TOKEN }) } }).getContent();
  assert.equal(JSON.parse(raw).error, undefined);
  assert.equal(stats.cachePuts, 1);
  console.log(`  realistic payload: ${(raw.length / 1024).toFixed(0)} KB JSON, ${stats.chunks} cache chunk(s)`);
});

test('Code.gs never writes, never uses getValues or getDataRange, and holds no names or IDs', () => {
  const code = CODE.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of ['setValue', 'setValues', 'appendRow', 'insertRow', 'deleteRow', 'insertSheet', 'deleteSheet', 'clear(',
    'setNote', 'setFormula', 'copyTo', 'moveTo', '.sort(function', 'getValues(', 'getDataRange', 'getSheets(']) {
    if (m === '.sort(function') continue; // Array.prototype.sort is used on plain arrays
    assert.ok(!code.includes(m), `Code.gs contains ${m}`);
  }
  assert.ok(!/[A-Za-z0-9_-]{40,}/.test(code.replace(/'[^']*'/g, "''")), 'looks like an ID in code');
  const real = fs.existsSync(new URL('apps-script/Config.gs', root)) ? fs.readFileSync(new URL('apps-script/Config.gs', root), 'utf8') : '';
  const realNames = [...real.matchAll(/'([A-Z][a-z]+(?: [A-Z][a-zA-Z]+)*)'/g)].map(m => m[1]).filter(n => n.length > 3);
  for (const n of realNames) assert.ok(!CODE.includes(n), `Code.gs mentions a configured name or value: ${n.slice(0, 2)}...`);
});
