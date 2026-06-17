#!/usr/bin/env python3
"""Additive bulk-restore of dropped (barcode, item_code) pairs — Stage 1 of docs/010.

The original import kept only the FIRST owner of each shared barcode (single-column PK); the rest
were dropped. After 0020 makes barcodes a composite (barcode, item_code) key, this script re-parses
the source Catalogue workbooks and INSERTS the missing pairs so every shared barcode links to all
its SKUs (Receiving then shows the picker honestly).

Parsing reuses the importer's own read_catalogue() (same dedup + the reworked plain-pair logic), so
the pairs are byte-for-byte what a fresh import would emit. The diff against the live barcodes table
is the to-add set (≈ the 77 known collisions).

HARD GUARD — this script is INSERT-ONLY and touches ONLY the `barcodes` table: it issues GET
barcodes (paginated read) and, with --execute, POST barcodes with on-conflict-(barcode,item_code)-
do-nothing. There is no DELETE/PATCH/PUT anywhere and no other table name in the file. No truncate.

Usage (run on Andrio's Mac, where the workbooks + .env.local live):
  python3 scripts/import/sync_barcodes.py            # dry-run (default): report the to-add set
  python3 scripts/import/sync_barcodes.py --execute  # insert the missing pairs
"""
from __future__ import annotations
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import import_jigzle as imp          # noqa: E402  (import-safe: guarded by `if __name__ == '__main__'`)
from db import Client, load_env      # noqa: E402

TABLE = "barcodes"   # the ONLY table this script ever reads or writes
BATCH = 500


def parse_pairs():
    """Re-parse the Catalogue workbooks via the importer's read_catalogue() → the full set of
    (barcode, item_code) pairs it would emit (composite model, plain pairs). read_catalogue only
    reads workbooks + mutates a throwaway Report; it never touches the DB. Returns
    (pair_to_row, collision_count)."""
    ctx = imp.Ctx(None, True, imp.Report())      # dry ctx, db=None — read_catalogue never uses ctx.db
    _cat, bc_rows, _src, _self = imp.read_catalogue(ctx)
    pair_to_row = {(r["barcode"], r["item_code"]): r for r in bc_rows}
    return pair_to_row, len(ctx.r.collisions)


def fetch_live_pairs(db):
    """All (barcode, item_code) pairs currently in the live barcodes table (paginated, READ-ONLY)."""
    pairs = set()
    page, off = 1000, 0
    while True:
        rows = db._req("GET", f"{TABLE}?select=barcode,item_code&order=barcode,item_code&limit={page}&offset={off}")
        if not rows:
            break
        for r in rows:
            pairs.add((r["barcode"], r["item_code"]))
        if len(rows) < page:
            break
        off += page
    return pairs


def insert_missing(db, rows):
    """INSERT-ONLY into barcodes with on-conflict-(barcode,item_code)-do-nothing. Issues only
    POST barcodes with resolution=ignore-duplicates — never delete/update, never another table."""
    for i in range(0, len(rows), BATCH):
        db._req("POST", TABLE, body=rows[i:i + BATCH],
                prefer="resolution=ignore-duplicates,return=minimal")


def main():
    ap = argparse.ArgumentParser(description="Additive bulk-restore of dropped (barcode, item_code) pairs")
    ap.add_argument("--execute", action="store_true", help="insert the missing pairs (default: dry-run)")
    args = ap.parse_args()
    dry = not args.execute

    env = load_env()
    db = Client(env.get("NEXT_PUBLIC_SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY"))
    db._req("GET", f"{TABLE}?select=barcode&limit=1")   # connectivity check (barcodes only)

    print(f"[{'dry-run' if dry else 'EXECUTE'}] re-parsing Catalogue workbooks …")
    pair_to_row, collisions = parse_pairs()
    parsed = set(pair_to_row)
    live = fetch_live_pairs(db)
    to_add = sorted(parsed - live)
    already = len(parsed & live)

    print(f"\n  parsed pairs (workbooks):   {len(parsed)}")
    print(f"  already in barcodes:        {already}")
    print(f"  TO ADD (missing pairs):     {len(to_add)}")
    print(f"  reused-barcode collisions logged by the parser: {collisions}  (to-add should be ≈ this)")
    print("  DELETES: 0 · UPDATES: 0   (INSERT-ONLY, barcodes table only)")
    if to_add:
        print("\n  sample to-add:")
        for bc, code in to_add[:10]:
            print(f"   • {bc} → {code}")
        if len(to_add) > 10:
            print(f"   … +{len(to_add) - 10} more")

    if dry:
        print("\n  dry-run — nothing written. Re-run with --execute to insert the missing pairs.")
        return

    rows = [pair_to_row[p] for p in to_add]
    if not rows:
        print("\n  nothing to add — barcodes already in sync.")
        return
    print(f"\n  inserting {len(rows)} pairs (on conflict (barcode, item_code) do nothing) …")
    insert_missing(db, rows)

    live2 = fetch_live_pairs(db)
    present = len(set(to_add) & live2)
    missing = len(to_add) - present
    print(f"  done. now present: {present}/{len(to_add)}" + (f" · STILL MISSING: {missing}" if missing else " · all present"))
    sys.exit(1 if missing else 0)


if __name__ == "__main__":
    main()
