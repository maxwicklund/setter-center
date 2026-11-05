// Runs apps-script/Code.gs locally against FAKE sheets.
// Every name, ID and number in this file is made up. Nothing here came from the live
// sheets or the live endpoint, and nothing captured from them may ever be added.
//
//   node --test tests/*.test.mjs
//
// The fake spreadsheet logs every range the code reads, so these tests prove the
// forbidden columns are never touched, not just never shipped.

import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const root = new URL('../', import.meta.url);
export const CODE = fs.readFileSync(new URL('apps-script/Code.gs', root), 'utf8');
const CONFIG_SRC = fs.readFileSync(new URL('apps-script/Config.example.gs', root), 'utf8');
export const TOKEN = 'fake-token-'.padEnd(44, 'x');
export const NOW = Date.UTC(2026, 10, 2, 23, 50); // Nov 2 2026, 5:50 PM CST (DST ended Nov 1)

// ---------------------------------------------------------------- fake Apps Script

class FakeRange {
  constructor(sheet, row, col, nr, nc) { Object.assign(this, { sheet, row, col, nr, nc }); }
  getDisplayValues() {
    this.sheet.log.push({ tab: this.sheet.name, row: this.row, col: this.col, nr: this.nr, nc: this.nc });
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const src = this.sheet.grid[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.nc; c++) line.push(String(src[this.col - 1 + c] ?? ''));
      out.push(line);
    }
    return out;
  }
  getNote() {
    this.sheet.log.push({ tab: this.sheet.name, note: true, row: this.row, col: this.col, nr: 1, nc: 1 });
    return this.sheet.notes[`${this.row},${this.col}`] || '';
  }
}
for (const m of ['getValues', 'getValue', 'setValue', 'setValues', 'setNote', 'setFormula', 'clear', 'clearContent',
  'deleteCells', 'insertCells', 'copyTo', 'moveTo', 'sort']) {
  FakeRange.prototype[m] = function () { throw new Error(`forbidden range method: ${m}`); };
}

export class FakeSheet {
  constructor(name, grid, { notes = {}, maxRows } = {}) {
    Object.assign(this, { name, grid, notes, log: [], maxRows: maxRows || grid.length + 20 });
  }
  getRange(a, b, c = 1, d = 1) {
    if (typeof a === 'string') {
      const m = /^([A-Z]+)(\d+)$/.exec(a);
      const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
      return new FakeRange(this, +m[2], col, 1, 1);
    }
    return new FakeRange(this, a, b, c, d);
  }
  getLastRow() {
    for (let i = this.grid.length; i > 0; i--) if ((this.grid[i - 1] || []).some(v => String(v ?? '') !== '')) return i;
    return 0;
  }
  getMaxRows() { return this.maxRows; }
  getDataRange() { throw new Error('forbidden: getDataRange'); }
  appendRow() { throw new Error('forbidden: appendRow'); }
}

export function fakeSpreadsheet(sheets) {
  const byName = Object.fromEntries(sheets.map(s => [s.name, s]));
  return { sheets, getSheetByName: n => byName[n] || null, getSheets: () => { throw new Error('forbidden: getSheets'); } };
}

function blob(bytes) {
  const buf = Buffer.from(bytes);
  return { buf, getBytes: () => buf, getDataAsString: () => buf.toString('utf8') };
}

export function makeContext({ spreadsheets, props = { DASH_TOKEN: TOKEN } }) {
  const cache = new Map();
  const stats = { opens: 0, cachePuts: 0, chunks: 0 };
  const ctx = vm.createContext({
    console,
    SpreadsheetApp: {
      openById(id) {
        stats.opens++;
        if (!spreadsheets[id]) throw new Error(`Unexpected error while getting the method or property openById on object SpreadsheetApp. (${id})`);
        return spreadsheets[id];
      }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: s => ({ content: s, setMimeType() { return this; }, getContent() { return this.content; } })
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null }) },
    CacheService: {
      getScriptCache: () => ({
        get: k => cache.get(k) ?? null,
        getAll: keys => Object.fromEntries(keys.filter(k => cache.has(k)).map(k => [k, cache.get(k)])),
        putAll(values) {
          for (const [k, v] of Object.entries(values)) {
            if (v.length > 100 * 1024) throw new Error('Argument too large: value');
            cache.set(k, v);
          }
          stats.cachePuts++;
          stats.chunks = Object.keys(values).length - 1;
        }
      })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: {
      newBlob: (data) => blob(typeof data === 'string' ? Buffer.from(data, 'utf8') : data),
      gzip: b => blob(zlib.gzipSync(b.buf)),
      ungzip: b => blob(zlib.gunzipSync(b.buf)),
      base64Encode: bytes => Buffer.from(bytes).toString('base64'),
      base64Decode: s => Buffer.from(s, 'base64')
    }
  });
  vm.runInContext(`Date.now = () => ${NOW};`, ctx);
  vm.runInContext(CONFIG_SRC + '\n' + CODE, ctx, { filename: 'Code.gs' });
  return { ctx, stats, cache };
}

// Values built inside the vm belong to another realm; copy them out before deepEqual.
export const inCtx = (ctx, src) => JSON.parse(JSON.stringify(vm.runInContext(src, ctx)) ?? 'null');
export const post = (ctx, body) => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).getContent());

// ---------------------------------------------------------------- fake sheets (made-up data)

export const S = 'SENTINEL'; // planted in every column the code must never read

function fakeKpi() {
  const dials = [['Date', 'Setter', 'Dials', 'Answered', 'Talk Seconds', 'Talk Time', 'Calls Over 60s', `${S} banner`]];
  const people = ['Ava Testwell', 'Ben Sampleton', 'Cal Dummond', 'Xena Formerly', 'Quinn Unknown', 'Eli R'];
  ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'].forEach((d, i) => people.forEach((p, j) => {
    const n = (i + 1) * 10 + j;
    dials.push([d, p, String(n), `${S}-7777`, String(n * 30), `${S}-tt`, String(Math.floor(n / 5))]);
  }));
  const eodHead = ['Timestamp', 'Submission ID', 'Report Date', 'Setter', 'Contacts', 'Not Qualified', 'Reported Booked',
    'Appointments Added', 'Status Updates', 'Qualified No Book', 'Notes', 'Booking Difference', 'Processing Status', 'Closed Deals'];
  const eodRow = (date, who, contacts, diff) => [`${S}-ts`, `${S}-id`, date, who, String(contacts), '0', '2', '1', '0', '0', `${S} notes $9`, String(diff), `${S}-proc`, '0'];
  const eod = [eodHead,
    eodRow('7/23/2026 12:00:00', 'Ava Testwell', 2, 0),     // the leftover test row
    eodRow('11/1/2026 12:00:00', 'Ava Testwell', 10, 1),
    eodRow('11/1/2026 12:00:00', 'Ben Sampleton', 8, 0),
    eodRow('11/1/2026 12:00:00', 'Ava Testwell', 12, 1),    // a second submission: this one stands
    eodRow('11/2/2026 12:00:00', 'Xena Formerly', 5, 0),
    eodRow('11/2/2026 12:00:00', 'Quinn Unknown', 3, -1)];
  const aAppts = [['Date Booked', 'Setter', 'Advisor', 'Prospect'], ['Nov 2, 2026', 'x', 'x', S], ['Nov 1, 2026', 'x', 'x', S], ['Oct 30, 2026', 'x', 'x', S]];
  return fakeSpreadsheet([
    new FakeSheet('Live Scoreboard', [[S]]),
    new FakeSheet('_Dials', dials, { maxRows: 200 }),
    new FakeSheet('_EOD', eod),
    new FakeSheet('_Appointments', aAppts),
    new FakeSheet('_Goals', [[S]])
  ]);
}

function fakeTracker() {
  const head = ['Date Booked', 'Setter', 'Advisor', 'Prospect', 'Appointment Date', 'Time', 'Time Zone', 'Status', 'Advisor Result',
    'Qualified?', 'Estimated Assets', 'Closed Assets', 'Pay Eligible?', 'Notes', 'Appointment ID', 'Booking #',
    'Last EOD Update', 'EOD Submission ID', 'Outcome Notes'];
  const a = (booked, who, date, tz, status, q, pe, id) =>
    [booked, who, `${S}-advisor`, `${S}-prospect`, date, `${S}-3:00 PM`, tz, status, `${S}-Pending`, q, `${S} $500,000`, `${S} $0`, pe,
      `${S} notes`, id, `${S}-#`, `${S}-eod`, `${S}-eodid`, `${S} outcome notes`];
  const rows = [
    [], [`${S} instructions banner`], [], head,
    a('Nov 2, 2026', 'Ava Testwell', 'Nov 4, 2026', 'ET', 'Booked', '', '', 'APT-F001'),        // pending, future
    a('Nov 1, 2026', 'Ava Testwell', 'Nov 2, 2026', 'CT', 'Booked', '', '', 'APT-F002'),        // pending, today
    a('Oct 30, 2026', 'Ava Testwell', 'Oct 31, 2026', 'PT', 'Showed', 'Yes', 'Yes', 'APT-F003'),// qualified show
    a('Oct 30, 2026', 'Ben Sampleton', 'Oct 31, 2026', 'ET', 'No Show', '', 'Yes', 'APT-F004'), // pay flag without a show
    a('Oct 29, 2026', 'Ben Sampleton II', 'Nov 5, 2026', 'ET', 'Canceled', '', '', 'APT-F005'), // alias; canceled, future
    a('Oct 28, 2026', 'Ben Sampleton', 'Oct 29, 2026', 'ET', 'Booked', '', '', 'APT-F006'),     // pending, overdue
    a('Oct 28, 2026', 'Cal Dummond', 'Nov 9, 2026', 'CT', 'Showed', 'Yes', '', 'APT-F007'),     // outcome in the future
    a('Oct 28, 2026', 'Cal Dummond', '10/29/2026', 'CT', 'Showed', 'Yes', '', 'APT-F008'),      // stray date shape
    a('Oct 25, 2026', 'Ava Testwell', 'Oct 26, 2026', 'ET', 'No Show', '', '', 'APT-F003'),     // duplicate ID
    a('Oct 27, 2026', 'Xena Formerly', 'Oct 28, 2026', 'ET', 'Showed', 'Yes', 'Yes', ''),       // departed, blank ID
    a('Oct 27, 2026', 'Quinn Unknown', 'TBD', 'ET', 'Booked', '', '', 'APT-F011'),             // unparseable date
    a('10/26/2026', 'Yuri Pastdue', 'Oct 27, 2026', 'MT', 'Cancelled', '', '', 'APT-F012'),     // departed, stray shape
    a('Oct 26, 2026', 'Ava Testwell', 'Oct 27, 2026', 'ET', 'Left voicemail', '', '', 'APT-F013'),
    a('Oct 26, 2026', 'Ava Testwell', 'Oct 27, 2026', 'ET', 'Rescheduled', '', '', 'APT-F014')
  ];
  const goals = [[`${S} banner`], [], [], ['Setter', 'Monthly Booked Goal', 'Monthly Showed Goal', 'Base Pay', 'Active?', 'Notes'],
    ['Ava Testwell', '100', '60', `${S} $2,000`, 'Yes', `${S} commission`],
    ['Xena Formerly', '80', '60', `${S} $1,500`, 'Yes', S],
    ['Ben Sampleton', '80', '', `${S} $1,500`, 'Yes', S],
    ['Quinn Unknown', '50', '40', `${S} $1,500`, 'Yes', S],
    ['Cal Dummond', '0', '0', `${S} $1,500`, 'Yes', S],
    ['Eli R', '80', '60', `${S} $1,500`, 'Yes', S]];
  while (goals.length < 28) goals.push([]);
  goals.push(['Setter', 'Eligible Shows', 'Pay Rule', 'Amount Due']);
  for (let i = 0; i < 7; i++) goals.push([`${S}-name`, '3', `${S} rule`, `${S} $300`]);
  return fakeSpreadsheet([
    new FakeSheet('Dashboard', [[S]]),
    new FakeSheet('Appointment Tracker', rows),
    new FakeSheet('Self Booked', [[S, `${S}@example.com`, '555-0100']]),
    new FakeSheet('Goals & Payroll', goals),
    new FakeSheet('Payroll Detail', [[S]])
  ]);
}

function fakeRouter() {
  const note = { '1,1': 'Updated Nov 2, 5:47 PM CT - refreshes every 5 min' };
  const leadsHead = ['Lead', 'Came in', 'Date', 'Setter', 'Routed by', 'Routed at', 'Touched', 'First touch', 'First touch type',
    'First touch by', 'Minutes to first touch', 'Texts', 'Calls', 'Calls answered', 'Booked', 'Booked with', 'Source',
    'CRM link', 'Re-submitted', 'Re-submitted at', 'First came in'];
  const L = (came, date, who, routed, touched, by, mins, booked) =>
    [`${S}-lead name`, came, date, who, routed, came, touched, touched === 'Yes' ? came : '',
      touched === 'Yes' ? 'call' : '', by, mins, `${S}-3`, `${S}-2`, `${S}-1`, booked, `${S}-with`, `${S}-source`,
      `https://crm.example/${S}`, `${S}-re`, `${S}-reat`, `${S}-first`];
  const leads = [leadsHead,
    L('Nov 2, 5:05 PM CST', '2026-11-02 (Mon)', 'Ava Testwell', 'rotation', 'Yes', 'Ava Testwell', '4', 'Yes'),
    L('Nov 2, 4:43 PM CST', '2026-11-02 (Mon)', 'Ava Testwell', 'rotation', 'Yes', 'Ava Testwell', '34', 'No'),
    L('Nov 2, 3:57 PM CST', '2026-11-02 (Mon)', 'Ben Sampleton II', 'rotation', 'No', '', '', 'No'),
    L('Nov 1, 9:00 AM CST', '2026-11-01 (Sun)', 'House (unassigned)', 'house', 'Yes', 'Ava (agency login)', '300', 'Yes'),
    L('Nov 1, 8:00 AM CST', '2026-11-01 (Sun)', 'House (unassigned)', 'house', 'No', '', '', 'No'),
    L('Oct 31, 10:00 AM CDT', '2026-10-31 (Sat)', 'Cal Dummond', 'manual', 'Yes', 'Ben Sampleton II', '2000', 'No'),
    L('Oct 31, 11:00 AM CDT', '2026-10-31 (Sat)', 'Xena Formerly', 'reassigned', 'Yes', 'Cal Dummond', '12', 'No'),
    L('Oct 30, 9:00 AM CDT', '2026-10-30 (Fri)', 'Eli Rotary', 'rotation', 'No', '', '', 'No'),
    L('Oct 30, 9:30 AM CDT', '2026-10-30 (Fri)', 'Eli Rotary', 'rotation', 'Yes', 'Eli Rotary', '', 'No'),
    L('Oct 30, 9:40 AM CDT', '2026-10-30 (Fri)', 'Ava Testwell', 'rotation', 'Yes', 'Ava Testwell', '60', 'No')];
  const D = (date, who, leads, touched, w1h, median, booked) =>
    [date, who, String(leads), String(touched), String(leads - touched), String(Math.round(100 * touched / leads)), String(w1h), median, String(booked)];
  const daily = [['Date', 'Setter', 'Leads', 'Touched', 'Untouched', 'Touched %', 'Touched within 1h', 'Median minutes to touch', 'Booked'],
    D('2026-11-02 (Mon)', 'All', 3, 2, 2, '19', 1), D('2026-11-02 (Mon)', 'Ava Testwell', 2, 2, 2, '19', 1),
    D('2026-11-02 (Mon)', 'Ben Sampleton II', 1, 0, 0, '', 0),
    D('2026-11-01 (Sun)', 'All', 2, 1, 0, '300', 1), D('2026-11-01 (Sun)', 'House (unassigned)', 2, 1, 0, '300', 1),
    D('2026-10-31 (Sat)', 'All', 2, 2, 1, '1006', 0), D('2026-10-31 (Sat)', 'Cal Dummond', 1, 1, 0, '2000', 0),
    D('2026-10-31 (Sat)', 'Xena Formerly', 1, 1, 1, '12', 0),
    D('2026-10-30 (Fri)', 'All', 3, 2, 1, '60', 0), D('2026-10-30 (Fri)', 'Eli Rotary', 2, 1, 0, '', 0),
    D('2026-10-30 (Fri)', 'Ava Testwell', 1, 1, 1, '60', 0)];
  const F = (date, who, n, own, house, w1h, median, booked) =>
    [date, who, String(n), String(own), String(house), '0', String(n), '0', String(w1h), median, String(booked)];
  const firstTouch = [['Date', 'First touch by', 'First touches', 'Own leads', 'House leads', "Other setters' leads", 'By call', 'By text',
    'Within 1h', 'Median minutes to touch', 'Booked'],
    F('2026-11-02 (Mon)', 'All', 2, 2, 0, 2, '19', 1), F('2026-11-02 (Mon)', 'Ava Testwell', 2, 2, 0, 2, '19', 1),
    F('2026-11-01 (Sun)', 'All', 1, 0, 1, 0, '300', 1), F('2026-11-01 (Sun)', 'Ava (agency login)', 1, 0, 1, 0, '300', 1),
    F('2026-10-31 (Sat)', 'All', 2, 1, 0, 1, '1006', 0), F('2026-10-31 (Sat)', 'Ben Sampleton II', 1, 0, 0, 0, '2000', 0),
    F('2026-10-31 (Sat)', 'Cal Dummond', 1, 0, 0, 1, '12', 0)];
  return fakeSpreadsheet([
    new FakeSheet('Leads', leads, { notes: note, maxRows: 400 }),
    new FakeSheet('First touch by', firstTouch, { notes: note }),
    new FakeSheet('Daily', daily, { notes: note, maxRows: 400 })
  ]);
}

export function fakeWorld() {
  return {
    'FAKE-KPI-SPREADSHEET-ID-0000000000000000000': fakeKpi(),
    'FAKE-TRACKER-SPREADSHEET-ID-00000000000000': fakeTracker(),
    'FAKE-ROUTER-SPREADSHEET-ID-000000000000000': fakeRouter()
  };
}

export const sum = (arr, f) => arr.reduce((t, r) => t + (r[f] || 0), 0);

