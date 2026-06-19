#!/usr/bin/env python3
"""PR17 Inbound↔Order reconciliation smoke (docs/PR17-inbound-reconcile-spec.md §9) — exercises the
REWORKED record_receipt + the new reverse_receipt against the live DB:

  - exact          : PO qty 5 → receive 5 (close) → line Received qty 5, stock +5, shipment completed
  - short/split open: PO qty 5 → receive 3 (leave open) → original Received qty 3 + NEW open qty-2 line
                      that STAYS on the shipment (ship_id kept, no breadcrumb), stock +3
  - short/split close: same, but close → leftover reverts (ship_id NULL) + "shorted from <ship>" crumb
  - full short close : two SKUs on a ship, receive one (close) → the other reverts to Processing, no stock
  - over            : PO qty 2 → receive 3 → line Received, stock +3 (full physical), no negative PO
  - exclude         : 5 arrived, 1 excluded → PO of 5 Received, stock +4, excluded_qty=1 + reason recorded
  - unexpected      : SKU with no PO line on the ship → +stock, no PO touched (flag-and-allow)
  - reverse         : receive 50 → reverse → stock net 0 + a source='reverse' "Reverse action" adjustment
                      + PO line back to pre-state (un-Received) + shipment un-closed → re-receive 5 = 5
  - adversarial     : a reconcile that must reject (excluded>counted) leaves ZERO residue

Uses the service-role key as a TEST HARNESS only (the app uses anon + session). Run AFTER 0023.
try/finally restores live data; a residual + baseline check confirms every touched SKU is back to base.

  python3 scripts/smoke_inbound_reconcile.py
"""
import json
import sys
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "import"))
from db import Client, load_env  # noqa: E402

env = load_env()
db = Client(env.get("NEXT_PUBLIC_SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY"))
db.ping()

JKT = datetime.now(timezone.utc) + timedelta(hours=7)
R = JKT.strftime("%Y-%m-%d")

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

def stock(code):
    r = rest("GET", f"stock_check?item_code=eq.{urllib.parse.quote(code)}&select=available,physical")
    return r[0] if r else {"available": 0, "physical": 0}

def receipt(ship_id, lines, close):
    return rest("POST", "rpc/record_receipt", body={
        "p_ship_id": ship_id, "p_receive_date": R, "p_lines": lines, "p_close_shipment": close})

def reverse(receipt_id):
    return rest("POST", "rpc/reverse_receipt", body={"p_receipt_id": receipt_id, "p_note": "Reverse action"})

MKT = "ZZIR"  # marketplace_order_id sentinel on every test PO → cleanup survives a ship_id-nulling revert
def mkship(n): return f"ZZ-IR-S{n}"
def add_ship(ship_id):
    rest("POST", "shipments", body=[{"ship_id": ship_id, "origin_country": "China", "status": "open",
         "ship_date": "2026-06-01", "tracking": f"TRK-{ship_id}"}], prefer="return=minimal")
def add_po(item_code, qty, ship_id, status="On the way"):
    rest("POST", "purchase_orders", body=[{"item_code": item_code, "qty": qty, "status": status,
         "status_since": "2026-05-01", "input_date": "2026-05-01", "ship_id": ship_id,
         "marketplace_order_id": MKT}], prefer="return=minimal")
def pos_for(item_code, **filters):
    q = f"purchase_orders?item_code=eq.{urllib.parse.quote(item_code)}&marketplace_order_id=eq.{MKT}&select=po_id,qty,status,ship_id,receive_date,shipment_note,status_since"
    for k, v in filters.items():
        q += f"&{k}={v}"
    return rest("GET", q + "&order=po_id") or []

created_adj_ids = []
def cleanup():
    try:
        rest("DELETE", "inbound?ship_id=like.ZZ-IR-*", prefer="return=minimal")
        rest("DELETE", "receipts?ship_id=like.ZZ-IR-*", prefer="return=minimal")
        rest("DELETE", f"purchase_orders?marketplace_order_id=eq.{MKT}", prefer="return=minimal")
        rest("DELETE", "purchase_orders?ship_id=like.ZZ-IR-*", prefer="return=minimal")
        rest("DELETE", "shipments?ship_id=like.ZZ-IR-*", prefer="return=minimal")
        for aid in created_adj_ids:
            rest("DELETE", f"adjustments?adjustment_id=eq.{aid}", prefer="return=minimal")
        print("  (cleanup done)")
    except Exception as e:
        print("  cleanup error:", e)

base = {}
codes = []
try:
    cleanup()  # start clean in case a prior run aborted

    skus = rest("GET", "stock_check?select=item_code,available&available=gte.0&available=lte.50&order=item_code&limit=9")
    if len(skus) < 9:
        skus = rest("GET", "catalogue?select=item_code&order=item_code&limit=9")
    codes = [s["item_code"] for s in skus]
    A, B, C, D, E, F, G, H, I = codes
    base = {c: stock(c) for c in codes}

    # ── CASE 1: exact — PO qty 5, receive 5, close ──
    print("\n-- CASE 1: exact (5 ordered, 5 received, close) --")
    add_ship(mkship(1)); add_po(A, 5, mkship(1))
    r1 = receipt(mkship(1), [{"item_code": A, "qty": 5}], True)
    check("returns jsonb {receipt_id, affected, closed}", isinstance(r1, dict) and r1.get("receipt_id") and A in (r1.get("affected") or []) and r1.get("closed") is True, str(r1))
    p = pos_for(A, ship_id=f"eq.{mkship(1)}")
    check("PO line → Received qty 5", len(p) == 1 and p[0]["status"] == "Received" and p[0]["qty"] == 5, str(p))
    sA = stock(A)
    check("A stock +5 (avail & physical)", sA["available"] == base[A]["available"] + 5 and sA["physical"] == base[A]["physical"] + 5, f'{base[A]}→{sA}')
    sh = rest("GET", f"shipments?ship_id=eq.{mkship(1)}&select=status")[0]
    check("shipment → completed", sh["status"] == "completed")

    # ── CASE 2: short/split LEAVE OPEN — leftover stays on the shipment (no revert, no breadcrumb) ──
    print("\n-- CASE 2: short/split, leave open (5 ordered, 3 received) --")
    add_ship(mkship(2)); add_po(B, 5, mkship(2)); add_po(I, 4, mkship(2), "On the way")  # I = un-counted in-transit line
    receipt(mkship(2), [{"item_code": B, "qty": 3}], False)
    p = pos_for(B)
    recv = [x for x in p if x["status"] == "Received"]
    left = [x for x in p if x["status"] == "Processing"]
    check("original → Received qty 3", len(recv) == 1 and recv[0]["qty"] == 3, str(recv))
    check("NEW leftover qty 2, STAYS on ship (ship_id kept), no breadcrumb",
          len(left) == 1 and left[0]["qty"] == 2 and left[0]["ship_id"] == mkship(2) and not left[0]["shipment_note"], str(left))
    sB = stock(B)
    check("B stock +3", sB["available"] == base[B]["available"] + 3 and sB["physical"] == base[B]["physical"] + 3)
    sh = rest("GET", f"shipments?ship_id=eq.{mkship(2)}&select=status")[0]
    check("shipment stays open", sh["status"] == "open")
    # decision 5: an UN-COUNTED in-transit line keeps its status + ship_id on leave-open (no downgrade)
    pi = pos_for(I)
    check("un-counted 'On the way' line UNTOUCHED on leave-open (no Processing downgrade, ship kept, no crumb)",
          len(pi) == 1 and pi[0]["status"] == "On the way" and pi[0]["ship_id"] == mkship(2) and not pi[0]["shipment_note"], str(pi))

    # ── CASE 3: short/split CLOSE — leftover reverts (ship_id NULL) + breadcrumb ──
    print("\n-- CASE 3: short/split, close (5 ordered, 3 received) --")
    add_ship(mkship(3)); add_po(C, 5, mkship(3))
    receipt(mkship(3), [{"item_code": C, "qty": 3}], True)
    p = pos_for(C)
    recv = [x for x in p if x["status"] == "Received"]
    left = [x for x in p if x["status"] == "Processing"]
    check("original → Received qty 3", len(recv) == 1 and recv[0]["qty"] == 3, str(recv))
    check("leftover qty 2 REVERTS (ship_id NULL, Processing) + breadcrumb",
          len(left) == 1 and left[0]["qty"] == 2 and left[0]["ship_id"] is None
          and (left[0]["shipment_note"] or "").find(f"shorted from {mkship(3)}") >= 0, str(left))
    sC = stock(C)
    check("C stock +3", sC["available"] == base[C]["available"] + 3)

    # ── CASE 4: full short on close — two SKUs, receive one, the other reverts ──
    print("\n-- CASE 4: full short on close (D received, E reverts) --")
    add_ship(mkship(4)); add_po(D, 2, mkship(4)); add_po(E, 3, mkship(4))
    receipt(mkship(4), [{"item_code": D, "qty": 2}], True)
    pd = pos_for(D, ship_id=f"eq.{mkship(4)}")
    check("D → Received qty 2", len(pd) == 1 and pd[0]["status"] == "Received", str(pd))
    pe = pos_for(E)
    check("E reverts → Processing, ship_id NULL, breadcrumb",
          len(pe) == 1 and pe[0]["status"] == "Processing" and pe[0]["ship_id"] is None
          and (pe[0]["shipment_note"] or "").find(f"shorted from {mkship(4)}") >= 0, str(pe))
    sE = stock(E)
    check("E stock unchanged (nothing arrived)", sE["available"] == base[E]["available"] and sE["physical"] == base[E]["physical"])

    # ── CASE 5: over-receipt — PO qty 2, receive 3 ──
    print("\n-- CASE 5: over (2 ordered, 3 received) --")
    add_ship(mkship(5)); add_po(F, 2, mkship(5))
    receipt(mkship(5), [{"item_code": F, "qty": 3}], True)
    p = pos_for(F, ship_id=f"eq.{mkship(5)}")
    check("PO → Received, qty NOT negative", len(p) == 1 and p[0]["status"] == "Received" and p[0]["qty"] >= 0, str(p))
    sF = stock(F)
    check("F stock +3 (full physical arrived)", sF["available"] == base[F]["available"] + 3 and sF["physical"] == base[F]["physical"] + 3)

    # ── CASE 6: exclude — 5 arrived, 1 excluded → PO of 5 Received, stock +4, reason recorded ──
    print("\n-- CASE 6: exclude (5 arrived, 1 damaged) --")
    add_ship(mkship(6)); add_po(G, 5, mkship(6))
    receipt(mkship(6), [{"item_code": G, "qty": 5, "excluded_qty": 1, "exclude_reason": "damaged box"}], True)
    p = pos_for(G, ship_id=f"eq.{mkship(6)}")
    check("PO of 5 → Received (allocated on TOTAL arrived incl. excluded)", len(p) == 1 and p[0]["status"] == "Received" and p[0]["qty"] == 5, str(p))
    sG = stock(G)
    check("G stock +4 (sellable = 5 − 1 excluded)", sG["available"] == base[G]["available"] + 4 and sG["physical"] == base[G]["physical"] + 4, f'{base[G]}→{sG}')
    inb = rest("GET", f"inbound?ship_id=eq.{mkship(6)}&item_code=eq.{urllib.parse.quote(G)}&select=qty,excluded_qty,receive_note")
    check("inbound row: qty 4, excluded_qty 1, reason recorded",
          len(inb) == 1 and inb[0]["qty"] == 4 and inb[0]["excluded_qty"] == 1 and inb[0]["receive_note"] == "damaged box", str(inb))

    # ── CASE 7: unexpected SKU (no PO line on the ship) → +stock, no PO touched ──
    print("\n-- CASE 7: unexpected (no PO line) --")
    pre_h = stock(H)
    receipt("ZZ-IR-ADHOC", [{"item_code": H, "qty": 4}], False)
    sH = stock(H)
    check("H stock +4 (flag-and-allow)", sH["available"] == pre_h["available"] + 4 and sH["physical"] == pre_h["physical"] + 4)
    check("no PO touched for H (none existed)", pos_for(H) == [])

    # ── CASE 8: reverse — receive 50 → reverse → net 0 + 'reverse' adjustment + PO restored → re-receive 5 ──
    print("\n-- CASE 8: reverse a confirmed receipt --")
    pre_a = stock(A)
    add_ship(mkship(8)); add_po(A, 50, mkship(8))
    r8 = receipt(mkship(8), [{"item_code": A, "qty": 50}], True)
    mid = stock(A)
    check("A stock +50 before reverse", mid["available"] == pre_a["available"] + 50)
    rev = reverse(r8["receipt_id"])
    check("reverse returns reversed=true", isinstance(rev, dict) and rev.get("reversed") is True, str(rev))
    post = stock(A)
    check("A stock back to pre-reverse baseline (net 0)", post["available"] == pre_a["available"] and post["physical"] == pre_a["physical"], f'{pre_a}→{post}')
    adj = rest("GET", f"adjustments?source=eq.reverse&item_code=eq.{urllib.parse.quote(A)}&note=eq.Reverse%20action&order=adjustment_id.desc&limit=1")
    check("source='reverse' 'Reverse action' adjustment of −50 written", len(adj) == 1 and adj[0]["delta"] == -50, str(adj))
    for a in adj:
        created_adj_ids.append(a["adjustment_id"])
    pa = pos_for(A, ship_id=f"eq.{mkship(8)}")
    check("PO restored to pre-state (un-Received, qty 50, On the way)", len(pa) == 1 and pa[0]["status"] == "On the way" and pa[0]["qty"] == 50 and pa[0]["receive_date"] is None, str(pa))
    sh = rest("GET", f"shipments?ship_id=eq.{mkship(8)}&select=status")[0]
    check("shipment un-closed (back to open)", sh["status"] == "open")
    # re-receive correctly: 5
    receipt(mkship(8), [{"item_code": A, "qty": 5}], False)
    sA8 = stock(A)
    check("re-receive 5 → A = pre_a + 5", sA8["available"] == pre_a["available"] + 5, f'{pre_a["available"]}→{sA8["available"]}')

    # ── CASE 9: adversarial — excluded > counted must REJECT, zero residue ──
    print("\n-- CASE 9: adversarial reject (excluded > counted) --")
    raised = False
    try:
        receipt("ZZ-IR-ADV", [{"item_code": B, "qty": 3, "excluded_qty": 5}], False)
    except urllib.error.HTTPError as e:
        raised = "excluded qty must be between" in e.read().decode(errors="replace")
    check("rejects excluded>counted (loud)", raised)
    check("zero residue: no inbound for the rejected ship", rest("GET", "inbound?ship_id=eq.ZZ-IR-ADV&select=inbound_id") == [])
    check("zero residue: no receipt header for the rejected ship", rest("GET", "receipts?ship_id=eq.ZZ-IR-ADV&select=receipt_id") == [])

    # double-reverse guard
    print("\n-- CASE 8b: double-reverse rejected --")
    raised = False
    try:
        reverse(r8["receipt_id"])
    except urllib.error.HTTPError as e:
        raised = "already reversed" in e.read().decode(errors="replace")
    check("reversing an already-reversed receipt is rejected", raised)

finally:
    cleanup()

# residual + baseline restore
print("\n-- residual / restore check --")
try:
    for c in codes:
        s = stock(c)
        ok = s["available"] == base[c]["available"] and s["physical"] == base[c]["physical"]
        check(f"{c} stock restored to baseline", ok, f'base={base[c]} now={s}')
    check("no residual test inbound", rest("GET", "inbound?ship_id=like.ZZ-IR-*&select=inbound_id") == [])
    check("no residual test receipts", rest("GET", "receipts?ship_id=like.ZZ-IR-*&select=receipt_id") == [])
    check("no residual test shipments", rest("GET", "shipments?ship_id=like.ZZ-IR-*&select=ship_id") == [])
    check("no residual test POs (incl. reverted ship_id=NULL via sentinel)",
          rest("GET", f"purchase_orders?marketplace_order_id=eq.{MKT}&select=po_id") == [])
except NameError:
    pass

print(f"\n{'ALL PASS' if not FAIL else 'FAILURES: ' + ', '.join(FAIL)}  ({len(PASS)} passed, {len(FAIL)} failed)")
sys.exit(1 if FAIL else 0)
