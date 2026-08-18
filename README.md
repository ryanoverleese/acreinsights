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
through Supabase and two scheduled agents in another repo. If you are trying to
work out why the Wire says what it says, or where a reminder went, the map is:

**[`cropx-daily-brief/SYSTEM_MAP.md`](https://github.com/ryanoverleese/cropx-daily-brief/blob/main/SYSTEM_MAP.md)**
— locally at `~/Documents/cropx-daily-brief/SYSTEM_MAP.md`.

Short version:

```
capture.html -> Supabase -> capture-review agent -> brief_agent.py -> wire.html
```

## Known issue

The Supabase table behind `capture.html` has row-level security **off**, and the
anon key is in the page, which is served publicly. Anyone with the URL can read,
edit or delete everything. The unguessable old filename was never authentication.
Fix is Supabase Auth plus row policies.
