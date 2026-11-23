# Sentek soil probes -> /soiltemps

```
Sentek logger --FTP--> Vultr box /home/sentek/*.esp
  --hourly cron (ingest.py)--> Acre Ops Supabase public.soil_ingest (insert-only, secret-gated)
  --> public.soil_readings
/soiltemps --> /api/soil (netlify/functions/soil-public.js) --> public.soil_public_sites (active AND public loggers only)
```

## Vultr box (64.177.14.69, `sentek-ftp`)
- Script: `/opt/sentek-ingest/ingest.py` (a copy is `sentek/ingest.py` here; keep them in sync).
- Cron: `/etc/cron.d/sentek-ingest` runs `5 * * * *` as root, log `/var/log/sentek-ingest.log` (rotated weekly).
- Write secret: `/etc/sentek-ingest/secret` (root only, 600). Only its sha256 is stored in
  `acre_private.soil_ingest_keys`. To rotate: write a new secret, insert its hash, set `revoked_at` on the old row.
- `/etc/sentek-ingest/config.json`: Acre Ops URL and publishable key (not secret).
- State: `/var/lib/sentek-ingest/sent.txt` lists files already sent. Raw `.esp` files are never changed.
- Dry run: `python3 /opt/sentek-ingest/ingest.py --dry-run`.

## Acre Ops Supabase (junawlttpyztjlnbmvcb)
Migrations applied (copies in `acre-ops-migrations/`): `20261123204436_soil_probes`, `20261123204731_soil_probes_depth_rounding`.
- `public.soil_loggers`: one row per logger. `logger_name` must match the name inside the .esp files.
  Only `active AND public` rows show on the site, and only `site_name` and `location_label` are published.
- `public.soil_readings`: one row per logger, time, depth. `temp_f` from the file's deg C channel;
  `water_pct` from Sentek's default calibration on `raw_moisture` (uncalibrated for the site soil).
- Neither table is readable or writable by the anon/authenticated API roles.

## Adding a site
1. Point the logger's FTP upload at the Vultr box (same login). Set its clock to CST (UTC-6, no DST).
2. Insert a `soil_loggers` row with `logger_name`, `site_name`, `location_label` (general, e.g. "3 mi NW of Axtell"; never a field name).
3. The next hourly run backfills its files. Set `active = true, public = true` to show it.

## Netlify
`/api/soil` needs env var `SOIL_SUPABASE_KEY` = the Acre Ops publishable key. Without it the page shows
"No probe readings to show right now."
