#!/usr/bin/env python3
"""Catalogue (SKU editor) smoke: exercise the editor's data-layer ops on two isolated temp SKUs —
field update (updateSku), barcode add + share + verify + unlink, needs-review clear, and the
barcode_collisions view. Self-cleaning (temp ZZ-CAT-SMOKE rows only), zero residue. Uses the
service-role key as a TEST HARNESS only (the app uses anon + session, same single-table RLS writes).
Run AFTER PR-A's 0020 is applied (needs the composite barcodes PK + barcode_collisions view).

  python3 scripts/smoke_catalogue.py
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

SKU1 = "ZZ-CAT-SMOKE-001"
SKU2 = "ZZ-CAT-SMOKE-002"
BC = "ZZCATSMOKE1"

def cleanup():
    try:
        rest("DELETE", "barcodes?barcode=like.ZZCATSMOKE*", prefer="return=minimal")
        rest("DELETE", "catalogue?item_code=like.ZZ-CAT-SMOKE-*", prefer="return=minimal")
        print("  (cleanup done)")
    except Exception as e:
        print("  cleanup error:", e)

try:
    cleanup()  # start clean in case a prior run aborted

    # two isolated temp SKUs (no real catalogue rows are touched)
    rest("POST", "catalogue", body=[
        {"item_code": SKU1, "translate_name": "Smoke Cat 1", "needs_review": True},
        {"item_code": SKU2, "translate_name": "Smoke Cat 2", "needs_review": False},
    ], prefer="return=minimal")

    # ── CASE 1: updateSku — write changed fields + clear needs_review ──
    print("\n-- CASE 1: edit fields + clear needs_review --")
    rest("PATCH", f"catalogue?item_code=eq.{q(SKU1)}",
         body={"product_type": "TestType", "piece_count_n": 99, "needs_review": False}, prefer="return=minimal")
    r = rest("GET", f"catalogue?item_code=eq.{q(SKU1)}&select=product_type,piece_count_n,needs_review")[0]
    check("field edits persisted", r["product_type"] == "TestType" and r["piece_count_n"] == 99, str(r))
    check("needs_review cleared", r["needs_review"] is False, str(r["needs_review"]))

    # ── CASE 2: addBarcode → shared across two SKUs → barcode_collisions + verify toggle ──
    print("\n-- CASE 2: link a shared barcode + verify --")
    rest("POST", "barcodes", body=[{"barcode": BC, "item_code": SKU1, "is_verified": False}], prefer="return=minimal")
    rest("POST", "barcodes", body=[{"barcode": BC, "item_code": SKU2, "is_verified": False}], prefer="return=minimal")
    owners = sorted(x["item_code"] for x in rest("GET", f"barcodes?barcode=eq.{q(BC)}&select=item_code"))
    check("barcode linked to BOTH SKUs", owners == sorted([SKU1, SKU2]), str(owners))
    col = rest("GET", f"barcode_collisions?barcode=eq.{q(BC)}&select=barcode,n,item_codes")
    check("barcode_collisions shows it shared (n=2)", bool(col) and col[0]["n"] == 2, str(col))
    check("collision lists both SKUs", bool(col) and sorted(col[0]["item_codes"]) == sorted([SKU1, SKU2]), str(col[0].get("item_codes") if col else None))
    rest("PATCH", f"barcodes?barcode=eq.{q(BC)}&item_code=eq.{q(SKU1)}", body={"is_verified": True}, prefer="return=minimal")
    v = rest("GET", f"barcodes?barcode=eq.{q(BC)}&item_code=eq.{q(SKU1)}&select=is_verified")[0]
    check("setVerified toggled this link only", v["is_verified"] is True, str(v))

    # ── CASE 3: unlink one SKU → barcode no longer shared, other link kept ──
    print("\n-- CASE 3: unlink the wrong SKU --")
    rest("DELETE", f"barcodes?barcode=eq.{q(BC)}&item_code=eq.{q(SKU2)}", prefer="return=minimal")
    check("no longer in barcode_collisions", rest("GET", f"barcode_collisions?barcode=eq.{q(BC)}&select=barcode") == [])
    kept = [x["item_code"] for x in rest("GET", f"barcodes?barcode=eq.{q(BC)}&select=item_code")]
    check("the kept link survives (SKU1 only)", kept == [SKU1], str(kept))

finally:
    cleanup()

# zero-residual check
print("\n-- residual check --")
try:
    check("no residual test barcodes", rest("GET", "barcodes?barcode=like.ZZCATSMOKE*&select=barcode") == [])
    check("no residual test SKUs", rest("GET", "catalogue?item_code=like.ZZ-CAT-SMOKE-*&select=item_code") == [])
except Exception as e:
    print("  residual check error:", e)

print(f"\n{'ALL PASS' if not FAIL else 'FAILURES: ' + ', '.join(FAIL)}  ({len(PASS)} passed, {len(FAIL)} failed)")
sys.exit(1 if FAIL else 0)
