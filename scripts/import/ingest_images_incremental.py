#!/usr/bin/env python3
"""Incremental SKU-image ingest — the ADDITIVE-ONLY sibling of import_images.py (docs/011).

Unlike import_images.py (which walks the WHOLE Drive library and RESETS every unmatched SKU to
`pending` — destructive with a partial input), this script touches ONLY the SKUs whose files are in
`--dir`. It's built for the weekly "quick pass for flagged SKUs": a Claude session downloads the newly
added `<code>_edit.jpg` / `<code>_<n>.jpg` files into a folder, then runs this to ingest just those.

Per file: parse `<code>_<variant>`, confirm the code is in the catalogue, generate a 300px display.webp,
upload it to Storage `sku-images/{code}/display.webp` (service-role), upsert the sku_images row, set it
primary, and point catalogue.primary_image_id + image_status='has_image'. NEVER downgrades or resets any
other SKU. Idempotent (content_hash skips re-upload; re-pointing only on change).

  python3 scripts/import/ingest_images_incremental.py --dir /tmp/dl            # dry-run
  python3 scripts/import/ingest_images_incremental.py --dir /tmp/dl --execute  # apply

Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Needs Pillow.
"""
from __future__ import annotations
import argparse, hashlib, io, json, os, re, sys, urllib.parse, urllib.request
from pathlib import Path

BUCKET = "sku-images"
DISPLAY_MAX = 300
WEBP_QUALITY = 80
IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
PAGE = 1000
_SUFFIX_RE = re.compile(r"^(.*?)_(edit|\d+)$", re.UNICODE)


def parse_stem(stem: str):
    m = _SUFFIX_RE.match(stem)
    return (m.group(1), "_" + m.group(2)) if m else (stem, "")


def source_of(variant: str) -> str:
    return "edited" if variant == "_edit" else "pre"


def primary_rank(variant: str):
    if variant == "_edit":
        return (0, 0)
    if variant == "_0":
        return (1, 0)
    if re.fullmatch(r"_\d+", variant):
        return (2, int(variant[1:]))
    return (3, 0)


def make_display(raw: bytes):
    from PIL import Image
    im = Image.open(io.BytesIO(raw))
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGB")
    im.thumbnail((DISPLAY_MAX, DISPLAY_MAX), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="WEBP", quality=WEBP_QUALITY, method=6)
    return buf.getvalue(), im.width, im.height


def q(s: str) -> str:
    return urllib.parse.quote(str(s), safe="")


class Db:
    def __init__(self, url: str, key: str):
        self.url = url.rstrip("/")
        self.key = key

    def _req(self, method: str, path: str, body=None, prefer=None):
        headers = {"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}
        if prefer:
            headers["Prefer"] = prefer
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"{self.url}/rest/v1/{path}", data=data, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=60) as resp:
            txt = resp.read().decode()
            return json.loads(txt) if txt else None

    def upload_display(self, item_code: str, webp: bytes) -> str:
        path = f"{q(item_code)}/display.webp"
        req = urllib.request.Request(
            f"{self.url}/storage/v1/object/{BUCKET}/{path}", data=webp, method="POST",
            headers={"apikey": self.key, "Authorization": f"Bearer {self.key}",
                     "Content-Type": "image/webp", "x-upsert": "true"})
        with urllib.request.urlopen(req, timeout=180) as resp:
            resp.read()
        return path


def all_item_codes(db: Db):
    codes, off = set(), 0
    while True:
        rows = db._req("GET", f"catalogue?select=item_code&order=item_code&limit={PAGE}&offset={off}")
        if not rows:
            break
        codes.update(r["item_code"] for r in rows)
        if len(rows) < PAGE:
            break
        off += PAGE
    return codes


def main():
    ap = argparse.ArgumentParser(description="Incremental SKU-image ingest (additive only)")
    ap.add_argument("--dir", required=True, help="folder of <code>_<variant>.<ext> files to ingest")
    ap.add_argument("--execute", action="store_true", help="apply (default: dry-run)")
    args = ap.parse_args()
    dry = not args.execute
    d = Path(args.dir)
    if not d.is_dir():
        sys.exit(f"ERROR: not a folder: {d}")

    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit("ERROR: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set")
    db = Db(url, key)

    print(f"[{'dry-run' if dry else 'EXECUTE'}] loading catalogue codes …")
    catalogue = all_item_codes(db)

    # index the input dir → item_code -> best (variant, path)
    best: dict[str, tuple] = {}
    unmatched_files, skipped = [], 0
    for p in sorted(d.rglob("*")):
        if not p.is_file() or p.suffix.lower() not in IMG_EXTS:
            continue
        cand, variant = parse_stem(p.stem)
        if not variant:
            skipped += 1
            continue
        if cand not in catalogue:
            unmatched_files.append(p.name)
            continue
        if cand not in best or primary_rank(variant) < primary_rank(best[cand][0]):
            best[cand] = (variant, p)

    print(f"  files matched to SKUs: {len(best)} · unmatched files: {len(unmatched_files)} · unparseable: {skipped}")
    if unmatched_files:
        print("  ⚠ unmatched (no such SKU): " + ", ".join(unmatched_files[:10]) + (" …" if len(unmatched_files) > 10 else ""))
    if not best:
        print("  nothing to ingest.")
        return

    done, uploaded, errors = 0, 0, []
    for code, (variant, path) in sorted(best.items()):
        try:
            raw = path.read_bytes()
            webp, w, h = make_display(raw)
            chash = hashlib.sha256(raw).hexdigest()
        except Exception as e:  # noqa: BLE001
            errors.append((code, str(e)))
            continue
        print(f"  {'would ingest' if dry else 'ingest'}: {code}  ({variant}, {len(raw)//1024}KB → webp {len(webp)//1024}KB {w}x{h})")
        if dry:
            done += 1
            continue
        # upsert the candidate row (natural key: item_code, source, variant)
        row = {"item_code": code, "source": source_of(variant), "variant": variant, "source_path": str(path.name)}
        stored = db._req("POST", "sku_images?on_conflict=item_code,source,variant", body=[row],
                         prefer="resolution=merge-duplicates,return=representation")
        pr = stored[0] if stored else None
        if not pr:
            errors.append((code, "upsert returned no row"))
            continue
        pid = pr["id"]
        if not (pr.get("content_hash") == chash and pr.get("display_path")):
            dp = db.upload_display(code, webp)
            db._req("PATCH", f"sku_images?id=eq.{q(pid)}",
                    body={"display_path": dp, "width": w, "height": h, "bytes": len(webp), "content_hash": chash},
                    prefer="return=minimal")
            uploaded += 1
        # exactly one primary: clear others, set this, point catalogue
        db._req("PATCH", f"sku_images?item_code=eq.{q(code)}&id=neq.{q(pid)}&is_primary=eq.true",
                body={"is_primary": False}, prefer="return=minimal")
        db._req("PATCH", f"sku_images?id=eq.{q(pid)}", body={"is_primary": True}, prefer="return=minimal")
        db._req("PATCH", f"catalogue?item_code=eq.{q(code)}",
                body={"image_status": "has_image", "primary_image_id": pid}, prefer="return=minimal")
        done += 1

    print(f"\n  {'would ingest' if dry else 'ingested'}: {done} · uploaded: {uploaded} · errors: {len(errors)}")
    for c, e in errors[:5]:
        print(f"   • {c}: {e}")
    if dry:
        print("  dry-run — nothing written. Re-run with --execute to apply.")


if __name__ == "__main__":
    main()
