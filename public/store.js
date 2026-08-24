/* Everything that talks to the server. app.js renders; this module owns the
   event, the SSE connection, and the optimistic local edits. */

const RECENT_KEY = 'level.recent';
const ME_KEY = 'level.me';

/* ── money ────────────────────────────────────────────────────────────── */

/* Amounts are plain numbers — no currency, no symbol. Two decimals of precision
   are kept internally (as hundredths) so a three-way split of 100 still adds up. */

/** "12,50" / "12.5" / " 12 " → 1250. Junk → 0. */
export function toCents(str) {
  const n = parseFloat(String(str).replace(',', '.').replace(/[^0-9.\-]/g, ''));
  if (!isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

/** Trailing zeros are noise on a virtual currency: 500000 → "5000", 3333 → "33.33". */
export function fromCents(c) {
  const n = Math.round(c) / 100;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Quantities are whole and at least 1. */
export function toQty(str) {
  const n = parseInt(String(str).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(999, n) : 1;
}

/* ── local memory (the only things still kept in this browser) ────────── */

function safeLocal(read, fallback) {
  try { return read(); } catch (_) { return fallback; }
}

/* Visits are recorded as {id, at} so the recent page can sort and date them.
   Older builds stored a bare array of ids; those come back as at: 0. */
const RECENT_MAX = 100;

export function recentEntries() {
  const raw = safeLocal(() => JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'), []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(e => (typeof e === 'string' ? { id: e, at: 0 } : e))
    .filter(e => e && typeof e.id === 'string')
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

export const recentIds = () => recentEntries().map(e => e.id);

/** Called on every event page load — the visit itself is what gets remembered. */
export function rememberVisit(id) {
  if (!id) return;
  safeLocal(() => {
    const kept = recentEntries().filter(e => e.id !== id);
    const next = [{ id, at: Date.now() }, ...kept].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  });
}

export function forgetVisit(id) {
  safeLocal(() => localStorage.setItem(
    RECENT_KEY, JSON.stringify(recentEntries().filter(e => e.id !== id))));
}

export function forgetAllVisits() {
  safeLocal(() => localStorage.removeItem(RECENT_KEY));
}

export const myName = () => safeLocal(() => localStorage.getItem(ME_KEY) || '', '');
export const rememberName = n => safeLocal(() => { if (n && n.trim()) localStorage.setItem(ME_KEY, n.trim()); });

/* ── http ─────────────────────────────────────────────────────────────── */

async function req(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = null;
  try { payload = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok) {
    const err = new Error(payload?.error || res.statusText || 'request failed');
    err.status = res.status;
    throw err;
  }
  return payload;
}

export const createEvent = name => req('POST', '/api/events', { name });

/** The server answers 30 ids at a time; a long visit history is asked for in batches. */
export async function fetchSummaries(ids) {
  const events = [];
  for (let i = 0; i < ids.length; i += 30) {
    const batch = ids.slice(i, i + 30);
    const res = await req('GET', '/api/events?ids=' + encodeURIComponent(batch.join(',')));
    events.push(...res.events);
  }
  return { events };
}

/* ── the store ────────────────────────────────────────────────────────── */

export class EventStore {
  constructor(id) {
    this.id = id;
    this.event = null;
    this.status = 'loading';   // loading | live | reconnecting | gone | error
    this.error = null;
    this.paused = false;       // set while the equalize animation runs
    this._pending = null;      // remote snapshot waiting for the animation to end
    this._timers = new Map();  // debounced field writes
    this._listeners = { change: [], status: [] };
    this._es = null;
    this._backoff = 1000;
  }

  on(kind, fn) { this._listeners[kind].push(fn); return this; }
  _emit(kind, arg) { for (const fn of this._listeners[kind]) fn(arg); }

  _setStatus(s, err) {
    if (this.status === s && !err) return;
    this.status = s;
    this.error = err || null;
    this._emit('status', s);
  }

  /** Adopt a server snapshot, unless it is stale or the UI is mid-animation. */
  _apply(event, { force = false } = {}) {
    if (!event) return;
    if (!force && this.event && event.rev <= this.event.rev) return;
    if (this.paused && !force) { this._pending = event; return; }
    this.event = event;
    this._emit('change', event);
  }

  /** Called by the animation: while held, remote updates queue instead of landing. */
  setPaused(paused) {
    this.paused = paused;
    if (!paused && this._pending) {
      const queued = this._pending;
      this._pending = null;
      this._apply(queued, { force: true });
    }
  }

  async start() {
    try {
      this._apply(await req('GET', '/api/events/' + this.id), { force: true });
      this._setStatus('live');
      this._connect();
    } catch (err) {
      if (err.status === 404) { forgetVisit(this.id); this._setStatus('gone'); }
      else this._setStatus('error', err);
    }
  }

  _connect() {
    if (this._es) this._es.close();
    const es = new EventSource('/api/events/' + this.id + '/stream');
    this._es = es;
    es.addEventListener('update', e => {
      this._backoff = 1000;
      this._setStatus('live');
      try { this._apply(JSON.parse(e.data)); } catch (_) { /* ignore a torn frame */ }
    });
    es.onopen = () => { this._backoff = 1000; this._setStatus('live'); };
    es.onerror = () => {
      /* EventSource retries on its own; re-sync on the way back so nothing is missed */
      this._setStatus('reconnecting');
      setTimeout(() => this._resync(), this._backoff);
      this._backoff = Math.min(15000, this._backoff * 2);
    };
  }

  async _resync() {
    try {
      this._apply(await req('GET', '/api/events/' + this.id), { force: true });
      this._setStatus('live');
    } catch (err) {
      if (err.status === 404) { forgetVisit(this.id); this._setStatus('gone'); }
    }
  }

  stop() { this._es?.close(); this._es = null; }

  /* ── mutations ──────────────────────────────────────────────────────
     Each one paints locally first so typing never lags a round trip, then
     confirms against the server. A rejection re-reads the truth. */

  _optimistic(mutate) {
    if (!this.event) return;
    const next = structuredClone(this.event);
    mutate(next);
    for (const p of next.people) {
      for (const i of p.items) i.totalCents = i.amountCents * i.qty;
      p.totalCents = p.items.reduce((s, i) => s + i.totalCents, 0);
    }
    next.totalCents = next.people.reduce((s, p) => s + p.totalCents, 0);
    this.event = next;
    this._emit('change', next);
  }

  async _send(fn) {
    try {
      this._apply(await fn(), { force: true });
      this._setStatus('live');
    } catch (err) {
      if (err.status === 404) { forgetVisit(this.id); this._setStatus('gone'); return; }
      this._setStatus('error', err);
      this._resync();
    }
  }

  /** Collapse a burst of keystrokes into one request per field. */
  _debounce(key, ms, fn) {
    const prev = this._timers.get(key);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => { this._timers.delete(key); fn(); }, ms);
    this._timers.set(key, { timer, fn });
  }

  /** Fire every pending debounced write now — a page going away still owes them. */
  flush() {
    for (const [key, t] of this._timers) {
      clearTimeout(t.timer);
      this._timers.delete(key);
      t.fn();
    }
  }

  addPerson(name = '') {
    return this._send(() => req('POST', `/api/events/${this.id}/people`, { name }));
  }

  renamePerson(personId, name) {
    this._optimistic(ev => { const p = ev.people.find(p => p.id === personId); if (p) p.name = name; });
    this._debounce('p:' + personId, 400, () =>
      this._send(() => req('PATCH', `/api/events/${this.id}/people/${personId}`, { name })));
  }

  removePerson(personId) {
    this._optimistic(ev => { ev.people = ev.people.filter(p => p.id !== personId); });
    return this._send(() => req('DELETE', `/api/events/${this.id}/people/${personId}`));
  }

  addItem(personId, label = '', amountCents = 0, qty = 1) {
    return this._send(() =>
      req('POST', `/api/events/${this.id}/people/${personId}/items`, { label, amountCents, qty }));
  }

  updateItem(itemId, patch) {
    this._optimistic(ev => {
      for (const p of ev.people) {
        const it = p.items.find(i => i.id === itemId);
        if (it) Object.assign(it, patch);
      }
    });
    this._debounce('i:' + itemId, 400, () =>
      this._send(() => req('PATCH', `/api/events/${this.id}/items/${itemId}`, patch)));
  }

  removeItem(itemId) {
    this._optimistic(ev => { for (const p of ev.people) p.items = p.items.filter(i => i.id !== itemId); });
    return this._send(() => req('DELETE', `/api/events/${this.id}/items/${itemId}`));
  }

  renameEvent(name) {
    this._optimistic(ev => { ev.name = name; });
    this._debounce('ev:name', 400, () =>
      this._send(() => req('PATCH', `/api/events/${this.id}`, { name })));
  }

  setSettled(settled) {
    return this._send(() => req('PATCH', `/api/events/${this.id}`, { settled }));
  }
}
