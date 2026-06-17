#!/usr/bin/env python3
"""Barcode composite-model smoke: prove one barcode can link to many SKUs (the (barcode, item_code)
key from 0020) and that barcode_collisions surfaces shared barcodes. Seed one temp barcode shared by
two real catalogue SKUs (two composite rows) → assert an exact `where barcode = X` returns BOTH owners
(the picker condition) and barcode_collisions lists it with n = 2 → delete → assert it's gone. Zero
residue. Uses the service-role key as a TEST HARNESS only. Run AFTER 0020 is applied.

  python3 scripts/smoke_barcode_model.py
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

# fake test barcode (non-numeric → never clashes with a real EAN/UPC/JAN); ZZBCM* = teardown filter
BC = "ZZBCMSMOKE1"

def cleanup():
    try:
        rest("DELETE", "barcodes?barcode=like.ZZBCM*", prefer="return=minimal")
        print("  (cleanup done)")
    except Exception as e:
        print("  cleanup error:", e)

try:
    cleanup()  # start clean in case a prior run aborted

    cats = rest("GET", "catalogue?select=item_code&order=item_code&limit=2")
    if len(cats) < 2:
        print("  need two catalogue rows to test against")
        sys.exit(1)
    A, B = cats[0]["item_code"], cats[1]["item_code"]
    print(f"  test SKUs: {A}, {B}  ·  test barcode: {BC}")

    # seed: one barcode shared by two SKUs — two composite rows (needs the 0020 composite PK)
    rest("POST", "barcodes", body=[{"barcode": BC, "item_code": A, "is_verified": False},
                                    {"barcode": BC, "item_code": B, "is_verified": False}],
         prefer="return=minimal")

    # ── CASE 1: an exact `where barcode = X` returns BOTH owners (the resolveBarcode picker case) ──
    print("\n-- CASE 1: one barcode → two SKUs --")
    rows = rest("GET", f"barcodes?barcode=eq.{q(BC)}&select=item_code&order=item_code")
    got = sorted(r["item_code"] for r in (rows or []))
    check("exact barcode query returns BOTH owners", got == sorted([A, B]), str(got))

    # ── CASE 2: barcode_collisions lists it with n = 2 + both item_codes ──
    print("\n-- CASE 2: barcode_collisions view --")
    col = rest("GET", f"barcode_collisions?barcode=eq.{q(BC)}&select=barcode,n,item_codes")
    check("collision view lists the shared barcode", len(col or []) == 1, str(col))
    check("n = 2", bool(col) and col[0]["n"] == 2, str(col[0].get("n") if col else None))
    check("item_codes = both SKUs", bool(col) and sorted(col[0]["item_codes"]) == sorted([A, B]),
          str(col[0].get("item_codes") if col else None))

    # ── CASE 3: delete both links → gone from the collision view + the table ──
    print("\n-- CASE 3: cleanup removes the collision --")
    rest("DELETE", f"barcodes?barcode=eq.{q(BC)}", prefer="return=minimal")
    check("gone from barcode_collisions", rest("GET", f"barcode_collisions?barcode=eq.{q(BC)}&select=barcode") == [])
    check("no barcode rows remain", rest("GET", f"barcodes?barcode=eq.{q(BC)}&select=item_code") == [])

finally:
    cleanup()

# zero-residual check
print("\n-- residual check --")
try:
    check("no residual test barcodes", rest("GET", "barcodes?barcode=like.ZZBCM*&select=barcode") == [])
except Exception as e:
    print("  residual check error:", e)

print(f"\n{'ALL PASS' if not FAIL else 'FAILURES: ' + ', '.join(FAIL)}  ({len(PASS)} passed, {len(FAIL)} failed)")
sys.exit(1 if FAIL else 0)
