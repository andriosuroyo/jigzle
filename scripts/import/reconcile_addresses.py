#!/usr/bin/env python3
"""Parse customer_addresses into structured geo fields (PR113).

The legacy import packed each address into one copy-paste blob (`raw_address`): the recipient name on
the first line, the location in the middle, the phone at the end, plus stray courier notes. `name` and
`contact_phone` were already split out at import; this fills the GEO columns the app expects —
street / kelurahan / kecamatan / kota / provinsi / negara / kode_pos — plus `delivery_note`, then
recomposes `raw_address` as the app does (addrFields()): the structured pieces joined by ", " with NO
name / phone / note. The ORIGINAL blob is preserved verbatim in `source_blob` (migration 0047).

GEO matching snaps to the bundled Indonesia postcode dataset (apps/ops/public/data/id-postal.json,
~81k kelurahan) — the same source the in-app autofill uses — so the values are canonical, not guessed.
We anchor on the trailing 5-digit postcode and confirm against kelurahan / kecamatan / city tokens in
the text. kelurahan / kecamatan are filled CONSERVATIVELY (decision 1A): only when the name is present
in the text or the postcode maps to a single ward; otherwise left NULL for the UI autofill / manual.

`source_blob` is the parse source whenever present (so re-runs are stable); `raw_address` is the
fallback for the first pass before 0047's backfill.

Usage (from repo root or scripts/import):
    python3 reconcile_addresses.py --report out.csv     # parse all, write a review CSV; no DB writes
    python3 reconcile_addresses.py                       # DRY-RUN vs live DB (reads; writes nothing)
    python3 reconcile_addresses.py --customer-id 6408    # scope dry-run/execute to one customer
    python3 reconcile_addresses.py --address-id 2767     # scope to one address
    python3 reconcile_addresses.py --execute --address-id 2767   # apply just that address
    python3 reconcile_addresses.py --execute             # apply the full parse (writes via service key)

Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (service-role bypasses RLS). Columns
source_blob / delivery_note must exist first (migration 0047); --execute aborts with a clear message
if they don't. --report and dry-run never touch those columns.
"""
from __future__ import annotations
import argparse
import csv
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

from db import Client

REPO_ROOT = Path(__file__).resolve().parents[2]
POSTAL_JSON = REPO_ROOT / "apps" / "ops" / "public" / "data" / "id-postal.json"

# ── postal reference ─────────────────────────────────────────────────────────
class Postal:
    """id-postal.json indexed for reverse lookup. rows = [kelurahan, kecamatan, city, provIdx, pos]."""

    def __init__(self, path: Path):
        d = json.loads(path.read_text(encoding="utf-8"))
        self.provinces = d["provinces"]
        self.rows = d["rows"]
        self.by_pc: dict[str, list[tuple]] = defaultdict(list)
        self.by_kel: dict[str, list[tuple]] = defaultdict(list)
        self.kecamatans: set[str] = set()
        self.cities: set[str] = set()
        for kel, kec, city, pi, pc in self.rows:
            prov = self.provinces[pi] if pi is not None and 0 <= pi < len(self.provinces) else ""
            tup = (kel, kec, city, prov, pc)
            self.by_pc[pc].append(tup)
            self.by_kel[kel.lower()].append(tup)
            self.kecamatans.add(kec.lower())
            self.cities.add(city.lower())


# ── small text helpers ───────────────────────────────────────────────────────
def clean(s: str | None) -> str:
    return re.sub(r"[ \t]+", " ", (s or "").strip())


def digits(s: str | None) -> str:
    return re.sub(r"\D", "", s or "")


# a line that is essentially just a phone number (ID mobile/landline), allowing +62/0 and separators
PHONE_LINE = re.compile(r"^[\s+()./-]*(?:\+?62|0)[\d\s+()./-]{7,}$")
# courier / sender / map noise → delivery_note (kept out of the street + composed raw_address)
NOTE_PREFIX = re.compile(r"^\s*(note|catatan|nb|dari|from|untuk|utk|patokan|landmark)\s*[:\-]", re.I)
URL_RE = re.compile(r"https?://\S+|goo\.gl/\S+|maps\.\S+", re.I)
POSTCODE_RE = re.compile(r"\b(\d{5})\b")
# administrative connector words that prefix a division name (e.g. "Desa Cijantra", "Kec. Pinang") —
# once the division is lifted into its own column, the bare connector is debris in the street.
CONNECTORS = re.compile(
    r"\b(desa|kelurahan|kel|kecamatan|kec|kota|kabupaten|kab|provinsi|prov|kotamadya)\b\.?",
    re.I)
# a parenthetical is a delivery hint (→ delivery_note) only when it carries instruction language;
# otherwise it's part of the address (a shop/building name) and stays in the street.
NOTE_KEYWORDS = re.compile(
    r"seb[er]+ang|depan|samping|sebelah|dekat|belakang|warna|cat\b|pagar|satpam|titip|masuk|"
    r"portal|patokan|gerbang|lantai|\blt\.?\b|\blobby\b|rumah|gang\b|gg\.|blok kayu|hook",
    re.I)


def strip_phone(text: str, phone: str | None) -> str:
    """Remove the contact phone (by digit run) and any phone-only fragments from text."""
    out = text
    dp = digits(phone)
    if dp:
        # match the phone with arbitrary separators between its digits
        pat = r"\+?\s*" + r"[\s().\-]*".join(re.escape(c) for c in dp[-9:])
        out = re.sub(pat, " ", out)
    return out


# ── parse one address ────────────────────────────────────────────────────────
class Parsed:
    __slots__ = ("street", "kelurahan", "kecamatan", "kota", "provinsi", "negara",
                 "kode_pos", "delivery_note", "raw_address", "tier", "how")

    def __init__(self):
        self.street = None
        self.kelurahan = None
        self.kecamatan = None
        self.kota = None
        self.provinsi = None
        self.negara = "Indonesia"
        self.kode_pos = None
        self.delivery_note = None
        self.raw_address = None
        self.tier = "NONE"
        self.how = "unmatched"


def split_notes(lines: list[str]) -> tuple[list[str], list[str]]:
    """Separate body lines from courier/sender/map notes. Whole note-lines (Note:/Dari:/URL) move
    out entirely; instruction-bearing parentheticals are lifted out of an otherwise-address line."""
    body, notes = [], []
    for ln in lines:
        if NOTE_PREFIX.search(ln) or URL_RE.search(ln):
            notes.append(URL_RE.sub("", ln).strip() or ln.strip())
            continue
        # lift parentheticals that read as delivery hints; keep plain ones (shop/building names)
        def take(m):
            inner = m.group(1).strip()
            if NOTE_KEYWORDS.search(inner):
                notes.append(inner)
                return " "
            return m.group(0)
        kept = re.sub(r"\(([^)]*)\)", take, ln).strip()
        if kept:
            body.append(kept)
    return body, notes


def match_geo(text: str, postal: Postal) -> tuple[tuple | None, str]:
    """Return ((kel,kec,city,prov,pos) or None, how). Conservative on kel/kec (decision 1A)."""
    low = text.lower()
    # anchor on the LAST postcode that actually exists in the dataset (postcodes sit at the tail;
    # earlier 5-digit groups are usually house/building numbers)
    pcs = [pc for pc in POSTCODE_RE.findall(text) if pc in postal.by_pc]
    if pcs:
        pc = pcs[-1]
        cands = postal.by_pc[pc]
        if len(cands) == 1:
            return cands[0], "pc-unique"
        for t in cands:                                  # confirm ward by token in text
            if t[0].lower() in low or t[1].lower() in low:
                return t, "pc+ward"
        for t in cands:                                  # else confirm city
            if t[2].lower() in low:
                # keep geo (city/prov/pos) but DROP the guessed ward → conservative
                return (None, None, t[2], t[3], t[4]), "pc+city"
        t = cands[0]
        return (None, None, t[2], t[3], t[4]), "pc-multi"  # city/prov/pos only; ward unknown
    # no postcode: try a kelurahan name present in the text (>=5 chars to avoid noise)
    for kl, cl in postal.by_kel.items():
        if len(kl) >= 5 and re.search(r"\b" + re.escape(kl) + r"\b", low):
            if len(cl) == 1:
                return cl[0], "kel-unique"
            for t in cl:
                if t[2].lower() in low:
                    return t, "kel+city"
            break
    return None, "unmatched"


def remove_tokens(street: str, p: Parsed) -> str:
    """Drop the canonical geo tokens (and their bare connector words) from the street so it doesn't
    repeat the structured fields, then normalize to a single clean comma-separated line."""
    s = street
    # strip the matched divisions; a "(Udik)"-style canonical suffix is matched without it too
    toks = [p.kelurahan, p.kecamatan, p.kota, p.provinsi, p.kode_pos, "Indonesia"]
    for tok in toks:
        if not tok:
            continue
        s = re.sub(r"\b" + re.escape(tok) + r"\b", "", s, flags=re.I)
        bare = re.sub(r"\s*\(.*?\)\s*", "", tok).strip()   # e.g. "Pinang (Penang)" → "Pinang"
        if bare and bare != tok:
            s = re.sub(r"\b" + re.escape(bare) + r"\b", "", s, flags=re.I)
    s = CONNECTORS.sub(" ", s)                  # orphaned "Desa" / "Kec." / "Kota" debris
    s = re.sub(r"\(\s*\)", " ", s)              # empty parens
    s = s.replace("\n", ", ")                   # flatten to one line
    s = re.sub(r"\s+,", ",", s)                 # "No.3 , Legok" → "No.3, Legok"
    s = re.sub(r"\s*,\s*(,\s*)+", ", ", s)      # collapse ", , ," runs
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"^[\s,./-]+|[\s,./-]+$", "", s)  # trim dangling separators/whitespace
    return s.strip()


def compose_raw(p: Parsed) -> str | None:
    parts = [p.street, p.kelurahan, p.kecamatan, p.kota, p.provinsi, p.negara, p.kode_pos]
    return ", ".join(x for x in parts if x) or None


def parse_address(rec: dict, postal: Postal) -> Parsed:
    p = Parsed()
    blob = rec.get("source_blob") or rec.get("raw_address") or ""
    name = clean(rec.get("recipient_name"))
    phone = rec.get("contact_phone")
    lines = [clean(l) for l in blob.splitlines()]
    lines = [l for l in lines if l]
    # drop the leading name line (decision: name already in recipient_name)
    if lines and name and lines[0].lower() == name.lower():
        lines = lines[1:]
    # separate courier/sender notes
    body, notes = split_notes(lines)
    # drop phone-only lines from the body
    body = [l for l in body if not PHONE_LINE.match(l)]
    body_text = "\n".join(body)
    body_text = strip_phone(body_text, phone)

    hit, how = match_geo(body_text, postal)
    p.how = how
    if hit:
        kel, kec, city, prov, pos = hit
        p.kelurahan, p.kecamatan, p.kota, p.provinsi, p.kode_pos = kel, kec, city, prov, pos
        if kel and kec:
            p.tier = "FULL"
        elif city and prov and pos:
            p.tier = "GEO"
        else:
            p.tier = "PARTIAL"
    else:
        # last-ditch: postcode present but not in dataset → still capture it
        m = POSTCODE_RE.findall(body_text)
        if m:
            p.kode_pos = m[-1]
            p.tier = "PARTIAL"

    street = remove_tokens(body_text, p)
    p.street = street or None
    p.delivery_note = "\n".join(n for n in notes if n).strip() or None
    p.raw_address = compose_raw(p)
    return p


# ── DB I/O ───────────────────────────────────────────────────────────────────
BASE_COLS = ("address_id,customer_id,address_label,raw_address,recipient_name,"
             "contact_phone,street,kelurahan,kecamatan,kota,provinsi,negara,kode_pos")


def fetch_addresses(client: Client, where: str = "", *, with_new: bool = False) -> list[dict]:
    select = BASE_COLS + (",source_blob,delivery_note" if with_new else "")
    out, offset = [], 0
    while True:
        path = f"customer_addresses?select={select}&order=address_id.asc&limit=1000&offset={offset}"
        if where:
            path += f"&{where}"
        chunk = client._req("GET", path) or []
        out.extend(chunk)
        if len(chunk) < 1000:
            break
        offset += 1000
    return out


def has_new_columns(client: Client) -> bool:
    return client.column_exists("customer_addresses", "source_blob") and \
           client.column_exists("customer_addresses", "delivery_note")


# ── main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Parse customer addresses into structured geo fields.")
    ap.add_argument("--report", metavar="OUT.csv", help="parse all rows → review CSV; no DB writes")
    ap.add_argument("--customer-id", type=int, help="scope to one customer")
    ap.add_argument("--address-id", type=int, help="scope to one address")
    ap.add_argument("--limit", type=int, help="cap rows processed (sampling)")
    ap.add_argument("--execute", action="store_true", help="APPLY the parse (writes via service key)")
    args = ap.parse_args()

    if not POSTAL_JSON.exists():
        sys.exit(f"postal dataset not found at {POSTAL_JSON}")
    postal = Postal(POSTAL_JSON)
    print(f"Postal reference: {len(postal.rows)} rows, {len(postal.by_pc)} postcodes")

    where = ""
    if args.address_id:
        where = f"address_id=eq.{args.address_id}"
    elif args.customer_id:
        where = f"customer_id=eq.{args.customer_id}"

    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    client = Client(url, key)
    new_cols = has_new_columns(client)
    rows = fetch_addresses(client, where, with_new=new_cols)
    if args.limit:
        rows = rows[: args.limit]
    print(f"Fetched {len(rows)} address rows" + (f" ({where})" if where else ""))

    parsed = [(r, parse_address(r, postal)) for r in rows]
    tiers = defaultdict(int)
    hows = defaultdict(int)
    for _r, p in parsed:
        tiers[p.tier] += 1
        hows[p.how] += 1
    n = len(parsed) or 1
    print("\nConfidence tiers:")
    for t in ("FULL", "GEO", "PARTIAL", "NONE"):
        print(f"  {t:8s}: {tiers.get(t,0):5d}  ({100*tiers.get(t,0)//n}%)")
    print("Match method:")
    for k, v in sorted(hows.items(), key=lambda kv: -kv[1]):
        print(f"  {k:12s}: {v}")

    if args.report:
        out = Path(args.report)
        with out.open("w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["address_id", "customer_id", "tier", "how", "recipient_name", "contact_phone",
                        "street", "kelurahan", "kecamatan", "kota", "provinsi", "negara", "kode_pos",
                        "delivery_note", "new_raw_address", "source_blob"])
            for r, p in parsed:
                w.writerow([r["address_id"], r["customer_id"], p.tier, p.how, r.get("recipient_name"),
                            r.get("contact_phone"), p.street, p.kelurahan, p.kecamatan, p.kota,
                            p.provinsi, p.negara, p.kode_pos, p.delivery_note, p.raw_address,
                            (r.get("source_blob") or r.get("raw_address"))])
        print(f"\n[--report] wrote {len(parsed)} rows → {out}  (no DB writes)")
        return

    # show a few before/after samples
    print("\nSample (up to 8):")
    for r, p in parsed[:8]:
        print(f"  #{r['address_id']} [{p.tier}/{p.how}]")
        print(f"     FROM: {repr((r.get('source_blob') or r.get('raw_address') or ''))[:140]}")
        print(f"     street={p.street!r}")
        print(f"     kel={p.kelurahan} kec={p.kecamatan} kota={p.kota} prov={p.provinsi} pos={p.kode_pos}")
        if p.delivery_note:
            print(f"     note={p.delivery_note!r}")

    if not args.execute:
        print("\nDRY-RUN — nothing written. Re-run with --execute to apply.")
        return

    if not has_new_columns(client):
        sys.exit("\nABORT: columns source_blob / delivery_note do not exist yet. "
                 "Apply migration 0047_address_parse.sql first (Supabase CLI or Dashboard SQL editor).")

    print("\nAPPLYING…")
    done = skipped = 0
    norm = lambda v: v if (v is not None and v != "") else None
    for r, p in parsed:
        patch = {
            "street": p.street,
            "kelurahan": p.kelurahan,
            "kecamatan": p.kecamatan,
            "kota": p.kota,
            "provinsi": p.provinsi,
            "negara": p.negara,
            "kode_pos": p.kode_pos,
            "delivery_note": p.delivery_note,
            "raw_address": p.raw_address,
        }
        # capture the original once (migration backfills this, but belt-and-suspenders for new rows)
        if not r.get("source_blob") and r.get("raw_address"):
            patch["source_blob"] = r["raw_address"]
        # skip rows already in the target state — makes the run idempotent + cheap to resume
        if all(norm(r.get(k)) == norm(v) for k, v in patch.items()):
            skipped += 1
            continue
        client._req("PATCH", f"customer_addresses?address_id=eq.{r['address_id']}",
                    body=patch, prefer="return=minimal")
        done += 1
        if done % 250 == 0:
            print(f"  …wrote {done} (skipped {skipped} unchanged)")
    print(f"Done. Wrote {done}, skipped {skipped} already-current of {len(parsed)} addresses.")


if __name__ == "__main__":
    main()
