#!/usr/bin/env python3
"""Inventory smoke: exercise the stock_snapshot matview + refresh_stock_snapshot() against the
live DB — make a dead SKU active by adding a Processing PO, refresh, and assert it appears in the
snapshot with pending>0 and a populated name; assert refreshed_at advances across two refreshes;
then remove the PO + supplier, refresh, and assert the SKU drops out of the snapshot again.
Zero-residue check at the end. Uses the service-role key as a TEST HARNESS only (the app uses
anon + the user session). Run AFTER 0019 is applied.

  python3 scripts/smoke_inventory.py
"""
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "import"))
from db import Client, load_env  # noqa: E402

env = load_env()
db = Client(env.get("NEXT_PUBLIC_SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY"))
db.ping()

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

def q(s):
    return urllib.parse.quote(str(s), safe="")

def ts_key(iso):
    # normalize a PostgREST timestamptz (UTC) for safe ordering regardless of how many
    # fractional-second digits Postgres emits (it trims trailing zeros): pad fractional to 6.
    s = iso or ""
    for off in ("+00:00", "Z"):
        if s.endswith(off):
            s = s[: -len(off)]
            break
    if "." in s:
        head, frac = s.split(".", 1)
        return head + "." + (frac + "000000")[:6]
    return s + ".000000"

def refresh():
    rest("POST", "rpc/refresh_stock_snapshot", body={}, prefer="return=minimal")

def snap(code):
    r = rest("GET", f"stock_snapshot?item_code=eq.{q(code)}&select=item_code,name,pending,on_the_way,physical,refreshed_at")
    return r[0] if r else None

SUP_NAME = "ZZ-INV-SUP"
sup_id = None

def cleanup():
    try:
        if sup_id is not None:
            rest("DELETE", f"purchase_orders?supplier_id=eq.{sup_id}", prefer="return=minimal")
        rest("DELETE", f"suppliers?name=eq.{q(SUP_NAME)}", prefer="return=minimal")
        try:
            refresh()  # leave the matview reflecting reality
        except Exception:
            pass
        print("  (cleanup done)")
    except Exception as e:
        print("  cleanup error:", e)

try:
    cleanup()  # start clean in case a prior run aborted

    # pick a DEAD SKU (no pending / on_the_way / physical) that has a catalogue name
    cand = rest("GET", "stock_check?select=item_code&pending=eq.0&on_the_way=eq.0&physical=eq.0&order=item_code&limit=100")
    ITEM, ITEM_NAME = None, None
    for c in cand:
        code = c["item_code"]
        cat = rest("GET", f"catalogue?item_code=eq.{q(code)}&select=translate_name,original_name")
        nm = cat and (cat[0].get("translate_name") or cat[0].get("original_name"))
        if nm:
            ITEM, ITEM_NAME = code, nm
            break
    if not ITEM:
        print("  could not find a dead SKU with a name to test against")
        sys.exit(1)
    print(f"  test SKU: {ITEM} ({ITEM_NAME})")

    # baseline: the dead SKU is NOT in the snapshot
    refresh()
    check("dead SKU absent from snapshot at baseline", snap(ITEM) is None, str(snap(ITEM)))

    # temp supplier + a Processing PO → makes the SKU active (pending > 0)
    sup = rest("POST", "suppliers", body=[{"name": SUP_NAME, "country": "China", "type": "agent"}], prefer="return=representation")
    sup_id = sup[0]["supplier_id"]
    rest("POST", "purchase_orders", body=[{"supplier_id": sup_id, "item_code": ITEM, "qty": 5, "status": "Processing"}], prefer="return=minimal")

    # ── CASE 1: refresh → the SKU now appears, active, named ──
    print("\n-- CASE 1: dead SKU becomes active after a PO + refresh --")
    refresh()
    row = snap(ITEM)
    check("SKU now present in snapshot", row is not None, str(row))
    check("pending = 5 (the new PO)", bool(row) and row["pending"] == 5, str(row.get("pending") if row else None))
    check("name populated", bool(row) and bool(row["name"]), str(row.get("name") if row else None))
    check("refreshed_at present", bool(row) and bool(row["refreshed_at"]), str(row.get("refreshed_at") if row else None))
    r1 = row["refreshed_at"] if row else None

    # ── CASE 2: refreshed_at advances across refreshes ──
    print("\n-- CASE 2: refreshed_at advances --")
    refresh()
    row2 = snap(ITEM)
    r2 = row2["refreshed_at"] if row2 else None
    check("refreshed_at advanced (r2 > r1)", bool(r1) and bool(r2) and ts_key(r2) > ts_key(r1), f"{r1} -> {r2}")

    # ── CASE 3: remove the PO + supplier → the SKU drops out again ──
    print("\n-- CASE 3: SKU leaves the snapshot when no longer active --")
    rest("DELETE", f"purchase_orders?supplier_id=eq.{sup_id}", prefer="return=minimal")
    rest("DELETE", f"suppliers?name=eq.{q(SUP_NAME)}", prefer="return=minimal")
    refresh()
    check("SKU gone from snapshot (dead again)", snap(ITEM) is None, str(snap(ITEM)))

finally:
    cleanup()

# zero-residual check
print("\n-- residual check --")
try:
    check("no residual test supplier", rest("GET", f"suppliers?name=eq.{q(SUP_NAME)}&select=supplier_id") == [])
    if sup_id is not None:
        check("no residual test POs", rest("GET", f"purchase_orders?supplier_id=eq.{sup_id}&select=po_id") == [])
except Exception as e:
    print("  residual check error:", e)

print(f"\n{'ALL PASS' if not FAIL else 'FAILURES: ' + ', '.join(FAIL)}  ({len(PASS)} passed, {len(FAIL)} failed)")
sys.exit(1 if FAIL else 0)
