#!/usr/bin/env python3
"""Procurement smoke: exercise group_pos_into_shipment against the live DB — group open POs
into a forwarder shipment (upsert the shipments row + advance each PO to 'With Forwarder' with
the ship_id), the on-conflict-do-update path when grouping into an existing ship_id, and the
two fail-loud guards (unknown po_id, already-Received PO). Asserts the POs carry the ship_id +
status and the shipments row exists open, then cleans up ALL test rows and confirms zero residue.
Uses the service-role key as a TEST HARNESS only (the app uses anon + the user session). Run
AFTER 0018 is applied.

  python3 scripts/smoke_procurement.py
"""
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "import"))
from db import Client, load_env  # noqa: E402

env = load_env()
db = Client(env.get("NEXT_PUBLIC_SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY"))
db.ping()

UTC_DATE = datetime.now(timezone.utc).strftime("%Y-%m-%d")
JKT_DATE = (datetime.now(timezone.utc) + timedelta(hours=7)).strftime("%Y-%m-%d")
SHIP_DATE = JKT_DATE

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")

def rest(method, path, body=None, prefer=None):
    url = f"{db.base}/{path}"
    data = json.dumps(body).encode() if body is not None else None
    h = dict(db.h)
    if prefer:
        h["Prefer"] = prefer
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=db.timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None

def q(s):  # percent-encode a filter value (ship_ids contain a space)
    return urllib.parse.quote(str(s), safe="")

def group(ship_id, po_ids, prefix, origin, ship_date):
    return rest("POST", "rpc/group_pos_into_shipment", body={
        "p_ship_id": ship_id, "p_po_ids": po_ids, "p_forwarder_prefix": prefix,
        "p_origin_country": origin, "p_ship_date": ship_date})

# test row markers (single prefix per kind → clean single-filter teardown)
SUP_NAME = "ZZ-PROC-SUP"
FWD_PREFIX = "ZZPROC"
SHIP1 = "ZZPROC 1"

sup_id = None
def cleanup():
    try:
        if sup_id is not None:
            rest("DELETE", f"purchase_orders?supplier_id=eq.{sup_id}", prefer="return=minimal")
        rest("DELETE", "shipments?ship_id=like.ZZPROC*", prefer="return=minimal")
        rest("DELETE", f"forwarders?prefix=eq.{FWD_PREFIX}", prefer="return=minimal")
        rest("DELETE", f"suppliers?name=eq.{q(SUP_NAME)}", prefer="return=minimal")
        print("  (cleanup done)")
    except Exception as e:
        print("  cleanup error:", e)

try:
    cleanup()  # start clean in case a prior run aborted

    # temp supplier + forwarder + two real SKUs
    sup = rest("POST", "suppliers", body=[{"name": SUP_NAME, "country": "China", "type": "agent"}],
               prefer="return=representation")
    sup_id = sup[0]["supplier_id"]
    rest("POST", "forwarders", body=[{"prefix": FWD_PREFIX, "name": "Smoke Forwarder", "country": "China"}],
         prefer="return=minimal")
    cats = rest("GET", "catalogue?select=item_code&order=item_code&limit=2")
    A, B = cats[0]["item_code"], cats[1]["item_code"]

    pos = rest("POST", "purchase_orders", body=[
        {"supplier_id": sup_id, "item_code": A, "qty": 3, "status": "Processing"},
        {"supplier_id": sup_id, "item_code": B, "qty": 2, "status": "Processing"},
    ], prefer="return=representation")
    id1, id2 = sorted(p["po_id"] for p in pos)

    # ── CASE 1: group both POs into a NEW shipment ──
    print("\n-- CASE 1: group 2 POs into a new shipment --")
    ret = group(SHIP1, [id1, id2], FWD_PREFIX, "China", SHIP_DATE)
    check("returns the updated po_ids", isinstance(ret, list) and sorted(ret) == [id1, id2], str(ret))
    rows = rest("GET", f"purchase_orders?po_id=in.({id1},{id2})&select=po_id,ship_id,status,status_since&order=po_id")
    check("both POs carry the ship_id", all(r["ship_id"] == SHIP1 for r in rows), str([r["ship_id"] for r in rows]))
    check("both POs → With Forwarder", all(r["status"] == "With Forwarder" for r in rows), str([r["status"] for r in rows]))
    check("status_since stamped today", all(r["status_since"] in (UTC_DATE, JKT_DATE) for r in rows), str([r["status_since"] for r in rows]))
    sh = rest("GET", f"shipments?ship_id=eq.{q(SHIP1)}&select=status,forwarder_prefix,origin_country,ship_date")
    check("shipments row created", len(sh) == 1, str(sh))
    check("shipment is open + forwarder/origin/date set", bool(sh) and sh[0]["status"] == "open"
          and sh[0]["forwarder_prefix"] == FWD_PREFIX and sh[0]["origin_country"] == "China"
          and sh[0]["ship_date"] == SHIP_DATE, str(sh[0] if sh else None))

    # ── CASE 2: on-conflict-do-update — group a 3rd PO into the EXISTING ship_id ──
    print("\n-- CASE 2: group into an existing ship_id (upsert) --")
    po3 = rest("POST", "purchase_orders", body=[{"supplier_id": sup_id, "item_code": A, "qty": 1, "status": "Processing"}],
               prefer="return=representation")
    id3 = po3[0]["po_id"]
    NEW_DATE = (datetime.now(timezone.utc) + timedelta(hours=7) + timedelta(days=1)).strftime("%Y-%m-%d")
    group(SHIP1, [id3], FWD_PREFIX, "Taiwan", NEW_DATE)
    r3 = rest("GET", f"purchase_orders?po_id=eq.{id3}&select=ship_id,status")[0]
    check("3rd PO attached + With Forwarder", r3["ship_id"] == SHIP1 and r3["status"] == "With Forwarder", str(r3))
    sh2 = rest("GET", f"shipments?ship_id=eq.{q(SHIP1)}&select=origin_country,ship_date,status")[0]
    check("existing shipment row updated (not duplicated)", sh2["origin_country"] == "Taiwan" and sh2["ship_date"] == NEW_DATE and sh2["status"] == "open", str(sh2))
    cnt = rest("GET", f"shipments?ship_id=eq.{q(SHIP1)}&select=ship_id")
    check("still exactly one shipments row for the ship_id", len(cnt) == 1, str(len(cnt)))

    # ── CASE 3: fail-loud on an unknown po_id ──
    print("\n-- CASE 3: fail-loud on unknown po_id --")
    raised = False
    try:
        group(SHIP1, [999999999], FWD_PREFIX, "China", SHIP_DATE)
    except urllib.error.HTTPError as e:
        raised = "unknown po_id" in e.read().decode(errors="replace")
    check("rejects an unknown po_id (loud)", raised)

    # ── CASE 4: reject an already-Received PO (Receiving owns that state) ──
    print("\n-- CASE 4: reject an already-Received PO --")
    rest("PATCH", f"purchase_orders?po_id=eq.{id1}", body={"status": "Received"}, prefer="return=minimal")
    raised2 = False
    try:
        group("ZZPROC 9", [id1], FWD_PREFIX, "China", SHIP_DATE)
    except urllib.error.HTTPError as e:
        raised2 = "already Received" in e.read().decode(errors="replace")
    check("rejects a Received PO (loud)", raised2)
    stray = rest("GET", f"shipments?ship_id=eq.{q('ZZPROC 9')}&select=ship_id")
    check("no shipments row created for the rejected group", stray == [], str(stray))

finally:
    cleanup()

# zero-residual check
print("\n-- residual check --")
try:
    check("no residual test POs", rest("GET", f"purchase_orders?supplier_id=eq.{sup_id}&select=po_id") == [] if sup_id is not None else True)
    check("no residual test shipments", rest("GET", "shipments?ship_id=like.ZZPROC*&select=ship_id") == [])
    check("no residual test forwarder", rest("GET", f"forwarders?prefix=eq.{FWD_PREFIX}&select=prefix") == [])
    check("no residual test supplier", rest("GET", f"suppliers?name=eq.{q(SUP_NAME)}&select=supplier_id") == [])
except Exception as e:
    print("  residual check error:", e)

print(f"\n{'ALL PASS' if not FAIL else 'FAILURES: ' + ', '.join(FAIL)}  ({len(PASS)} passed, {len(FAIL)} failed)")
sys.exit(1 if FAIL else 0)
