#!/usr/bin/env python3
"""Reconcile public.inbound to the canonical "Inbound Data" CSV (the receipt / stock-in record).

inbound is the "+" side of stock (stock_check = Σ inbound(not excluded) − Σ sales). This rebuilds the
LEGACY rows from the CSV so the DB reflects the sheet exactly, while PRESERVING rows created by the app
(record_receipt sets receipt_id — those are kept so recent in-app receiving + the reversible receipts
ledger stay intact). Column mapping mirrors import_jigzle.load_inbound exactly.

The CSV's real header is its SECOND row (the first is a spacer). Columns:
  0 Item Code · 1 Qty · 2 Ship ID · 3 Receive Date · 4 NOMOR RESI || DETAIL PRODUK ·
  5 Dimension / Weight · 6 📌Label · 7 Box ID
A Receive Date of "Up to 2023" marks an OPENING BALANCE → is_opening_balance, receive_date 2023-12-31.
Column 4 packs "tracking || note". Label is kept only for Exclude/Hold/Tokopedia. A line is excluded
when label='Exclude' or the note matches the exclude vocabulary.

Usage (from repo root):
    python3 scripts/import/reconcile_inbound.py INBOUND.csv            # DRY-RUN (no DB)
    python3 scripts/import/reconcile_inbound.py INBOUND.csv --execute  # write to DB

--execute resolves item_codes against the live catalogue (paged past the PostgREST 1000-row cap),
deletes only the legacy rows (receipt_id IS NULL), and inserts the CSV rows. Verify the dry-run first.
"""
from __future__ import annotations
import csv
import re
import sys
from collections import Counter

from db import load_env, Client  # type: ignore

EXCLUDE_RE = re.compile(r"exclude|gift|rusak|bonus|damage|hadiah|sample", re.I)
KEEP_LABELS = {"Exclude", "Hold", "Tokopedia"}
UP_TO_2023 = "up to 2023"


def clean(v):
    if v is None:
        return None
    s = str(v).replace("\xa0", " ").strip()
    return s or None


def to_int(v):
    s = clean(v)
    if not s:
        return None
    try:
        return int(round(float(s.replace(",", ""))))
    except ValueError:
        m = re.search(r"-?\d+", s)
        return int(m.group()) if m else None


def parse_date(v):
    s = clean(v)
    if not s:
        return None
    m = re.match(r"^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})", s)
    if not m:
        return None
    y, mo, d = m.groups()
    return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"


def parse_inbound(path):
    with open(path, newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.reader(fh))
    if len(rows) < 3:
        return [], Counter()
    out, rep = [], Counter()
    for raw in rows[2:]:  # real header is rows[1]; data from rows[2]
        if not any(clean(c) for c in raw):
            continue
        g = lambda i: raw[i] if i < len(raw) else None  # noqa: E731
        qty = to_int(g(1))
        if qty is None:
            rep["skipped_no_qty"] += 1
            continue
        rd_raw = clean(g(3))
        opening = bool(rd_raw) and rd_raw.lower() == UP_TO_2023
        rdate = "2023-12-31" if opening else parse_date(g(3))
        resi = clean(g(4))
        tracking = note = None
        if resi:
            parts = resi.split("||")
            tracking = clean(parts[0])
            note = clean(parts[1]) if len(parts) > 1 else None
        label = clean(g(6))
        if label not in KEEP_LABELS:
            label = None
        excluded = (label == "Exclude") or bool(note and EXCLUDE_RE.search(note))
        rep["read"] += 1
        if opening:
            rep["opening_balance"] += 1
        if excluded:
            rep["excluded"] += 1
        out.append({
            "item_code_in": clean(g(0)),     # resolved at --execute
            "qty": qty,
            "ship_id": clean(g(2)),
            "receive_date": rdate,
            "receive_date_raw": rd_raw,
            "is_opening_balance": opening,
            "excluded": excluded,
            "label": label,
            "tracking": tracking,
            "receive_note": note,
            "dimension_weight": clean(g(5)),
            "transfer_box_id": clean(g(7)),
        })
    return out, rep


def page_all(client, table, select, order):
    """Read every row past the PostgREST db-max-rows cap (page by actual count, stop on empty)."""
    out, offset = [], 0
    while True:
        page = client._req("GET", f"{table}?select={select}&order={order}&limit=1000&offset={offset}") or []
        if not page:
            break
        out.extend(page)
        offset += len(page)
    return out


def batched_delete(client, table, filt, chunk=2000):
    """DELETE rows matching `filt`, batched (a single big DELETE blows statement_timeout)."""
    path = f"{table}?{filt}&created_at=gte.1900-01-01&order=created_at&limit={chunk}&select=created_at"
    while True:
        res = client._req("DELETE", path, prefer="return=representation")
        if not res:
            break


def main():
    args = sys.argv[1:]
    execute = "--execute" in args
    paths = [a for a in args if not a.startswith("-")]
    if not paths:
        print("usage: reconcile_inbound.py <INBOUND.csv> [--execute]", file=sys.stderr)
        sys.exit(2)

    rows, rep = parse_inbound(paths[0])
    ships = {r["ship_id"] for r in rows if r["ship_id"]}
    codes = {r["item_code_in"] for r in rows if r["item_code_in"]}
    print("── reconcile report ───────────────────────────")
    print(f"  rows to write        {rep['read']}")
    print(f"  opening balances     {rep['opening_balance']}")
    print(f"  dated receipts       {rep['read'] - rep['opening_balance']}")
    print(f"  excluded lines       {rep['excluded']}")
    print(f"  skipped (no qty)     {rep['skipped_no_qty']}")
    print(f"  distinct ship-ids    {len(ships)}")
    print(f"  distinct SKUs        {len(codes)}")

    if not execute:
        print("\nDRY-RUN — nothing written. Re-run with --execute to load (verify the numbers first).")
        for r in rows[:5]:
            print("   sample:", {k: r[k] for k in ("item_code_in", "qty", "ship_id", "receive_date", "is_opening_balance", "label")})
        return

    env = load_env()
    client = Client(env.get("NEXT_PUBLIC_SUPABASE_URL", ""), env.get("SUPABASE_SERVICE_ROLE_KEY", ""))
    client.ping()

    valid = {c["item_code"] for c in page_all(client, "catalogue", "item_code", "item_code")}
    print(f"  catalogue codes      {len(valid)}")
    print(f"  inbound rows now     {client.count('inbound') or 0}")

    db_rows, unmatched = [], 0
    for r in rows:
        code = r["item_code_in"]
        ok = bool(code) and code in valid
        if code and not ok:
            unmatched += 1
        db_rows.append({
            "item_code": code if ok else None,
            "item_code_raw": None if ok else code,
            "qty": r["qty"],
            "ship_id": r["ship_id"],
            "receive_date": r["receive_date"],
            "receive_date_raw": r["receive_date_raw"],
            "is_opening_balance": r["is_opening_balance"],
            "excluded": r["excluded"],
            "label": r["label"],
            "tracking": r["tracking"],
            "receive_note": r["receive_note"],
            "dimension_weight": r["dimension_weight"],
            "transfer_box_id": r["transfer_box_id"],
        })
    print(f"  unmatched SKUs       {unmatched} (stored in item_code_raw)")

    print("\nDeleting legacy inbound (receipt_id IS NULL — app receipts kept) + inserting CSV…")
    batched_delete(client, "inbound", "receipt_id=is.null")
    client.insert("inbound", db_rows)
    print(f"  done — {client.count('inbound')} rows now in inbound (CSV {len(db_rows)} + kept app receipts).")


if __name__ == "__main__":
    main()
