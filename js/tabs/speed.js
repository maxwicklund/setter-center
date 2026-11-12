import { h, s } from '../dom.js';
import { fmtInt, dayLabel, ctClock, daysBetween } from '../data.js';
import { tag, segmented, defLink } from '../ui.js';

// Tab 5, Speed to Lead. Sheet C is the only source that sees a lead nobody touched.
// Per-lead figures (buckets, the unworked pile, medians) were reduced to counts in Apps
// Script over the sheet's whole live span, so this tab always shows that span. No target:
// the 1-hour mark is a reference line only.

const BUCKETS = [['le5m', '≤ 5 min'], ['le15m', '≤ 15 min'], ['le1h', '≤ 1 hour'], ['le4h', '≤ 4 hours'], ['le24h', '≤ 24 hours'], ['gt24h', '> 24 hours'], ['never', 'Never']];
const AGES = [['lt1h', '< 1 hour'], ['1to4h', '1–4 hours'], ['4to24h', '4–24 hours'], ['1to3d', '1–3 days'], ['gt3d', '> 3 days'], ['unknown', 'age unknown']];
const SMALL_BUCKET = 20;   // book rates on fewer leads than this are greyed
const SMALL_ROTATION = 20; // setters with fewer rotation leads are listed, not ranked

const view = { routed: 'all' };

export function renderSpeed(p, ix) {
  const root = h('div', { class: 'speed-tab' });
  const draw = () => root.replaceChildren(...content(p, ix, draw));
  draw();
  return root;
}

function content(p, ix, draw) {
  if (!p.sources.router.ok) {
    return [h('div', { class: 'banner banner-warn' }, "Sheet C (setter routing) couldn't be read, so there's no speed-to-lead data right now.")];
  }
  const types = [...new Set(p.speed_buckets.map(r => r.routed_by))].sort((a, b) => count(p.speed_buckets, b) - count(p.speed_buckets, a));
  if (view.routed !== 'all' && !types.includes(view.routed)) view.routed = 'all';
  const keep = r => view.routed === 'all' || r.routed_by === view.routed;
  const buckets = p.speed_buckets.filter(keep);
  const ages = p.unworked_age.filter(keep);
  const from = p.coverage.leads_from;
  const to = p.coverage.leads_to;
  const span = from ? `${dayLabel(from)} – ${dayLabel(to)} (${daysBetween(from, to) + 1} days)` : '—';
  const stamp = p.sources.router.stamp_ct;

  return [
    h('div', { class: 'controls' },
      segmented('Lead type', [['all', 'All lead types'], ...types.map(t => [t, t])], view.routed, v => { view.routed = v; draw(); }),
      h('span', { class: 'controls-gap' }),
      h('span', { class: 'mix-label' }, `Routing sheet, its whole span: ${span}`)),
    h('p', { class: 'sub faint' }, `The routing sheet starts ${from ? dayLabel(from) : '—'}; there is no speed-to-lead data before that. ` +
      'Lead type changes the tiles, the unworked pile and the bucket chart; the tables below always show every type.'),
    tiles(p, buckets, ages),
    pile(ages, stamp),
    bucketChart(buckets),
    dailyTrend(p),
    queueTable(p, ix),
    rotationTable(p, ix)
  ];
}

const count = (rows, type) => rows.filter(r => r.routed_by === type).reduce((t, r) => t + r.leads, 0);
const sumLeads = (rows, keys) => rows.filter(r => keys.includes(r.bucket)).reduce((t, r) => t + r.leads, 0);

function mins(v) {
  if (v == null) return '—';
  if (v < 90) return `${Math.round(v)} min`;
  if (v < 48 * 60) return `${(v / 60).toFixed(1)} h`;
  return `${(v / 1440).toFixed(1)} days`;
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '—');

// ---------------------------------------------------------------- tiles

function tiles(p, buckets, ages) {
  const leads = buckets.reduce((t, r) => t + r.leads, 0);
  const never = sumLeads(buckets, ['never']);
  const over24 = ages.filter(a => a.age === '1to3d' || a.age === 'gt3d').reduce((t, a) => t + a.leads, 0);
  const fast = sumLeads(buckets, ['le5m', 'le15m', 'le1h']);
  const tile = (label, value, sub, kind) => h('section', { class: 'tile card' + (kind ? ` kind-${kind}` : '') }, h('p', { class: 'label' }, label), h('p', { class: 'tile-value' }, value), h('p', { class: 'sub' }, sub));
  return h('div', { class: 'tiles tiles-4' },
    tile('Leads in', fmtInt(leads), 'every lead the routing sheet logged', 'count'),
    tile(defLink('worked', 'Never worked'), fmtInt(never), `${pct(never, leads)} of leads · ${fmtInt(over24)} of them waiting over 24 hours`),
    tile('Worked within 1 hour', fmtInt(fast), `${pct(fast, leads)} of leads`),
    tile(defLink('min-touch', 'Median to first touch'), mins(p.speed_window_median_min), 'over touched leads, all lead types · the mean is never used'));
}

// ---------------------------------------------------------------- unworked pile

function pile(ages, stamp) {
  const total = ages.reduce((t, a) => t + a.leads, 0);
  const rows = AGES.map(([key, label], i) => ({ key, label, n: ages.filter(a => a.age === key).reduce((t, a) => t + a.leads, 0), step: key === 'unknown' ? 'nodata' : `s${i + 1}` }))
    .filter(r => r.n > 0);
  return h('section', { class: 'card' },
    h('h2', null, 'The unworked pile, by how long it has waited'),
    h('p', { class: 'sub' }, `${fmtInt(total)} leads never touched · age measured against the routing sheet's own refresh stamp (${ctClock(stamp)}), not your clock`),
    total ? h('div', { class: 'pile', role: 'img', 'aria-label': rows.map(r => `${r.label}: ${r.n}`).join('; ') },
      rows.map(r => {
        const seg = h('span', { class: `pile-seg hc ${r.step}`, title: `${r.label}: ${r.n} leads` }, (100 * r.n) / total >= 7 ? fmtInt(r.n) : '');
        seg.style.width = `${((100 * r.n) / total).toFixed(2)}%`;
        return seg;
      })) : h('p', { class: 'faint' }, 'No untouched leads.'),
    total ? h('div', { class: 'legend' }, rows.map(r => h('span', { class: 'legend-item' }, h('span', { class: `swatch hc ${r.step}` }), `${r.label} `, h('strong', null, fmtInt(r.n))))) : null);
}

// ---------------------------------------------------------------- the bucket chart

/**
 * Lead count and book rate per time-to-first-touch bucket, drawn as two aligned rows on
 * one shared set of columns rather than one chart with two y-axes.
 */
function bucketChart(buckets) {
  const cols = BUCKETS.map(([key, label]) => {
    const rows = buckets.filter(r => r.bucket === key);
    const leads = rows.reduce((t, r) => t + r.leads, 0);
    const booked = rows.reduce((t, r) => t + r.booked, 0);
    return { key, label, leads, booked, rate: leads ? booked / leads : null };
  });
  const noTime = buckets.filter(r => r.bucket === 'touched_no_time').reduce((t, r) => t + r.leads, 0);
  const maxLeads = Math.max(...cols.map(c => c.leads), 1);
  const maxRate = Math.max(...cols.map(c => c.rate || 0), 0.01);
  const rateTop = Math.ceil((maxRate * 100) / 5) * 5 / 100; // round the axis up to a clean 5%
  const RH = 120; // px height of the rate row
  const pts = cols.map((c, i) => (c.rate == null ? null : [((i + 0.5) / cols.length) * 100, RH - (c.rate / rateTop) * (RH - 18) - 4]));

  const rateRow = h('div', { class: 'bk-rate', role: 'img', 'aria-label': cols.map(c => `${c.label}: book rate ${c.rate == null ? 'none' : Math.round(c.rate * 100) + '%'} of ${c.leads}`).join('; ') },
    s('svg', { class: 'bk-line', viewBox: `0 0 100 ${RH}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      [0.5, 1].map(f => s('line', { x1: 0, x2: 100, y1: RH - f * (RH - 18) - 4, y2: RH - f * (RH - 18) - 4, class: 'bk-grid', 'vector-effect': 'non-scaling-stroke' })),
      s('polyline', { points: pts.filter(Boolean).map(([x, y]) => `${x},${y.toFixed(1)}`).join(' '), class: 'bk-path', 'vector-effect': 'non-scaling-stroke' })),
    h('span', { class: 'bk-axis', 'aria-hidden': 'true' }, `${Math.round(rateTop * 100)}%`),
    h('span', { class: 'bk-axis bk-axis-mid', 'aria-hidden': 'true' }, `${Math.round(rateTop * 50)}%`),
    cols.map((c, i) => {
      if (!pts[i]) return null;
      const dot = h('span', { class: 'bk-dot' + (c.leads < SMALL_BUCKET ? ' is-small' : ''), title: `${c.label}: ${c.booked} booked of ${c.leads} (${Math.round(c.rate * 100)}%)` },
        h('span', { class: 'bk-dot-val' }, `${Math.round(c.rate * 100)}%`));
      dot.style.left = `${pts[i][0]}%`;
      dot.style.top = `${pts[i][1]}px`;
      return dot;
    }),
    h('span', { class: 'bk-ref', title: '1 hour: a reference line, not a target' }));

  const countRow = h('div', { class: 'bk-cols' }, cols.map(c => {
    const bar = h('div', { class: 'bk-bar' + (c.key === 'never' ? ' is-never' : '') });
    bar.style.height = `${Math.max(2, (100 * c.leads) / maxLeads).toFixed(1)}%`;
    return h('div', { class: 'bk-col', title: `${c.label}: ${c.leads} leads` }, h('span', { class: 'bk-n' }, fmtInt(c.leads)), h('div', { class: 'bk-track' }, bar));
  }), h('span', { class: 'bk-ref' }));

  return h('section', { class: 'card bucket-card' },
    h('h2', null, 'Does calling fast matter? Book rate by time to first touch'),
    h('p', { class: 'sub' }, 'Each column is a group of leads by how long they waited for the first touch. Top: the share that booked. Bottom: how many leads. Book rate = booked ÷ leads in that group.'),
    h('div', { class: 'bk-chart' },
      h('p', { class: 'bk-row-label' }, h('span', { class: 'swatch k-booked-line' }), 'Book rate'),
      rateRow,
      h('p', { class: 'bk-row-label' }, h('span', { class: 'swatch k-leads' }), 'Leads'),
      countRow,
      h('div', { class: 'bk-labels' }, cols.map(c => h('span', null, c.label))),
      h('p', { class: 'bk-ref-note' }, h('span', { class: 'bk-ref-key' }), defLink('speed-target', '1 hour — reference, not a target'))),
    h('p', { class: 'sub faint' }, `Book rates on fewer than ${SMALL_BUCKET} leads are greyed: too few to read much into. ` +
      `Lead type drives book rate more than speed does, so compare like with like using the lead-type buttons above.` +
      (noTime ? ` ${fmtInt(noTime)} touched leads had no time recorded and aren't in any column.` : '')));
}

// ---------------------------------------------------------------- daily trend

function dailyTrend(p) {
  const byDate = new Map();
  for (const r of p.speed_daily.concat(p.speed_daily_queues)) {
    const d = byDate.get(r.date) || { leads: 0, within: 0 };
    d.leads += r.leads;
    d.within += r.within_1h;
    byDate.set(r.date, d);
  }
  const dates = [...byDate.keys()].sort();
  if (!dates.length) return null;
  return h('section', { class: 'card' },
    h('h2', null, 'Share of leads worked within 1 hour, by day'),
    h('p', { class: 'sub' }, "By the lead's date · from the routing sheet's daily tab · every queue, House included"),
    h('div', { class: 'day-cols', role: 'img', 'aria-label': dates.map(d => `${d}: ${pct(byDate.get(d).within, byDate.get(d).leads)}`).join('; ') },
      dates.map(d => {
        const v = byDate.get(d);
        const share = v.leads ? v.within / v.leads : 0;
        const bar = h('div', { class: 'day-bar' + (v.leads < 10 ? ' is-small' : '') });
        bar.style.height = `${Math.max(2, 100 * share).toFixed(1)}%`;
        return h('div', { class: 'day-col', title: `${dayLabel(d)}: ${v.within} of ${v.leads} leads within 1 hour (${pct(v.within, v.leads)})` },
          h('div', { class: 'day-track' }, bar),
          h('span', { class: 'day-lbl' }, Number(d.slice(8)) === 1 || d === dates[0] ? dayLabel(d).split(', ')[1] : String(Number(d.slice(8)))));
      })),
    h('p', { class: 'sub faint' }, 'Axis 0–100%. Days with fewer than 10 leads are drawn lighter.'));
}

// ---------------------------------------------------------------- per queue

/** Assigned queue (who the lead was routed to) beside first touches (who actually worked it). */
function queueTable(p, ix) {
  const assigned = new Map(p.speed_window.filter(r => r.by === 'assigned' && r.routed_by === '*').map(r => [r.who, r]));
  const touched = new Map(p.speed_window.filter(r => r.by === 'first_touch').map(r => [r.who, r]));
  const mix = new Map();
  for (const r of p.first_touch.map(x => ({ ...x, who: x.setter })).concat(p.first_touch_queues.map(x => ({ ...x, who: x.queue })))) {
    const m = mix.get(r.who) || { house: 0, other: 0 };
    m.house += r.house;
    m.other += r.other;
    mix.set(r.who, m);
  }
  const names = [...new Set([...assigned.keys(), ...touched.keys()])];
  const isQueue = n => (assigned.get(n) || touched.get(n)).kind === 'queue';
  names.sort((a, b) => ((assigned.get(b) || {}).leads || 0) - ((assigned.get(a) || {}).leads || 0) || ((touched.get(b) || {}).leads || 0) - ((touched.get(a) || {}).leads || 0));
  return h('section', { class: 'card' },
    h('h2', null, defLink('worked', 'By queue: assigned leads beside the first touches each person made')),
    h('p', { class: 'sub' }, '"Assigned" is the routing Setter column, which never changes when someone else picks a lead up. "First touches" credits whoever actually worked the lead, on anyone\'s queue. Queues keep the sheet\'s own text.'),
    h('div', { class: 'table-scroll' }, h('table', { class: 'mini-table speed-table' },
      h('thead', null,
        h('tr', null, h('th', { scope: 'col', rowspan: 2 }, 'Queue'), h('th', { scope: 'colgroup', colspan: 5, class: 'grp' }, 'Assigned to this queue'),
          h('th', { scope: 'colgroup', colspan: 3, class: 'grp' }, 'First touches they made')),
        h('tr', null, ['Leads', 'Worked', 'Within 1h', 'Median', 'Booked', 'Touches', 'On house / others’', 'Median'].map(t => h('th', { scope: 'col', class: 'num' }, t)))),
      h('tbody', null, names.map(n => {
        const a = assigned.get(n);
        const t = touched.get(n);
        const m = mix.get(n);
        const queue = isQueue(n);
        return h('tr', { class: queue ? 'is-queue' : null },
          h('th', { scope: 'row' }, queue ? n : ix.label(n), queue ? h('span', { class: 'tag' }, 'queue') : tag(ix.status(n))),
          h('td', { class: 'num' }, a ? fmtInt(a.leads) : '—'),
          h('td', { class: 'num' }, a ? pct(a.touched, a.leads) : '—'),
          h('td', { class: 'num' }, a ? pct(a.within_1h, a.leads) : '—'),
          h('td', { class: 'num' }, a ? mins(a.median_min) : '—'),
          h('td', { class: 'num' }, a ? fmtInt(a.booked) : '—'),
          h('td', { class: 'num' }, t ? fmtInt(t.leads) : '—'),
          h('td', { class: 'num' }, m ? fmtInt(m.house + m.other) : '—'),
          h('td', { class: 'num' }, t ? mins(t.median_min) : '—'));
      })))),
    h('p', { class: 'sub faint' }, 'Medians are over touched leads. "On house / others’" counts from the daily first-touch tab, by touch date.'));
}

// ---------------------------------------------------------------- rotation only

/** The only fair setter-vs-setter comparison: rotation leads, where lead quality is alike. */
function rotationTable(p, ix) {
  const rows = p.speed_window.filter(r => r.by === 'assigned' && r.routed_by === 'rotation' && r.kind === 'setter');
  const ranked = rows.filter(r => r.leads >= SMALL_ROTATION).sort((a, b) => b.within_1h / b.leads - a.within_1h / a.leads || b.leads - a.leads);
  const small = rows.filter(r => r.leads < SMALL_ROTATION);
  return h('section', { class: 'card' },
    h('h2', null, defLink('routed-by', 'Rotation leads only: the like-for-like comparison')),
    h('p', { class: 'sub' }, 'Manual and reassigned leads are the recycled pile and book far less whoever works them, so setters are compared on rotation leads alone.'),
    ranked.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'mini-table speed-table' },
      h('thead', null, h('tr', null, ['Setter', 'Rotation leads', 'Worked', 'Within 1h', 'Median to first touch', 'Booked', 'Book rate'].map((t, i) => h('th', { scope: 'col', class: i ? 'num' : null }, t)))),
      h('tbody', null, ranked.map(r => h('tr', null,
        h('th', { scope: 'row' }, ix.label(r.who), tag(ix.status(r.who))),
        h('td', { class: 'num' }, fmtInt(r.leads)),
        h('td', { class: 'num' }, pct(r.touched, r.leads)),
        h('td', { class: 'num strong' }, pct(r.within_1h, r.leads)),
        h('td', { class: 'num' }, mins(r.median_min)),
        h('td', { class: 'num' }, fmtInt(r.booked)),
        h('td', { class: 'num' }, pct(r.booked, r.leads))))))) : h('p', { class: 'faint' }, `Nobody has ${SMALL_ROTATION} or more rotation leads in the span.`),
    small.length ? h('p', { class: 'sub faint' }, `Fewer than ${SMALL_ROTATION} rotation leads, not ranked: ` +
      small.map(r => `${ix.label(r.who)} (${r.booked}/${r.leads} booked)`).join(', ')) : null,
    h('p', { class: 'sub faint' }, 'Sorted by share worked within 1 hour. No speed target exists; this is a comparison, not a grade.'));
}
