/**
 * FAKE VALUES: the committed twin of Config.gs. Every ID and name below is made up.
 * The real Config.gs (spreadsheet IDs, live roster, departed list) is never committed.
 * tests/endpoint.test.mjs runs Code.gs against this file and fake sheet data.
 */

var CONFIG = {
  IDS: {
    kpi:     'FAKE-KPI-SPREADSHEET-ID-0000000000000000000',
    tracker: 'FAKE-TRACKER-SPREADSHEET-ID-00000000000000',
    router:  'FAKE-ROUTER-SPREADSHEET-ID-000000000000000'
  },
  LIVE: ['Ava Testwell', 'Ben Sampleton', 'Cal Dummond', 'Dot Nodata', 'Eli Rotary'],
  ONBOARDING: ['Cal Dummond', 'Dot Nodata'],
  DEPARTED: ['Xena Formerly', 'Yuri Pastdue'],
  ALIASES: {
    'Ben Sampleton II': 'Ben Sampleton',
    'Eli R': 'Eli Rotary'
  },
  QUEUES: ['House (unassigned)', 'Ava (agency login)'],
  FLAG_REASONS: {
    'Quinn Unknown': 'Fake unresolved name for tests.'
  },
  EOD_TEST_ROW: { row: 2, report_date: '2026-07-23', setter: 'Ava Testwell' }
};
