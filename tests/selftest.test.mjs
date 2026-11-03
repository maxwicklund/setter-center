// Runs the ?selftest=1 checks (js/selftest.js) against a payload built by Code.gs from
// FAKE sheets. Golden-figure rows fail here by design: the fake data is not the live data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN, makeContext, fakeWorld } from './fake-endpoint.mjs';

function fakePayload() {
  const { ctx } = makeContext({ spreadsheets: fakeWorld() });
  const text = ctx.doPost({ postData: { contents: JSON.stringify({ token: TOKEN }) } }).getContent();
  return { payload: JSON.parse(text), text };
}

function mockEndpoint(answer) {
  globalThis.fetch = async () => ({ status: 200, text: async () => answer });
}

const { runChecks } = await import('../js/selftest.js');
const byCheck = rows => Object.fromEntries(rows.map(r => [r.check, r]));

test('every structural and privacy row passes on a well-formed payload', async () => {
  mockEndpoint('{"error":"unauthorized"}');
  const rows = byCheck(await runChecks(fakePayload()));
  for (const check of [
    'Departed names rendered anywhere in the output',
    'Payload grep: Prospect, Notes, CRM, Base Pay, Amount Due, Pay Rule, Payroll, $',
    'Payload: any array of per-appointment or per-lead records',
    'Endpoint with no token / wrong token / empty token',
    'Rows with Setter = All, a queue, or the agency login in any per-setter total',
    'Goal rows belonging to a departed (or off-roster) setter',
    'Booked − (Showed + No Show + Rescheduled + Canceled + Pending), all time',
    'EOD leftover test row (row 2) filtered',
    "Per-lead figures (Leads B–K + O) vs sheet C's own 'All' rows, date by date",
    '_Dials rows = days covered × setters stored',
    'Column headers dropped by the allowlist'
  ]) assert.equal(rows[check].status, 'pass', `${check}: ${rows[check].computed} / ${rows[check].note}`);
  assert.equal(rows['Rescheduled count, all time'].status, 'fail'); // the fake tracker has one
  assert.equal(rows['Unparseable dates'].note, 'Appointment Tracker!E15 "(text, 3 chars)"');
});

test('a data-returning endpoint, a forbidden word, or a row-level array fails its row', async () => {
  mockEndpoint('{"dials":[]}');
  const base = fakePayload();
  let rows = byCheck(await runChecks(base));
  assert.equal(rows['Endpoint with no token / wrong token / empty token'].status, 'fail');

  mockEndpoint('{"error":"unauthorized"}');
  rows = byCheck(await runChecks({ payload: base.payload, text: base.text.replace('"version"', '"Outcome Notes","version"') }));
  assert.equal(rows['Payload grep: Prospect, Notes, CRM, Base Pay, Amount Due, Pay Rule, Payroll, $'].computed, 'Notes');

  const leaky = structuredClone(base.payload);
  leaky.booked.push({ ...leaky.booked[0] });
  leaky.outcomes[0].appointment_time = '3:00 PM';
  rows = byCheck(await runChecks({ payload: leaky, text: base.text }));
  const schema = rows['Payload: any array of per-appointment or per-lead records'];
  assert.equal(schema.status, 'fail');
  assert.match(schema.computed, /booked repeats date_booked\+setter/);
  assert.match(schema.computed, /outcomes carries appointment_time/);
});

test('a queue that slips into a per-setter table is caught', async () => {
  mockEndpoint('{"error":"unauthorized"}');
  const { payload, text } = fakePayload();
  payload.speed_daily.push({ date: '2026-11-02', setter: 'House (unassigned)', leads: 1, touched: 1, untouched: 0, within_1h: 0, booked: 0, median_min: 5 });
  const rows = byCheck(await runChecks({ payload, text }));
  assert.equal(rows['Rows with Setter = All, a queue, or the agency login in any per-setter total'].status, 'fail');
});
