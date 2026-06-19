#!/usr/bin/env python3
"""search_skus RPC smoke (PR20 §2a): prove the single-round-trip Add-search finds a SKU by code,
by name, and by barcode, and returns an int `available`. Self-cleaning (one throwaway ZZ-SRCHSMOKE
catalogue row + its barcode), zero residue. Uses the service-role key as a TEST HARNESS only (the app
calls search_skus with anon + session; SECURITY INVOKER means the same is_allowed_user() RLS applies).
Run AFTER 0026 is applied (needs public.search_skus).

  python3 scripts/smoke_search_skus.py
"""
import json
import sys
import urllib.error
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

def search(term):
    return rest("POST", "rpc/search_skus", body={"p_q": term}) or []

def find(rows, code):
    return next((r for r in rows if r.get("item_code") == code), None)

# Distinctive throwaway identifiers so the row is the only hit (no real catalogue collision) and the
# 20-row cap is never in play. CODE_SLICE / NAME_SLICE are ≥3 chars and unique to this row.
SKU = "ZZ-SRCHSMOKE-001"
CODE_SLICE = "SRCHSMOKE"          # matches item_code via ilike
NAME = "Zqxwvyz Smoke Puzzle"     # translate_name → resolved name
NAME_SLICE = "Zqxwvyz"            # matches translate_name via ilike
BC = "ZZSRCHSMOKE1"               # barcode-only path (does not appear in item_code/name)

def cleanup():
    try:
        rest("DELETE", "barcodes?barcode=like.ZZSRCHSMOKE*", prefer="return=minimal")
        rest("DELETE", "catalogue?item_code=like.ZZ-SRCHSMOKE-*", prefer="return=minimal")
        print("  (cleanup done)")
    except Exception as e:
        print("  cleanup error:", e)

try:
    cleanup()  # start clean in case a prior run aborted

    rest("POST", "catalogue", body=[{"item_code": SKU, "translate_name": NAME, "needs_review": True}],
         prefer="return=minimal")
    rest("POST", "barcodes", body=[{"barcode": BC, "item_code": SKU, "is_verified": False}],
         prefer="return=minimal")
    print(f"seeded {SKU} (name {NAME!r}, barcode {BC})\n")

    # (i) by a ≥3-char slice of the item_code → catalogue hit
    by_code = search(CODE_SLICE)
    row = find(by_code, SKU)
    check("found by item_code slice", row is not None, f"q={CODE_SLICE!r} → {len(by_code)} rows")

    # (ii) by a ≥3-char slice of the name → catalogue hit, name resolved (translate_name)
    by_name = search(NAME_SLICE)
    rn = find(by_name, SKU)
    check("found by name slice", rn is not None, f"q={NAME_SLICE!r} → {len(by_name)} rows")
    check("name resolves to translate_name", rn is not None and rn.get("name") == NAME,
          f"got {rn.get('name') if rn else None!r}")

    # (iii) by the barcode → barcode-only path (bc → bc_named)
    by_bc = search(BC)
    rb = find(by_bc, SKU)
    check("found by barcode", rb is not None, f"q={BC!r} → {len(by_bc)} rows")

    # shape: every result carries an int `available` (0 here — temp SKU not in stock_snapshot)
    check("result carries an int available", row is not None and isinstance(row.get("available"), int),
          f"available={row.get('available') if row else None!r}")
finally:
    cleanup()

print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)
