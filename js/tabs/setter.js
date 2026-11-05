import { h, s } from '../dom.js';
import { DEPARTED_KEY, WINDOWS, fmtInt, fmtDuration, dayLabel, addDays, dateRange, monthBounds, monthElapsed, resolveWindow, hasContacts, contactRate, fmtPct1 } from '../data.js';
import { tag, segmented, customRange, defLink } from '../ui.js';

// Tab 4, Setter Deep Dive: one person, one page, read like a player card. Compared only
// with their own previous period and a thin team-median line; never a rank number.

const view = { who: null, window: '30d', from: null, to: null };

export function renderSetter(p, ix) {
  const root = h('div', { class: 'setter-tab' });
  const draw = () => root.replaceChildren(...content(p, ix, draw));
  draw();
  return root;
}

function content(p, ix, draw) {
  const people = p.roster.filter(r => r.status !== 'alias' && r.setter !== DEPARTED_KEY && (r.active || r.status === 'unresolved'));
  if (!people.some(r => r.setter === view.who)) view.who = (people[0] || {}).setter || null;
  if (!view.who) return [h('p', { class: 'faint' }, 'Nobody to show.')];
  const me = people.find(r => r.setter === view.who);
  const win = resolveWindow(view, p.today_ct);
  const prior = { from: addDays(win.from, -win.days), to: addDays(win.from, -1), days: win.days };
  const team = p.roster.filter(r => ix.isTeam(r.setter)).map(r => r.setter);

  const picker = h('select', { class: 'picker', 'aria-label': 'Setter', onchange: e => { view.who = e.target.value; draw(); } },
    people.map(r => h('option', { value: r.setter, selected: r.setter === view.who },
      r.status === 'unresolved' ? `${r.setter} (not on roster)` : r.status === 'onboarding' ? `${r.setter} (onboarding)` : r.setter)));

  return [
    h('div', { class: 'controls' },
      picker,
      segmented('Window', WINDOWS, view.window, v => { view.window = v; draw(); }),
      view.window === 'custom' ? customRange(view, win, p.today_ct, draw) : null),
    playerHead(p, ix, me, win, prior),
    h('div', { class: 'card-grid' },
      activity(p, me, win, prior, team),
      funnel(p, me.setter, win, prior)),
    goals(p, me.setter),
    trends(p, me, win, team),
    h('div', { class: 'card-grid' },
      eodCard(p, me, win),
      speedCard(p, me.setter, team))
  ];
}

// ---------------------------------------------------------------- header

function playerHead(p, ix, me, win, prior) {
  const facts = [];
  if (me.status === 'live') facts.push('Live setter');
  if (me.status === 'onboarding') facts.push('Onboarding');
  if (me.status === 'unresolved') facts.push('In the data, not on the live roster');
  if (!me.on_dials_roster) facts.push('No dial coverage: the dialer stores no rows for this name');
  const firstDial = p.dials.filter(r => r.setter === me.setter && r.dials > 0).map(r => r.date).sort()[0];
  if (firstDial) facts.push(`First dial day ${dayLabel(firstDial)}, ${firstDial.slice(0, 4)}`);
  return h('section', { class: 'player card' },
    h('div', { class: 'player-name' }, h('h1', null, ix.label(me.setter)), tag(me.status)),
    h('p', { class: 'sub' }, facts.join(' · ')),
    me.status === 'unresolved' && me.flag_reason ? h('p', { class: 'sub faint' }, me.flag_reason) : null,
    h('p', { class: 'sub faint' }, `${dayLabel(win.from)} – ${dayLabel(win.to)} (${win.days} days), compared with the ${win.days} days before: ${dayLabel(prior.from)} – ${dayLabel(prior.to)}`));
}

// ---------------------------------------------------------------- activity (tiles, not funnel bars)

function dialStats(p, who, from, to) {
  const rows = p.dials.filter(r => r.setter === who && r.date >= from && r.date <= to);
  const dials = rows.reduce((t, r) => t + r.dials, 0);
  const talk = rows.reduce((t, r) => t + r.talk_seconds, 0);
  const contacts = rows.reduce((t, r) => t + (r.contacts || 0), 0);
  const active = rows.filter(r => r.dials > 0).length;
  const best = rows.reduce((b, r) => (r.dials > (b ? b.dials : 0) ? r : b), null);
  return { rows: rows.length, dials, talk, contacts, active, best };
}

const bookedIn = (p, who, from, to) => p.booked.filter(r => r.setter === who && r.date_booked >= from && r.date_booked <= to).reduce((t, r) => t + r.booked, 0);

function activity(p, me, win, prior, team) {
  if (!p.sources.kpi.ok) return h('section', { class: 'card' }, h('p', { class: 'faint' }, "Sheet A couldn't be read, so there are no dial counts right now."));
  if (!me.on_dials_roster) {
    return h('section', { class: 'card' },
      h('h2', null, 'Activity'),
      h('p', { class: 'tile-value is-empty' }, 'No dial coverage'),
      h('p', { class: 'sub' }, "The dialer feed stores no rows for this name, so dials and talk time can't be shown. That is not the same as 0."));
  }
  const now = dialStats(p, me.setter, win.from, win.to);
  const before = dialStats(p, me.setter, prior.from, prior.to);
  const booked = bookedIn(p, me.setter, win.from, win.to);
  const perDay = now.active ? now.dials / now.active : null;
  const teamPerDay = median(team.map(t => dialStats(p, t, win.from, win.to)).filter(st => st.active).map(st => st.dials / st.active));
  const teamSpd = median(team.map(t => dialStats(p, t, win.from, win.to)).filter(st => st.dials).map(st => st.talk / st.dials));
  const teamRate = median(team.map(t => dialStats(p, t, win.from, win.to)).filter(st => st.dials).map(st => st.contacts / st.dials));
  const contactsTile = hasContacts(p) ? h('div', { class: 'mini-tile' },
    h('p', { class: 'label' }, defLink('contacts-60', 'Contacts')),
    h('p', { class: 'tile-value' }, fmtInt(now.contacts)),
    delta(now.contacts, before.rows ? before.contacts : null, 'previous period'),
    h('p', { class: 'sub' }, `${contactRate(now.contacts, now.dials)} of dials · ${now.active ? fmtInt(now.contacts / now.active) : '—'} per active day`),
    h('p', { class: 'sub faint' }, `Team median ${teamRate == null ? '—' : fmtPct1(teamRate)} of dials`)) : null;
  return h('section', { class: 'card activity' },
    h('h2', null, 'Activity'),
    h('div', { class: contactsTile ? 'tile-trio' : 'tile-pair' },
      h('div', { class: 'mini-tile' },
        h('p', { class: 'label' }, 'Dials'),
        h('p', { class: 'tile-value' }, fmtInt(now.dials)),
        delta(now.dials, before.rows ? before.dials : null, 'previous period'),
        h('p', { class: 'sub' }, `${fmtInt(now.active)} active days · ${perDay == null ? '—' : fmtInt(perDay)} per active day`),
        h('p', { class: 'sub faint' }, `Team median ${teamPerDay == null ? '—' : fmtInt(teamPerDay)} per active day`),
        now.best && now.best.dials ? h('p', { class: 'sub' }, `Best day: ${fmtInt(now.best.dials)} on ${dayLabel(now.best.date)}`) : null),
      contactsTile,
      h('div', { class: 'mini-tile' },
        h('p', { class: 'label' }, 'Talk time'),
        h('p', { class: 'tile-value' }, fmtDuration(now.talk)),
        delta(now.talk, before.rows ? before.talk : null, 'previous period', fmtDuration),
        h('p', { class: 'sub' }, `${now.active ? fmtDuration(now.talk / now.active) : '—'} per active day`))),
    h('div', { class: 'figures' },
      figure('Dials per booking', booked ? fmtInt(now.dials / booked) : '—', booked ? `${fmtInt(now.dials)} dials ÷ ${fmtInt(booked)} booked (Date Booked)` : 'nothing booked in this window'),
      figure('Seconds per dial', now.dials ? `${Math.round(now.talk / now.dials)}s` : '—', `Team median ${teamSpd == null ? '—' : Math.round(teamSpd) + 's'}`)),
    h('p', { class: 'sub faint' }, 'By dialer date. Active day = a day with dials > 0.'));
}

function figure(label, value, sub) {
  return h('div', { class: 'figure' }, h('p', { class: 'label' }, label), h('p', { class: 'figure-value' }, value), h('p', { class: 'sub faint' }, sub));
}

/** Change versus their own previous period, in neutral ink: this tab motivates, it doesn't grade. */
function delta(now, before, label, fmt = fmtInt) {
  if (before == null) return h('p', { class: 'delta faint' }, `no data for the ${label}`);
  const d = now - before;
  const sign = d > 0 ? '▲ ' : d < 0 ? '▼ ' : '';
  return h('p', { class: 'delta' }, `${sign}${d === 0 ? 'same as' : fmt(Math.abs(d)) + (d > 0 ? ' more than' : ' fewer than')} the ${label} (${fmt(before)})`);
}

// ---------------------------------------------------------------- funnel

function cohortTotals(p, who, from, to) {
  const t = { booked: 0, showed: 0, no_show: 0, rescheduled: 0, canceled: 0, other_status: 0, pending: 0, qualified_show: 0, pay_eligible: 0 };
  for (const r of p.cohort) if (r.setter === who && r.date_booked >= from && r.date_booked <= to) for (const k in t) t[k] += r[k];
  t.resolved = t.showed + t.no_show + t.rescheduled;
  return t;
}

/** Five bars on one count scale, all the same population: bookings made in the window. */
function funnel(p, who, win, prior) {
  if (!p.sources.tracker.ok) return h('section', { class: 'card' }, h('p', { class: 'faint' }, "Sheet B couldn't be read, so there are no appointment numbers right now."));
  const c = cohortTotals(p, who, win.from, win.to);
  const b = cohortTotals(p, who, prior.from, prior.to);
  const steps = [
    ['Booked', c.booked, null, b.booked],
    ['Resolved', c.resolved, c.booked, b.resolved],
    ['Showed', c.showed, c.resolved, b.showed],
    ['Qualified shows', c.qualified_show, c.showed, b.qualified_show],
    ['Pay eligible', c.pay_eligible, c.qualified_show, b.pay_eligible]
  ];
  const scale = Math.max(c.booked, 1);
  const open = c.booked - c.resolved;
  const settled = c.booked ? (c.resolved + c.canceled + c.other_status) / c.booked : 1;
  return h('section', { class: 'card funnel-card' },
    h('h2', null, defLink('cohort', 'What happened to what they booked')),
    h('p', { class: 'sub' }, 'Appointments booked in this window (by Date Booked), followed to their outcome. One population, so each step converts from the one above.'),
    c.booked ? h('div', { class: 'funnel' }, steps.map(([label, n, from, before]) => {
      const fill = h('div', { class: 'funnel-fill' });
      fill.style.width = `${((100 * n) / scale).toFixed(1)}%`;
      return h('div', { class: 'funnel-step' },
        h('div', { class: 'funnel-label' }, h('span', null, label),
          h('span', { class: 'funnel-n' }, fmtInt(n)),
          from != null ? h('span', { class: 'funnel-conv' }, from ? `${Math.round((100 * n) / from)}% of ${label === 'Resolved' ? 'booked' : 'the step above'}` : '—') : null),
        h('div', { class: 'funnel-track' }, fill),
        h('p', { class: 'funnel-prior faint' }, `previous period ${fmtInt(before)}`));
    })) : h('p', { class: 'faint' }, 'Nothing booked in this window.'),
    open ? h('p', { class: 'sub' }, `Not resolved yet: ${fmtInt(c.pending)} pending, ${fmtInt(c.canceled)} canceled` + (c.other_status ? `, ${fmtInt(c.other_status)} other status` : '') +
      `. ${Math.round(100 * settled)}% of these bookings have an outcome${settled < 0.95 ? ', so the lower steps will still grow' : ''}.`) : null,
    h('p', { class: 'sub faint' }, 'Resolved = Showed + No Show + Rescheduled. Pay eligible is the sheet’s own flag, read as-is.'));
}

// ---------------------------------------------------------------- goals (this month)

function goals(p, who) {
  const goal = p.goals.find(g => g.setter === who);
  const [first] = monthBounds(p.today_ct);
  const { day, daysInMonth, elapsed } = monthElapsed(p);
  const share = elapsed / daysInMonth;
  const booked = bookedIn(p, who, first, p.today_ct);
  const showed = p.outcomes.filter(r => r.setter === who && r.appt_date >= first && r.appt_date <= p.today_ct).reduce((t, r) => t + r.showed, 0);
  const bar = (label, actual, target, basis) => {
    if (!target) {
      return h('div', { class: 'goal' }, h('div', { class: 'goal-head' }, h('span', { class: 'label' }, label), h('span', { class: 'faint' }, 'no goal set')),
        h('p', { class: 'sub faint' }, `${fmtInt(actual)} so far this month (${basis}). Not paced against anything.`));
    }
    const scale = Math.max(target, actual) * 1.04;
    const pace = target * share;
    const fill = h('div', { class: 'goal-fill' });
    fill.style.width = `${((100 * actual) / scale).toFixed(1)}%`;
    const paceMark = h('div', { class: 'goal-pace', title: `Where they'd be today on an even pace: ${Math.round(pace)}` });
    paceMark.style.left = `${((100 * pace) / scale).toFixed(1)}%`;
    const end = h('div', { class: 'goal-end' });
    end.style.left = `${((100 * target) / scale).toFixed(1)}%`;
    return h('div', { class: 'goal' },
      h('div', { class: 'goal-head' }, h('span', { class: 'label' }, label),
        h('span', null, h('strong', null, fmtInt(actual)), ` of ${fmtInt(target)}`)),
      h('div', { class: 'goal-track' }, fill, paceMark, end),
      h('p', { class: 'sub faint' }, `${basis} · the marker is where an even pace puts them today (day ${day} of ${daysInMonth}): ${Math.round(pace)}`));
  };
  return h('section', { class: 'card goals-card' },
    h('h2', null, defLink('pace', `Monthly goals · ${dayLabel(first).split(', ')[1].split(' ')[0]} ${first.slice(0, 4)}`)),
    h('div', { class: 'goal-pair' },
      bar('Booked', booked, goal && goal.monthly_booked_goal, 'by Date Booked'),
      bar('Showed', showed, goal && goal.monthly_showed_goal, 'by Appointment Date, outcomes still landing')),
    h('p', { class: 'sub faint' }, "Goals come from the tracker's goals tab. This card always shows the current month, whatever window is picked above."));
}

// ---------------------------------------------------------------- trends

function trends(p, me, win, team) {
  const dates = dateRange(win.from, win.to);
  const dialsBy = new Map(p.dials.filter(r => r.setter === me.setter).map(r => [r.date, r.dials]));
  const sumBy = (arr, dateKey, field) => {
    const m = new Map();
    for (const r of arr) if (r.setter === me.setter) m.set(r[dateKey], (m.get(r[dateKey]) || 0) + r[field]);
    return m;
  };
  const booked = sumBy(p.booked, 'date_booked', 'booked');
  const qs = sumBy(p.outcomes, 'appt_date', 'qualified_show');
  // Team median line: the median, across team setters, of their per-active-day average.
  const perActive = field => median(team.map(t => {
    const st = dialStats(p, t, win.from, win.to);
    if (!st.active) return null;
    if (field === 'dials') return st.dials / st.active;
    if (field === 'booked') return bookedIn(p, t, win.from, win.to) / st.active;
    return p.outcomes.filter(r => r.setter === t && r.appt_date >= win.from && r.appt_date <= win.to).reduce((x, r) => x + r.qualified_show, 0) / st.active;
  }).filter(v => v != null));
  return h('section', { class: 'card' },
    h('h2', null, 'Day by day'),
    h('div', { class: 'trend3' },
      trendChart('Dials', 'dialer date', dates.map(d => (dialsBy.has(d) ? dialsBy.get(d) : null)), perActive('dials'), me.on_dials_roster),
      trendChart('Booked', 'Date Booked', dates.map(d => booked.get(d) || 0), perActive('booked'), true),
      trendChart('Qualified shows', 'Appointment Date', dates.map(d => qs.get(d) || 0), perActive('qs'), true)),
    h('p', { class: 'sub faint' }, `${dayLabel(win.from)} – ${dayLabel(win.to)}. The thin line is the team median per active dialing day; gaps are days with no data.`));
}

function trendChart(label, basis, values, teamMedian, covered) {
  const W = 300, H = 64, pad = 4;
  const known = values.filter(v => v != null);
  const total = known.reduce((t, v) => t + v, 0);
  if (!covered || !known.length) {
    return h('div', { class: 'trend-cell' }, h('p', { class: 'label' }, label),
      h('p', { class: 'trend-total faint' }, 'No dial coverage'), h('div', { class: 'trend-empty nodata' }));
  }
  const max = Math.max(...known, teamMedian || 0, 1);
  const x = i => pad + (i * (W - 2 * pad)) / Math.max(values.length - 1, 1);
  const y = v => H - pad - (v / max) * (H - 2 * pad);
  const runs = [];
  let run = [];
  values.forEach((v, i) => { if (v == null) { if (run.length) runs.push(run); run = []; } else run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`); });
  if (run.length) runs.push(run);
  return h('div', { class: 'trend-cell' },
    h('p', { class: 'label' }, label),
    h('p', { class: 'trend-total' }, fmtInt(total), h('span', { class: 'faint' }, ` in window · by ${basis}`)),
    s('svg', { class: 'trend-svg', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img',
      'aria-label': `${label} per day, ${fmtInt(total)} in the window${teamMedian != null ? `; team median ${teamMedian.toFixed(1)} per active day` : ''}` },
    teamMedian != null ? s('line', { x1: 0, x2: W, y1: y(teamMedian).toFixed(1), y2: y(teamMedian).toFixed(1), class: 'trend-median', 'vector-effect': 'non-scaling-stroke' }) : null,
    runs.map(pts => (pts.length > 1
      ? s('polyline', { points: pts.join(' '), class: 'trend-line', 'vector-effect': 'non-scaling-stroke' })
      : s('circle', { cx: pts[0].split(',')[0], cy: pts[0].split(',')[1], r: 2, class: 'trend-pt' })))),
    h('p', { class: 'sub faint' }, teamMedian != null ? `team median ${teamMedian < 10 ? teamMedian.toFixed(1) : fmtInt(teamMedian)} per active day` : 'no team median'));
}

// ---------------------------------------------------------------- EOD compliance

function eodCard(p, me, win) {
  const dates = dateRange(win.from, win.to);
  const sent = new Map(p.eod.filter(r => r.setter === me.setter && r.report_date >= win.from && r.report_date <= win.to).map(r => [r.report_date, r]));
  const active = new Set(p.dials.filter(r => r.setter === me.setter && r.dials > 0 && r.date >= win.from && r.date <= win.to).map(r => r.date));
  const sentOnActive = [...active].filter(d => sent.has(d)).length;
  const contacts = [...sent.values()].reduce((t, r) => t + (r.contacts || 0), 0);
  return h('section', { class: 'card' },
    h('h2', null, defLink('eod', 'End-of-day reports')),
    me.on_dials_roster
      ? h('p', { class: 'tile-value' }, `${fmtInt(sentOnActive)} of ${fmtInt(active.size)}`, h('span', { class: 'unit' }, ' active days with an EOD'))
      : h('p', { class: 'tile-value' }, fmtInt(sent.size), h('span', { class: 'unit' }, ' EODs sent (no dial coverage to compare with)')),
    h('div', { class: 'eod-strip', role: 'img', 'aria-label': `EOD sent on ${sent.size} of ${dates.length} days` },
      dates.map(d => h('span', {
        class: 'eod-day ' + (sent.has(d) ? 'is-sent' : active.has(d) ? 'is-missing' : 'is-off'),
        title: `${dayLabel(d)}: ${sent.has(d) ? 'EOD sent' : active.has(d) ? 'dialed, no EOD' : 'no dials, no EOD'}`
      }))),
    h('div', { class: 'legend' },
      h('span', { class: 'legend-item' }, h('span', { class: 'eod-day is-sent' }), 'sent'),
      h('span', { class: 'legend-item' }, h('span', { class: 'eod-day is-missing' }), 'dialed, no EOD'),
      h('span', { class: 'legend-item' }, h('span', { class: 'eod-day is-off' }), 'no dials')),
    h('p', { class: 'sub' }, `${fmtInt(contacts)} contacts self-reported on those EODs`),
    h('p', { class: 'sub faint' }, "By Report Date. These are the setter's own count; the dialer's contacts (calls over 60s) are under Activity."));
}

// ---------------------------------------------------------------- routing-queue speed

function speedCard(p, who, team) {
  if (!p.sources.router.ok) return h('section', { class: 'card' }, h('p', { class: 'faint' }, "Sheet C couldn't be read, so there's no speed-to-lead data right now."));
  const mine = p.speed_window.filter(r => r.who === who && r.by === 'assigned');
  const touches = p.speed_window.find(r => r.who === who && r.by === 'first_touch');
  const all = mine.find(r => r.routed_by === '*');
  const span = p.coverage.leads_from ? `${dayLabel(p.coverage.leads_from)} – ${dayLabel(p.coverage.leads_to)}` : '';
  const teamRotation = median(team.map(t => p.speed_window.find(r => r.who === t && r.by === 'assigned' && r.routed_by === 'rotation'))
    .filter(r => r && r.median_min != null).map(r => r.median_min));
  const mins = v => (v == null ? '—' : v < 90 ? `${Math.round(v)} min` : `${(v / 60).toFixed(1)} h`);
  return h('section', { class: 'card' },
    h('h2', null, defLink('min-touch', 'Speed on routed leads')),
    h('p', { class: 'sub' }, `Routing sheet, ${span} (its whole span; not affected by the window above)`),
    all ? h('div', { class: 'speed-head' },
      h('div', null, h('p', { class: 'label' }, 'Median to first touch'), h('p', { class: 'tile-value' }, mins(all.median_min)),
        h('p', { class: 'sub faint' }, `Team median on rotation leads ${mins(teamRotation)}`)),
      h('div', null, h('p', { class: 'label' }, 'Worked'), h('p', { class: 'tile-value' }, `${Math.round((100 * all.touched) / all.leads)}%`),
        h('p', { class: 'sub faint' }, `${fmtInt(all.touched)} of ${fmtInt(all.leads)} assigned`))) : h('p', { class: 'faint' }, 'No leads assigned to this name in the routing sheet.'),
    mine.length > 1 ? h('table', { class: 'mini-table' },
      h('thead', null, h('tr', null, ['Routed by', 'Leads', 'Worked', 'Within 1h', 'Median', 'Booked'].map((t, i) => h('th', { scope: 'col', class: i ? 'num' : null }, t)))),
      h('tbody', null, mine.filter(r => r.routed_by !== '*').sort((a, b) => b.leads - a.leads).map(r => h('tr', null,
        h('th', { scope: 'row' }, r.routed_by),
        h('td', { class: 'num' }, fmtInt(r.leads)),
        h('td', { class: 'num' }, `${Math.round((100 * r.touched) / r.leads)}%`),
        h('td', { class: 'num' }, fmtInt(r.within_1h)),
        h('td', { class: 'num' }, mins(r.median_min)),
        h('td', { class: 'num' }, fmtInt(r.booked)))))) : null,
    touches ? h('p', { class: 'sub' }, `First touches they made on anyone's leads: ${fmtInt(touches.leads)}, median ${mins(touches.median_min)}, ${fmtInt(touches.booked)} booked.`) : null,
    h('p', { class: 'sub faint' }, 'Assigned = the Setter column, which never updates when someone else picks the lead up; first touches credit whoever actually worked it. Medians are over touched leads.'));
}

function median(values) {
  const v = values.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
