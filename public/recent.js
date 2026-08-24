/* The recent page: every event this browser has opened, newest visit first.
   The list of visits is local; the numbers beside each one come from the server. */
import { recentEntries, forgetVisit, forgetAllVisits, fetchSummaries, fromCents } from './store.js';

const $ = id => document.getElementById(id);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

const DAY = 86400000;

/** "just now", "20 min ago", "yesterday", then a plain date. */
function when(ts) {
  if (!ts) return 'visited before';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.round(diff / 60000) + ' min ago';
  if (diff < DAY) { const h = Math.round(diff / 3600000); return h + (h === 1 ? ' hour ago' : ' hours ago'); }
  if (diff < 2 * DAY) return 'yesterday';
  if (diff < 7 * DAY) return Math.round(diff / DAY) + ' days ago';
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const dateOf = ts => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function row(entry, summary) {
  const wrap = el('div', 'rec' + (summary ? '' : ' rec-missing'));

  const link = el(summary ? 'a' : 'div', 'rec-link');
  if (summary) link.href = '/e/' + entry.id;

  const name = el('div', 'rec-name');
  name.textContent = summary ? summary.name : entry.id;

  const meta = el('div', 'rec-meta');
  meta.textContent = summary
    ? [
        when(entry.at),
        summary.people + (summary.people === 1 ? ' person' : ' people'),
        'started ' + dateOf(summary.createdAt)
      ].join(' · ')
    : when(entry.at) + ' · not on this server any more';

  const left = el('div', 'rec-left');
  left.append(name, meta);

  const right = el('div', 'rec-right');
  if (summary) {
    const total = el('div', 'rec-total');
    total.textContent = fromCents(summary.totalCents);
    right.append(total);
    if (summary.settledAt) {
      const tag = el('div', 'rec-state');
      tag.textContent = 'SETTLED';
      right.append(tag);
    }
  }

  link.append(left, right);

  const forget = el('button', 'btn btn-secondary rec-x');
  forget.type = 'button';
  forget.textContent = '×';
  forget.title = 'Forget this event';
  forget.setAttribute('aria-label', 'Forget ' + (summary ? summary.name : entry.id));
  forget.addEventListener('click', () => { forgetVisit(entry.id); render(); });

  wrap.append(link, forget);
  return wrap;
}

function empty(text) {
  const e = el('div', 'empty rec-empty');
  e.textContent = text;
  return e;
}

async function render() {
  const entries = recentEntries();
  const list = $('list');
  list.innerHTML = '';

  if (!entries.length) {
    $('sub').textContent = 'NOTHING YET';
    $('clear').hidden = true;
    list.append(empty('No events opened in this browser yet. Start one and the link will show up here.'));
    return;
  }

  $('clear').hidden = false;
  $('sub').textContent = entries.length + (entries.length === 1 ? ' EVENT' : ' EVENTS') + ' ON THIS DEVICE';

  let byId = new Map();
  try {
    const { events } = await fetchSummaries(entries.map(e => e.id));
    byId = new Map(events.map(e => [e.id, e]));
  } catch (_) {
    list.append(empty('Couldn’t reach the server — showing what this browser remembers.'));
  }

  for (const entry of entries) list.append(row(entry, byId.get(entry.id)));
}

$('clear').addEventListener('click', () => {
  forgetAllVisits();
  render();
});

render();
