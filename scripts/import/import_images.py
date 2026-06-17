#!/usr/bin/env python3
"""SKU image bootstrap — Stage 1 of docs/011. DISPLAY-ONLY. Run on Andrio's Mac.

Walks the two Google-Drive folders (A. Pre Edited `_0/_1/…`, B. Edited `_edit`), matches each file to
a catalogue item_code, resolves the primary per SKU (B `_edit` → A `_0` → A lowest `_<n>`), generates
a single ~400px `display.webp` for the PRIMARY ONLY, uploads it to Storage `sku-images/{item_code}/
display.webp`, and points `catalogue.primary_image_id` + sets `image_status`. Originals are NEVER
uploaded — `source_path` keeps the Drive provenance; Drive stays the cold archive. It also emits the
reconciliation report (orphan files / missing SKUs / conflicts) and fills `image_orphans`.

Mirrors sync_barcodes.py: **dry-run by default**, `--execute` to apply, idempotent (skips unchanged
uploads via content_hash, re-points only on change). Touches ONLY the image tables/columns + the
`sku-images` bucket. Needs `Pillow` and `rapidfuzz` (pip install pillow rapidfuzz).

  python3 scripts/import/import_images.py --dir-a "<A folder>" --dir-b "<B folder>"            # dry-run
  python3 scripts/import/import_images.py --dir-a "<A folder>" --dir-b "<B folder>" --execute  # apply
  # (folders may also come from JZ_IMG_DIR_A / JZ_IMG_DIR_B env vars)
"""
from __future__ import annotations
import argparse
import csv
import hashlib
import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db import Client, load_env  # noqa: E402

# ── config (no hard-coded secrets) ──
NOT_FOUND_CSV = Path(__file__).resolve().parent / "image_not_found_skus.csv"
BUCKET = "sku-images"
DISPLAY_MAX = 400          # longest side, px
WEBP_QUALITY = 80
FUZZY_THRESHOLD = 0.85     # orphan-suggest cutoff (never auto-applied)
IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
PAGE = 1000

# ── stem / code parsing (unicode-safe — CJK item codes exist) ──
_SUFFIX_RE = re.compile(r"^(.*?)_(edit|\d+)$", re.UNICODE)

def parse_stem(stem: str):
    """('<code>_edit'|'<code>_3') → (candidate_item_code, variant). No suffix → (stem, '')."""
    m = _SUFFIX_RE.match(stem)
    if m:
        return m.group(1), "_" + m.group(2)
    return stem, ""

def normalize_code(s: str) -> str:
    """Uppercase, drop separators, strip per-segment leading zeros so EPO-60-15 ≡ EPO-60-015."""
    out = []
    for tok in re.findall(r"\d+|[^\d]+", s.upper()):
        out.append(str(int(tok)) if tok.isdigit() else re.sub(r"[-_\s]+", "", tok))
    return "".join(out)

def primary_rank(source: str, variant: str):
    """D1 priority — lower sorts first: edited/_edit, then pre/_0, then pre/_<n> ascending."""
    if source == "edited" and variant == "_edit":
        return (0, 0)
    if source == "pre" and variant == "_0":
        return (1, 0)
    if source == "pre" and re.fullmatch(r"_\d+", variant):
        return (2, int(variant[1:]))
    return (3, 0)

# ── display derivative (Pillow) ──
def make_display(raw: bytes):
    """Fit longest side ~400px, return (webp_bytes, width, height)."""
    from PIL import Image  # lazy: only needed when generating
    im = Image.open(io.BytesIO(raw))
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGB")
    im.thumbnail((DISPLAY_MAX, DISPLAY_MAX), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="WEBP", quality=WEBP_QUALITY, method=6)
    return buf.getvalue(), im.width, im.height

# ── storage upload (service-role; only ever writes to the sku-images bucket) ──
def upload_display(url: str, key: str, item_code: str, webp: bytes):
    path = f"{urllib.parse.quote(item_code, safe='')}/display.webp"
    endpoint = f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{path}"
    req = urllib.request.Request(endpoint, data=webp, method="POST", headers={
        "apikey": key, "Authorization": f"Bearer {key}",
        "Content-Type": "image/webp", "x-upsert": "true",
    })
    with urllib.request.urlopen(req, timeout=120) as resp:
        resp.read()
    return path

# ── DB helpers (only image tables/columns + catalogue.image_status/primary_image_id) ──
def all_item_codes(db: Client):
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

def upsert_candidate(db: Client, row: dict):
    """Upsert one sku_images row on (item_code, source, variant); return the stored row (with id).
    on_conflict MUST name the natural key — merge-duplicates otherwise targets the PK (id), which has
    a gen_random_uuid default we never send, so it would never conflict and a re-run would 409."""
    res = db._req("POST", "sku_images?on_conflict=item_code,source,variant", body=[row],
                  prefer="resolution=merge-duplicates,return=representation")
    return res[0] if res else None

def patch(db: Client, path: str, body: dict):
    db._req("PATCH", path, body=body, prefer="return=minimal")

def q(s: str) -> str:
    return urllib.parse.quote(str(s), safe="")


def main():
    ap = argparse.ArgumentParser(description="SKU image bootstrap (display-only)")
    ap.add_argument("--execute", action="store_true", help="apply (default: dry-run)")
    ap.add_argument("--dir-a", default=os.environ.get("JZ_IMG_DIR_A", ""), help="A. Pre Edited folder")
    ap.add_argument("--dir-b", default=os.environ.get("JZ_IMG_DIR_B", ""), help="B. Edited folder")
    args = ap.parse_args()
    dry = not args.execute
    if not args.dir_a or not args.dir_b:
        sys.exit("ERROR: set both folders via --dir-a/--dir-b or JZ_IMG_DIR_A / JZ_IMG_DIR_B.")
    dir_a, dir_b = Path(args.dir_a), Path(args.dir_b)
    for d in (dir_a, dir_b):
        if not d.is_dir():
            sys.exit(f"ERROR: not a folder: {d}")

    env = load_env()
    url = env.get("NEXT_PUBLIC_SUPABASE_URL")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    db = Client(url, key)
    db._req("GET", "catalogue?select=item_code&limit=1")  # connectivity check

    print(f"[{'dry-run' if dry else 'EXECUTE'}] loading catalogue + the 🖼️ (not_found) set …")
    catalogue = all_item_codes(db)
    not_found_set = set()
    if NOT_FOUND_CSV.exists():
        with NOT_FOUND_CSV.open(newline="") as f:
            for r in csv.DictReader(f):
                code = (r.get("item_code") or "").strip()
                if code:
                    not_found_set.add(code)
    print(f"  catalogue SKUs: {len(catalogue)} · 🖼️ not_found set: {len(not_found_set)}")

    # ── index files in A (pre) and B (edited) ──
    files_by_code: dict[str, list] = {}   # matched item_code -> [(source, variant, path)]
    orphans: list[tuple] = []             # (path, source, variant, candidate_code) — stem matched no SKU
    skipped = 0
    for folder, source in ((dir_b, "edited"), (dir_a, "pre")):
        for p in sorted(folder.rglob("*")):
            if not p.is_file() or p.suffix.lower() not in IMG_EXTS:
                continue
            cand, variant = parse_stem(p.stem)
            if not variant:
                skipped += 1
                continue
            if cand in catalogue:
                files_by_code.setdefault(cand, []).append((source, variant, p))
            else:
                orphans.append((p, source, variant, cand))

    # ── resolve primary per SKU ──
    matched = {}   # item_code -> (source, variant, path) chosen as primary
    candidates = {}  # item_code -> all (source, variant, path)
    for code, files in files_by_code.items():
        files_sorted = sorted(files, key=lambda f: primary_rank(f[0], f[1]))
        candidates[code] = files_sorted
        matched[code] = files_sorted[0]

    matched_codes = set(matched)
    unmatched = catalogue - matched_codes
    notfound_codes = unmatched & not_found_set
    pending_codes = unmatched - not_found_set
    conflicts = sorted(matched_codes & not_found_set)   # 🖼️-marked but a file exists (file wins)

    # ── reconciliation: fuzzy-suggest a missing SKU for each orphan file ──
    from rapidfuzz import fuzz, process  # lazy: only needed for orphan suggestions
    miss_list = sorted(unmatched)
    norm_to_code = {}
    for c in miss_list:
        norm_to_code.setdefault(normalize_code(c), c)
    norm_keys = list(norm_to_code.keys())
    orphan_rows = []
    for (p, source, variant, cand) in orphans:
        ncand = normalize_code(cand)
        suggestion, score = None, 0.0
        if ncand in norm_to_code:
            suggestion, score = norm_to_code[ncand], 1.0
        elif norm_keys:
            best = process.extractOne(ncand, norm_keys, scorer=fuzz.ratio)
            if best and best[1] / 100.0 >= FUZZY_THRESHOLD:
                suggestion, score = norm_to_code[best[0]], round(best[1] / 100.0, 3)
        orphan_rows.append({
            "orphan_path": str(p), "source": source, "variant": variant,
            "suggested_item_code": suggestion, "score": score or None,
        })

    # ── generate display bytes for each primary (needed for the dry-run byte estimate too) ──
    total_display_bytes = 0
    display_cache = {}   # item_code -> (webp_bytes, w, h, content_hash)
    gen_errors = []
    for code, (source, variant, path) in matched.items():
        try:
            raw = path.read_bytes()
            webp, w, h = make_display(raw)
            display_cache[code] = (webp, w, h, hashlib.sha256(raw).hexdigest())
            total_display_bytes += len(webp)
        except Exception as e:  # noqa: BLE001 — report, don't abort the whole run
            gen_errors.append((code, str(path), str(e)))

    # ── report ──
    mb = total_display_bytes / (1024 * 1024)
    print("\n  ── status ──")
    print(f"   has_image (matched files): {len(matched_codes)}")
    print(f"   not_found (🖼️, no file):    {len(notfound_codes)}")
    print(f"   pending  (no file, no 🖼️): {len(pending_codes)}")
    print(f"   candidate files indexed:   {sum(len(v) for v in candidates.values())} · unparseable skipped: {skipped}")
    print("\n  ── reconciliation ──")
    print(f"   orphan files (no SKU match): {len(orphan_rows)}  ({sum(1 for o in orphan_rows if o['suggested_item_code'])} with a suggestion)")
    print(f"   missing SKUs (no file):      {len(unmatched)}")
    print(f"   conflicts (🖼️ but has file): {len(conflicts)}")
    print(f"\n  ── storage (display.webp, primary only) ──")
    print(f"   to upload: {len(display_cache)} images · total {mb:.1f} MB  ({'OK ≪ 1 GB' if mb < 1024 else '⚠ OVER 1 GB'})")
    if gen_errors:
        print(f"   ⚠ {len(gen_errors)} display(s) failed to generate (see first 5):")
        for c, pth, err in gen_errors[:5]:
            print(f"     • {c}: {err}")
    print("  DELETES: 0  (this importer only inserts/updates image rows + uploads display.webp)")

    if dry:
        print("\n  dry-run — nothing written/uploaded. Re-run with --execute to apply.")
        # surface a few sample suggestions to eyeball the fuzzy matching
        sample = [o for o in orphan_rows if o["suggested_item_code"]][:10]
        if sample:
            print("\n  sample orphan suggestions:")
            for o in sample:
                print(f"   • {Path(o['orphan_path']).name} → {o['suggested_item_code']} ({o['score']})")
        return

    # ── EXECUTE ──
    print("\n  writing sku_images rows + uploading display.webp …")
    for code, files in candidates.items():
        primary = matched[code]
        ids = {}
        for (source, variant, path) in files:
            stored = upsert_candidate(db, {
                "item_code": code, "source": source, "variant": variant,
                "source_path": str(path),
            })
            if stored:
                ids[(source, variant)] = stored
        primary_key = (primary[0], primary[1])
        primary_row = ids.get(primary_key)
        if not primary_row:
            continue
        primary_id = primary_row["id"]

        # upload display only when content changed (idempotent)
        disp = display_cache.get(code)
        if disp:
            webp, w, h, chash = disp
            if not (primary_row.get("content_hash") == chash and primary_row.get("display_path")):
                display_path = upload_display(url, key, code, webp)
                patch(db, f"sku_images?id=eq.{q(primary_id)}", {
                    "display_path": display_path, "width": w, "height": h,
                    "bytes": len(webp), "content_hash": chash,
                })

        # exactly one primary: clear the others first (partial unique index), then set this one
        patch(db, f"sku_images?item_code=eq.{q(code)}&id=neq.{q(primary_id)}&is_primary=eq.true", {"is_primary": False})
        patch(db, f"sku_images?id=eq.{q(primary_id)}", {"is_primary": True})
        patch(db, f"catalogue?item_code=eq.{q(code)}", {"image_status": "has_image", "primary_image_id": primary_id})

    print("  setting not_found / pending statuses …")
    def batch_status(codes, status):
        codes = list(codes)
        for i in range(0, len(codes), 100):  # 100 keeps the in.() URL well under typical limits (CJK codes)
            chunk = codes[i:i + 100]
            inlist = ",".join(q(c) for c in chunk)
            patch(db, f"catalogue?item_code=in.({inlist})", {"image_status": status, "primary_image_id": None})
    batch_status(notfound_codes, "not_found")
    batch_status(pending_codes, "pending")

    print("  recording orphans → image_orphans …")
    if orphan_rows:
        # ignore-duplicates on orphan_path → idempotent re-runs, and never clobber an admin's
        # accepted/rejected status (we don't send status, so existing rows are left untouched).
        for i in range(0, len(orphan_rows), 200):
            db._req("POST", "image_orphans?on_conflict=orphan_path", body=orphan_rows[i:i + 200],
                    prefer="resolution=ignore-duplicates,return=minimal")

    print(f"\n  done. has_image={len(matched_codes)} not_found={len(notfound_codes)} pending={len(pending_codes)} "
          f"orphans={len(orphan_rows)} uploaded≈{len(display_cache)} ({mb:.1f} MB).")


if __name__ == "__main__":
    main()
