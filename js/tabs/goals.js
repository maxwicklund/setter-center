import { h } from '../dom.js';
import { fmtInt, dayLabel, monthBounds, monthElapsed } from '../data.js';
import { tag, segmented, defLink } from '../ui.js';

// Tab 6, Goals, Pacing & Leaderboard: the wall view. Goals come only from the tracker's
// goals tab (live roster only); nobody is paced against a goal they don't have. Boards
// rank per active dialing day by default, and only people with MIN_ACTIVE_DAYS or more.

const MIN_ACTIVE_DAYS = 5;
// "On pace" = within 10% of the even-pace line, or within 2, whichever is wider, so the
// first days of a month don't swing between states on a single booking.
const PACE_BAND = 0.1;
const PACE_MIN_BAND = 2;
const MATURE = 0.95;

const view = { month: 'this', board: 'rate' };

export function renderGoals(p, ix) {
  const root = h('div', { class: 'goals-tab' });
  const draw = () => root.replaceChildren(...content(p, ix, draw));
  draw();
  return root;
}

function content(p, ix, draw) {
  const [first, lastDay] = view.month === 'last' ? monthBounds(p.today_ct, -1) : monthBounds(p.today_ct);
  const to = view.month === 'last' ? lastDay : p.today_ct;
  const now = monthElapsed(p);
  const daysInMonth = Number(lastDay.slice(8));
  const day = view.month === 'last' ? daysInMonth : now.day;
  const share = view.month === 'last' ? 1 : now.elapsed / daysInMonth;
  const monthName = `${dayLabel(first).split(', ')[1].split(' ')[0]} ${first.slice(0, 4)}`;
  const inMonth = d => d >= first && d <= to;

  const stats = new Map();
  const st = who => stats.get(who) || stats.set(who, { who, dials: 0, active: 0, booked: 0, showed: 0, qs: 0, covered: false }).get(who);
  for (const r of p.dials) if (inMonth(r.date)) { const x = st(r.setter); x.covered = true; x.dials += r.dials; if (r.dials > 0) x.active++; }
  for (const r of p.booked) if (inMonth(r.date_booked)) st(r.setter).booked += r.booked;
  for (const r of p.outcomes) if (inMonth(r.appt_date)) { const x = st(r.setter); x.showed += r.showed; x.qs += r.qualified_show; }

  const roster = p.roster.filter(r => r.status !== 'alias');
  const team = roster.filter(r => r.active).map(r => ({ ...st(r.setter), covered: r.on_dials_roster }));
  const flagged = roster.filter(r => r.status === 'unresolved').map(r => st(r.setter)).filter(x => x.dials || x.booked || x.showed);

  // Maturity of this month's outcomes: dated before today, how many have one.
  let settled = 0, open = 0;
  for (const r of p.outcomes) if (inMonth(r.appt_date) && r.appt_date < p.today_ct) settled += r.showed + r.no_show + r.rescheduled + r.canceled + r.other_status;
  for (const r of p.pending) if (inMonth(r.appt_date) && r.appt_date < p.today_ct) open += r.pending;
  const maturity = settled + open ? settled / (settled + open) : 1;

  return [
    h('div', { class: 'controls' },
      segmented('Month', [['this', 'This month'], ['last', 'Last month']], view.month, v => { view.month = v; draw(); }),
      h('span', { class: 'controls-gap' }),
      h('span', { class: 'mix-label' }, defLink('client-mix', 'RetireWell + Funnel client — mixed'))),
    pacing(p, ix, team, monthName, day, daysInMonth, share, view.month === 'last'),
    boards(ix, team, flagged, monthName, maturity, draw)
  ];
}

// ---------------------------------------------------------------- pacing

function stateOf(actual, expected) {
  const band = Math.max(PACE_BAND * expected, PACE_MIN_BAND);
  return actual > expected + band ? 'ahead' : actual >= expected - band ? 'on' : 'behind';
}
const STATE = { ahead: ['▲', 'Ahead'], on: ['●', 'On pace'], behind: ['▼', 'Behind'] };

function pacing(p, ix, team, monthName, day, daysInMonth, share, finished) {
  const goals = new Map(p.goals.map(g => [g.setter, g]));
  const rows = team.slice().sort((a, b) => ix.label(a.who).localeCompare(ix.label(b.who)));
  const bar = (actual, goal, basis) => {
    const kind = h('span', { class: 'pace-kind' }, basis);
    if (!goal) return h('div', { class: 'pace-cell no-goal' }, h('span', { class: 'faint' }, kind, 'no goal set'), h('span', { class: 'pace-n' }, fmtInt(actual)));
    const expected = goal * share;
    const state = stateOf(actual, expected);
    const scale = Math.max(goal, actual) * 1.04;
    const fill = h('div', { class: `pace-fill st-${state}` });
    fill.style.width = `${((100 * actual) / scale).toFixed(1)}%`;
    const mark = h('div', { class: 'pace-mark', title: `Where an even pace puts them today: ${Math.round(expected)}` });
    mark.style.left = `${((100 * expected) / scale).toFixed(1)}%`;
    const end = h('div', { class: 'pace-end' });
    end.style.left = `${((100 * goal) / scale).toFixed(1)}%`;
    return h('div', { class: 'pace-cell', title: `${basis}: ${actual} of ${goal}; even pace today ${Math.round(expected)}` },
      h('div', { class: 'pace-top' },
        h('span', { class: `state st-${state}` }, kind, `${STATE[state][0]} ${STATE[state][1]}`),
        h('span', { class: 'pace-n' }, h('strong', null, fmtInt(actual)), ` / ${fmtInt(goal)}`)),
      h('div', { class: 'pace-track' }, fill, mark, end));
  };
  return h('section', { class: 'card pacing-card' },
    h('div', { class: 'card-head' },
      h('h2', null, defLink('pace', `Monthly goals · ${monthName}`)),
      h('p', { class: 'sub' }, (finished
        ? `The finished month, judged against the goals on the sheet today (the goals tab keeps no history of past goals). Dotted marker = the goal. `
        : `Day ${day} of ${daysInMonth}. Dotted marker = where an even pace puts each setter right now (Central time). `) +
        `Ahead or behind means more than ${Math.round(PACE_BAND * 100)}% or ${PACE_MIN_BAND}, whichever is larger, off that marker; anything closer is on pace.`)),
    h('div', { class: 'pace-grid' },
      h('span', { class: 'pace-h' }, 'Setter'),
      h('span', { class: 'pace-h' }, 'Booked · by Date Booked'),
      h('span', { class: 'pace-h' }, 'Showed · by Appointment Date'),
      rows.map(x => {
        const g = goals.get(x.who) || {};
        return [
          h('span', { class: 'pace-who' }, ix.label(x.who), tag(ix.status(x.who))),
          bar(x.booked, g.monthly_booked_goal, 'Booked'),
          bar(x.showed, g.monthly_showed_goal, 'Showed')
        ];
      })),
    h('p', { class: 'sub faint' }, 'Goals come from the tracker’s goals tab, live roster only. A setter without a goal is never paced against 0. ' +
      'Showed lags: outcomes land days after the appointment, so the Showed column runs behind until they do.'));
}

// ---------------------------------------------------------------- leaderboards

function boards(ix, team, flagged, monthName, maturity, draw) {
  const eligible = team.filter(x => x.covered && x.active >= MIN_ACTIVE_DAYS);
  const ramping = team.filter(x => x.covered && x.active < MIN_ACTIVE_DAYS);
  const uncovered = team.filter(x => !x.covered);
  const metrics = [
    ['dials', 'Dials', 'dialer date'],
    ['booked', 'Booked', 'Date Booked'],
    ['qs', 'Qualified shows', 'Appointment Date']
  ];
  const board = kind => h('section', { class: `card board board-${kind}` + (view.board === kind ? ' is-picked' : '') },
    h('div', { class: 'card-head' },
      h('h2', null, kind === 'rate' ? defLink('active-day', 'Rate · per active dialing day') : view.month === 'last' ? 'Volume · whole month' : 'Volume · month to date'),
      h('p', { class: 'sub' }, kind === 'rate'
        ? `Each total ÷ the setter's days with dials > 0. Fair to part-timers and new starts.`
        : view.month === 'last' ? 'Plain totals for the whole month.' : 'Plain totals for the month so far.')),
    metrics.map(([key, label, basis]) => {
      const value = x => (kind === 'rate' ? x[key] / x.active : x[key]);
      const ranked = eligible.slice().sort((a, b) => value(b) - value(a) || ix.label(a.who).localeCompare(ix.label(b.who)));
      let rank = 0, prev = null;
      return h('div', { class: 'mini-board' },
        h('p', { class: 'label' }, `${label} · by ${basis}`),
        ranked.length ? h('ol', { class: 'lb' }, ranked.map((x, i) => {
          const v = value(x);
          if (prev === null || Math.abs(v - prev) > 1e-9) rank = i + 1;
          prev = v;
          return h('li', { class: 'lb-row' },
            h('span', { class: 'lb-rank' }, String(rank)),
            h('span', { class: 'lb-who' }, ix.label(x.who), tag(ix.status(x.who))),
            h('span', { class: 'lb-val' }, kind === 'rate' ? fmtRate(v) : fmtInt(v)));
        })) : h('p', { class: 'faint' }, `Nobody has ${MIN_ACTIVE_DAYS} active dialing days in ${monthName} yet.`),
        key === 'qs' ? h('p', { class: 'sub faint' }, `${Math.round(maturity * 100)}% of appointments dated before today have an outcome` +
          (maturity < MATURE ? ', so qualified shows will still rise. Read this board as provisional.' : '.')) : null);
    }));

  const listed = (title, rows, note) => (rows.length ? h('div', { class: 'unranked' },
    h('p', { class: 'label' }, title, ` (${rows.length})`),
    h('ul', null, rows.map(x => h('li', null, ix.label(x.who), tag(ix.status(x.who)),
      h('span', { class: 'faint' }, ` · ${x.covered ? `${x.active} active day${x.active === 1 ? '' : 's'}, ${fmtInt(x.dials)} dials, ` : ''}${fmtInt(x.booked)} booked, ${fmtInt(x.qs)} qualified shows`)))),
    h('p', { class: 'sub faint' }, note)) : null);

  return h('div', { class: 'boards-wrap' },
    h('div', { class: 'board-pick' }, segmented('Board', [['rate', 'Rate'], ['volume', 'Volume']], view.board, v => { view.board = v; draw(); })),
    h('div', { class: 'boards' }, board('rate'), board('volume')),
    h('section', { class: 'card' },
      listed(defLink('ramping', `Part-time / ramping, fewer than ${MIN_ACTIVE_DAYS} active days`), ramping, 'Not ranked until they reach 5 active dialing days this month.'),
      listed('No dial coverage', uncovered, "The dialer stores no rows for them, so there are no active days to rate by. Not ranked; that's not the same as 0."),
      listed('In the data, not on the roster', flagged, 'Shown with their numbers, never ranked, until their name is resolved.')));
}

function fmtRate(v) {
  return v >= 10 ? fmtInt(v) : v >= 1 ? v.toFixed(1) : v.toFixed(2);
}
