#!/usr/bin/env python3
"""Reconcile public.outbound_shipments to the canonical CSV export ("Outbound Data").

outbound_shipments is the canonical outbound log (weight, courier, address, items, notes,
verification). This rebuilds it from the CSV so the DB reflects the sheet exactly. The CSV is the
SOURCE OF TRUTH; any "Test" rows are skipped; the table is fully reloaded (delete-all + insert), so
stale/outdated DB rows are replaced.

Each CSV row is one shipment whose "Item Name" cell packs one OR MORE items (newline-separated). Each
item line is "qty　CODE　Brand　Name　Category　✅　barcode" (delimiter = U+3000, the full-width space).
We expand to one outbound_shipments row PER ITEM, repeating the shipment-level fields (customer, date,
address, courier, weight, note). A ✅ marks a barcode scan → verify_method='scan' + scanned_barcode;
otherwise verify_method='manual'.

Usage (from repo root):
    python3 scripts/import/reconcile_outbound.py path/to/Outbound_Data.csv            # DRY-RUN (no DB)
    python3 scripts/import/reconcile_outbound.py path/to/Outbound_Data.csv --execute  # write to DB

Dry-run parses the CSV, applies every transform, prints a reconciliation report, and writes NOTHING
(no DB connection). --execute resolves item_codes against the live catalogue, then delete-alls and
reloads outbound_shipments via the SERVICE-ROLE key from .env.local (NEXT_PUBLIC_SUPABASE_URL +
SUPABASE_SERVICE_ROLE_KEY). Verify the dry-run on a ~20-row slice before running the full file.
"""
from __future__ import annotations
import csv
import re
import sys
from collections import Counter

from db import load_env, Client  # type: ignore

IDSP = "　"      # full-width space — the Item Name field delimiter
CHECK = "✅"     # ✅ — barcode-checked marker
BARCODE_RE = re.compile(r"^\d{8,14}$")
TEST_RE = re.compile(r"\btest\b", re.IGNORECASE)


def clean(v):
    if v is None:
        return None
    s = str(v).replace("\xa0", " ").strip()
    return s or None


def parse_date(v):
    """'2026.06.13' / '2026-06-13' / '2026/06/13' → 'YYYY-MM-DD' (or None)."""
    s = clean(v)
    if not s:
        return None
    m = re.match(r"^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})", s)
    if not m:
        return None
    y, mo, d = m.groups()
    return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"


def to_num(v):
    s = clean(v)
    if not s:
        return None
    s = s.replace(",", "")
    try:
        f = float(s)
        return int(f) if f.is_integer() else f
    except ValueError:
        return None


def parse_items(cell):
    """One Item Name cell → list of {qty, code, verify_method, scanned_barcode}. Newline-separated;
    each line packs fields by U+3000. fields[0]=qty, fields[1]=code, last all-digit field=barcode."""
    s = clean(cell)
    if not s:
        return []
    out = []
    for line in re.split(r"[\r\n]+", s):
        fields = [f.strip() for f in line.split(IDSP) if f.strip()]
        if len(fields) < 2:
            continue
        qty = to_num(fields[0]) or 1
        code = fields[1]
        scanned = next((f for f in reversed(fields) if BARCODE_RE.match(f)), None)
        verify = "scan" if (CHECK in line or scanned) else "manual"
        out.append({
            "qty": int(qty) if isinstance(qty, int) else 1,
            "code": code,
            "verify_method": verify,
            "scanned_barcode": scanned if verify == "scan" else None,
        })
    return out


def parse_csv(path):
    """→ (shipment_item_rows, report Counter). Shipment-level fields repeated per item."""
    rep = Counter()
    rows = []
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.reader(fh)
        header = next(reader, None)  # Customer ID, Date, Name, Item Name, Address, Courier, Notes, Weight (gram)
        for raw in reader:
            if not any(clean(c) for c in raw):
                continue
            g = lambda i: raw[i] if i < len(raw) else None  # noqa: E731
            name = clean(g(2))
            cust_ref = clean(g(0)) or name
            # skip Test shipments (the source occasionally carries them; never load into the log)
            if (name and TEST_RE.search(name)) or (cust_ref and TEST_RE.search(cust_ref)):
                rep["skipped_test"] += 1
                continue
            items = parse_items(g(3))
            if not items:
                rep["skipped_no_items"] += 1
                continue
            rep["shipments"] += 1
            shipment = {
                "customer_ref": cust_ref,
                "ship_date": parse_date(g(1)),
                "recipient_name": name,
                "address": clean(g(4)),
                "courier": clean(g(5)),
                "note": clean(g(6)),
                "weight_gram": to_num(g(7)),
            }
            for it in items:
                rep["items"] += 1
                if it["verify_method"] == "scan":
                    rep["scan_verified"] += 1
                rows.append({**shipment, **it})
    return rows, rep


def main():
    args = [a for a in sys.argv[1:]]
    execute = "--execute" in args
    paths = [a for a in args if not a.startswith("-")]
    if not paths:
        print("usage: reconcile_outbound.py <csv> [--execute]", file=sys.stderr)
        sys.exit(2)

    rows, rep = parse_csv(paths[0])
    print("── parse report ───────────────────────────────")
    for k in ("shipments", "items", "scan_verified", "skipped_test", "skipped_no_items"):
        print(f"  {k:18} {rep[k]}")
    codes = Counter(r["code"] for r in rows)
    print(f"  distinct SKUs      {len(codes)}")
    print(f"  rows to write      {len(rows)}")

    if not execute:
        print("\nDRY-RUN — nothing written. Re-run with --execute to load (verify the numbers above first).")
        # show a small sample for eyeballing
        for r in rows[:5]:
            print("   sample:", {k: r[k] for k in ("ship_date", "recipient_name", "courier", "code", "qty", "verify_method", "weight_gram")})
        return

    env = load_env()
    client = Client(env.get("NEXT_PUBLIC_SUPABASE_URL", ""), env.get("SUPABASE_SERVICE_ROLE_KEY", ""))
    client.ping()

    # resolve item_code against the live catalogue (FK) — unmatched → item_code=NULL, keep item_code_raw
    valid = set()
    offset = 0
    while True:
        page = client._req("GET", f"catalogue?select=item_code&limit=2000&offset={offset}") or []
        valid.update(c["item_code"] for c in page)
        if len(page) < 2000:
            break
        offset += 2000
    print(f"  catalogue codes    {len(valid)}")

    db_rows, unmatched = [], 0
    for r in rows:
        code = r["code"]
        ok = code in valid
        if not ok:
            unmatched += 1
        db_rows.append({
            "customer_ref": r["customer_ref"], "ship_date": r["ship_date"],
            "recipient_name": r["recipient_name"], "address": r["address"], "courier": r["courier"],
            "note": r["note"], "weight_gram": r["weight_gram"], "qty": r["qty"],
            "item_code": code if ok else None, "item_code_raw": None if ok else code,
            "verify_method": r["verify_method"], "scanned_barcode": r["scanned_barcode"],
        })
    print(f"  unmatched SKUs     {unmatched} (stored in item_code_raw)")

    print("\nReloading outbound_shipments (delete-all + insert)…")
    client.delete_all("outbound_shipments")
    client.insert("outbound_shipments", db_rows)
    print(f"  done — {client.count('outbound_shipments')} rows now in outbound_shipments.")


if __name__ == "__main__":
    main()
