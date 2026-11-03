/**
 * RetireWell Setter Center: read-only aggregate endpoint (Google Apps Script).
 *
 * Paste this file AND Config.gs into one standalone Apps Script project
 * (script.google.com > New project, not bound to any sheet).
 *
 * Deploy > New deployment > Web app
 *   Execute as:     Me
 *   Who has access: Anyone            (NOT "Anyone with Google Account")
 *
 * "Anyone" makes the /exec URL an unauthenticated public endpoint. The DASH_TOKEN
 * check in doPost is the only thing between that URL and the data, which is why
 * nothing row-level ever leaves this script: every array below is a count.
 *
 * Code edits do not reach /exec until Deploy > Manage deployments > edit >
 * Version: New version.
 *
 * This file holds no names, spreadsheet IDs or secrets and is safe to commit.
 * Config.gs holds the IDs and the roster and must never be committed.
 * Nothing in this file writes to a sheet.
 */

const VERSION = '2026-11-02.1';
const CACHE_PREFIX = 'payload:' + VERSION + ':';
const CACHE_TTL_S = 180;
const CACHE_CHUNK_CHARS = 90000; // CacheService rejects a value over 100KB
const DEPARTED_KEY = '__departed__';

// Header allowlist, applied by NAME after every read. This is the boundary, not the
// ranges and not the UI. Anything that survives this map is readable by anyone
// holding the token. Header strings are byte-exact against the live sheets.
const ALLOW = {
  '_Dials':             ['Date', 'Setter', 'Dials', 'Talk Seconds'],
  '_EOD':               ['Report Date', 'Setter', 'Contacts', 'Not Qualified', 'Reported Booked',
                         'Appointments Added', 'Status Updates', 'Qualified No Book',
                         'Booking Difference', 'Closed Deals'],
  // Row count only, for the A-vs-B truncation check on Data Health. Nothing else
  // from this tab is read.
  '_Appointments':      ['Date Booked'],
  'Appointment Tracker': ['Date Booked', 'Setter', 'Advisor', 'Appointment Date', 'Time Zone',
                         'Status', 'Qualified?', 'Pay Eligible?', 'Appointment ID'],
  'Goals & Payroll':    ['Setter', 'Monthly Booked Goal', 'Monthly Showed Goal', 'Active?'],
  'Daily':              ['Date', 'Setter', 'Leads', 'Touched', 'Untouched', 'Touched %',
                         'Touched within 1h', 'Median minutes to touch', 'Booked'],
  'First touch by':     ['Date', 'First touch by', 'First touches', 'Own leads', 'House leads',
                         "Other setters' leads", 'By call', 'By text', 'Within 1h',
                         'Median minutes to touch', 'Booked'],
  'Leads':              ['Came in', 'Date', 'Setter', 'Routed by', 'Routed at', 'Touched', 'First touch',
                         'First touch type', 'First touch by', 'Minutes to first touch', 'Booked']
                         // = columns B-K + O exactly. Used only to compute speed aggregates;
                         // no Leads row ever enters the payload.
};

// Values that sit in a person column but are not people (trap 4). 'All' is the
// sheet's own roll-up row; CONFIG.QUEUES are queues, reported under their own text.
const ROLLUP = 'All';

// If any of these appear anywhere in the serialized payload, no data is returned.
const FORBIDDEN_TERMS = ['prospect', 'notes', 'crm', 'base pay', 'amount due', 'pay rule', 'payroll', '$'];

// A tab name that would itself trip the guard is shipped under a neutral label.
const SHIPPED_TAB_LABEL = { 'Goals & Payroll': 'Goals (B)' };

const SPEED_BUCKETS =[[5, 'le5m'], [15, 'le15m'], [60, 'le1h'], [240, 'le4h'], [1440, 'le24h'], [Infinity, 'gt24h']];
const AGE_BUCKETS = [[60, 'lt1h'], [240, '1to4h'], [1440, '4to24h'], [4320, '1to3d'], [Infinity, 'gt3d']];

const EOD_FIELDS = [
  ['Contacts', 'contacts'], ['Not Qualified', 'not_qualified'], ['Reported Booked', 'reported_booked'],
  ['Appointments Added', 'appointments_added'], ['Status Updates', 'status_updates'],
  ['Qualified No Book', 'qualified_no_book'], ['Booking Difference', 'booking_difference'],
  ['Closed Deals', 'closed_deals']
];
const DAILY_FIELDS = [
  ['Leads', 'leads'], ['Touched', 'touched'], ['Untouched', 'untouched'],
  ['Touched within 1h', 'within_1h'], ['Booked', 'booked']
];
const FIRST_TOUCH_FIELDS = [
  ['First touches', 'first_touches'], ['Own leads', 'own'], ['House leads', 'house'],
  ["Other setters' leads", 'other'], ['By call', 'by_call'], ['By text', 'by_text'],
  ['Within 1h', 'within_1h'], ['Booked', 'booked']
];


// ---------------------------------------------------------------- handlers

/**
 * Health check for the browser address bar. No token, no data. `configured` is false
 * until Config.gs is pasted in and DASH_TOKEN is set in Script properties.
 */
function doGet(e) {
  try {
    const token = String(PropertiesService.getScriptProperties().getProperty('DASH_TOKEN') || '').trim();
    const configured = typeof CONFIG !== 'undefined' && !!CONFIG.IDS && token.length >= 32;
    return json_({ ok: true, service: 'rw-setter-center', version: VERSION, configured: configured });
  } catch (err) {
    return json_({ error: 'internal' });
  }
}

/**
 * The real call. The page POSTs text/plain (CORS-safelisted, so no preflight) with a
 * JSON body: {"token": "..."}.
 */
function doPost(e) {
  try {
    const body = parseBody_(e);
    if (!authorized_(body.token)) return json_({ error: 'unauthorized' });
    return ContentService.createTextOutput(payloadJson_()).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (msg.indexOf('payload guard') === 0) return json_({ error: 'payload_guard', detail: msg });
    return json_({ error: 'internal', detail: scrub_(msg) });
  }
}

/**
 * Run from the editor (select selfCheck, press Run) to test the sheet reads before
 * deploying. Logs counts and source status only, to your own execution log.
 */
function selfCheck() {
  const p = buildPayload_();
  const hits = guardPayload_(JSON.stringify(p), CONFIG);
  console.log(JSON.stringify({
    sources: p.sources, today_ct: p.today_ct, last_row: p.health.last_row, data_rows: p.health.data_rows,
    a_vs_b_appt_rows: [p.health.a_appt_rows, p.health.b_appt_rows], distinct_names: p.health.distinct_names,
    payload_kb: Math.round(JSON.stringify(p).length / 1024), payload_guard: hits.length ? hits : 'ok'
  }, null, 1));
}

function parseBody_(e) {
  try {
    const parsed = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function authorized_(token) {
  const expected = String(PropertiesService.getScriptProperties().getProperty('DASH_TOKEN') || '').trim();
  const given = typeof token === 'string' ? token.trim() : '';
  // An unset or short property must never authorize anything, including an empty token.
  if (expected.length < 32 || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Error text may echo a spreadsheet ID; never send one back. */
function scrub_(msg) {
  let out = msg;
  const ids = (typeof CONFIG !== 'undefined' && CONFIG.IDS) || {};
  Object.keys(ids).forEach(function (k) { out = out.split(ids[k]).join('[id]'); });
  return out.slice(0, 200);
}


// ---------------------------------------------------------------- cache

/** One shared, gzipped, chunked cache entry for every viewer. */
function payloadJson_() {
  const hit = cacheGet_();
  if (hit) return hit;
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(20000);
  try {
    if (locked) {
      const again = cacheGet_();
      if (again) return again;
    }
    const json = JSON.stringify(buildPayload_());
    const hits = guardPayload_(json, CONFIG);
    if (hits.length) throw new Error('payload guard tripped: ' + hits.join(', '));
    cachePut_(json);
    return json;
  } finally {
    if (locked) lock.releaseLock();
  }
}

function cacheGet_() {
  try {
    const cache = CacheService.getScriptCache();
    const n = Number(cache.get(CACHE_PREFIX + 'n'));
    if (!n) return null;
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(CACHE_PREFIX + i);
    const parts = cache.getAll(keys);
    let b64 = '';
    for (const k of keys) {
      if (!parts[k]) return null;
      b64 += parts[k];
    }
    return Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(b64), 'application/x-gzip')).getDataAsString();
  } catch (err) {
    return null;
  }
}

function cachePut_(json) {
  try {
    const b64 = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(json, 'application/json')).getBytes());
    const values = {};
    let n = 0;
    for (let i = 0; i < b64.length; i += CACHE_CHUNK_CHARS) values[CACHE_PREFIX + (n++)] = b64.slice(i, i + CACHE_CHUNK_CHARS);
    values[CACHE_PREFIX + 'n'] = String(n);
    CacheService.getScriptCache().putAll(values, CACHE_TTL_S);
  } catch (err) {
    // A failed put degrades to a slow response, never to an error.
    console.warn('cache put failed: ' + err);
  }
}

/**
 * Returns the reasons (generic labels, never the matched text) this payload must not
 * leave the server. Empty array = safe.
 */
function guardPayload_(json, cfg) {
  const lower = json.toLowerCase();
  const hits = FORBIDDEN_TERMS.filter(function (t) { return lower.indexOf(t) >= 0; });
  if (/APT-[A-Z0-9]/i.test(json)) hits.push('appointment id');
  for (const full of cfg.DEPARTED) {
    const last = full.trim().split(/\s+/).pop();
    if (lower.indexOf(full.toLowerCase()) >= 0 || new RegExp('\\b' + escapeRe_(last) + '\\b', 'i').test(json)) {
      hits.push('departed setter name (likely a spelling variant: add an alias in Config.gs)');
      break;
    }
  }
  return hits;
}


// ---------------------------------------------------------------- reading

const READERS = { kpi: readKpi_, tracker: readTracker_, router: readRouter_ };

/** Opens each spreadsheet separately so one lost share greys out its tabs, not the dashboard. */
function buildPayload_() {
  if (typeof CONFIG === 'undefined' || !CONFIG || !CONFIG.IDS) throw new Error('CONFIG not found: add Config.gs to the Apps Script project');
  const sources = {};
  const raw = {};
  for (const key of ['kpi', 'tracker', 'router']) {
    try {
      raw[key] = READERS[key](SpreadsheetApp.openById(CONFIG.IDS[key]));
      sources[key] = { ok: true, error: null, stamp: null };
    } catch (err) {
      raw[key] = null;
      sources[key] = { ok: false, error: scrub_(String((err && err.message) || err)), stamp: null };
    }
  }
  return aggregate_(raw, CONFIG, Date.now(), sources);
}

function readKpi_(ss) {
  return {
    // A-C and E. D (Answered) and F (Talk Time) are never read.
    dials: readTab_(ss, '_Dials', 1, [[1, 3], [5, 1]], ['Date', 'Setter', 'Dials', 'Talk Seconds']),
    // C-J, L, N. K (Notes) is never read.
    eod: readTab_(ss, '_EOD', 1, [[3, 8], [12, 1], [14, 1]], ALLOW['_EOD']),
    a_appts: readTab_(ss, '_Appointments', 1, [[1, 1]], ['Date Booked'])
  };
}

function readTracker_(ss) {
  return {
    // A-B, E, G-H, J, M, O. Headers on row 4, data from row 5. Prospect, Time, Advisor
    // Result, the asset columns, Notes and Outcome Notes are never read. Advisor is in
    // ALLOW but only needed for the Advisor+Date+Time duplicate flag, which waits on
    // reading Time, so it is not read either.
    appts: readTab_(ss, 'Appointment Tracker', 4, [[1, 2], [5, 1], [7, 2], [10, 1], [13, 1], [15, 1]],
      ['Date Booked', 'Setter', 'Appointment Date', 'Time Zone', 'Status', 'Qualified?', 'Pay Eligible?', 'Appointment ID']),
    // A4:C19 and E4:E19 only. Column D (Base Pay), F, and rows 29-36 (Payroll Due) are
    // never read; never getDataRange() this tab.
    goals: readTab_(ss, 'Goals & Payroll', 4, [[1, 3], [5, 1]], ALLOW['Goals & Payroll'], 19)
  };
}

function readRouter_(ss) {
  const out = {
    daily: readTab_(ss, 'Daily', 1, [[1, 9]], ALLOW['Daily']),
    first_touch: readTab_(ss, 'First touch by', 1, [[1, 11]], ALLOW['First touch by']),
    // B-K and O only. A (lead name) and R (CRM link) are never read.
    leads: readTab_(ss, 'Leads', 1, [[2, 10], [15, 1]],
      ['Came in', 'Date', 'Setter', 'Routed by', 'Touched', 'First touch by', 'Minutes to first touch', 'Booked']),
    stamps: {}
  };
  for (const tab of ['Leads', 'Daily', 'First touch by']) {
    // The A1 cell NOTE is refresh metadata. A1's value is never read on Leads.
    out.stamps[tab] = ss.getSheetByName(tab).getRange('A1').getNote();
  }
  return out;
}

/**
 * Reads explicit column blocks [[startCol, width], ...] with getDisplayValues (never
 * getValues: Date objects serialize as UTC and shift CT dates across midnight), then
 * keeps only ALLOWed headers. Throws if an expected header is gone, which is what a
 * column inserted inside a read window looks like.
 */
function readTab_(ss, tab, headerRow, blocks, expect, lastRowCap) {
  const label = SHIPPED_TAB_LABEL[tab] || tab;
  const sheet = ss.getSheetByName(tab);
  if (!sheet) throw new Error('tab missing: ' + label);
  const allow = ALLOW[tab];
  let last = sheet.getLastRow();
  if (lastRowCap) last = Math.min(last, lastRowCap);
  const n = Math.max(0, last - headerRow);
  const fields = [];
  const dropped = [];
  for (const block of blocks) {
    const start = block[0];
    const width = block[1];
    const head = sheet.getRange(headerRow, start, 1, width).getDisplayValues()[0];
    const body = n ? sheet.getRange(headerRow + 1, start, n, width).getDisplayValues() : [];
    head.forEach(function (h, j) {
      const name = String(h).trim();
      const col = colLetter_(start + j);
      if (allow.indexOf(name) < 0) {
        dropped.push({ tab: label, col: col }); // the column letter only, never the header text
        return;
      }
      fields.push({ name: name, col: col, values: body.map(function (r) { return r[j]; }) });
    });
  }
  const missing = expect.filter(function (e) { return !fields.some(function (f) { return f.name === e; }); });
  if (missing.length) throw new Error('header drift in ' + label + ': "' + missing.join('", "') + '" not found where expected');

  const rows = [];
  let lastPopulated = 0;
  for (let i = 0; i < n; i++) {
    const row = { _row: headerRow + 1 + i };
    let any = false;
    for (const f of fields) {
      const v = String(f.values[i] == null ? '' : f.values[i]).trim();
      row[f.name] = v;
      if (v) any = true;
    }
    if (any) {
      rows.push(row);
      lastPopulated = row._row;
    }
  }
  const letters = {};
  fields.forEach(function (f) { letters[f.name] = f.col; });
  return {
    tab: label,
    rows: rows,
    letters: letters,
    last_row: lastPopulated || headerRow,
    data_rows: rows.length,
    gap_rows: (lastPopulated ? lastPopulated - headerRow : 0) - rows.length,
    grid_rows: sheet.getMaxRows(),
    headers_dropped: dropped
  };
}


// ---------------------------------------------------------------- aggregation
// Everything below is plain JavaScript with no Apps Script services, so it can be
// tested locally against fake data.

function aggregate_(raw, cfg, nowMs, sources) {
  const today = ctDay_(nowMs);
  const names = nameBook_(cfg);
  const h = {
    last_row: {}, data_rows: {}, grid_rows: {}, gap_rows: {}, headers_dropped: [],
    a_appt_rows: null, b_appt_rows: null, b_appt_rows_deduped: null,
    dup_appt_ids: { rows_dropped: 0, ids: 0 }, blank_appt_ids: 0,
    dup_advisor_slot: null,
    dup_advisor_slot_reason: 'Needs the Time column, which the build spec keeps unread. Awaiting a decision.',
    unparsed_dates: [], unparsed_total: 0, nonstandard_dates: [], nonstandard_total: 0, blank_dates: {},
    unkeyed: { date_booked: 0, appt_date: 0 },
    status_inventory: [], tz_counts: [], future_with_outcome: 0,
    pay_vs_qshow: { pe_not_qs: 0, qs_not_pe: 0 },
    distinct_names: {}, nonpeople_in_ab: { dials: 0, appts: 0, eod: 0, goals: 0 },
    eod_test_row: null, eod_multi_submissions: 0,
    goals: null,
    all_rows_filtered: { daily: 0, first_touch: 0 }, median_collisions: 0,
    router_all: null, router_recon: null, leads_values: null,
    speed_unusable: { touched_no_time: 0, untouched_no_age: 0 },
    roster_total: {}, rawscan_total: {}
  };
  const out = {
    version: VERSION,
    as_of_ct: ctIso_(nowMs),
    today_ct: today,
    client_mix: 'mixed',
    sources: sources,
    coverage: {},
    dials: [], booked: [], outcomes: [], pending: [], cohort: [], eod: [], goals: [], roster: [],
    speed_daily: [], speed_daily_queues: [], first_touch: [], first_touch_queues: [],
    speed_buckets: [], speed_window: [], unworked_age: [], speed_window_median_min: null,
    health: h
  };

  if (raw.kpi) {
    noteTable_(h, 'dials', raw.kpi.dials);
    noteTable_(h, 'eod', raw.kpi.eod);
    noteTable_(h, 'a_appts', raw.kpi.a_appts);
    h.a_appt_rows = raw.kpi.a_appts.data_rows;
    dialsPart_(raw.kpi.dials, names, h, out);
    eodPart_(raw.kpi.eod, cfg, names, h, out);
  }
  if (raw.tracker) {
    noteTable_(h, 'tracker', raw.tracker.appts);
    noteTable_(h, 'goals', raw.tracker.goals);
    apptPart_(raw.tracker.appts, names, today, h, out);
    goalsPart_(raw.tracker.goals, cfg, names, h, out);
  }
  if (raw.router) {
    noteTable_(h, 'daily', raw.router.daily);
    noteTable_(h, 'first_touch', raw.router.first_touch);
    noteTable_(h, 'leads', raw.router.leads);
    routerPart_(raw.router, names, today, h, out, sources.router);
  }

  out.roster = names.roster();
  totalsPart_(out, names, h);
  out.coverage = {
    dials_from: minOf_(out.dials, 'date'), dials_to: maxOf_(out.dials, 'date'),
    appts_from: minOf_(out.booked, 'date_booked'), appts_to: maxOf_(out.booked, 'date_booked'),
    appt_dates_from: minOf_(out.outcomes.concat(out.pending), 'appt_date'),
    appt_dates_to: maxOf_(out.outcomes.concat(out.pending), 'appt_date'),
    eod_from: minOf_(out.eod, 'report_date'), eod_to: maxOf_(out.eod, 'report_date'),
    daily_from: minOf_(out.speed_daily.concat(out.speed_daily_queues), 'date'),
    daily_to: maxOf_(out.speed_daily.concat(out.speed_daily_queues), 'date'),
    leads_from: h.router_recon ? h.router_recon.leads_from : null,
    leads_to: h.router_recon ? h.router_recon.leads_to : null
  };
  return out;
}

function noteTable_(h, key, t) {
  h.last_row[key] = t.last_row;
  h.data_rows[key] = t.data_rows;
  h.grid_rows[key] = t.grid_rows;
  h.gap_rows[key] = t.gap_rows;
  h.headers_dropped = h.headers_dropped.concat(t.headers_dropped);
}

function dialsPart_(t, names, h, out) {
  const acc = new Map();
  const rawNames = new Set();
  for (const r of t.rows) {
    if (r.Setter) rawNames.add(normName_(r.Setter));
    const who = names.resolve(r.Setter, 'dials');
    const date = dayOf_(t, r, 'Date', 'iso', h);
    if (who.kind !== 'person') { h.nonpeople_in_ab.dials++; continue; }
    if (!date) continue;
    const a = bucketOf_(acc, date + '|' + who.key, function () {
      return { date: date, setter: who.key, dials: 0, talk_seconds: 0 };
    });
    a.dials += int_(r.Dials);
    a.talk_seconds += int_(r['Talk Seconds']);
  }
  out.dials = Array.from(acc.values());
  h.distinct_names.dials = rawNames.size;
}

function eodPart_(t, cfg, names, h, out) {
  const acc = new Map();
  const rawNames = new Set();
  const test = cfg.EOD_TEST_ROW;
  h.eod_test_row = { expected_row: test ? test.row : null, dropped: false };
  for (const r of t.rows) {
    const date = dayOf_(t, r, 'Report Date', 'mdy_time', h);
    // Trap 11: the leftover test submission. Dropped only if the whole signature still
    // matches, so a real row that later moves up to row 2 is never lost.
    if (test && r._row === test.row && date === test.report_date && normName_(r.Setter) === test.setter) {
      h.eod_test_row.dropped = true;
      continue;
    }
    if (r.Setter) rawNames.add(normName_(r.Setter));
    const who = names.resolve(r.Setter, 'eod');
    if (who.kind !== 'person') { h.nonpeople_in_ab.eod++; continue; }
    if (!date) continue;
    const key = date + '|' + who.key;
    const prev = acc.get(key);
    const rec = { report_date: date, setter: who.key, submitted: prev ? prev.submitted + 1 : 1 };
    EOD_FIELDS.forEach(function (f) { rec[f[1]] = numOrNull_(r[f[0]]); });
    if (prev) {
      h.eod_multi_submissions++;
      // Several departed people collapse into one key: add theirs up. For anyone else the
      // later submission (lower in the sheet) is the one that stands.
      if (who.key === DEPARTED_KEY) EOD_FIELDS.forEach(function (f) { rec[f[1]] = sumNull_(prev[f[1]], rec[f[1]]); });
    }
    acc.set(key, rec);
  }
  out.eod = Array.from(acc.values());
  h.distinct_names.eod = rawNames.size;
}

/**
 * Booked is keyed on Date Booked; outcomes and pending on Appointment Date; cohort on
 * Date Booked with each booking's eventual outcome (for the tab-4 funnel only).
 */
function apptPart_(t, names, today, h, out) {
  h.b_appt_rows = t.data_rows;
  const rawNames = new Set();
  const idCounts = new Map();
  const kept = [];
  for (const r of t.rows) {
    if (r.Setter) rawNames.add(normName_(r.Setter));
    const id = r['Appointment ID'];
    if (id) {
      const seen = idCounts.get(id) || 0;
      idCounts.set(id, seen + 1);
      if (seen) { h.dup_appt_ids.rows_dropped++; continue; } // first row in sheet order stands
    } else {
      h.blank_appt_ids++;
    }
    kept.push(r);
  }
  h.dup_appt_ids.ids = Array.from(idCounts.values()).filter(function (c) { return c > 1; }).length;
  h.b_appt_rows_deduped = kept.length;
  h.distinct_names.appts = rawNames.size;

  const booked = new Map(), outcomes = new Map(), pending = new Map(), cohort = new Map();
  const statusInv = new Map(), tzInv = new Map();
  for (const r of kept) {
    const who = names.resolve(r.Setter, 'appts');
    if (who.kind !== 'person') { h.nonpeople_in_ab.appts++; continue; }
    const dBooked = dayOf_(t, r, 'Date Booked', 'mon_d_y', h);
    const dAppt = dayOf_(t, r, 'Appointment Date', 'mon_d_y', h);
    count_(statusInv, safeLabel_(r.Status));
    count_(tzInv, safeLabel_(r['Time Zone']));

    const kind = statusKind_(r.Status);
    let bucket;
    if (kind === 'canceled') bucket = 'canceled';            // resolved, even when dated in the future
    else if (kind === 'unresolved') bucket = 'pending';      // blank or "Booked", any date
    else if (kind === 'other') bucket = 'other_status';
    else if (dAppt && dAppt > today) { bucket = 'pending'; h.future_with_outcome++; }
    else bucket = kind;                                      // showed | no_show | rescheduled
    const qualifiedShow = bucket === 'showed' && yes_(r['Qualified?']);
    const payEligible = yes_(r['Pay Eligible?']);            // the sheet's flag, as-is
    if (payEligible && !qualifiedShow) h.pay_vs_qshow.pe_not_qs++;
    if (qualifiedShow && !payEligible) h.pay_vs_qshow.qs_not_pe++;

    if (dBooked) {
      bucketOf_(booked, dBooked + '|' + who.key, function () {
        return { date_booked: dBooked, setter: who.key, booked: 0 };
      }).booked++;
      const c = bucketOf_(cohort, dBooked + '|' + who.key, function () {
        return { date_booked: dBooked, setter: who.key, booked: 0, showed: 0, no_show: 0, rescheduled: 0,
          canceled: 0, other_status: 0, pending: 0, qualified_show: 0, pay_eligible: 0 };
      });
      c.booked++;
      c[bucket]++;
      if (qualifiedShow) c.qualified_show++;
      if (payEligible) c.pay_eligible++;
    } else {
      h.unkeyed.date_booked++;
    }

    if (dAppt) {
      if (bucket === 'pending') {
        bucketOf_(pending, dAppt + '|' + who.key, function () {
          return { appt_date: dAppt, setter: who.key, pending: 0 };
        }).pending++;
      }
      if (bucket !== 'pending' || payEligible) {
        const o = bucketOf_(outcomes, dAppt + '|' + who.key, function () {
          return { appt_date: dAppt, setter: who.key, showed: 0, no_show: 0, rescheduled: 0, canceled: 0,
            other_status: 0, qualified_show: 0, pay_eligible: 0 };
        });
        if (bucket !== 'pending') o[bucket]++;
        if (qualifiedShow) o.qualified_show++;
        if (payEligible) o.pay_eligible++;
      }
    } else {
      h.unkeyed.appt_date++;
    }
  }
  out.booked = Array.from(booked.values());
  out.outcomes = Array.from(outcomes.values());
  out.pending = Array.from(pending.values());
  out.cohort = Array.from(cohort.values());
  h.status_inventory = inventory_(statusInv, 'status');
  h.tz_counts = inventory_(tzInv, 'tz');
}

function goalsPart_(t, cfg, names, h, out) {
  const g = { rows_read: t.data_rows, kept: 0, dropped_departed: 0, dropped_unresolved: [], live_without_goal: [], active_yes: 0 };
  const have = new Set();
  for (const r of t.rows) {
    if (yes_(r['Active?'])) g.active_yes++;
    const who = names.resolve(r.Setter, 'goals');
    if (who.kind !== 'person') { h.nonpeople_in_ab.goals++; continue; }
    const status = names.status(who.key);
    if (status === 'departed') { g.dropped_departed++; continue; }
    if (status === 'unresolved') { g.dropped_unresolved.push(who.key); continue; }
    // A blank or zero goal is "no goal set", never a target of 0.
    const booked = positiveOrNull_(r['Monthly Booked Goal']);
    const showed = positiveOrNull_(r['Monthly Showed Goal']);
    out.goals.push({ setter: who.key, monthly_booked_goal: booked, monthly_showed_goal: showed });
    have.add(who.key);
    g.kept++;
  }
  g.live_without_goal = cfg.LIVE.filter(function (n) { return !have.has(n); });
  h.goals = g;
}

function routerPart_(r, names, today, h, out, src) {
  const stamps = {};
  Object.keys(r.stamps).forEach(function (tab) { stamps[tab] = safeStamp_(r.stamps[tab]); });
  const stampMs = parseStamp_(r.stamps.Leads, today);
  if (src) {
    src.stamp = stamps.Leads;
    src.stamps = stamps;
    src.stamp_ct = stampMs ? ctIso_(stampMs) : null;
  }

  // Daily: pre-aggregated per (date, assigned setter).
  const sheetAll = new Map();
  const daily = new Map();
  for (const row of r.daily.rows) {
    const date = dayOf_(r.daily, row, 'Date', 'iso_weekday', h);
    const who = names.resolve(row.Setter, 'router');
    if (!date) continue;
    const rec = { median_min: numOrNull_(row['Median minutes to touch']) };
    DAILY_FIELDS.forEach(function (f) { rec[f[1]] = int_(row[f[0]]); });
    if (who.kind === 'rollup') { h.all_rows_filtered.daily++; sheetAll.set(date, rec); continue; }
    if (who.kind === 'queue') { out.speed_daily_queues.push(assign_({ date: date, queue: who.key }, rec)); continue; }
    mergeDaily_(daily, date, who.key, rec, DAILY_FIELDS, h);
  }
  out.speed_daily = Array.from(daily.values());

  // First touch by: per (touch date, whoever actually touched).
  const firstTouch = new Map();
  const ftAll = { first_touches: 0, booked: 0 };
  for (const row of r.first_touch.rows) {
    const date = dayOf_(r.first_touch, row, 'Date', 'iso_weekday', h);
    const who = names.resolve(row['First touch by'], 'router');
    if (!date) continue;
    const rec = { median_min: numOrNull_(row['Median minutes to touch']) };
    FIRST_TOUCH_FIELDS.forEach(function (f) { rec[f[1]] = int_(row[f[0]]); });
    if (who.kind === 'rollup') {
      h.all_rows_filtered.first_touch++;
      ftAll.first_touches += rec.first_touches;
      ftAll.booked += rec.booked;
      continue;
    }
    if (who.kind === 'queue') { out.first_touch_queues.push(assign_({ date: date, queue: who.key }, rec)); continue; }
    mergeDaily_(firstTouch, date, who.key, rec, FIRST_TOUCH_FIELDS, h);
  }
  out.first_touch = Array.from(firstTouch.values());

  // Leads: per-lead rows, reduced here to counts and medians. No row leaves.
  const buckets = new Map();
  const windowStats = new Map();
  const ages = new Map();
  const byDate = new Map();
  const allMinutes = [];
  const inv = { touched: new Map(), booked: new Map(), routed_by: new Map() };
  for (const row of r.leads.rows) {
    const date = dayOf_(r.leads, row, 'Date', 'iso_weekday', h);
    const routed = safeLabel_(row['Routed by']);
    const touched = yes_(row.Touched);
    const booked = yes_(row.Booked);
    count_(inv.touched, safeLabel_(row.Touched));
    count_(inv.booked, safeLabel_(row.Booked));
    count_(inv.routed_by, routed);
    const minutes = touched ? numOrNull_(row['Minutes to first touch']) : null;
    let bucket;
    if (!touched) bucket = 'never';
    else if (minutes == null) { bucket = 'touched_no_time'; h.speed_unusable.touched_no_time++; }
    else bucket = SPEED_BUCKETS.filter(function (b) { return minutes <= b[0]; })[0][1];
    const b = bucketOf_(buckets, bucket + '|' + routed, function () {
      return { bucket: bucket, routed_by: routed, leads: 0, booked: 0 };
    });
    b.leads++;
    if (booked) b.booked++;
    if (minutes != null) allMinutes.push(minutes);

    if (date) {
      const d = bucketOf_(byDate, date, function () { return { leads: 0, touched: 0, within_1h: 0, booked: 0, minutes: [] }; });
      d.leads++;
      if (touched) d.touched++;
      if (booked) d.booked++;
      if (minutes != null) { d.minutes.push(minutes); if (minutes <= 60) d.within_1h++; }
    }

    const lead = { touched: touched, minutes: minutes, booked: booked };
    const assigned = names.resolve(row.Setter, 'router');
    if (assigned.kind !== 'rollup') {
      addWindow_(windowStats, assigned, 'assigned', '*', lead);
      addWindow_(windowStats, assigned, 'assigned', routed, lead);
    }
    if (touched && row['First touch by']) {
      const toucher = names.resolve(row['First touch by'], 'router');
      if (toucher.kind !== 'rollup') addWindow_(windowStats, toucher, 'first_touch', '*', lead);
    }

    if (!touched) {
      // Age is measured against sheet C's own refresh stamp, never a viewer's clock.
      const ref = date ? date.split('-') : null;
      const cameIn = ref ? parseClock_(row['Came in'], Number(ref[0]), Number(ref[1])) : null;
      const age = stampMs && cameIn ? (stampMs - cameIn) / 60000 : null;
      const label = age == null ? 'unknown' : AGE_BUCKETS.filter(function (a) { return age < a[0]; })[0][1];
      if (age == null) h.speed_unusable.untouched_no_age++;
      bucketOf_(ages, label + '|' + routed, function () {
        return { age: label, routed_by: routed, leads: 0 };
      }).leads++;
    }
  }
  out.speed_buckets = Array.from(buckets.values());
  out.unworked_age = Array.from(ages.values());
  out.speed_window = Array.from(windowStats.values()).map(function (w) {
    const m = w.minutes;
    delete w.minutes;
    w.median_min = median_(m);
    return w;
  });
  out.speed_window_median_min = median_(allMinutes);
  h.leads_values = {
    touched: inventory_(inv.touched, 'value'),
    booked: inventory_(inv.booked, 'value'),
    routed_by: inventory_(inv.routed_by, 'value')
  };

  // Cross-check: our per-lead figures against the sheet's own 'All' rows, date by date.
  const recon = {
    dates_compared: 0, leads_equal: 0, touched_equal: 0, within_1h_equal: 0, booked_equal: 0, median_within_1: 0,
    mismatches: [], leads_from: null, leads_to: null
  };
  const leadDates = Array.from(byDate.keys()).sort();
  recon.leads_from = leadDates[0] || null;
  recon.leads_to = leadDates[leadDates.length - 1] || null;
  sheetAll.forEach(function (s, date) {
    const ours = byDate.get(date);
    if (!ours) return;
    recon.dates_compared++;
    const mine = { leads: ours.leads, touched: ours.touched, within_1h: ours.within_1h, booked: ours.booked, median_min: median_(ours.minutes) };
    ['leads', 'touched', 'within_1h', 'booked'].forEach(function (f) {
      if (mine[f] === s[f]) recon[f + '_equal']++;
      else if (recon.mismatches.length < 8) recon.mismatches.push({ date: date, field: f, ours: mine[f], sheet: s[f] });
    });
    if (mine.median_min == null && s.median_min == null) recon.median_within_1++;
    else if (mine.median_min != null && s.median_min != null && Math.abs(mine.median_min - s.median_min) <= 1) recon.median_within_1++;
    else if (recon.mismatches.length < 8) recon.mismatches.push({ date: date, field: 'median_min', ours: mine.median_min, sheet: s.median_min });
  });
  h.router_recon = recon;
  const all = { leads: 0, touched: 0, untouched: 0, within_1h: 0, booked: 0 };
  sheetAll.forEach(function (s) { Object.keys(all).forEach(function (k) { all[k] += s[k]; }); });
  h.router_all = { daily: all, first_touch: ftAll };
}

function mergeDaily_(map, date, key, rec, fields, h) {
  const prev = map.get(date + '|' + key);
  if (!prev) {
    map.set(date + '|' + key, assign_({ date: date, setter: key }, rec));
    return;
  }
  // Two spellings (or two departed people) on one date: counts add, medians cannot.
  fields.forEach(function (f) { prev[f[1]] += rec[f[1]]; });
  prev.median_min = null;
  h.median_collisions++;
}

function addWindow_(map, who, by, routed, lead) {
  const w = bucketOf_(map, [who.key, by, routed].join('|'), function () {
    return { who: who.key, kind: who.kind === 'queue' ? 'queue' : 'setter', by: by, routed_by: routed,
      leads: 0, touched: 0, within_1h: 0, booked: 0, minutes: [] };
  });
  w.leads++;
  if (lead.touched) w.touched++;
  if (lead.booked) w.booked++;
  if (lead.minutes != null) {
    w.minutes.push(lead.minutes);
    if (lead.minutes <= 60) w.within_1h++;
  }
}

/** Every team total both ways: live roster only, and every row in the data. */
function totalsPart_(out, names, h) {
  const onRoster = function (k) { const s = names.status(k); return s === 'live' || s === 'onboarding'; };
  const any = function () { return true; };
  const sum = function (arr, f, keep) { return arr.reduce(function (t, r) { return t + (keep(r.setter) ? r[f] : 0); }, 0); };
  [['dials', out.dials, 'dials'], ['booked', out.booked, 'booked'], ['showed', out.outcomes, 'showed'],
    ['qualified_show', out.outcomes, 'qualified_show'], ['pending', out.pending, 'pending']].forEach(function (m) {
    h.roster_total[m[0]] = sum(m[1], m[2], onRoster);
    h.rawscan_total[m[0]] = sum(m[1], m[2], any);
  });
}


// ---------------------------------------------------------------- names

/**
 * Resolves raw sheet text to a display key. Live names are canonical; aliases map only
 * the confirmed spellings in Config.gs; every departed name becomes one opaque key so
 * no departed name can reach the payload; anything else stays as its own flagged row.
 * Matching is exact after trimming and collapsing spaces: never fuzzy, never inferred.
 */
function nameBook_(cfg) {
  const live = new Set(cfg.LIVE);
  const onboarding = new Set(cfg.ONBOARDING || []);
  const departed = new Set(cfg.DEPARTED);
  const seen = new Map();
  const departedSeen = new Set();
  const aliasSeen = new Map();
  const touch = function (key, source) {
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(source);
  };
  const status = function (key) {
    if (key === DEPARTED_KEY) return 'departed';
    if (live.has(key)) return onboarding.has(key) ? 'onboarding' : 'live';
    return 'unresolved';
  };
  return {
    status: status,
    resolve: function (rawName, source) {
      const name = normName_(rawName);
      if (name === ROLLUP) return { key: name, kind: 'rollup' };
      if (cfg.QUEUES.indexOf(name) >= 0) return { key: name, kind: 'queue' };
      if (!name) { touch('(blank)', source); return { key: '(blank)', kind: 'person' }; }
      const canon = Object.prototype.hasOwnProperty.call(cfg.ALIASES, name) ? cfg.ALIASES[name] : name;
      if (canon !== name) {
        if (!aliasSeen.has(name)) aliasSeen.set(name, new Set());
        aliasSeen.get(name).add(source);
      }
      if (departed.has(canon)) {
        departedSeen.add(canon);
        touch(DEPARTED_KEY, source);
        return { key: DEPARTED_KEY, kind: 'person' };
      }
      touch(canon, source);
      return { key: canon, kind: 'person' };
    },
    roster: function () {
      const rows = [];
      const keys = new Set(cfg.LIVE.concat(Array.from(seen.keys())));
      keys.forEach(function (key) {
        const src = seen.get(key) || new Set();
        const st = status(key);
        const row = {
          setter: key, status: st, active: st === 'live' || st === 'onboarding',
          on_dials_roster: src.has('dials'), in_appt_data: src.has('appts'), in_eod: src.has('eod'),
          in_router: src.has('router'), in_goals: src.has('goals'), alias_of: null
        };
        if (key === DEPARTED_KEY) row.departed_n = departedSeen.size;
        if (st === 'unresolved') {
          row.flag_reason = key === '(blank)' ? 'Setter cell is blank'
            : (cfg.FLAG_REASONS && cfg.FLAG_REASONS[key]) || 'Not on the live roster or the departed list';
        }
        rows.push(row);
      });
      Object.keys(cfg.ALIASES).forEach(function (from) {
        // An alias that points at a departed person would name them; it is never listed.
        if (departed.has(cfg.ALIASES[from])) return;
        rows.push({ setter: from, status: 'alias', alias_of: cfg.ALIASES[from],
          seen_in: aliasSeen.has(from) ? Array.from(aliasSeen.get(from)) : [] });
      });
      return rows;
    }
  };
}


// ---------------------------------------------------------------- dates and times

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * One parser for every date shape in the three sheets:
 *   iso          2026-07-14                (_Dials)
 *   iso_weekday  2026-11-02 (Mon)          (sheet C)
 *   mon_d_y      Nov 2, 2026               (tracker)
 *   mdy / mdy_time  8/28/2026, 11/1/2026 12:00:00   (_EOD, and tracker strays)
 */
function parseDay_(s) {
  let m, y, mo, d, shape;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(\s*\((?:mon|tue|wed|thu|fri|sat|sun)\))?$/i.exec(s))) {
    y = +m[1]; mo = +m[2]; d = +m[3]; shape = m[4] ? 'iso_weekday' : 'iso';
  } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?)?$/i.exec(s))) {
    mo = +m[1]; d = +m[2]; y = +m[3]; shape = m[4] ? 'mdy_time' : 'mdy';
  } else if ((m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(s)) && MONTHS[m[1].toLowerCase()]) {
    mo = MONTHS[m[1].toLowerCase()]; d = +m[2]; y = +m[3]; shape = 'mon_d_y';
  } else {
    return null;
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 2000 || y > 2100 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { day: ymd_(y, mo, d), shape: shape };
}

/** Parses a date cell, logging blanks, unparseable values and off-format strays to health. */
function dayOf_(t, row, field, canonicalShape, h) {
  const v = row[field];
  if (!v) {
    const k = t.tab + ' / ' + field;
    h.blank_dates[k] = (h.blank_dates[k] || 0) + 1;
    return null;
  }
  const p = parseDay_(v);
  const ref = { tab: t.tab, field: field, cell: t.letters[field] + row._row, value: safeSample_(v) };
  if (!p) {
    h.unparsed_total++;
    if (h.unparsed_dates.length < 50) h.unparsed_dates.push(ref);
    return null;
  }
  if (p.shape !== canonicalShape) {
    h.nonstandard_total++;
    if (h.nonstandard_dates.length < 50) h.nonstandard_dates.push(assign_(ref, { shape: p.shape, parsed_as: p.day }));
  }
  return p.day;
}

const ZONE_OFFSETS = { CST: -6, CDT: -5, EST: -5, EDT: -4, MST: -7, MDT: -6, PST: -8, PDT: -7 };
const ZONE_STANDARD = { CT: -6, ET: -5, MT: -7, PT: -8 };

/** "Nov 2, 4:43 PM CST" (no year) -> epoch ms, taking the year from a reference date. */
function parseClock_(s, refYear, refMonth) {
  const m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{1,2}):(\d{2})\s*([ap]m)\s+([a-z]{1,4})$/i.exec(String(s || '').trim());
  if (!m || !MONTHS[m[1].toLowerCase()]) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  let year = refYear;
  if (mo === 12 && refMonth === 1) year--;
  if (mo === 1 && refMonth === 12) year++;
  const hour = (+m[3] % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  return wallToUtc_(year, mo, +m[2], hour, +m[4], m[6].toUpperCase());
}

function wallToUtc_(y, mo, d, hh, mm, zone) {
  const wall = Date.UTC(y, mo - 1, d, hh, mm);
  if (ZONE_OFFSETS[zone] != null) return wall - ZONE_OFFSETS[zone] * 3600000;
  const std = ZONE_STANDARD[zone];
  if (std == null) return null;
  const asDaylight = wall - (std + 1) * 3600000;
  return usDst_(asDaylight, std) ? asDaylight : wall - std * 3600000;
}

/** "Updated Nov 2, 5:22 PM CT - refreshes every 5 min" -> epoch ms. */
function parseStamp_(note, today) {
  const m = /^Updated (.+?) - refreshes/.exec(String(note || '').trim());
  if (!m) return null;
  const ref = today.split('-');
  return parseClock_(m[1], Number(ref[0]), Number(ref[1]));
}

/** US daylight time: 2am local on the second Sunday of March to 2am local on the first Sunday of November. */
function usDst_(utcMs, standardOffsetH) {
  const y = new Date(utcMs).getUTCFullYear();
  const start = Date.UTC(y, 2, nthSunday_(y, 3, 2), 2 - standardOffsetH);
  const end = Date.UTC(y, 10, nthSunday_(y, 11, 1), 2 - (standardOffsetH + 1));
  return utcMs >= start && utcMs < end;
}

function nthSunday_(y, month, n) {
  const firstDow = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
  return 1 + ((7 - firstDow) % 7) + 7 * (n - 1);
}

function ctParts_(ms) {
  const offset = usDst_(ms, -6) ? -5 : -6;
  const d = new Date(ms + offset * 3600000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds(), offset: offset };
}

/** "Today" is always the server's America/Chicago date. */
function ctDay_(ms) {
  const p = ctParts_(ms);
  return ymd_(p.y, p.mo, p.d);
}

function ctIso_(ms) {
  const p = ctParts_(ms);
  return ymd_(p.y, p.mo, p.d) + 'T' + pad_(p.hh) + ':' + pad_(p.mm) + ':' + pad_(p.ss) + '-0' + Math.abs(p.offset) + ':00';
}


// ---------------------------------------------------------------- small helpers

function statusKind_(s) {
  const t = String(s || '').trim().toLowerCase().replace(/[\s\-_]+/g, ' ');
  if (t === 'showed') return 'showed';
  if (t === 'no show' || t === 'noshow') return 'no_show';
  if (t === 'rescheduled') return 'rescheduled';
  if (t === 'canceled' || t === 'cancelled') return 'canceled';
  if (t === '' || t === 'booked') return 'unresolved';
  return 'other';
}

function yes_(v) { return /^(yes|y|true)$/i.test(String(v || '').trim()); }

function normName_(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }

function int_(v) {
  const n = parseInt(String(v || '').replace(/[,\s]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function numOrNull_(v) {
  const s = String(v == null ? '' : v).replace(/[,\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

function positiveOrNull_(v) {
  const n = numOrNull_(v);
  return n != null && n > 0 ? n : null;
}

function sumNull_(a, b) { return a == null && b == null ? null : (a || 0) + (b || 0); }

function median_(values) {
  if (!values.length) return null;
  const s = values.slice().sort(function (a, b) { return a - b; });
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return Math.round(m * 10) / 10;
}

function bucketOf_(map, key, init) {
  let v = map.get(key);
  if (!v) { v = init(); map.set(key, v); }
  return v;
}

function count_(map, key) { map.set(key, (map.get(key) || 0) + 1); }

function inventory_(map, label) {
  return Array.from(map.entries()).sort(function (a, b) { return b[1] - a[1]; }).map(function (e) {
    const o = { n: e[1] };
    o[label] = e[0];
    return o;
  });
}

/** Category text (status, time zone, routed by): shipped only if it looks like a short label. */
function safeLabel_(v) {
  const s = String(v || '').trim();
  if (!s) return '(blank)';
  return /^[A-Za-z][A-Za-z0-9 ()\/?'\-]{0,29}$/.test(s) ? s : '(other text)';
}

/** A malformed date cell is shown only if it still looks like a date; anything else is described, not quoted. */
function safeSample_(v) {
  const s = String(v);
  return s.length <= 24 && /\d/.test(s) && /^[0-9A-Za-z ,\/:.()\-]+$/.test(s) ? s : '(text, ' + s.length + ' chars)';
}

function safeStamp_(note) {
  const s = String(note || '').trim();
  if (!s) return '(no note)';
  return /^Updated [A-Za-z]{3,9} \d{1,2}, \d{1,2}:\d{2} [AP]M [A-Z]{2,4} - refreshes every \d+ min$/.test(s) ? s : '(unrecognised note)';
}

function minOf_(arr, f) {
  let m = null;
  arr.forEach(function (r) { if (r[f] && (m == null || r[f] < m)) m = r[f]; });
  return m;
}

function maxOf_(arr, f) {
  let m = null;
  arr.forEach(function (r) { if (r[f] && (m == null || r[f] > m)) m = r[f]; });
  return m;
}

function assign_(target, src) {
  Object.keys(src).forEach(function (k) { target[k] = src[k]; });
  return target;
}

function colLetter_(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function ymd_(y, mo, d) { return y + '-' + pad_(mo) + '-' + pad_(d); }

function pad_(n) { return (n < 10 ? '0' : '') + n; }

function escapeRe_(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
