# LEVEL

Split what tonight cost. Start an event, send the link, and everyone adds their name and what
they spent from their own phone. The bars level out and LEVEL says who pays whom — in the
fewest payments it can manage.

No accounts, no app to install, no currency: the numbers are whatever you want them to be.

## Run it

Needs Node 23.4 or newer. Nothing to install — there are no dependencies.

```bash
npm start
```

Then open <http://localhost:8731>, name the event, and share the link it gives you.

To let other people on your network join, share your machine's address instead of `localhost`
(e.g. `http://192.168.1.20:8731/e/abc123`).

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8731` | Port to listen on |
| `LEVEL_DB` | `./level.db` | Where the SQLite file lives |

## How it works

**Add people, add spending.** Each person gets a row, and under it a line for each thing they
paid for. A line has a description, a quantity, and the amount for one of them — 3 lift passes
at 5000 counts as 15000. Quantity defaults to 1, so you can ignore it when it doesn't apply.

**Watch the bars.** Everyone's total is a bar; the line across them is the fair share. Bars above
the line paid more than their share, bars below paid less.

**Press EQUALIZE.** Blocks of money fly from the people who owe to the people who are owed, one
payment at a time, until every bar sits on the line. The list underneath is what actually needs
sending. Press it again mid-flight to skip to the answer, and once more to reset.

**Mark it settled** when the money has moved. The event stays readable afterwards.

## Sharing an event

Everyone with the link sees the same event, live — a name typed on one phone shows up on the
others within a moment, with no refreshing. It works the other way too: keep the page open and
you'll see spending appear as people enter it.

**The link is the only key.** Anyone who has it can add, edit, rename, or delete anything in that
event, including other people's entries. That's deliberate — it's meant to work like a piece of
paper passed around a table. Don't post an event link somewhere public.

## Recent

Every event you open is remembered under **Recent**, with its total, headcount, and when you last
looked at it. That list lives in your browser and is never sent anywhere, so a different phone
shows a different list — and clearing your browser data clears it. Losing the list doesn't delete
the events; anyone still holding a link can open them.

`×` forgets one event, **CLEAR LIST** forgets all of them.

## Good to know

- Amounts are kept to two decimal places, so splitting 100 three ways still adds up.
- An event holds up to 50 people and 300 entries.
- Events are never deleted, and there is no way to recover a link you've lost — keep it in your
  chat thread, that's what it's for.
- Everything is stored in one SQLite file (`level.db`). Copy it to back up, delete it to start over.

## Development

```bash
npm test     # API and live-update tests, no browser needed
```

Plain HTML, CSS, and JavaScript with no build step: `server/` is the API and storage, `public/`
is what the browser gets. See [CLAUDE.md](CLAUDE.md) for the design rules the code follows.
