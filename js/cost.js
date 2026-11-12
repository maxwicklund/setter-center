import { h } from './dom.js';
import { fmtInt, fmtMoney, dayLabel, addDays, mondayOf, hasSpend, costPerBooking } from './data.js';
import { defLink } from './ui.js';

// Cost per booking for the Floor tile and the Appointments card: RetireWell spend and total ad
// spend, each ÷ every setter booking. Spend is sheet D's Daily Report; bookings are the
// tracker's, by Date Booked.

/** Floor: today, with this week so far under it. */
export function costTile(p) {
  const ok = hasSpend(p) && p.sources.tracker.ok;
  const today = p.today_ct;
  const day = ok ? costPerBooking(p, today, today) : null;
  const week = ok ? costPerBooking(p, mondayOf(today), today) : null;
  const sub = !ok ? (p.sources.tracker.ok ? 'spend unavailable' : 'source unavailable')
    : `${day.spendDays ? '' : 'no spend row for today yet · '}this week so far: ${fmtMoney(week.rwCost)} RW · ${fmtMoney(week.totalCost)} total`;
  return h('section', { class: 'tile card kind-money' + (ok ? '' : ' is-unavailable') },
    h('p', { class: 'label' }, defLink('cost-per-booking', 'Cost per booking today')),
    ok ? h('p', { class: 'tile-value tile-value-pair', title: titleOf(day, 'Today') },
      h('span', null, fmtMoney(day.rwCost), h('span', { class: 'unit' }, ' RW')),
      h('span', null, fmtMoney(day.totalCost), h('span', { class: 'unit' }, ' total'))) : h('p', { class: 'tile-value' }, '—'),
    h('p', { class: 'sub' }, sub));
}

/** Appointments: the tab's window, then six Monday-to-Sunday weeks. */
export function costCard(p, win, windowText) {
  if (!hasSpend(p)) {
    return h('section', { class: 'card cost-card is-unavailable' },
      h('h2', null, defLink('cost-per-booking', 'Cost per booking')),
      h('p', { class: 'sub' }, "Sheet D (the lead router's Daily Report) couldn't be read, so there is no spend to divide right now."));
  }
  const c = costPerBooking(p, win.from, win.to);
  const gap = c.days - c.spendDays;
  return h('section', { class: 'card cost-card', 'aria-labelledby': 'cost-title' },
    h('div', { class: 'card-head' },
      h('h2', { id: 'cost-title' }, defLink('cost-per-booking', 'Cost per booking')),
      h('p', { class: 'sub' }, `${windowText} · spend by the ad account's day · all setter bookings by Date Booked, entered so far`)),
    h('div', { class: 'figures' },
      figure('RetireWell spend', fmtMoney(c.rwCost), `${fmtMoney(c.rwSpend)} RetireWell spend ÷ ${fmtInt(c.booked)} bookings`),
      figure('Total ad spend', fmtMoney(c.totalCost), `${fmtMoney(c.totalSpend)} total ad spend ÷ ${fmtInt(c.booked)} bookings`)),
    gap ? h('p', { class: 'sub' }, `${fmtInt(gap)} of ${fmtInt(c.days)} days have no spend row yet, so their spend isn't counted.`) : null,
    weeks(p),
    h('p', { class: 'sub faint footnote' },
      'Both divide by every booking on the tracker, whichever client it was for, so they won’t match the Command Center’s RW-only cost per booking. ' +
      'Total ad spend = the Daily Report’s Ad Spend + RetireWell Spend. Today is always so far: spend backfills through the day.'));
}

function weeks(p) {
  const thisMonday = mondayOf(p.today_ct);
  const rows = [5, 4, 3, 2, 1, 0].map(k => {
    const from = addDays(thisMonday, -7 * k);
    return { from, current: !k, c: costPerBooking(p, from, k ? addDays(from, 6) : p.today_ct) };
  });
  const num = (v, cls = '') => h('td', { class: 'num' + cls }, v);
  return h('div', { class: 'table-scroll' },
    h('table', { class: 'mini-table cost-weeks' },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, 'Week of'),
        h('th', { scope: 'col', class: 'num' }, 'Booked'),
        h('th', { scope: 'col', class: 'num' }, 'RW spend'), h('th', { scope: 'col', class: 'num' }, 'RW cost'),
        h('th', { scope: 'col', class: 'num' }, 'Total spend'), h('th', { scope: 'col', class: 'num' }, 'Total cost'))),
      h('tbody', null, rows.map(({ from, current, c }) => h('tr', { class: current ? 'is-partial' : '', title: titleOf(c, `Week of ${dayLabel(from)}`) },
        h('th', { scope: 'row' }, current ? 'This week (so far)' : dayLabel(from).split(', ')[1]),
        num(fmtInt(c.booked)),
        num(fmtMoney(c.rwSpend)), num(fmtMoney(c.rwCost), ' strong'),
        num(fmtMoney(c.totalSpend)), num(fmtMoney(c.totalCost), ' strong'))))));
}

function titleOf(c, when) {
  return `${when}: ${fmtInt(c.booked)} bookings. RW ${fmtMoney(c.rwSpend)} ÷ ${fmtInt(c.booked)} = ${fmtMoney(c.rwCost)}. ` +
    `Total ${fmtMoney(c.totalSpend)} ÷ ${fmtInt(c.booked)} = ${fmtMoney(c.totalCost)}.`;
}

function figure(label, value, sub) {
  return h('div', { class: 'figure' }, h('p', { class: 'label' }, label), h('p', { class: 'figure-value' }, value), h('p', { class: 'sub faint' }, sub));
}
