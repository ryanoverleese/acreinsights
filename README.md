# acreinsights

The public site. Netlify deploys straight from `main` — no build step, no
framework. Every page is a self-contained HTML file at the repo root, and
pretty URLs drop the `.html`.

## The pages that matter

| URL | File | What it is |
|---|---|---|
| `/capture` | `capture.html` | The capture app. Dump anything, an agent files it and decides what comes back. Was `todos-a7k2x9.html`; `_redirects` keeps the old link alive. |
| `/wire` | `wire.html` | The morning brief. **Generated — never hand-edit.** Written by `brief_agent.py` in the cropx-daily-brief repo, 5:47am. |
| `/soiltemps` | `soiltemps.html` | Soil temperature history. |

Anything else here is a one-off report or a demo page.

## Where the rest of it lives

`capture.html` and `wire.html` are the two visible ends of a chain that runs
through a private Netlify function, Supabase, and two scheduled agents in another repo. If you are trying to
work out why the Wire says what it says, or where a reminder went, the map is:

**[`cropx-daily-brief/SYSTEM_MAP.md`](https://github.com/ryanoverleese/cropx-daily-brief/blob/main/SYSTEM_MAP.md)**
— locally at `~/Documents/cropx-daily-brief/SYSTEM_MAP.md`.

Short version:

```
paired capture.html -> private Netlify function -> Supabase -> capture_review.py -> brief_agent.py -> wire.html
```

## Access decision

This is Ryan's private, convenience-first tool and intentionally has no login
screen. A one-time private link pairs Ryan's browser, then the app opens normally.
The page contains no database key. Only the protected Netlify function and the
morning organizer can reach the private Capture tables.
