#!/usr/bin/env python3
"""One-off storage saver: re-encode every primary display.webp from 400px → 300px longest side @ q80,
in place (bucket → bucket, no Google-Drive originals needed). Shrinks the sku-images bucket ~40% so the
project stays under Supabase's 1 GB free-tier storage limit.

  --dry-run [--sample N]   download+re-encode a sample, project the full old→new total, write NOTHING
  --apply   [--limit N]    do it for real: re-upload (upsert) + update sku_images {bytes,width,height}

Resumable/idempotent: rows already at <=300px longest side are skipped, so a re-run continues where it
left off. Re-encoding a q80 webp down to 300px q80 is a mild lossy step — fine for thumbnails that render
at 36–220px (the 600px fallback hero is the only upscale, and it prefers manual Drive URLs anyway).
"""
import argparse, io, os, sys, urllib.parse, urllib.request, concurrent.futures, threading
sys.path.insert(0, os.path.dirname(__file__))
from db import Client
from PIL import Image

BUCKET = "sku-images"
DISPLAY_MAX = 300
WEBP_QUALITY = 80

URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
db = Client(URL, KEY)

_lock = threading.Lock()


def fetch_rows():
    """All primaries with a stored display.webp, still larger than the target (resumable)."""
    out, off = [], 0
    while True:
        rows = db._req("GET", "sku_images?" + urllib.parse.urlencode({
            "select": "id,display_path,width,height,bytes", "display_path": "not.is.null",
            "limit": 1000, "offset": off,
        }))
        if not rows:
            break
        out += rows
        if len(rows) < 1000:
            break
        off += 1000
    # skip ones already shrunk (longest side already <= target + slack)
    return [r for r in out if max(r.get("width") or 0, r.get("height") or 0) > DISPLAY_MAX + 5]


def download(display_path: str) -> bytes:
    endpoint = f"{URL}/storage/v1/object/public/{BUCKET}/{display_path}"
    with urllib.request.urlopen(endpoint, timeout=120) as resp:
        return resp.read()


def reencode(raw: bytes):
    im = Image.open(io.BytesIO(raw))
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGB")
    im.thumbnail((DISPLAY_MAX, DISPLAY_MAX), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="WEBP", quality=WEBP_QUALITY, method=6)
    return buf.getvalue(), im.width, im.height


def upload(display_path: str, webp: bytes):
    endpoint = f"{URL}/storage/v1/object/{BUCKET}/{display_path}"
    req = urllib.request.Request(endpoint, data=webp, method="POST", headers={
        "apikey": KEY, "Authorization": f"Bearer {KEY}",
        "Content-Type": "image/webp", "x-upsert": "true",
    })
    with urllib.request.urlopen(req, timeout=120) as resp:
        resp.read()


def patch_row(row_id: str, nbytes: int, w: int, h: int):
    db._req("PATCH", f"sku_images?id=eq.{row_id}", body={"bytes": nbytes, "width": w, "height": h}, prefer="return=minimal")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--sample", type=int, default=400)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=16)
    a = ap.parse_args()
    if not (a.dry_run or a.apply):
        ap.error("pass --dry-run or --apply")

    rows = fetch_rows()
    print(f"rows needing re-encode (>{DISPLAY_MAX}px): {len(rows)}")
    if not rows:
        print("nothing to do — everything is already <= target.")
        return

    if a.dry_run:
        sample = rows[:: max(1, len(rows) // a.sample)][: a.sample]
        old = new = 0
        ok = 0
        for r in sample:
            try:
                raw = download(r["display_path"])
                webp, _, _ = reencode(raw)
                old += len(raw); new += len(webp); ok += 1
            except Exception as e:  # noqa
                print("  sample error:", r["display_path"], e)
        if not ok:
            print("dry-run: no samples succeeded"); return
        ratio = new / old
        cur_total = sum((r.get("bytes") or 0) for r in fetch_all_bytes())
        proj = cur_total * ratio
        print(f"\n  sampled {ok} files: {old/1024/1024:.2f} MB → {new/1024/1024:.2f} MB  (ratio {ratio:.3f})")
        print(f"  current bucket (all stored webps): {cur_total/1024/1024:.0f} MB")
        print(f"  PROJECTED after regen:             {proj/1024/1024:.0f} MB  ({(1-proj/cur_total)*100:.0f}% smaller)")
        return

    # --apply
    todo = rows[: a.limit] if a.limit else rows
    print(f"applying to {len(todo)} files with {a.workers} workers…")
    done = {"n": 0, "old": 0, "new": 0, "err": 0}

    def work(r):
        try:
            raw = download(r["display_path"])
            webp, w, h = reencode(raw)
            upload(r["display_path"], webp)
            patch_row(r["id"], len(webp), w, h)
            with _lock:
                done["n"] += 1; done["old"] += len(raw); done["new"] += len(webp)
                if done["n"] % 500 == 0:
                    print(f"  {done['n']}/{len(todo)}  saved so far {(done['old']-done['new'])/1024/1024:.0f} MB  errs {done['err']}")
        except Exception as e:  # noqa
            with _lock:
                done["err"] += 1
                if done["err"] <= 10:
                    print("  ERROR", r["display_path"], e)

    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as ex:
        list(ex.map(work, todo))
    print(f"\nDONE: {done['n']} re-encoded, {done['err']} errors. "
          f"{done['old']/1024/1024:.0f} MB → {done['new']/1024/1024:.0f} MB "
          f"(freed {(done['old']-done['new'])/1024/1024:.0f} MB).")


def fetch_all_bytes():
    out, off = [], 0
    while True:
        rows = db._req("GET", "sku_images?" + urllib.parse.urlencode({
            "select": "bytes", "display_path": "not.is.null", "limit": 1000, "offset": off}))
        if not rows:
            break
        out += rows
        if len(rows) < 1000:
            break
        off += 1000
    return out


if __name__ == "__main__":
    main()
