#!/usr/bin/env python3
"""Sentek .esp -> Acre Ops Supabase uploader (runs hourly by cron on the Vultr FTP box).

Reads every *.esp the loggers have uploaded to /home/sentek, decodes the ones not
sent yet, and posts them to public.soil_ingest (insert-only, secret-gated). Raw
files are never modified, moved, or deleted. Loggers with no soil_loggers row are
skipped and retried next run, so adding a site is just a database row.

Config (root-only):
  /etc/sentek-ingest/secret       write secret (only its sha256 is in the database)
  /etc/sentek-ingest/config.json  {"supabase_url": "...", "publishable_key": "..."}
State: /var/lib/sentek-ingest/sent.txt (one file name per line)

Decoding is reverse-engineered (see parse_esp.py notes). Channel groups by id >> 8:
  0x06 = temperature (deg C), 0x04 = moisture (Sentek scaled frequency), 0x05 = unknown.
Each file starts at the logger-clock time in its header; records are `interval` apart,
where interval is inferred from the gap between consecutive files (30 min so far).
"""
import argparse, fcntl, glob, json, math, os, struct, sys, time, urllib.request
from datetime import timezone
from datetime import datetime, timedelta
from statistics import median

SRC_DIRS = ["/home/sentek", "/home/sentek/incoming"]
CONF_DIR = "/etc/sentek-ingest"
STATE = "/var/lib/sentek-ingest/sent.txt"
LOCK = "/var/lib/sentek-ingest/lock"
EPOCH = datetime(2000, 1, 1)
GROUPS = {0x06: "raw_temp_c", 0x04: "raw_moisture", 0x05: "raw_aux"}
BATCH_ROWS = 4000


def log(msg):
    print(f"{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} {msg}", flush=True)


def crc16_ccitt(data, crc=0xFFFF):
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def parse_file(path):
    d = open(path, "rb").read()
    if len(d) < 0x42:
        raise ValueError("too short")
    if crc16_ccitt(d[:-2]) != struct.unpack(">H", d[-2:])[0]:
        raise ValueError("CRC mismatch")
    start = EPOCH + timedelta(seconds=struct.unpack(">I", d[0:4])[0])
    logger = d[8:24].split(b"\0")[0].decode("ascii", "replace")
    data_off = struct.unpack(">I", d[0x20:0x24])[0]
    rec_size = struct.unpack(">H", d[0x24:0x26])[0]
    nfloat = struct.unpack(">H", d[0x38:0x3A])[0]
    if rec_size != nfloat * 4 or data_off >= len(d):
        raise ValueError("unexpected layout")
    channels, p = [], 0x40
    while p < data_off:
        ln, cid = struct.unpack(">HH", d[p:p + 4])
        if ln < 4:
            raise ValueError("bad item length")
        if ln == 8:
            channels.append((cid, struct.unpack(">f", d[p + 4:p + 8])[0]))
        p += ln
    body = d[data_off:-2]
    if len(body) % rec_size:
        raise ValueError("partial record")
    recs = [struct.unpack(">%df" % nfloat, body[i:i + rec_size]) for i in range(0, len(body), rec_size)]
    return dict(path=path, name=os.path.basename(path), start=start, logger=logger, channels=channels, records=recs)


def num(v):
    return None if v is None or math.isnan(v) or math.isinf(v) else round(float(v), 5)


def rows_for(f, interval):
    nch = len(f["channels"])
    out = []
    for i, rec in enumerate(f["records"]):
        ts = f["start"] + i * interval
        by_depth = {}
        for (cid, depth), val in zip(f["channels"], rec[:nch]):
            key = GROUPS.get(cid >> 8)
            if key:
                by_depth.setdefault(int(round(depth)), {})[key] = num(val)
        extras = list(rec[nch:]) + [None, None]
        for depth, vals in sorted(by_depth.items()):
            out.append(dict(logger_time=ts.isoformat(), depth_cm=depth, raw_temp_c=vals.get("raw_temp_c"),
                            raw_moisture=vals.get("raw_moisture"), raw_aux=vals.get("raw_aux"),
                            extra_1=num(extras[0]), extra_2=num(extras[1]), source_file=f["name"]))
    return out


def call_ingest(conf, secret, logger, rows):
    req = urllib.request.Request(
        conf["supabase_url"].rstrip("/") + "/rest/v1/rpc/soil_ingest",
        data=json.dumps({"p_secret": secret, "p_logger": logger, "p_rows": rows}).encode(),
        headers={"apikey": conf["publishable_key"], "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="decode and count only; send nothing")
    ap.add_argument("--src", action="append", help="override source folder(s)")
    args = ap.parse_args()

    os.makedirs(os.path.dirname(STATE), exist_ok=True) if not args.dry_run else None
    lock = open(LOCK if not args.dry_run else "/tmp/sentek-ingest.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("another run is active; exiting")
        return 0

    sent = set()
    if os.path.exists(STATE) and not args.dry_run:
        sent = set(open(STATE).read().split())

    now = time.time()
    files, bad = [], 0
    for folder in args.src or SRC_DIRS:
        for path in glob.glob(os.path.join(folder, "*.esp")):
            if now - os.path.getmtime(path) < 90:
                continue  # may still be uploading
            try:
                files.append(parse_file(path))
            except Exception as e:  # noqa: BLE001
                bad += 1
                if os.path.basename(path) not in sent:
                    log(f"skip {os.path.basename(path)}: {e}")

    by_logger = {}
    for f in files:
        by_logger.setdefault(f["logger"], []).append(f)

    conf = secret = None
    if not args.dry_run:
        conf = json.load(open(os.path.join(CONF_DIR, "config.json")))
        secret = open(os.path.join(CONF_DIR, "secret")).read().strip()

    total_files = total_rows = total_inserted = 0
    for logger, fs in sorted(by_logger.items()):
        fs.sort(key=lambda f: f["start"])
        gaps = [(b["start"] - a["start"]).total_seconds() / len(a["records"])
                for a, b in zip(fs, fs[1:]) if a["records"] and b["start"] > a["start"]]
        interval = timedelta(seconds=median(gaps) if gaps else 1800)
        todo = [f for f in fs if f["name"] not in sent]
        if not todo:
            continue
        batches, cur, cur_files = [], [], []
        for f in todo:
            r = rows_for(f, interval)
            if cur and len(cur) + len(r) > BATCH_ROWS:
                batches.append((cur, cur_files)); cur, cur_files = [], []
            cur += r; cur_files.append(f["name"])
        if cur:
            batches.append((cur, cur_files))
        if args.dry_run:
            n = sum(len(b[0]) for b in batches)
            log(f"{logger}: {len(todo)} files, {n} rows, interval {interval} (dry run)")
            total_files += len(todo); total_rows += n
            continue
        for rows, names in batches:
            res = call_ingest(conf, secret, logger, rows)
            if res.get("status") == "unknown_logger":
                log(f"{logger}: no soil_loggers row; {len(todo)} files waiting")
                break
            if res.get("status") != "ok":
                raise RuntimeError(f"{logger}: unexpected response {res}")
            with open(STATE, "a") as fh:
                fh.write("".join(n + "\n" for n in names))
            sent.update(names)
            total_files += len(names); total_rows += len(rows); total_inserted += res.get("inserted", 0)
            log(f"{logger}: sent {len(names)} files, {len(rows)} rows, inserted {res.get('inserted')}")
    log(f"done: {total_files} new files, {total_rows} rows, {total_inserted} inserted, {bad} unreadable")
    return 0


if __name__ == "__main__":
    sys.exit(main())
