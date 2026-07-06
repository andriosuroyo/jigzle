#!/usr/bin/env python3
"""Add-only catalogue backfill (PR194) — insert SKUs present in the old-system region CSVs but
MISSING from the live `catalogue` table. Existing rows are NEVER touched.

Unlike import_jigzle.py (a full clean-load that empties + reloads every table), this script only
ADDS: it fetches the set of item_codes already in the DB and inserts just the ones not there yet,
so any edits made in the app since launch are preserved.

Source: the four region CSV exports (ITEM CODE, SELF CODE, SOURCE 0-6, 🖼️, ORIGINAL/TRANSLATE NAME,
PRODUCT/SUB TYPE, PIECE COUNT/TYPE, SIZE P/L/T, SIZE ALL, PIECE SIZE, IMAGE TYPE, MATERIAL, EFFECT,
ARTIST, TAGS, DIM P/L/T, REAL W, VOL W, DIM ALL, ARTICLE NUMBER, DESCRIPTION, RELEASE DATE,
+THEME/LOCATION in the Japan export). Column order matches import_jigzle.py's catalogue mapping.

Design mirrors import_jigzle.py:
  • --dry-run (default): reads the CSVs, maps every row, prints a reconciliation report, writes
    NOTHING and needs no DB. Add --check-db to also fetch the live item_codes and report how many
    would actually be inserted.
  • --execute: fetches existing item_codes, then inserts only the missing rows (batched, with
    Prefer: resolution=ignore-duplicates as a race-safety net). Uses the SERVICE-ROLE key.

needs_review is DERIVED with the SAME completion gate the app uses (name + brand_prefix +
product_type, plus piece_count_n if a puzzle) — so only genuinely-incomplete imports land in the
Catalog → Fix queue, not all ~47k.

Usage:
  python3 scripts/import/backfill_catalogue.py --dir ~/Downloads            # dry-run (safe)
  python3 scripts/import/backfill_catalogue.py --dir ~/Downloads --check-db  # + live missing count
  python3 scripts/import/backfill_catalogue.py --dir ~/Downloads --execute   # real add-only insert
"""
from __future__ import annotations
import argparse
import csv
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db import Client, load_env  # noqa: E402

# The four region exports. Japan is FIRST so its THEME/LOCATION columns win on a duplicate item_code.
CSV_FILES = [
    "JIGZLE Catalogue — Japan - Catalog.csv",
    "JIGZLE Catalogue — East Asia - Catalog.csv",
    "JIGZLE Catalogue — Americas, UK & Europe - Catalog.csv",
    "JIGZLE Catalogue — Rest of the World - Catalog.csv",
]

DIRTY = {"#VALUE!", "#N/A", "#REF!", "#NUM!", "#NAME?", "#DIV/0!", "Loading ...", "Loading..."}

# the fixed catalogue column set every insert row carries (missing → None → DB null). created_at /
# updated_at / image / image_urls are deliberately omitted so their DB defaults apply.
COLUMNS = [
    "item_code", "self_code", "brand_prefix", "original_name", "translate_name",
    "product_type", "sub_type", "piece_count", "piece_count_n", "piece_type", "piece_size",
    "size_p", "size_l", "size_t", "image_type", "material", "effect", "artist", "tags",
    "dim_p", "dim_l", "dim_t", "real_weight", "article_number", "description",
    "release_date", "release_year", "release_month", "theme", "location",
    "has_image", "needs_review",
]


# ── cell helpers ────────────────────────────────────────────────────────────────
def g(row, i):
    return row[i] if i < len(row) else None


def clean(v):
    if v is None:
        return None
    s = str(v).strip()
    if not s or s in DIRTY:
        return None
    return s


def to_num(v):
    s = clean(v)
    if s is None:
        return None
    s = s.replace(",", "")
    try:
        f = float(s)
    except ValueError:
        return None
    return int(f) if f.is_integer() else f


def to_int(v):
    s = clean(v)
    if s is None:
        return None
    m = re.search(r"\d[\d,]*", s)
    if not m:
        return None
    try:
        return int(m.group(0).replace(",", ""))
    except ValueError:
        return None


def release_ym(rd):
    if not rd:
        return None, None
    y = re.search(r"(19|20)\d{2}", rd)
    year = int(y.group(0)) if y else None
    month = None
    m = re.search(r"(?:19|20)\d{2}[^\d]{1,2}(\d{1,2})", rd)
    if m and 1 <= int(m.group(1)) <= 12:
        month = int(m.group(1))
    return year, month


def is_puzzle(pt):
    return bool(pt) and re.search(r"puzzle", pt, re.I) is not None


def needs_review(r):
    # the app's completion gate (PR18 §6): name + brand + product_type (+ piece count if a puzzle)
    if not (r.get("original_name") or r.get("translate_name")):
        return True
    if not r.get("brand_prefix"):
        return True
    if not r.get("product_type"):
        return True
    if is_puzzle(r.get("product_type")) and r.get("piece_count_n") is None:
        return True
    return False


# ── one CSV row → a catalogue dict (column indices match import_jigzle.py) ──
def map_row(row):
    code = clean(g(row, 0))
    if not code:
        return None
    self_code = clean(g(row, 1))
    ptype = clean(g(row, 12))
    if ptype == "JIgsaw Puzzle":
        ptype = "Jigsaw Puzzle"
    ptype_piece = clean(g(row, 15))
    if ptype_piece == "Blindbox":
        ptype_piece = "Blind Box"
    pc_raw = clean(g(row, 14))
    rd_raw = clean(g(row, 34))
    ry, rm = release_ym(rd_raw)
    r = {
        "item_code": code,
        "self_code": self_code,
        "brand_prefix": (self_code or "").rstrip("-") or None,
        "original_name": clean(g(row, 10)),
        "translate_name": clean(g(row, 11)),
        "product_type": ptype,
        "sub_type": clean(g(row, 13)),
        "piece_count": pc_raw,
        "piece_count_n": to_int(pc_raw) if pc_raw and "," not in pc_raw else None,
        "piece_type": ptype_piece,
        "piece_size": clean(g(row, 20)),
        "size_p": to_num(g(row, 16)), "size_l": to_num(g(row, 17)), "size_t": to_num(g(row, 18)),
        "image_type": clean(g(row, 21)),
        "material": clean(g(row, 22)),
        "effect": clean(g(row, 23)),
        "artist": clean(g(row, 24)),
        "tags": clean(g(row, 25)),
        "dim_p": to_num(g(row, 26)), "dim_l": to_num(g(row, 27)), "dim_t": to_num(g(row, 28)),
        "real_weight": to_num(g(row, 29)),
        "article_number": clean(g(row, 32)),
        "description": clean(g(row, 33)),
        "release_date": rd_raw, "release_year": ry, "release_month": rm,
        "theme": clean(g(row, 35)), "location": clean(g(row, 36)),
        # no migrated image asset in the new system — leave has_image False (add images in-app later)
        "has_image": False,
    }
    r["needs_review"] = needs_review(r)
    return {k: r.get(k) for k in COLUMNS}


def read_all(src_dir: Path):
    """Map every CSV row; dedup by item_code (first file wins → Japan's THEME/LOCATION kept)."""
    by_code = {}
    per_file = []
    for name in CSV_FILES:
        path = src_dir / name
        if not path.exists():
            sys.exit(f"ERROR: missing CSV: {path}")
        n_rows = n_new = 0
        with path.open(newline="") as fh:
            reader = csv.reader(fh)
            next(reader, None)  # header
            for row in reader:
                r = map_row(row)
                if not r:
                    continue
                n_rows += 1
                if r["item_code"] not in by_code:
                    by_code[r["item_code"]] = r
                    n_new += 1
        per_file.append((name, n_rows, n_new))
    return by_code, per_file


def fetch_existing_codes(db: Client) -> set[str]:
    """Every item_code already in catalogue (paged; PostgREST caps a page at 1000)."""
    codes: set[str] = set()
    page = 1000
    offset = 0
    while True:
        res = db._req("GET", f"catalogue?select=item_code&order=item_code&limit={page}&offset={offset}")
        rows = res or []
        for r in rows:
            codes.add(r["item_code"])
        if len(rows) < page:
            break
        offset += page
    return codes


def coverage(rows):
    fields = ["brand_prefix", "product_type", "sub_type", "piece_count_n", "piece_type",
              "size_p", "image_type", "material", "artist", "tags", "theme", "location", "description"]
    n = len(rows)
    print("  field coverage (non-empty):")
    for f in fields:
        c = sum(1 for r in rows if r.get(f) not in (None, "", False))
        print(f"    {f:16s} {c:>7,} / {n:,}  ({(100*c//n) if n else 0}%)")


def main():
    ap = argparse.ArgumentParser(description="Add-only catalogue backfill from the region CSVs.")
    ap.add_argument("--dir", default="~/Downloads", help="folder holding the four CSV exports")
    ap.add_argument("--execute", action="store_true", help="perform the insert (default: dry-run)")
    ap.add_argument("--check-db", action="store_true", help="dry-run + fetch live codes to report the real missing count")
    args = ap.parse_args()

    src = Path(args.dir).expanduser()
    by_code, per_file = read_all(src)
    rows = list(by_code.values())

    print("── source ──")
    for name, n_rows, n_new in per_file:
        print(f"  {name.split('—')[1].split('-')[0].strip():22s}  rows {n_rows:>7,}  new codes +{n_new:,}")
    print(f"  DISTINCT item_codes: {len(rows):,}")
    print()
    coverage(rows)
    nr = sum(1 for r in rows if r["needs_review"])
    print(f"  completion gate: {len(rows)-nr:,} complete · {nr:,} → needs_review")
    print()
    print("  sample mapped rows:")
    for r in rows[:3]:
        print(f"    {r['item_code']}  {r.get('translate_name') or r.get('original_name')}  "
              f"[{r.get('product_type')}/{r.get('piece_count_n')}]  theme={r.get('theme')}")
    print()

    if not args.execute and not args.check_db:
        print("DRY-RUN — nothing written. Re-run with --check-db for the live missing count, or --execute to insert.")
        return

    env = load_env()
    url = env.get("NEXT_PUBLIC_SUPABASE_URL")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit("ERROR: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not in .env.local — required for DB access.")
    db = Client(url, key)
    db.ping()
    print("── database ──")
    existing = fetch_existing_codes(db)
    missing = [r for r in rows if r["item_code"] not in existing]
    print(f"  live catalogue: {len(existing):,} SKUs")
    print(f"  already present: {len(rows)-len(missing):,}   →   TO INSERT: {len(missing):,}")

    if not args.execute:
        print("\nCHECK-DB dry-run — nothing written. Re-run with --execute to insert the missing rows.")
        return

    if not missing:
        print("\nNothing to insert — every CSV SKU is already in the catalogue.")
        return

    # FK completeness: catalogue.brand_prefix → brands.prefix. Synthesize any absent prefix as a bare
    # brands row (name/country null), exactly as import_jigzle does, so the catalogue insert doesn't
    # trip the foreign key. Add-only via ignore-duplicates.
    prefixes = sorted({r["brand_prefix"] for r in missing if r.get("brand_prefix")})
    if prefixes:
        qs = ",".join(prefixes)
        have = {b["prefix"] for b in (db._req("GET", f"brands?select=prefix&prefix=in.({qs})") or [])}
        new_brands = [{"prefix": p} for p in prefixes if p not in have]
        if new_brands:
            print(f"Synthesizing {len(new_brands)} missing brand prefix(es): {', '.join(b['prefix'] for b in new_brands)}")
            db._req("POST", "brands", body=new_brands, prefer="resolution=ignore-duplicates,return=minimal")

    print(f"\nInserting {len(missing):,} rows (add-only, ignore-duplicates)…")
    # uniform single-signature batch (every row has all COLUMNS) → efficient inserts. ignore-duplicates
    # is a race-safety net; the missing-filter already excludes existing codes.
    B = 500
    done = 0
    for i in range(0, len(missing), B):
        chunk = missing[i:i + B]
        db._req("POST", "catalogue", body=chunk, prefer="resolution=ignore-duplicates,return=minimal")
        done += len(chunk)
        print(f"  {done:,} / {len(missing):,}")
    print(f"\nDone. Inserted up to {len(missing):,} new SKUs (needs_review set by the completion gate).")
    print(f"  live catalogue now ≈ {db.count('catalogue'):,}")


if __name__ == "__main__":
    main()
