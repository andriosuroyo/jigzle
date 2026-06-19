#!/usr/bin/env python3
"""Stock Check smoke (docs/016 §8.4): exercise the count/presence close paths + the adjustments
ledger against the live DB, asserting the stock-math invariant holds, then clean up to ZERO residue.

  Count mode    — open → set a SKU off its real number → close → assert EXACTLY ONE adjustment, the
                  stock_check view's physical AND available both moved by the delta, and the identity
                  available + reserved + on_hold = physical still holds; then EDIT that adjustment
                  (view tracks it) and DELETE it (view reverts).
  Presence mode — open → leave a SKU un-ticked → close marking it 'zeroed' → assert a −expected
                  adjustment + physical 0; separately close everything 'ignored' → assert NO
                  adjustment; and the validate-before-write guard (un-ticked + no decision → reject).
  Checkbox Qty  — (PR18 §5 / 0024) open presence → record_count 'set' a SKU off its real number (a
                  ticked Checkbox row at a Qty) → close → assert the SAME (counted − expected)
                  adjustment Scan writes; and that ticking AT expected writes NOTHING.

Uses the service-role key as a TEST HARNESS only (the app uses anon + the user session). Run AFTER
0024 is applied (the Checkbox-Qty close branch), and when no live order/receiving traffic is touching
the target SKU (the exact-delta asserts read the live view around the close).

  python3 scripts/smoke_stock_check.py
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

BY = "ZZ-SC-SMOKE"  # counted_by marker → single-filter teardown

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

def rpc(fn, body):
    return rest("POST", f"rpc/{fn}", body=body)

def view_row(code):
    r = rest("GET", f"stock_check?item_code=eq.{q(code)}&select=available,physical,reserved,on_hold")
    return r[0] if r else None

def session_adjustments(scid):
    return rest("GET", f"adjustments?stock_check_id=eq.{scid}&select=adjustment_id,item_code,delta") or []

def get_all_lines(scid):
    # page past PostgREST's ~1000-row cap so the Presence review covers EVERY seeded line.
    out, page, off = [], 1000, 0
    while True:
        rows = rest("GET", f"stock_check_lines?stock_check_id=eq.{scid}&select=item_code&order=line_id&limit={page}&offset={off}") or []
        out += rows
        if len(rows) < page:
            break
        off += page
    return out

def identity_holds(v):
    return v["available"] + v["reserved"] + v["on_hold"] == v["physical"]

def cleanup():
    try:
        ids = [r["stock_check_id"] for r in (rest("GET", "stock_checks?counted_by=like.ZZ-SC*&select=stock_check_id") or [])]
        if ids:
            rest("DELETE", f"adjustments?stock_check_id=in.({','.join(str(i) for i in ids)})", prefer="return=minimal")
        rest("DELETE", "stock_checks?counted_by=like.ZZ-SC*", prefer="return=minimal")
        print("  (cleanup done)")
    except Exception as e:
        print("  cleanup error:", e)

def pick_sku_with_brand():
    # a high-stock SKU (stable target) that has a brand_prefix, so we can scope a small brand session.
    sample = rest("GET", "stock_check?physical=gt.0&select=item_code,physical&order=physical.desc&limit=50") or []
    for s in sample:
        c = rest("GET", f"catalogue?item_code=eq.{q(s['item_code'])}&select=brand_prefix")
        bp = c[0]["brand_prefix"] if c else None
        if bp:
            return s["item_code"], int(s["physical"]), bp
    return None, None, None

cleanup()  # clean BEFORE capturing the baseline — leftover adjustments from an aborted run must not pollute A_PHYS0
A, A_PHYS0, BR = pick_sku_with_brand()
if not A:
    print("No physical>0 SKU with a brand_prefix found — cannot run the smoke.")
    sys.exit(1)
print(f"target SKU {A} (physical {A_PHYS0}) in brand {BR}")

try:
    # ── CASE 1: Count — set A off its real number, close, assert one adjustment + view moves ──
    print("\n-- CASE 1: count mode (set / close / edit / delete) --")
    scid = rpc("open_stock_check", {"p_mode": "count", "p_scope": "brand", "p_brands": [BR], "p_counted_by": BY})
    check("open_stock_check returns an id", isinstance(scid, int), str(scid))
    base = view_row(A)
    target = base["physical"] + 5
    rpc("record_count", {"p_stock_check_id": scid, "p_item_code": A, "p_op": "set", "p_qty": target})
    rpc("close_stock_check", {"p_stock_check_id": scid, "p_review": []})

    adjs = session_adjustments(scid)
    check("exactly one adjustment written", len(adjs) == 1, str(adjs))
    check("the adjustment is +5 on A", bool(adjs) and adjs[0]["item_code"] == A and adjs[0]["delta"] == 5, str(adjs[:1]))
    v1 = view_row(A)
    check("view physical moved by +5", v1["physical"] == base["physical"] + 5, f'{base["physical"]}→{v1["physical"]}')
    check("view available moved by +5", v1["available"] == base["available"] + 5, f'{base["available"]}→{v1["available"]}')
    check("identity available+reserved+on_hold = physical", identity_holds(v1), str(v1))

    # edit the adjustment → view tracks it
    aid = adjs[0]["adjustment_id"]
    rest("PATCH", f"adjustments?adjustment_id=eq.{aid}", body={"delta": 2}, prefer="return=minimal")
    v2 = view_row(A)
    check("edit adjustment +5→+2: view physical follows", v2["physical"] == base["physical"] + 2, f'{v2["physical"]}')
    check("identity still holds after edit", identity_holds(v2), str(v2))

    # delete the adjustment → view reverts
    rest("DELETE", f"adjustments?adjustment_id=eq.{aid}", prefer="return=minimal")
    v3 = view_row(A)
    check("delete adjustment: view physical reverts", v3["physical"] == base["physical"], f'{v3["physical"]} vs {base["physical"]}')

    # ── CASE 2: Presence — leave A un-ticked, mark 'zeroed' at close → −expected adjustment ──
    print("\n-- CASE 2: presence mode (zeroed → −expected) --")
    scid2 = rpc("open_stock_check", {"p_mode": "presence", "p_scope": "brand", "p_brands": [BR], "p_counted_by": BY})
    lines2 = get_all_lines(scid2)
    expected_A = view_row(A)["physical"]
    review_zero = [{"item_code": l["item_code"], "action": "ignored"} for l in lines2 if l["item_code"] != A]
    review_zero.append({"item_code": A, "action": "zeroed"})
    rpc("close_stock_check", {"p_stock_check_id": scid2, "p_review": review_zero})

    adjs2 = session_adjustments(scid2)
    check("presence-zeroed: exactly one adjustment", len(adjs2) == 1, str(adjs2))
    check("presence-zeroed: adjustment is −expected on A",
          bool(adjs2) and adjs2[0]["item_code"] == A and adjs2[0]["delta"] == -expected_A, f'expected -{expected_A}, got {adjs2[:1]}')
    vz = view_row(A)
    check("presence-zeroed: view physical → 0", vz["physical"] == 0, str(vz["physical"]))
    check("identity holds after zeroing", identity_holds(vz), str(vz))
    # restore A
    rest("DELETE", f"adjustments?stock_check_id=eq.{scid2}", prefer="return=minimal")
    check("presence-zeroed: delete reverts physical", view_row(A)["physical"] == expected_A, str(view_row(A)["physical"]))

    # ── CASE 3: Presence — leave A un-ticked but 'ignored' → NO adjustment ──
    print("\n-- CASE 3: presence mode (ignored → no change) --")
    scid3 = rpc("open_stock_check", {"p_mode": "presence", "p_scope": "brand", "p_brands": [BR], "p_counted_by": BY})
    lines3 = get_all_lines(scid3)
    review_leave = [{"item_code": l["item_code"], "action": "ignored"} for l in lines3]
    rpc("close_stock_check", {"p_stock_check_id": scid3, "p_review": review_leave})
    check("presence-ignored: NO adjustment written", len(session_adjustments(scid3)) == 0)
    check("presence-ignored: A physical unchanged", view_row(A)["physical"] == expected_A, str(view_row(A)["physical"]))

    # ── CASE 4: validate-before-write — un-ticked line with no decision → reject (zero residue) ──
    print("\n-- CASE 4: presence close with an uncovered un-ticked SKU is rejected --")
    scid4 = rpc("open_stock_check", {"p_mode": "presence", "p_scope": "brand", "p_brands": [BR], "p_counted_by": BY})
    raised = False
    try:
        rpc("close_stock_check", {"p_stock_check_id": scid4, "p_review": []})
    except urllib.error.HTTPError as e:
        raised = "set-0/leave decision" in e.read().decode(errors="replace")
    check("uncovered un-ticked close is rejected", raised)
    still_open = rest("GET", f"stock_checks?stock_check_id=eq.{scid4}&select=status")
    check("rejected close left zero residue (still open, no adjustments)",
          bool(still_open) and still_open[0]["status"] == "open" and len(session_adjustments(scid4)) == 0)
    # CASE 4 intentionally leaves scid4 OPEN — cancel it so its brand scope is free before CASE 5/6
    # open another presence session on the same brand (else open_stock_check's overlap guard rejects).
    rpc("cancel_stock_check", {"p_stock_check_id": scid4})

    # ── CASE 5: Checkbox Qty (PR18 §5) — tick A at qty ≠ expected → (counted − expected) adjustment ──
    print("\n-- CASE 5: presence Checkbox Qty (ticked at qty ≠ expected → counted−expected) --")
    scid5 = rpc("open_stock_check", {"p_mode": "presence", "p_scope": "brand", "p_brands": [BR], "p_counted_by": BY})
    base5 = view_row(A)
    target5 = base5["physical"] + 3  # ticked at +3 over the shelf
    rpc("record_count", {"p_stock_check_id": scid5, "p_item_code": A, "p_op": "set", "p_qty": target5})
    lines5 = get_all_lines(scid5)
    review5 = [{"item_code": l["item_code"], "action": "ignored"} for l in lines5 if l["item_code"] != A]  # A is ticked
    rpc("close_stock_check", {"p_stock_check_id": scid5, "p_review": review5})
    adjs5 = session_adjustments(scid5)
    check("checkbox-qty: exactly one adjustment", len(adjs5) == 1, str(adjs5))
    check("checkbox-qty: adjustment is +3 on A (same as Scan)",
          bool(adjs5) and adjs5[0]["item_code"] == A and adjs5[0]["delta"] == 3, str(adjs5[:1]))
    v5 = view_row(A)
    check("checkbox-qty: view physical moved +3", v5["physical"] == base5["physical"] + 3, f'{base5["physical"]}→{v5["physical"]}')
    check("checkbox-qty: view available moved +3", v5["available"] == base5["available"] + 3, f'{base5["available"]}→{v5["available"]}')
    check("identity holds after checkbox-qty", identity_holds(v5), str(v5))
    rest("DELETE", f"adjustments?stock_check_id=eq.{scid5}", prefer="return=minimal")
    check("checkbox-qty: delete reverts physical", view_row(A)["physical"] == base5["physical"], str(view_row(A)["physical"]))

    # ── CASE 6: Checkbox Qty — tick A AT expected → no change, no adjustment ──
    print("\n-- CASE 6: presence Checkbox Qty (ticked at expected → no adjustment) --")
    scid6 = rpc("open_stock_check", {"p_mode": "presence", "p_scope": "brand", "p_brands": [BR], "p_counted_by": BY})
    expected6 = view_row(A)["physical"]
    rpc("record_count", {"p_stock_check_id": scid6, "p_item_code": A, "p_op": "set", "p_qty": expected6})  # ticked at expected
    lines6 = get_all_lines(scid6)
    review6 = [{"item_code": l["item_code"], "action": "ignored"} for l in lines6 if l["item_code"] != A]
    rpc("close_stock_check", {"p_stock_check_id": scid6, "p_review": review6})
    check("checkbox-qty at expected: NO adjustment written", len(session_adjustments(scid6)) == 0, str(session_adjustments(scid6)))
    check("checkbox-qty at expected: A physical unchanged", view_row(A)["physical"] == expected6, str(view_row(A)["physical"]))

finally:
    cleanup()

# zero-residue confirmation
try:
    left = rest("GET", "stock_checks?counted_by=like.ZZ-SC*&select=stock_check_id")
    check("no stock_check rows left behind", left == [], str(left))
    fa = view_row(A)
    check("target SKU restored to its real physical", fa["physical"] == A_PHYS0, f'{fa["physical"]} vs {A_PHYS0}')
except Exception as e:
    print("  residual check error:", e)

print(f"\n{'ALL PASS' if not FAIL else 'FAILURES: ' + ', '.join(FAIL)}  ({len(PASS)} passed, {len(FAIL)} failed)")
sys.exit(1 if FAIL else 0)
