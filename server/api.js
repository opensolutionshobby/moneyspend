/* Route handlers. Everything here validates first, mutates second, and
   broadcasts the fresh snapshot last — a subscriber never sees a torn state. */
import { LIMITS } from './db.js';
import { broadcast, subscribe } from './sse.js';

const MAX_BODY = 16 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = msg => { throw new HttpError(400, msg); };

/* ── validation ───────────────────────────────────────────────────────── */

function text(v, max, field) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') bad(field + ' must be a string');
  const s = v.trim();
  if (s.length > max) bad(field + ' must be at most ' + max + ' characters');
  return s;
}

function cents(v, field) {
  if (typeof v !== 'number' || !Number.isInteger(v)) bad(field + ' must be an integer number of hundredths');
  if (v < 0 || v > LIMITS.amountCents) bad(field + ' must be between 0 and ' + LIMITS.amountCents);
  return v;
}

function qty(v) {
  if (typeof v !== 'number' || !Number.isInteger(v)) bad('qty must be a whole number');
  if (v < 1 || v > LIMITS.qty) bad('qty must be between 1 and ' + LIMITS.qty);
  return v;
}

/* ── write throttle ───────────────────────────────────────────────────── */

/* A public link is a public link: cap writes per client so one script can't
   fill the database. Memory-only and deliberately crude. */
const buckets = new Map();
const RATE = { capacity: 120, refillPerSec: 4 };

function allowWrite(ip) {
  if (process.env.LEVEL_RATE_LIMIT === 'off') return true;
  const t = Date.now() / 1000;
  const b = buckets.get(ip) || { tokens: RATE.capacity, at: t };
  b.tokens = Math.min(RATE.capacity, b.tokens + (t - b.at) * RATE.refillPerSec);
  b.at = t;
  if (buckets.size > 5000) buckets.clear();
  buckets.set(ip, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'body must be JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

const clientIp = req =>
  (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '?').trim();

/* ── router ───────────────────────────────────────────────────────────── */

/** Returns true when the request was an /api route (handled or errored). */
export async function handleApi(req, res, store) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return false;

  try {
    await route(req, res, store, url);
  } catch (err) {
    if (err instanceof HttpError) json(res, err.status, { error: err.message });
    else {
      console.error('api error', err);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    }
  }
  return true;
}

async function route(req, res, store, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api','events',...]
  const method = req.method;

  if (seg[0] !== 'api' || seg[1] !== 'events') throw new HttpError(404, 'not found');

  const isWrite = method !== 'GET' && method !== 'HEAD';
  if (isWrite && !allowWrite(clientIp(req))) throw new HttpError(429, 'slow down');

  /* /api/events */
  if (seg.length === 2) {
    if (method === 'POST') {
      const body = await readBody(req);
      const name = text(body.name, LIMITS.name, 'name') || 'TONIGHT';
      const id = store.createEvent(name);
      return json(res, 201, store.get(id));
    }
    if (method === 'GET') {
      const ids = (url.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
      return json(res, 200, { events: store.summaries(ids.slice(0, 30)) });
    }
    throw new HttpError(405, 'method not allowed');
  }

  const eventId = seg[2];
  if (!store.exists(eventId)) throw new HttpError(404, 'event not found');

  /* /api/events/:id/stream */
  if (seg.length === 4 && seg[3] === 'stream' && method === 'GET') {
    if (subscribe(eventId, req, res)) broadcast(eventId, store.get(eventId));
    return;
  }

  /* /api/events/:id */
  if (seg.length === 3) {
    if (method === 'GET') return json(res, 200, store.get(eventId));
    if (method === 'PATCH') {
      const body = await readBody(req);
      const patch = {};
      if (body.name !== undefined) patch.name = text(body.name, LIMITS.name, 'name');
      if (body.settled !== undefined) {
        if (typeof body.settled !== 'boolean') bad('settled must be a boolean');
        patch.settled = body.settled;
      }
      if (!Object.keys(patch).length) bad('nothing to update');
      store.updateEvent(eventId, patch);
      return done(res, store, eventId);
    }
    throw new HttpError(405, 'method not allowed');
  }

  /* /api/events/:id/people[...] */
  if (seg[3] === 'people') {
    if (seg.length === 4) {
      if (method !== 'POST') throw new HttpError(405, 'method not allowed');
      if (store.peopleCount(eventId) >= LIMITS.people) bad('this event already has ' + LIMITS.people + ' people');
      const body = await readBody(req);
      store.addPerson(eventId, text(body.name, LIMITS.name, 'name'));
      return done(res, store, eventId, 201);
    }

    const personId = seg[4];
    if (!store.hasPerson(eventId, personId)) throw new HttpError(404, 'person not found');

    if (seg.length === 5) {
      if (method === 'PATCH') {
        const body = await readBody(req);
        if (body.name === undefined) bad('nothing to update');
        store.renamePerson(eventId, personId, text(body.name, LIMITS.name, 'name'));
        return done(res, store, eventId);
      }
      if (method === 'DELETE') {
        store.removePerson(eventId, personId);
        return done(res, store, eventId);
      }
      throw new HttpError(405, 'method not allowed');
    }

    /* /api/events/:id/people/:pid/items */
    if (seg.length === 6 && seg[5] === 'items' && method === 'POST') {
      if (store.itemCount(eventId) >= LIMITS.items) bad('this event already has ' + LIMITS.items + ' entries');
      const body = await readBody(req);
      store.addItem(
        eventId, personId,
        text(body.label, LIMITS.label, 'label'),
        body.amountCents === undefined ? 0 : cents(body.amountCents, 'amountCents'),
        body.qty === undefined ? 1 : qty(body.qty)
      );
      return done(res, store, eventId, 201);
    }
    throw new HttpError(404, 'not found');
  }

  /* /api/events/:id/items/:iid */
  if (seg[3] === 'items' && seg.length === 5) {
    const itemId = seg[4];
    if (!store.hasItem(eventId, itemId)) throw new HttpError(404, 'entry not found');
    if (method === 'PATCH') {
      const body = await readBody(req);
      const patch = {};
      if (body.label !== undefined) patch.label = text(body.label, LIMITS.label, 'label');
      if (body.amountCents !== undefined) patch.amountCents = cents(body.amountCents, 'amountCents');
      if (body.qty !== undefined) patch.qty = qty(body.qty);
      if (!Object.keys(patch).length) bad('nothing to update');
      store.updateItem(eventId, itemId, patch);
      return done(res, store, eventId);
    }
    if (method === 'DELETE') {
      store.removeItem(eventId, itemId);
      return done(res, store, eventId);
    }
    throw new HttpError(405, 'method not allowed');
  }

  throw new HttpError(404, 'not found');
}

function done(res, store, eventId, status = 200) {
  const event = store.get(eventId);
  broadcast(eventId, event);
  return json(res, status, event);
}
