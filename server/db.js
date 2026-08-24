/* The only module that touches SQLite. Everything above it deals in plain objects.
   Money is stored as integer cents — floats never reach the database. */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

export const LIMITS = {
  people: 50,
  items: 300,
  name: 60,
  label: 80,
  /* amounts are plain numbers, not a currency — a unit can be big */
  amountCents: 1_000_000_00,
  qty: 999
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  rev        INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS people (
  id       TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name     TEXT NOT NULL DEFAULT '',
  pos      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id           TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  label        TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,   -- per unit
  qty          INTEGER NOT NULL DEFAULT 1,
  pos          INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS people_by_event ON people(event_id, pos);
CREATE INDEX IF NOT EXISTS items_by_person ON items(person_id, pos);
`;

export function openDb(file = process.env.LEVEL_DB || './level.db') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return new Store(db);
}

/* Databases created before quantities existed get the column added in place. */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(items)').all().map(c => c.name);
  if (!cols.includes('qty')) db.exec('ALTER TABLE items ADD COLUMN qty INTEGER NOT NULL DEFAULT 1');
}

/* URL-safe id. 10 chars of base32 ≈ 50 bits — the link is the capability, so it
   has to be unguessable, not pretty. */
function slug(n = 10) {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
  const bytes = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const now = () => Date.now();

export class Store {
  constructor(db) {
    this.db = db;
    this.q = {
      event: db.prepare('SELECT * FROM events WHERE id = ?'),
      people: db.prepare('SELECT * FROM people WHERE event_id = ? ORDER BY pos, rowid'),
      items: db.prepare(
        `SELECT i.* FROM items i JOIN people p ON p.id = i.person_id
         WHERE p.event_id = ? ORDER BY i.pos, i.rowid`),
      person: db.prepare('SELECT * FROM people WHERE id = ? AND event_id = ?'),
      itemOwner: db.prepare(
        `SELECT i.id FROM items i JOIN people p ON p.id = i.person_id
         WHERE i.id = ? AND p.event_id = ?`),
      countPeople: db.prepare('SELECT COUNT(*) AS n FROM people WHERE event_id = ?'),
      countItems: db.prepare(
        `SELECT COUNT(*) AS n FROM items i JOIN people p ON p.id = i.person_id
         WHERE p.event_id = ?`),
      maxPersonPos: db.prepare('SELECT COALESCE(MAX(pos), -1) AS m FROM people WHERE event_id = ?'),
      maxItemPos: db.prepare('SELECT COALESCE(MAX(pos), -1) AS m FROM items WHERE person_id = ?'),
      bump: db.prepare('UPDATE events SET rev = rev + 1 WHERE id = ?')
    };
  }

  close() { this.db.close(); }

  /* ── reads ──────────────────────────────────────────────────────────── */

  /** Full event as the client wants it, or null. Totals are cents; the client formats. */
  get(id) {
    const ev = this.q.event.get(id);
    if (!ev) return null;
    const people = this.q.people.all(id).map(p => ({ id: p.id, name: p.name, items: [] }));
    const byId = new Map(people.map(p => [p.id, p]));
    for (const it of this.q.items.all(id)) {
      byId.get(it.person_id)?.items.push({
        id: it.id,
        label: it.label,
        amountCents: it.amount_cents,       // per unit
        qty: it.qty,
        totalCents: it.amount_cents * it.qty
      });
    }
    for (const p of people) p.totalCents = p.items.reduce((s, i) => s + i.totalCents, 0);
    return {
      id: ev.id,
      name: ev.name,
      createdAt: ev.created_at,
      settledAt: ev.settled_at,
      rev: ev.rev,
      totalCents: people.reduce((s, p) => s + p.totalCents, 0),
      people
    };
  }

  /** Thin rows for the RECENT rail — no items. */
  summaries(ids) {
    return ids.map(id => this.get(id)).filter(Boolean).map(e => ({
      id: e.id, name: e.name, createdAt: e.createdAt,
      settledAt: e.settledAt, totalCents: e.totalCents, people: e.people.length
    }));
  }

  exists(id) { return !!this.q.event.get(id); }
  hasPerson(eventId, personId) { return !!this.q.person.get(personId, eventId); }
  hasItem(eventId, itemId) { return !!this.q.itemOwner.get(itemId, eventId); }
  peopleCount(eventId) { return this.q.countPeople.get(eventId).n; }
  itemCount(eventId) { return this.q.countItems.get(eventId).n; }

  /* ── writes ─────────────────────────────────────────────────────────── */

  createEvent(name) {
    const id = slug();
    this.db.prepare('INSERT INTO events (id, name, created_at) VALUES (?, ?, ?)')
      .run(id, name, now());
    return id;
  }

  updateEvent(id, { name, settled }) {
    if (name !== undefined) this.db.prepare('UPDATE events SET name = ? WHERE id = ?').run(name, id);
    if (settled !== undefined) {
      this.db.prepare('UPDATE events SET settled_at = ? WHERE id = ?').run(settled ? now() : null, id);
    }
    this.q.bump.run(id);
  }

  addPerson(eventId, name) {
    const id = slug(12);
    const pos = this.q.maxPersonPos.get(eventId).m + 1;
    this.db.prepare('INSERT INTO people (id, event_id, name, pos) VALUES (?, ?, ?, ?)')
      .run(id, eventId, name, pos);
    this.q.bump.run(eventId);
    return id;
  }

  renamePerson(eventId, personId, name) {
    this.db.prepare('UPDATE people SET name = ? WHERE id = ?').run(name, personId);
    this.q.bump.run(eventId);
  }

  removePerson(eventId, personId) {
    this.db.prepare('DELETE FROM people WHERE id = ?').run(personId);
    this.q.bump.run(eventId);
  }

  addItem(eventId, personId, label, amountCents, qty = 1) {
    const id = slug(12);
    const pos = this.q.maxItemPos.get(personId).m + 1;
    this.db.prepare(
      'INSERT INTO items (id, person_id, label, amount_cents, qty, pos, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, personId, label, amountCents, qty, pos, now());
    this.q.bump.run(eventId);
    return id;
  }

  updateItem(eventId, itemId, { label, amountCents, qty }) {
    if (label !== undefined) {
      this.db.prepare('UPDATE items SET label = ? WHERE id = ?').run(label, itemId);
    }
    if (amountCents !== undefined) {
      this.db.prepare('UPDATE items SET amount_cents = ? WHERE id = ?').run(amountCents, itemId);
    }
    if (qty !== undefined) {
      this.db.prepare('UPDATE items SET qty = ? WHERE id = ?').run(qty, itemId);
    }
    this.q.bump.run(eventId);
  }

  removeItem(eventId, itemId) {
    this.db.prepare('DELETE FROM items WHERE id = ?').run(itemId);
    this.q.bump.run(eventId);
  }
}
