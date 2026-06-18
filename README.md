# 🎡 Wheel of Suspense

A random name picker with dramatic flair — spin the wheel and let suspenseful,
randomly-styled live commentary tease who's about to get chosen.

**[▶ Try it live](https://wheel-of-suspense.vercel.app/)**

> Hosted on Vercel — saved lists & winners are shared server-side (see below).

## Features

- 🎯 **Near-miss physics** — the wheel creeps past the previous name's edge with an elastic settle, and the pointer flaps on every peg
- 🎙 **5 commentary styles** picked at random each spin (sports shout, breaking-news ticker, typewriter, heartbeat, paparazzi spotlight) that genuinely foreshadow the result
- 💾 **Shared saved lists** — keep multiple rosters on the server so everyone sees the same ones; reload them after eliminations
- 🏆 **Shared winners history** with per-winner delete (✕), "remove & spin" elimination mode, confetti burst, tick + fanfare sounds
- ♿ Respects `prefers-reduced-motion`

## How saving works

Saved lists and winners are stored **server-side** in Upstash Redis (shared by
everyone) via two tiny Vercel functions:

- `api/lists.js` — `GET` / `POST` (upsert one) / `DELETE` (one) for saved team lists
- `api/history.js` — `GET` / `POST` (append) / `DELETE` (one by `?id=` or all) for winners

`localStorage` is kept only as an **offline cache** — if the server is
unreachable (e.g. opening `index.html` straight from disk) the app still works
and shows the last synced copy, marked with a small "⚠ Offline" note.

## Run locally

The static front-end (`index.html`, `app.js`, `styles.css`) has no build step,
but the saved-state API needs the Vercel dev server and an Upstash store:

```bash
npm install
vercel link                       # one-time
vercel integration add upstash    # provisions the Redis store + env vars
vercel env pull .env              # pull UPSTASH_REDIS_REST_URL / _TOKEN
vercel dev                        # serves the site + /api on localhost
```

Without the API (e.g. just opening the file), the wheel still spins — it falls
back to the local cache. Deploy with `vercel deploy --prod`.
