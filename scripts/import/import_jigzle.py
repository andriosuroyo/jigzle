#!/usr/bin/env python3
"""Jigzle Phase-1 data lift — load the old Google-Sheets .xlsx exports into Supabase.

Spec: docs/import-reference.md  ·  Targets: migrations 0003–0010.

Design:
  • Full CLEAN LOAD (Decision D7): every data table is emptied and reloaded in FK order
    each run, so surrogate ids stay internally consistent. Re-running is safe.
  • --dry-run (default): reads the xlsx, runs every transform, prints the full
    reconciliation report, and writes NOTHING (no DB needed).
  • --execute: performs the clean load against Supabase using the SERVICE-ROLE key
    (bypasses RLS). Never uses the anon key.

Usage:
  python3 scripts/import/import_jigzle.py            # dry-run (safe)
  python3 scripts/import/import_jigzle.py --execute  # real clean load
"""
from __future__ import annotations
import argparse
import sys
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parent))
import transforms as t          # noqa: E402
from db import Client, load_env, REPO_ROOT  # noqa: E402

# ── source files ──────────────────────────────────────────────────────────────
CATALOGUE_FILES = [
    ("migration/JIGZLE Catalogue — Japan.xlsx", True),
    ("migration/JIGZLE Catalogue — East Asia.xlsx", False),
    ("migration/JIGZLE Catalogue — Americas, UK & Europe.xlsx", False),
    ("migration/JIGZLE Catalogue — Rest of the World.xlsx", False),
]
SALES = "migration/JIGZLE Sales.xlsx"
BACKUP = ("migration/SheetDev/Management Inventory & Sales Product/"
          "JIGZLE Inventory & Sales Products/~ Props/JIGZLE Props_ Sales.xlsx")
INBOUND = "migration/JIGZLE Inbound.xlsx"
ORDER = "migration/JIGZLE Order(1).xlsx"
OUTBOUND = "migration/JIGZLE Outbound.xlsx"
WAREHOUSE = "migration/JIGZLE _ Warehouse.xlsx"

# Insert order (parents → children). Clean deletes in reverse.
FK_ORDER = [
    "brands", "suppliers", "catalogue", "customers", "barcodes", "sku_sources",
    "customer_addresses", "forwarders", "shipments", "orders", "holds",
    "order_lines", "payments", "inbound", "purchase_orders", "missing_pieces",
    "outbound_shipments", "royalty_paid",
]

DIRTY = {"#VALUE!", "#N/A", "#REF!", "#NUM!", "#NAME?", "#DIV/0!"}


# ── helpers ────────────────────────────────────────────────────────────────────
def read_tab(path, tab, header_row):
    """Return (headers, data_rows). header_row is 1-based."""
    wb = openpyxl.load_workbook(REPO_ROOT / path, read_only=True, data_only=True)
    ws = wb[tab]
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    if not rows:
        return [], []
    return list(rows[header_row - 1]), rows[header_row:]


def g(row, i):
    return row[i] if i < len(row) else None


def scrub(v):
    s = t.clean(v)
    if not s or s in DIRTY or s.startswith("Loading"):
        return None
    return s


def to_num(v):
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def to_bool(v):
    if isinstance(v, bool):
        return v
    s = t.clean(v)
    if s is None:
        return None
    return {"true": True, "false": False}.get(s.lower())


def nonempty(row):
    return any(c not in (None, "") for c in row)


# ── reconciliation report ──────────────────────────────────────────────────────
class Report:
    def __init__(self):
        self.t = {}
        self.notes = []
        self.collisions = []          # (barcode, kept, rejected)
        self.dedup_merges = []        # (item_code, kept_region, dropped_region)
        self.unmatched_src = {}       # source-label -> unmatched item_code count

    def row(self, table):
        return self.t.setdefault(table, dict(read=0, emitted=0, inserted=0,
                                             unmatched=0, skipped=0, errors=0, verified=None))

    def note(self, msg):
        self.notes.append(msg)

    def um(self, key):
        """Record one unmatched item_code, tagged by its source (active vs backup)."""
        self.unmatched_src[key] = self.unmatched_src.get(key, 0) + 1

    def print(self, dry):
        mode = "DRY-RUN (nothing written)" if dry else "EXECUTE (clean load)"
        print("\n" + "=" * 78)
        print(f"  JIGZLE PHASE-1 IMPORT — RECONCILIATION REPORT   [{mode}]")
        print("=" * 78)
        hdr = (f"{'table':<20}{'read':>9}{'→rows':>9}{'inserted':>10}"
               f"{'unmatched':>11}{'skipped':>9}{'DB rows':>9}")
        print(hdr); print("-" * 87)
        tot = dict(read=0, emitted=0, inserted=0, unmatched=0, skipped=0)
        vtot, any_v = 0, False
        for table in FK_ORDER:
            if table not in self.t:
                continue
            r = self.t[table]
            for k in tot:
                tot[k] += r[k]
            v = r.get("verified")
            if v is not None:
                vtot += v; any_v = True
            print(f"{table:<20}{r['read']:>9}{r['emitted']:>9}{r['inserted']:>10}"
                  f"{r['unmatched']:>11}{r['skipped']:>9}{(str(v) if v is not None else '-'):>9}")
        print("-" * 87)
        print(f"{'TOTAL':<20}{tot['read']:>9}{tot['emitted']:>9}{tot['inserted']:>10}"
              f"{tot['unmatched']:>11}{tot['skipped']:>9}{(str(vtot) if any_v else '-'):>9}")
        print("\n  NOTES")
        for n in self.notes:
            print(f"   • {n}")
        # unmatched item_code, split current/active vs 2015–2023 backup archive
        if self.unmatched_src:
            active = {k: v for k, v in self.unmatched_src.items() if "(backup)" not in k}
            backup = {k: v for k, v in self.unmatched_src.items() if "(backup)" in k}
            print("\n  UNMATCHED item_code BY SOURCE  (do they land with item_code=NULL + raw kept)")
            print("    ── current / active transactions ──")
            for k, v in sorted(active.items()):
                print(f"     {k:<26}{v:>7}")
            print(f"     {'ACTIVE TOTAL':<26}{sum(active.values()):>7}")
            print("    ── 2015–2023 backup archive ──")
            for k, v in sorted(backup.items()):
                print(f"     {k:<26}{v:>7}")
            print(f"     {'BACKUP TOTAL':<26}{sum(backup.values()):>7}")
            print("    (the 'orders' row in the table above counts unresolved CUSTOMER refs, not item_code)")
        if self.dedup_merges:
            print(f"\n  CATALOGUE DEDUP MERGES ({len(self.dedup_merges)}):")
            for code, kept, dropped in self.dedup_merges:
                print(f"   • {code}: kept [{kept}], dropped [{dropped}]")
        print(f"\n  BARCODE COLLISIONS ({len(self.collisions)} — kept-first, rest logged):")
        for bc, kept, rej in self.collisions[:20]:
            print(f"   • {bc}: kept {kept}, rejected {rej}")
        if len(self.collisions) > 20:
            print(f"   … +{len(self.collisions) - 20} more")
        print("=" * 78)


# ── shared context ──────────────────────────────────────────────────────────────
class Ctx:
    def __init__(self, db, dry, report):
        self.db = db
        self.dry = dry
        self.r = report
        self.valid_item_codes = set()
        self.cust_key_to_id = {}
        self.label_to_cust_id = {}
        self.addr_label_to_id = {}
        self.supplier_to_id = {}
        self._fake = {}

    def _fakeid(self, table):
        n = self._fake.get(table, 0) + 1
        self._fake[table] = n
        return n

    def write(self, table, rows, *, returning=False, pk=None):
        """Insert rows (real) or simulate (dry). Strips None values and helper keys
        (those starting with '_') so column defaults apply. Returns id-bearing rows
        when returning=True."""
        clean_rows = [{k: v for k, v in r.items() if v is not None and not k.startswith("_")}
                      for r in rows]
        rep = self.r.row(table)
        rep["emitted"] += len(clean_rows)
        if not clean_rows:
            return [] if returning else None
        if self.dry:
            rep["inserted"] += len(clean_rows)
            if returning:
                return [{pk: self._fakeid(table)} for _ in clean_rows]
            return None
        res = self.db.insert(table, clean_rows, returning=returning)
        rep["inserted"] += len(clean_rows)
        return res

    def clean_all(self):
        """Full clean load (D7): one fast TRUNCATE … RESTART IDENTITY CASCADE via the
        0011 helper function. Far cheaper than per-row deletes and resets surrogate ids."""
        if self.dry:
            return
        try:
            self.db.rpc("truncate_phase1_data")
        except RuntimeError as e:
            msg = str(e)
            if "PGRST202" in msg or "404" in msg or "Could not find" in msg:
                sys.exit("ERROR: truncate_phase1_data() missing. Apply "
                         "supabase/migrations/0011_truncate_fn.sql (docs/apply-0011.sql) first.")
            raise


# ════════════════════════════════════════════════════════════════════════════════
# CATALOGUE SPINE
# ════════════════════════════════════════════════════════════════════════════════
def read_catalogue(ctx):
    """Read 4 region files once; dedup the 3 known codes (keep more-complete);
    build catalogue, barcodes, sku_sources, and the valid item-code / self-code sets."""
    rep = ctx.r.row("catalogue")
    kept = {}          # item_code -> (score, cat_dict, raw_tuple, file_idx, row_idx)
    for fi, (path, _has_tl) in enumerate(CATALOGUE_FILES):
        region = Path(path).stem.split("—")[-1].strip()
        _, data = read_tab(path, "Catalog", 1)
        for ri, row in enumerate(data):
            code = t.clean(g(row, 0))
            if not code:
                continue
            rep["read"] += 1
            cat = build_catalogue_row(row)
            score = sum(1 for v in cat.values() if v not in (None, "", False))
            prev = kept.get(code)
            if prev is None or score > prev[0]:
                if prev is not None:
                    ctx.r.dedup_merges.append((code, region, "prev"))
                kept[code] = (score, cat, row, fi, ri)
            elif prev is not None:
                ctx.r.dedup_merges.append((code, prev_region(prev), region))

    ctx.valid_item_codes = set(kept)
    self_codes = set()
    cat_rows, bc_rows, src_rows = [], [], []
    bc_seen = {}
    for code, (_s, cat, raw, _fi, _ri) in sorted(kept.items(), key=lambda kv: (kv[1][3], kv[1][4])):
        cat_rows.append(cat)
        if cat.get("brand_prefix"):
            self_codes.add(cat["brand_prefix"])   # already normalized (trailing '-' stripped)
        # barcodes (col 32)
        barcodes, marker = t.parse_barcodes(g(raw, 32))
        for bc in barcodes:
            owner = bc_seen.get(bc)
            if owner is None:
                bc_seen[bc] = code
                bc_rows.append({"barcode": bc, "item_code": code, "is_verified": marker})
            elif owner != code:
                ctx.r.collisions.append((bc, owner, code))
        # sources (cols 2..8 → source_index 0..6, URLs only)
        for ci in range(2, 9):
            url = t.clean(g(raw, ci))
            if url and url.lower().startswith("http"):
                src_rows.append({"item_code": code, "source_index": ci - 2,
                                 "url": url.replace("\t", "").strip()})
    return cat_rows, bc_rows, src_rows, self_codes


def prev_region(prev):
    return Path(CATALOGUE_FILES[prev[3]][0]).stem.split("—")[-1].strip()


def build_catalogue_row(row):
    pc_raw = t.clean(g(row, 14))
    rd_raw = t.clean(g(row, 34))
    ry = rm = None
    if rd_raw:
        import re
        m = re.match(r"(\d{4})[.\-/](\d{1,2})", rd_raw)
        if m:
            ry, rm = int(m[1]), int(m[2])
            if not (1 <= rm <= 12):
                rm = None
    ptype = scrub(g(row, 12))
    if ptype == "JIgsaw Puzzle":
        ptype = "Jigsaw Puzzle"
    ptype_piece = scrub(g(row, 15))
    if ptype_piece == "Blindbox":
        ptype_piece = "Blind Box"
    return {
        "item_code": t.clean(g(row, 0)),
        "self_code": t.clean(g(row, 1)),
        "brand_prefix": (t.clean(g(row, 1)) or "").rstrip("-") or None,
        "original_name": t.clean(g(row, 10)),
        "translate_name": t.clean(g(row, 11)),
        "product_type": ptype,
        "sub_type": scrub(g(row, 13)),
        "piece_count": pc_raw,
        "piece_count_n": t.to_int(pc_raw) if pc_raw and "," not in pc_raw else None,
        "piece_type": ptype_piece,
        "piece_size": scrub(g(row, 20)),
        "size_p": to_num(g(row, 16)), "size_l": to_num(g(row, 17)), "size_t": to_num(g(row, 18)),
        "image_type": scrub(g(row, 21)),
        "material": scrub(g(row, 22)),
        "effect": t.clean(g(row, 23)),
        "artist": t.clean(g(row, 24)),
        "tags": t.clean(g(row, 25)),
        "dim_p": to_num(g(row, 26)), "dim_l": to_num(g(row, 27)), "dim_t": to_num(g(row, 28)),
        "real_weight": to_num(g(row, 29)),
        "article_number": t.strip_marker(g(row, 32)),
        "description": t.clean(g(row, 33)),
        "release_date": rd_raw, "release_year": ry, "release_month": rm,
        "theme": t.clean(g(row, 35)), "location": t.clean(g(row, 36)),
        "has_image": t.clean(g(row, 9)) == "🖼️",
    }


def load_brands(ctx, self_codes):
    _, data = read_tab(ORDER, "brand_country_props", 1)
    rep = ctx.r.row("brands")
    seen = {}
    # header row IS data → include rows[0] too by re-reading without skipping
    hdr, _ = read_tab(ORDER, "brand_country_props", 1)
    allrows = [hdr] + data
    for row in allrows:
        prefix = t.clean(g(row, 0))
        if not prefix or prefix in DIRTY:
            continue
        prefix = prefix.rstrip("-")
        rep["read"] += 1
        if prefix in seen:
            continue
        seen[prefix] = {
            "prefix": prefix,
            "name": t.clean(g(row, 1)),
            "country": t.normalize_country(g(row, 2)),
        }
    added = 0
    for sc in self_codes:
        p = sc.rstrip("-")
        if p and p not in seen:
            seen[p] = {"prefix": p, "name": None, "country": None}
            added += 1
    ctx.r.note(f"brands: {len(seen)} prefixes ({added} synthesized from catalogue SELF CODE for FK completeness)")
    ctx.write("brands", list(seen.values()))


# ════════════════════════════════════════════════════════════════════════════════
# CUSTOMERS + ADDRESSES
# ════════════════════════════════════════════════════════════════════════════════
def load_customers(ctx):
    import re
    _, data = read_tab(SALES, "Customer Data", 1)
    crep = ctx.r.row("customers")
    by_key, key_order, labels_by_key = {}, [], {}
    addr_rows = []
    no_addr = 0
    for row in data:
        if not nonempty(row):
            continue
        label = t.clean(g(row, 0))
        phone = t.normalize_phone(g(row, 1))
        if not label and not phone:
            continue
        crep["read"] += 1
        key = phone or f"label:{label}"
        if key not in by_key:
            chan, ig = t.canonical_channel(g(row, 2))
            by_key[key] = {"name": t.name_from_label(label), "phone": phone,
                           "phone_raw": t.clean(g(row, 1)), "channel": chan,
                           "channel_raw": t.clean(g(row, 2)), "ig_handle": ig}
            key_order.append(key)
        if label:
            labels_by_key.setdefault(key, set()).add(label)
        addr_label = t.clean(g(row, 4))
        if addr_label and addr_label not in DIRTY:
            blob = t.clean(g(row, 3))
            rname = blob.split("\n")[0].strip() if blob else None
            m = re.search(r"(?:\+?62|0)\d[\d \-]{6,}\d", blob or "")
            addr_rows.append({"_key": key, "address_label": addr_label, "raw_address": blob,
                              "recipient_name": rname, "contact_phone": m.group().strip() if m else None})
        else:
            no_addr += 1

    cust_rows = [by_key[k] for k in key_order]
    merges = crep["read"] - len(cust_rows)
    ret = ctx.write("customers", cust_rows, returning=True, pk="customer_id")
    for i, k in enumerate(key_order):
        cid = ret[i]["customer_id"]
        ctx.cust_key_to_id[k] = cid
        for lbl in labels_by_key.get(k, ()):
            ctx.label_to_cust_id[lbl] = cid

    arep = ctx.r.row("customer_addresses")
    arep["read"] = len(addr_rows)
    for a in addr_rows:
        a["customer_id"] = ctx.cust_key_to_id[a.pop("_key")]
    aret = ctx.write("customer_addresses", addr_rows, returning=True, pk="address_id")
    for i, a in enumerate(addr_rows):
        ctx.addr_label_to_id[a["address_label"]] = aret[i]["address_id"]
    ctx.r.note(f"customers: {crep['read']} source rows → {len(cust_rows)} customers ({merges} dedup-merged); "
               f"{len(addr_rows)} addresses ({no_addr} rows had no/`#N/A` ADDRESS ID)")


# ════════════════════════════════════════════════════════════════════════════════
# PROCUREMENT reference: suppliers, forwarders, shipments
# ════════════════════════════════════════════════════════════════════════════════
def load_suppliers(ctx):
    rep = ctx.r.row("suppliers")
    rows, seen = [], {}

    def add(name, country, flag):
        if not name or name in seen:
            return
        seen[name] = True
        rows.append({"name": name, "country": country, "flag": flag, "type": t.supplier_type(name)})

    _, ob = read_tab(ORDER, "OutBuild", 1)
    for row in ob:
        sup = t.clean(g(row, 2))
        if not sup:
            continue
        rep["read"] += 1
        flag, name = t.strip_flag(sup)
        add(name or sup, t.normalize_country(g(row, 0)) or t.country_from_flag(flag), flag)
    _, od = read_tab(ORDER, "Order Data", 1)
    for row in od:
        raw = t.clean(g(row, 1))
        if not raw:
            continue
        flag, name = t.strip_flag(raw)
        add(name or raw, t.country_from_flag(flag), flag)

    ret = ctx.write("suppliers", rows, returning=True, pk="supplier_id")
    for i, r in enumerate(rows):
        ctx.supplier_to_id[r["name"]] = ret[i]["supplier_id"]
    ctx.r.note(f"suppliers: {len(rows)} distinct (OutBuild ∪ Order Data; type inferred)")


def collect_forwarder_prefixes(ctx):
    prefixes = set()
    _, od = read_tab(ORDER, "Order Data", 1)
    for row in od:
        p = t.ship_prefix(g(row, 12))
        if p:
            prefixes.add(p)
    _, ds = read_tab(WAREHOUSE, "Data Shipment", 3)
    for row in ds:
        p = t.ship_prefix(g(row, 7))
        if p:
            prefixes.add(p)
    return prefixes


KNOWN_FORWARDERS = {"LGB": ("LetsGoBuy", "Taiwan"), "CBL": ("CBL", "China"), "MTE": ("MTE", "China"),
                    "SUB": ("Superbuy", "China"), "PRI": ("Princess", "China"), "IMA": ("Imaginatorium", "Japan"),
                    "EMS": ("EMS", None), "DHL": ("DHL", None), "SURF": ("SURF", None)}


def load_forwarders(ctx):
    prefixes = collect_forwarder_prefixes(ctx)
    rows = []
    for p in sorted(prefixes):
        name, country = KNOWN_FORWARDERS.get(p, (None, None))
        rows.append({"prefix": p, "name": name, "country": country})
    ctx.r.row("forwarders")["read"] = len(prefixes)
    ctx.write("forwarders", rows)
    ctx.r.note(f"forwarders: {len(rows)} ship-id prefixes (names hand-curated where known)")
    ctx._forwarder_prefixes = prefixes


def load_shipments(ctx):
    import json
    rep = ctx.r.row("shipments")
    _, data = read_tab(WAREHOUSE, "Data Shipment", 3)
    rows, seen = [], set()
    for row in data:
        sid = t.clean(g(row, 7))
        if not sid or sid in seen:
            continue
        seen.add(sid)
        rep["read"] += 1
        recv = t.parse_date(g(row, 12))
        contents = None
        jraw = t.clean(g(row, 11))
        if jraw:
            try:
                contents = json.loads(jraw)
            except (ValueError, TypeError):
                contents = None
        pref = t.ship_prefix(sid)
        rows.append({
            "ship_id": sid,
            "forwarder_prefix": pref if pref in getattr(ctx, "_forwarder_prefixes", set()) else None,
            "origin_country": t.normalize_country(t.strip_flag(g(row, 8))[1] or g(row, 8)),
            "status": "completed" if recv else "open",
            "ship_date": t.parse_date(g(row, 6)), "received_date": recv,
            "tracking": t.clean(g(row, 9)), "note": t.clean(g(row, 10)), "contents": contents,
        })
    ctx.write("shipments", rows)


# ════════════════════════════════════════════════════════════════════════════════
# SALES: orders + order_lines + payments (active + backup, same shape)
# ════════════════════════════════════════════════════════════════════════════════
ORDER_STATUS = {"need payment": "Need payment", "need send": "Need send",
                "complete": "Complete", "cancel": "Cancelled", "cancelled": "Cancelled"}


def canon_status(v):
    return ORDER_STATUS.get((t.clean(v) or "").lower())


def is_header(row):
    ic = g(row, 4)
    return ic is not None and str(ic).startswith("📦")


def load_sales(ctx, path, tab, label):
    from collections import defaultdict
    _, data = read_tab(path, tab, 1)
    groups = defaultdict(list)
    for row in data:
        sid = t.clean(g(row, 0))
        if sid and (g(row, 4) not in (None, "")):
            groups[sid].append(row)

    orep, lrep, prep = ctx.r.row("orders"), ctx.r.row("order_lines"), ctx.r.row("payments")
    o_rows, l_rows, p_rows = [], [], []
    headerless = 0
    for sid, grp in groups.items():
        headers = [r for r in grp if is_header(r)]
        lines = [r for r in grp if not is_header(r)]
        src = headers[0] if headers else next((r for r in lines if g(r, 9) not in (None, "")), lines[0])
        if not headers:
            headerless += 1
        order_status = canon_status(g(src, 8))
        cust_ref = t.clean(g(src, 3))
        order = {
            "sales_id": sid,
            "customer_id": ctx.label_to_cust_id.get(cust_ref),
            "customer_ref": cust_ref,
            "address_id": ctx.addr_label_to_id.get(t.clean(g(src, 12))),
            "order_date": t.parse_date(g(src, 2)),
            "status": order_status,
            "sales_total_idr": t.to_idr_thousands(g(src, 9)),
            "payment_method": t.clean(g(src, 10)),
            "payment_status": _canon_pay(g(src, 11)),
            "order_note": t.clean(g(src, 7)),
        }
        if order["customer_id"] is None and cust_ref:
            orep["unmatched"] += 1
        o_rows.append(order)
        orep["read"] += 1

        for r in lines:
            code, raw, ok = t.resolve_item(g(r, 4), ctx.valid_item_codes)
            if not ok:
                lrep["unmatched"] += 1
                ctx.r.um(f"order_lines ({label})")
            courier, track = t.split_courier(g(r, 13))
            ff = t.dt(g(r, 14))
            # shipped_at / is_cancelled key off each LINE's own [8] STATUS, not the
            # order header: every line row carries its own status (verified — 100% of
            # active + backup line rows do), and per-line "Complete" is the physical
            # ship signal, whereas the header holds the order's workflow state (e.g.
            # "Need send"). fulfilled_at stays per-line (g(r,14)). is_cancelled is true
            # if the line itself is Cancelled OR the whole order is Cancelled.
            line_status = canon_status(g(r, 8))
            l_rows.append({
                "line_id": t.clean(g(r, 1)),
                "sales_id": sid,
                "item_code": code, "item_code_raw": None if ok else raw,
                "qty": t.to_int(g(r, 5)) or 0,
                "item_link": t.clean(g(r, 6)), "line_note": t.clean(g(r, 7)),
                "courier": courier, "courier_tracking": track,
                "fulfilled_at": ff,
                "shipped_at": ff if line_status == "Complete" else None,
                "is_cancelled": line_status == "Cancelled" or order_status == "Cancelled",
                "address_id": ctx.addr_label_to_id.get(t.clean(g(r, 12))),
            })
            lrep["read"] += 1

        for pay in t.parse_payments(g(src, 7), order["sales_total_idr"], g(src, 10), g(src, 11), g(src, 2)):
            pay["sales_id"] = sid
            p_rows.append(pay)

    ctx.write("orders", o_rows)
    ctx.write("order_lines", l_rows)
    ctx.write("payments", p_rows)
    ctx.r.note(f"sales[{label}]: {len(o_rows)} orders ({headerless} headerless→synthesized), "
               f"{len(l_rows)} lines, {len(p_rows)} payments")


def _canon_pay(v):
    s = (t.clean(v) or "").lower()
    return {"paid": "Paid", "unpaid": "Unpaid", "cancel": "Cancel"}.get(s)


# ════════════════════════════════════════════════════════════════════════════════
# HOLDS
# ════════════════════════════════════════════════════════════════════════════════
def load_holds(ctx):
    import re
    rep = ctx.r.row("holds")
    _, data = read_tab(SALES, "Hold Data", 2)
    rows = []
    for row in data:
        code_raw = t.clean(g(row, 1))
        if not code_raw:
            continue
        rep["read"] += 1
        code, _raw, ok = t.resolve_item(code_raw, ctx.valid_item_codes)
        if not ok:
            rep["unmatched"] += 1
            rep["skipped"] += 1
            ctx.r.um("holds")
            continue                       # holds.item_code is NOT NULL → cannot insert unmatched
        cust = None
        note = t.clean(g(row, 3))
        if note:
            m = re.search(r"For:\s*([^/\n]+)", note, re.I)
            if m and m.group(1).strip() not in ("?", ""):
                cust = ctx.label_to_cust_id.get(m.group(1).strip())
        rows.append({"created_at": t.dt(g(row, 0)), "item_code": code,
                     "qty": t.to_int(g(row, 2)) or 0, "note": note, "customer_id": cust})
    ctx.write("holds", rows)


# ════════════════════════════════════════════════════════════════════════════════
# INBOUND
# ════════════════════════════════════════════════════════════════════════════════
import re as _re
_EXCLUDE_RE = _re.compile(r"exclude|gift|rusak|bonus|damage|hadiah|sample", _re.I)


def load_inbound(ctx):
    rep = ctx.r.row("inbound")
    _, data = read_tab(INBOUND, "Inbound Data", 2)
    rows = []
    for row in data:
        if not nonempty(row):
            continue
        qty = t.to_int(g(row, 1))
        code, raw, ok = t.resolve_item(g(row, 0), ctx.valid_item_codes)
        if qty is None:
            rep["skipped"] += 1
            continue
        rep["read"] += 1
        if not ok:
            rep["unmatched"] += 1
            ctx.r.um("inbound")
        rd_raw = t.clean(g(row, 3))
        opening = t.is_up_to_2023(g(row, 3))
        rdate = "2023-12-31" if opening else t.parse_date(g(row, 3))
        resi = g(row, 4)
        tracking = note = None
        if resi is not None and str(resi).strip():
            parts = str(resi).split("||")
            tracking = parts[0].strip() or None
            note = parts[1].strip() if len(parts) > 1 and parts[1].strip() else None
        label = t.clean(g(row, 6))
        if label not in ("Exclude", "Hold", "Tokopedia"):
            label = None
        excluded = (label == "Exclude") or bool(note and _EXCLUDE_RE.search(note))
        rows.append({
            "item_code": code, "item_code_raw": None if ok else raw, "qty": qty,
            "ship_id": t.clean(g(row, 2)),
            "receive_date": rdate, "receive_date_raw": rd_raw, "is_opening_balance": opening,
            "excluded": excluded, "label": label, "tracking": tracking, "receive_note": note,
            "dimension_weight": t.clean(g(row, 5)), "transfer_box_id": t.clean(g(row, 7)),
        })
    ctx.write("inbound", rows)


# ════════════════════════════════════════════════════════════════════════════════
# PURCHASE ORDERS
# ════════════════════════════════════════════════════════════════════════════════
PO_STATUS = ["Processing", "On the way", "With Forwarder", "Received"]


def load_purchase_orders(ctx):
    rep = ctx.r.row("purchase_orders")
    _, data = read_tab(ORDER, "Order Data", 1)
    rows = []
    for row in data:
        enc = t.clean(g(row, 0))
        item_raw = t.clean(g(row, 3))
        if not enc and not item_raw:
            continue
        rep["read"] += 1
        code, raw, ok = t.resolve_item(g(row, 3), ctx.valid_item_codes)
        if not ok and item_raw:
            rep["unmatched"] += 1
            ctx.r.um("purchase_orders")
        flag, sname = t.strip_flag(g(row, 1))
        status_raw = t.clean(g(row, 5)) or ""
        s0 = status_raw.split("\n")[0].strip()
        status = next((s for s in PO_STATUS if s0.lower() == s.lower()), None)
        sm = _re.search(r"Since\s+([\d.\-/]+)", status_raw)
        rows.append({
            "encrypt": enc,
            "supplier_id": ctx.supplier_to_id.get(sname) or ctx.supplier_to_id.get(t.clean(g(row, 1))),
            "item_code": code, "item_code_raw": None if ok else raw,
            "qty": t.to_int(g(row, 4)) or 0,
            "status": status, "status_since": t.parse_date(sm.group(1)) if sm else None,
            "item_cost": to_num(g(row, 6)),
            "method": t.clean(g(row, 9)), "tracking_to_wh": t.clean(g(row, 10)),
            "item_note": t.clean(g(row, 11)), "ship_id": _none_dash(g(row, 12)),
            "marketplace_order_id": t.clean(g(row, 13)),
            "tracking_to_forwarder": t.clean(g(row, 14)), "tracking_to_jigzle": t.clean(g(row, 15)),
            "shipment_note": t.clean(g(row, 16)),
            "input_date": t.parse_date(g(row, 2)),
            "receive_date": t.parse_date(g(row, 20)),       # D10: real date in [20] JIGZLE
        })
    ctx.write("purchase_orders", rows)


def _none_dash(v):
    s = t.clean(v)
    return None if s in (None, "—", "-", "X") else s


# ════════════════════════════════════════════════════════════════════════════════
# MISSING PIECES
# ════════════════════════════════════════════════════════════════════════════════
def load_missing_pieces(ctx):
    rep = ctx.r.row("missing_pieces")
    _, data = read_tab(ORDER, "Missing Piece Data", 1)
    rows = []
    for row in data:
        enc = t.clean(g(row, 0))
        if not enc:
            continue
        rep["read"] += 1
        code, raw, ok = t.resolve_item(g(row, 4), ctx.valid_item_codes)
        if not ok and t.clean(g(row, 4)):
            rep["unmatched"] += 1
            ctx.r.um("missing_pieces")
        cust_ref = t.clean(g(row, 2))
        rows.append({
            "encrypt": enc, "report_date": t.parse_date(g(row, 1)),
            "customer_id": ctx.label_to_cust_id.get(cust_ref), "customer_ref": cust_ref,
            "origin_flag": t.clean(g(row, 3)),
            "item_code": code, "item_code_raw": None if ok else raw,
            "card_details": t.clean(g(row, 5)),
            "piece_1": t.clean(g(row, 6)), "piece_2": t.clean(g(row, 7)), "piece_3": t.clean(g(row, 8)),
            "pic_card_url": t.clean(g(row, 9)), "pic_puzzle_url": t.clean(g(row, 10)),
            "ship_id": _none_dash(g(row, 11)),
            "received_date": t.parse_date(g(row, 12)), "sent_date": t.parse_date(g(row, 13)),
        })
    ctx.write("missing_pieces", rows)


# ════════════════════════════════════════════════════════════════════════════════
# OUTBOUND (one SKU per row)
# ════════════════════════════════════════════════════════════════════════════════
def load_outbound(ctx):
    rep = ctx.r.row("outbound_shipments")
    _, data = read_tab(OUTBOUND, "OutboundData", 1)
    rows = []
    for row in data:
        if not nonempty(row):
            continue
        qty, code_raw = t.parse_packed_item(g(row, 3))
        if code_raw is None:
            rep["skipped"] += 1
            continue
        rep["read"] += 1
        code, raw, ok = t.resolve_item(code_raw, ctx.valid_item_codes)
        if not ok:
            rep["unmatched"] += 1
            ctx.r.um("outbound_shipments")
        ref = t.clean(g(row, 0)) or t.clean(g(row, 2))
        rows.append({
            "customer_id": ctx.label_to_cust_id.get(t.clean(g(row, 0))),
            "customer_ref": ref, "ship_date": t.parse_date(g(row, 1)),
            "recipient_name": t.clean(g(row, 2)),
            "item_code": code, "item_code_raw": None if ok else raw, "qty": qty or 1,
            "address": t.clean(g(row, 4)), "courier": t.clean(g(row, 5)),
            "weight_gram": to_num(g(row, 7)), "processed": to_bool(g(row, 8)),
        })
    ctx.write("outbound_shipments", rows)


# ════════════════════════════════════════════════════════════════════════════════
# ROYALTY PAID
# ════════════════════════════════════════════════════════════════════════════════
def load_royalty(ctx):
    rep = ctx.r.row("royalty_paid")
    _, data = read_tab(SALES, "Royalty Data", 1)
    rows = []
    for row in data:
        line_id = t.clean(g(row, 0))
        if not line_id:
            continue
        rep["read"] += 1
        code, raw, ok = t.resolve_item(g(row, 2), ctx.valid_item_codes)
        if not ok and t.clean(g(row, 2)):
            rep["unmatched"] += 1
            ctx.r.um("royalty_paid")
        pd = t.parse_date(g(row, 5))
        rows.append({
            "line_id": line_id, "partner": "Voila Arts",
            "fulfill_date": t.parse_date(g(row, 1)),
            "item_code": code, "item_code_raw": None if ok else raw,
            "qty": t.to_int(g(row, 3)) or 1, "royalty_idr": t.to_idr_full(g(row, 4)),
            "paid_date": pd, "paid_date_raw": None if pd else t.clean(g(row, 5)),
        })
    ctx.write("royalty_paid", rows)


# ════════════════════════════════════════════════════════════════════════════════
def main():
    ap = argparse.ArgumentParser(description="Jigzle Phase-1 data lift")
    ap.add_argument("--execute", action="store_true", help="perform the real clean load (default is dry-run)")
    ap.add_argument("--dry-run", action="store_true", help="explicit dry-run (default)")
    args = ap.parse_args()
    dry = not args.execute

    report = Report()
    db = None
    if not dry:
        env = load_env()
        url = env.get("NEXT_PUBLIC_SUPABASE_URL")
        key = env.get("SUPABASE_SERVICE_ROLE_KEY")
        if not key:
            sys.exit("ERROR: SUPABASE_SERVICE_ROLE_KEY not found in .env.local — required for the load.")
        db = Client(url, key)
        db.ping()
        if db.column_exists("catalogue", "region"):
            sys.exit("ERROR: catalogue.region still exists. Apply supabase/migrations/0010_drop_region.sql first.")

    ctx = Ctx(db, dry, report)
    print(f"[{'dry-run' if dry else 'EXECUTE'}] reading catalogue …")
    cat_rows, bc_rows, src_rows, self_codes = read_catalogue(ctx)

    ctx.clean_all()                          # no-op in dry-run
    load_brands(ctx, self_codes)
    ctx.write("catalogue", cat_rows)
    ctx.write("barcodes", bc_rows)
    ctx.write("sku_sources", src_rows)
    load_customers(ctx)
    load_suppliers(ctx)
    load_forwarders(ctx)
    load_shipments(ctx)
    load_sales(ctx, SALES, "Sales Data", "active")
    load_sales(ctx, BACKUP, "Backup Sales", "backup")
    load_holds(ctx)
    load_inbound(ctx)
    load_purchase_orders(ctx)
    load_missing_pieces(ctx)
    load_outbound(ctx)
    load_royalty(ctx)

    if not dry:
        print("verifying DB row counts …")
        for table in FK_ORDER:
            report.row(table)["verified"] = db.count(table)

    report.print(dry)


if __name__ == "__main__":
    main()
