#!/usr/bin/env python3
"""SKU-images smoke (docs/011 §8). Two parts:
  1. Pure-function checks of the importer's parsing — DB-free: stem→(code,variant), primary priority
     (edited/_edit → pre/_0 → pre/_<n>), unicode-safe CJK stems, and the zero-pad code normalization
     (EPO-60-15 ≡ EPO-60-015) that drives high-confidence orphan suggestions.
  2. DB model + view check (run AFTER 0021): seed a temp SKU + two candidate rows (_edit primary,
     _0), point the catalogue → assert sku_image_resolved returns has_image + the display_path, and a
     status flip reflects through the view; seed a temp image_orphans row → assert it lands. Then
     clean up → zero residue. Service-role harness (the app uses anon + session, same RLS-gated writes).

  python3 scripts/smoke_sku_images.py
"""
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "import"))
from db import Client, load_env  # noqa: E402
import import_images as imp  # noqa: E402  (import-safe: __main__ guard; Pillow/rapidfuzz are lazy)

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

SKU = "ZZ-IMG-SMOKE-001"
DISPLAY_PATH = f"{SKU}/display.webp"
ORPHAN_PATH = "drive/A/ZZ-IMG-ORPHAN_0.jpg"

# ── 1. pure-function checks (no DB needed) ──
print("-- pure functions (importer parsing) --")
check("parse_stem _edit", imp.parse_stem("APP-300-358_edit") == ("APP-300-358", "_edit"))
check("parse_stem _0", imp.parse_stem("APP-300-358_0") == ("APP-300-358", "_0"))
check("parse_stem unicode (CJK)", imp.parse_stem("Z-神秘少年旗舰店HX0649_3") == ("Z-神秘少年旗舰店HX0649", "_3"))
check("parse_stem no suffix", imp.parse_stem("APP-300-358") == ("APP-300-358", ""))
check("primary: _edit beats _0 beats _1",
      imp.primary_rank("edited", "_edit") < imp.primary_rank("pre", "_0") < imp.primary_rank("pre", "_1"))
check("normalize zero-pad EPO-60-15 ≡ EPO-60-015",
      imp.normalize_code("EPO-60-15") == imp.normalize_code("EPO-60-015"))
check("normalize distinguishes different codes",
      imp.normalize_code("EPO-60-015") != imp.normalize_code("EPO-61-015"))

def cleanup():
    try:
        rest("DELETE", "image_orphans?orphan_path=like.*ZZ-IMG-*", prefer="return=minimal")
        # clear the catalogue pointer before deleting sku_images (catalogue.primary_image_id → sku_images.id)
        rest("PATCH", f"catalogue?item_code=eq.{q(SKU)}", body={"primary_image_id": None}, prefer="return=minimal")
        rest("DELETE", f"sku_images?item_code=eq.{q(SKU)}", prefer="return=minimal")
        rest("DELETE", f"catalogue?item_code=eq.{q(SKU)}", prefer="return=minimal")
        print("  (cleanup done)")
    except Exception as e:
        print("  cleanup error:", e)

print("\n-- DB model + view (needs 0021 applied) --")
try:
    cleanup()  # start clean

    # temp SKU + two candidate rows. NB: PostgREST rejects a bulk insert whose objects don't share
    # the same key set (PGRST102), so send each row as its own single-object POST (as the importer does).
    rest("POST", "catalogue", body=[{"item_code": SKU, "translate_name": "Img Smoke"}], prefer="return=minimal")
    edited = rest("POST", "sku_images", body=[
        {"item_code": SKU, "source": "edited", "variant": "_edit", "source_path": "drive/B/ZZ-IMG-SMOKE-001_edit.jpg",
         "display_path": DISPLAY_PATH, "width": 400, "height": 300, "bytes": 1234, "content_hash": "deadbeef", "is_primary": True},
    ], prefer="return=representation")
    rest("POST", "sku_images", body=[
        {"item_code": SKU, "source": "pre", "variant": "_0", "source_path": "drive/A/ZZ-IMG-SMOKE-001_0.jpg"},
    ], prefer="return=minimal")
    primary_id = edited[0]["id"]
    rest("PATCH", f"catalogue?item_code=eq.{q(SKU)}",
         body={"primary_image_id": primary_id, "image_status": "has_image"}, prefer="return=minimal")

    # ── CASE 1: sku_image_resolved returns has_image + the display_path ──
    print("\n-- CASE 1: resolved view --")
    res = rest("GET", f"sku_image_resolved?item_code=eq.{q(SKU)}&select=image_status,display_path")[0]
    check("status = has_image", res["image_status"] == "has_image", str(res))
    check("display_path resolved to the primary", res["display_path"] == DISPLAY_PATH, str(res["display_path"]))
    parts = rest("GET", f"sku_images?item_code=eq.{q(SKU)}&select=variant,is_primary&order=variant")
    prim = [r["variant"] for r in parts if r["is_primary"]]
    check("exactly one primary, and it's _edit", prim == ["_edit"], str(prim))

    # ── CASE 2: a status flip reflects through the view ──
    print("\n-- CASE 2: status flip --")
    rest("PATCH", f"catalogue?item_code=eq.{q(SKU)}", body={"image_status": "not_found", "primary_image_id": None}, prefer="return=minimal")
    res2 = rest("GET", f"sku_image_resolved?item_code=eq.{q(SKU)}&select=image_status,display_path")[0]
    check("not_found + display_path null", res2["image_status"] == "not_found" and res2["display_path"] is None, str(res2))

    # ── CASE 3: orphan row lands in image_orphans ──
    print("\n-- CASE 3: image_orphans --")
    rest("POST", "image_orphans", body=[{"orphan_path": ORPHAN_PATH, "source": "pre", "variant": "_0",
                                         "suggested_item_code": SKU, "score": 0.9}], prefer="return=minimal")
    orp = rest("GET", f"image_orphans?orphan_path=eq.{q(ORPHAN_PATH)}&select=suggested_item_code,status")
    check("orphan recorded with suggestion + pending", bool(orp) and orp[0]["suggested_item_code"] == SKU and orp[0]["status"] == "pending", str(orp))

finally:
    cleanup()

# zero-residual check
print("\n-- residual check --")
try:
    check("no residual test SKU", rest("GET", f"catalogue?item_code=eq.{q(SKU)}&select=item_code") == [])
    check("no residual sku_images", rest("GET", f"sku_images?item_code=eq.{q(SKU)}&select=id") == [])
    check("no residual orphans", rest("GET", "image_orphans?orphan_path=like.*ZZ-IMG-*&select=id") == [])
except Exception as e:
    print("  residual check error:", e)

print(f"\n{'ALL PASS' if not FAIL else 'FAILURES: ' + ', '.join(FAIL)}  ({len(PASS)} passed, {len(FAIL)} failed)")
sys.exit(1 if FAIL else 0)
