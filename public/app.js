/* LEVEL — implementation of Split.dc.html, over a shared event.
   The settle math and the block-flight animation are unchanged from the design
   doc; what they read is now server state rather than this browser's. */
import {
  EventStore, toCents, fromCents, toQty,
  recentIds, rememberVisit, fetchSummaries, myName, rememberName
} from './store.js';

const SHOW_SHARE_LINE = true;
const ANIM_SPEED = 1;

/* ── math ─────────────────────────────────────────────────────────────── */

const ease = p => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;

/* Greedy settle-up: biggest creditor against biggest debtor, repeatedly.
   Lifted from the design doc so the numbers match the mockup exactly. */
function settle(people) {
  const vals = people.map(p => +p.amt || 0);
  const total = vals.reduce((s, v) => s + v, 0);
  const share = people.length ? total / people.length : 0;
  const C = people.map((p, i) => ({ i, name: p.name, d: vals[i] - share })).filter(x => x.d > 0.005).sort((a, b) => b.d - a.d);
  const D = people.map((p, i) => ({ i, name: p.name, d: share - vals[i] })).filter(x => x.d > 0.005).sort((a, b) => b.d - a.d);
  const tx = [];
  let ci = 0, di = 0;
  while (ci < C.length && di < D.length && tx.length < 40) {
    const m = Math.min(C[ci].d, D[di].d);
    tx.push({ from: D[di].i, fromName: D[di].name, to: C[ci].i, toName: C[ci].name, amt: Math.round(m * 100) / 100 });
    C[ci].d -= m; D[di].d -= m;
    if (C[ci].d < 0.005) ci++;
    if (D[di].d < 0.005) di++;
  }
  return { total, share, tx, vals };
}

/* Plain numbers — the ledger has no currency, so nothing is prefixed and
   trailing zeros are dropped: 5000, 33.33, 0. */
function fmt(v) {
  const n = Math.abs(v) < 0.005 ? 0 : Math.round(v * 100) / 100;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
const short = s => (s || '—').toUpperCase();

/* ── state ────────────────────────────────────────────────────────────── */

const eventId = decodeURIComponent(location.pathname.split('/')[2] || '');
const store = new EventStore(eventId);

let anim = { phase: 'input', step: -1, p: 0 };
let runToken = null;

const people = () => store.event?.people ?? [];
/** Each person's bar is the sum of their entries, so settle() needs no change. */
const asShares = () => people().map(p => ({ name: p.name, amt: p.totalCents / 100 }));

function resetAnim() {
  runToken = null;
  anim = { phase: 'input', step: -1, p: 0 };
  store.setPaused(false);
}

/* ── geometry ─────────────────────────────────────────────────────────── */

const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, Math.floor(v)));
const isDesktop = () => window.matchMedia('(min-width: 1000px)').matches;

/* Bar box, gaps and flight arc per breakpoint — 1a on the phone, 1c on the wall. */
function geo(n) {
  n = Math.max(1, n);
  return isDesktop()
    ? { H: 260, G: 24, plotH: 300, chipW: 104, rise: 60, lift: 40, dur: 1050, W: clamp(48, 150, (520 - (n - 1) * 24) / n) }
    : { H: 200, G: 16, plotH: 230, chipW: 72, rise: 46, lift: 32, dur: 950, W: clamp(38, 120, (344 - (n - 1) * 16) / n) };
}

/* ── dom ──────────────────────────────────────────────────────────────── */

const $ = id => document.getElementById(id);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

const ui = {
  conn: $('conn'), connLabel: $('conn-label'), banner: $('banner'),
  evName: $('ev-name'), shareUrl: $('share-url'), copy: $('copy'), whoCount: $('who-count'),
  history: $('history'), rows: $('rows'), add: $('add'), total: $('total'), share: $('share'),
  caption: $('caption'), phase: $('phase'), plot: $('plot'), bars: $('bars'),
  axis: $('axis'), shareline: $('shareline'), chip: $('chip'), chipAmt: $('chip-amt'),
  cta: $('cta'), result: $('result'), reshead: $('reshead'), txcount: $('txcount'),
  txlist: $('txlist'), saveBtn: $('save')
};

let barEls = [], axisEls = [];
let rowSig = null, chartSig = null, lastTxShown = null;
let pendingFocus = null;

/* Never overwrite a field someone is typing in — the whole point of a shared
   ledger is that two people edit at once. */
const setValue = (input, value) => { if (document.activeElement !== input) input.value = value; };

/* ── rows: people and their entries ───────────────────────────────────── */

const rowsSignature = () =>
  people().map(p => p.id + '[' + p.items.map(i => i.id).join(',') + ']').join('|');

function buildRows() {
  ui.rows.innerHTML = '';
  people().forEach(p => {
    const wrap = el('div', 'person');
    wrap.dataset.id = p.id;

    const head = el('div', 'person-head');
    const name = el('input', 'input name');
    name.value = p.name;
    name.placeholder = 'Name';
    name.maxLength = 60;
    name.setAttribute('aria-label', 'Name');
    name.addEventListener('input', () => { rememberName(name.value); store.renamePerson(p.id, name.value); });

    const total = el('div', 'person-total');
    total.textContent = fmt(p.totalCents / 100);

    const del = el('button', 'btn btn-secondary del');
    del.type = 'button';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Remove ' + (p.name || 'person'));
    del.addEventListener('click', () => { resetAnim(); store.removePerson(p.id); });

    head.append(name, total, del);

    const items = el('div', 'items');
    p.items.forEach(it => items.append(itemRow(it)));

    const addItem = el('button', 'btn btn-ghost add-item');
    addItem.type = 'button';
    addItem.textContent = '+ ADD SPENDING';
    addItem.addEventListener('click', () => {
      pendingFocus = { person: p.id, kind: 'item' };
      resetAnim();
      store.addItem(p.id, '', 0, 1);
    });

    wrap.append(head, items, addItem);
    ui.rows.append(wrap);
  });

  if (!people().length) {
    const e = el('div', 'empty');
    e.textContent = 'Nobody here yet. Add yourself, then send the link.';
    ui.rows.append(e);
  }

  applyPendingFocus();
}

function itemRow(it) {
  const row = el('div', 'item');
  row.dataset.id = it.id;

  const label = el('input', 'input label');
  label.value = it.label;
  label.placeholder = 'What for?';
  label.maxLength = 80;
  label.setAttribute('aria-label', 'What the money went on');
  label.addEventListener('input', () => store.updateItem(it.id, { label: label.value }));

  const qty = el('input', 'input qty');
  qty.value = it.qty;
  qty.inputMode = 'numeric';
  qty.title = 'How many';
  qty.setAttribute('aria-label', 'How many');
  qty.addEventListener('input', () => { resetAnim(); store.updateItem(it.id, { qty: toQty(qty.value) }); });
  qty.addEventListener('blur', () => { qty.value = toQty(qty.value); });

  const amt = el('input', 'input amt');
  amt.value = fromCents(it.amountCents);
  amt.inputMode = 'decimal';
  amt.title = 'Each';
  amt.setAttribute('aria-label', 'Amount each');
  amt.addEventListener('input', () => { resetAnim(); store.updateItem(it.id, { amountCents: toCents(amt.value) }); });
  /* tidy the number only once they leave the field, so "12." can be typed */
  amt.addEventListener('blur', () => { amt.value = fromCents(toCents(amt.value)); });

  const del = el('button', 'btn btn-secondary del');
  del.type = 'button';
  del.textContent = '×';
  del.setAttribute('aria-label', 'Remove entry');
  del.addEventListener('click', () => { resetAnim(); store.removeItem(it.id); });

  /* only worth saying when there is more than one of something */
  const sum = el('div', 'item-sum');
  sum.textContent = lineSum(it);
  sum.hidden = it.qty <= 1;

  row.append(label, qty, amt, del, sum);
  return row;
}

const lineSum = it => it.qty + ' × ' + fmt(it.amountCents / 100) + ' = ' + fmt(it.amountCents * it.qty / 100);

function refreshRowValues() {
  people().forEach(p => {
    const wrap = ui.rows.querySelector(`.person[data-id="${p.id}"]`);
    if (!wrap) return;
    setValue(wrap.querySelector('.name'), p.name);
    wrap.querySelector('.person-total').textContent = fmt(p.totalCents / 100);
    p.items.forEach(it => {
      const row = wrap.querySelector(`.item[data-id="${it.id}"]`);
      if (!row) return;
      setValue(row.querySelector('.label'), it.label);
      setValue(row.querySelector('.qty'), it.qty);
      setValue(row.querySelector('.amt'), fromCents(it.amountCents));
      const sum = row.querySelector('.item-sum');
      sum.textContent = lineSum(it);
      sum.hidden = it.qty <= 1;
    });
  });
}

function applyPendingFocus() {
  if (!pendingFocus) return;
  const { person, kind } = pendingFocus;
  pendingFocus = null;
  if (kind === 'person') {
    ui.rows.querySelector('.person:last-of-type .name')?.focus();
  } else {
    ui.rows.querySelector(`.person[data-id="${person}"] .item:last-of-type .label`)?.focus();
  }
}

/* ── rail ─────────────────────────────────────────────────────────────── */

function renderShare() {
  const ev = store.event;
  if (!ev) return;
  setValue(ui.evName, ev.name);
  ui.shareUrl.textContent = location.origin + '/e/' + ev.id;
  const n = ev.people.length;
  ui.whoCount.textContent = n + (n === 1 ? ' person' : ' people')
    + (ev.settledAt ? ' · settled' : '');
}

async function renderRecent() {
  const ids = recentIds().filter(id => id !== eventId).slice(0, 5);
  ui.history.innerHTML = '';
  if (!ids.length) {
    const e = el('div', 'empty');
    e.textContent = 'No other events opened in this browser yet.';
    ui.history.append(e);
    return;
  }
  let events = [];
  try { ({ events } = await fetchSummaries(ids)); } catch (_) { return; }
  ui.history.innerHTML = '';
  events.forEach(ev => {
    const a = el('a', 'hist hist-link');
    a.href = '/e/' + ev.id;
    const left = el('div');
    const label = el('div', 'hist-label');
    label.textContent = ev.name;
    const meta = el('div', 'hist-meta');
    meta.textContent = new Date(ev.createdAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
      + ' · ' + ev.people + (ev.people === 1 ? ' person' : ' people')
      + (ev.settledAt ? ' · settled' : '');
    const total = el('div', 'hist-total');
    total.textContent = fmt(ev.totalCents / 100);
    /* desktop tucks the total under the label, phone keeps it in its own column */
    if (isDesktop()) {
      const metaRow = el('div', 'hist-row');
      metaRow.append(meta, total);
      left.append(label, metaRow);
      a.append(left);
    } else {
      left.append(label, meta);
      a.append(left, total);
    }
    ui.history.append(a);
  });
}

/* ── chart ────────────────────────────────────────────────────────────── */

function buildChart() {
  const n = people().length;
  const g = geo(n);
  ui.plot.style.height = g.plotH + 'px';
  ui.bars.style.gap = g.G + 'px';
  ui.axis.style.gap = g.G + 'px';
  ui.bars.innerHTML = '';
  ui.axis.innerHTML = '';
  barEls = []; axisEls = [];
  for (let i = 0; i < n; i++) {
    const col = el('div', 'bar-col'); col.style.width = g.W + 'px';
    const ghost = el('div', 'bar-ghost');
    const amt = el('div', 'bar-amt');
    const fill = el('div', 'bar-fill');
    col.append(ghost, amt, fill);
    ui.bars.append(col);
    barEls.push({ ghost, amt, fill });

    const ac = el('div', 'axis-col'); ac.style.width = g.W + 'px';
    const nm = el('div', 'axis-name');
    const dl = el('div', 'axis-delta');
    ac.append(nm, dl);
    ui.axis.append(ac);
    axisEls.push({ name: nm, delta: dl });
  }
}

function factors(tx) {
  const { phase, step, p } = anim;
  return tx.map((t, k) => phase === 'done' ? 1 : (phase === 'run' ? (k < step ? 1 : (k === step ? ease(p) : 0)) : 0));
}

/* Bar heights mid-flight: each transfer drains the payer's bar into the payee's. */
function applied(tx, vals) {
  const eff = vals.slice();
  factors(tx).forEach((f, k) => { eff[tx[k].to] -= tx[k].amt * f; eff[tx[k].from] += tx[k].amt * f; });
  return eff;
}

function update() {
  const ppl = asShares();
  const { total, share, tx, vals } = settle(ppl);
  const g = geo(ppl.length);
  const scale = g.H / Math.max(1, Math.max(1, ...vals));
  const eff = applied(tx, vals);

  ui.total.textContent = fmt(total);
  ui.share.textContent = fmt(share);

  ppl.forEach((p, i) => {
    const b = barEls[i], a = axisEls[i];
    if (!b) return;
    b.amt.textContent = fmt(eff[i]);
    b.fill.style.height = Math.max(2, Math.round(eff[i] * scale)) + 'px';
    b.fill.style.background = vals[i] > share + 0.005 ? 'var(--color-accent)'
      : (vals[i] < share - 0.005 ? 'var(--color-neutral-300)' : 'var(--color-neutral-500)');
    b.ghost.style.height = Math.max(2, Math.round(vals[i] * scale)) + 'px';

    const d = share - vals[i];
    a.name.textContent = short(p.name);
    a.delta.textContent = Math.abs(d) < 0.005 ? 'even' : (d > 0 ? 'owes ' + fmt(d) : 'gets ' + fmt(-d));
    a.delta.className = 'axis-delta ' + (d > 0.005 ? 'delta-owes' : 'delta-even');
  });

  ui.shareline.hidden = !SHOW_SHARE_LINE;
  ui.shareline.style.bottom = Math.round(share * scale) + 'px';

  /* the block in flight */
  const t = anim.phase === 'run' ? tx[anim.step] : null;
  if (t) {
    const e = ease(anim.p);
    const x = i => i * (g.W + g.G) + g.W / 2;
    const x0 = x(t.to), x1 = x(t.from);
    const y0 = eff[t.to] * scale, y1 = eff[t.from] * scale;
    ui.chip.hidden = false;
    ui.chip.style.width = g.chipW + 'px';
    ui.chip.style.left = Math.round(x0 + (x1 - x0) * e - g.chipW / 2) + 'px';
    ui.chip.style.bottom = Math.round(y0 + (y1 - y0) * e + g.lift + g.rise * Math.sin(Math.PI * e)) + 'px';
    ui.chipAmt.textContent = fmt(t.amt);
  } else {
    ui.chip.hidden = true;
  }

  /* captions and the button, which is never dead: it runs, skips, then resets */
  const line = tt => short(tt.fromName) + ' → ' + short(tt.toName);
  ui.caption.textContent = anim.phase === 'run' && t ? line(t) + '  ' + fmt(t.amt)
    : (anim.phase === 'done' ? 'ALL LEVEL · ' + fmt(share) + ' EACH' : 'SPEND VS FAIR SHARE');
  ui.caption.className = 'rl' + (anim.phase === 'run' ? ' caption-live' : '');
  ui.phase.textContent = anim.phase === 'done' ? 'LEVEL' : (anim.phase === 'run' ? 'MOVING' : 'UNEVEN');
  ui.cta.textContent = anim.phase === 'done' ? 'RESET' : (anim.phase === 'run' ? 'MOVING MONEY…' : 'EQUALIZE');
  ui.cta.disabled = anim.phase === 'input' && !tx.length;

  /* transfers reveal one at a time, as each block lands */
  const shown = anim.phase === 'done' ? tx.length : (anim.phase === 'run' ? anim.step : 0);
  ui.result.hidden = shown === 0;
  /* rebuild only when the revealed set actually changed — this runs every 16ms */
  const txSig = shown + '|' + tx.slice(0, shown).map(t => t.fromName + '>' + t.toName + ':' + t.amt).join(',');
  if (txSig !== lastTxShown) {
    lastTxShown = txSig;
    ui.reshead.textContent = isDesktop() ? 'SEND THESE' : 'SETTLE UP';
    ui.txcount.textContent = tx.length + (tx.length === 1 ? ' PAYMENT' : ' PAYMENTS');
    ui.txlist.innerHTML = '';
    tx.slice(0, shown).forEach(tt => {
      const row = el('div', 'tx');
      const l = el('div', 'tx-line');
      l.append(document.createTextNode(short(tt.fromName) + ' '));
      const ar = el('span', 'arrow'); ar.textContent = '→';
      l.append(ar, document.createTextNode(' ' + short(tt.toName)));
      const a = el('div', 'tx-amt'); a.textContent = fmt(tt.amt);
      row.append(l, a);
      ui.txlist.append(row);
    });
  }

  ui.saveBtn.textContent = store.event?.settledAt ? 'SETTLED ✓' : 'MARK SETTLED';
}

/* ── the run ──────────────────────────────────────────────────────────── */

function run() {
  const tx = settle(asShares()).tx;

  /* a tap mid-flight skips to the settled state — never a dead button */
  if (anim.phase === 'run') { runToken = null; anim = { phase: 'done', step: tx.length, p: 0 }; store.setPaused(false); update(); return; }
  if (anim.phase === 'done') { resetAnim(); update(); return; }
  if (!tx.length) return;

  const dur = geo(people().length).dur / ANIM_SPEED;
  const token = {};
  runToken = token;
  const live = () => runToken === token;

  /* hold remote updates until the blocks land, or the bars teleport mid-flight */
  store.setPaused(true);

  const step = k => {
    if (!live()) return;
    if (k >= tx.length) { anim = { phase: 'done', step: tx.length, p: 0 }; store.setPaused(false); update(); return; }
    const t0 = performance.now();
    const tick = () => {
      if (!live()) return;
      const p = Math.min(1, (performance.now() - t0) / dur);
      anim = { phase: 'run', step: k, p };
      update();
      /* timers, not rAF: a hidden tab still finishes instead of stranding */
      if (p < 1) setTimeout(tick, 16);
      else setTimeout(() => step(k + 1), 220);
    };
    setTimeout(tick, 0);
  };

  anim = { phase: 'run', step: 0, p: 0 };
  update();
  step(0);
}

/* ── wiring ───────────────────────────────────────────────────────────── */

ui.cta.addEventListener('click', run);

ui.add.addEventListener('click', () => {
  pendingFocus = { kind: 'person' };
  resetAnim();
  /* prefill with the name this device used last, unless it is already here */
  const mine = myName();
  const taken = people().some(p => p.name.trim().toLowerCase() === mine.trim().toLowerCase());
  store.addPerson(mine && !taken ? mine : '');
});

ui.evName.addEventListener('input', () => store.renameEvent(ui.evName.value));

ui.copy.addEventListener('click', async () => {
  const url = location.origin + '/e/' + eventId;
  try {
    await navigator.clipboard.writeText(url);
    ui.copy.textContent = 'COPIED ✓';
  } catch (_) {
    /* clipboard needs a secure context — select the text so it can be copied by hand */
    const r = document.createRange();
    r.selectNodeContents(ui.shareUrl);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    ui.copy.textContent = 'SELECTED';
  }
  setTimeout(() => { ui.copy.textContent = 'COPY'; }, 1400);
});

ui.saveBtn.addEventListener('click', () => {
  store.setSettled(!store.event?.settledAt);
});

function showBanner(text, kind) {
  ui.banner.textContent = text;
  ui.banner.className = 'banner banner-' + kind;
  ui.banner.hidden = false;
}

store.on('status', status => {
  ui.conn.className = 'conn conn-' + status;
  ui.connLabel.textContent = { live: 'LIVE', reconnecting: 'RECONNECTING', loading: 'LOADING', gone: 'GONE', error: 'OFFLINE' }[status] || status;
  if (status === 'gone') {
    showBanner('This event no longer exists. Start a new one from the LEVEL logo.', 'bad');
  } else if (status === 'error') {
    showBanner('Couldn’t reach the server — your last change may not be saved.', 'bad');
  } else if (status === 'live') {
    ui.banner.hidden = true;
  }
});

store.on('change', () => {
  renderShare();

  const sig = rowsSignature();
  if (sig !== rowSig) { rowSig = sig; buildRows(); } else { refreshRowValues(); }

  const cSig = people().map(p => p.id).join(',');
  if (cSig !== chartSig) { chartSig = cSig; buildChart(); lastTxShown = null; }

  update();
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { renderRecent(); buildChart(); lastTxShown = null; update(); }, 120);
});

/* a page hidden mid-edit still owes the server its last keystroke */
window.addEventListener('pagehide', () => store.flush());

rememberVisit(eventId);
renderRecent();
store.start();
