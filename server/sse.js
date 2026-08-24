/* Per-event subscriber registry. Every mutation broadcasts the whole event —
   it is small, and a full snapshot means the client never reconciles diffs. */

const MAX_PER_EVENT = 50;
const HEARTBEAT_MS = 25000;

const rooms = new Map(); // eventId -> Set<res>

export function subscribe(eventId, req, res) {
  const room = rooms.get(eventId) || new Set();
  if (room.size >= MAX_PER_EVENT) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'too many listeners on this event' }));
    return null;
  }
  rooms.set(eventId, room);

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write('retry: 2000\n\n');
  room.add(res);

  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closing */ } }, HEARTBEAT_MS);
  const drop = () => {
    clearInterval(beat);
    room.delete(res);
    if (!room.size) rooms.delete(eventId);
  };
  req.on('close', drop);
  res.on('error', drop);
  return res;
}

export function broadcast(eventId, event) {
  const room = rooms.get(eventId);
  if (!room) return;
  const frame = `event: update\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of room) {
    try { res.write(frame); } catch { room.delete(res); }
  }
}

export function listenerCount(eventId) {
  return rooms.get(eventId)?.size ?? 0;
}

export function closeAll() {
  for (const room of rooms.values()) for (const res of room) { try { res.end(); } catch { /* gone */ } }
  rooms.clear();
}
