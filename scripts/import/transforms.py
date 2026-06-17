"""Pure transform helpers for the Jigzle Phase-1 data lift.

No I/O here — every function takes raw cell values and returns clean target values,
so they can be unit-tested in isolation. See docs/import-reference.md for the spec.
"""
from __future__ import annotations
import re
from datetime import datetime, date

IDSP = "　"  # ideographic (full-width) space — the OutboundData Item Name delimiter
MARK = "◼"  # ◼  black-square barcode verification marker (may carry U+FE0F)


# ── basic cleaning ────────────────────────────────────────────────────────────
def clean(v):
    """Trim a cell to a non-empty str, or None."""
    if v is None:
        return None
    s = str(v).replace(" ", " ").strip()
    return s or None


def to_int(v):
    if v is None or v == "":
        return None
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        m = re.search(r"-?\d+", str(v))
        return int(m.group()) if m else None


def to_idr_thousands(v):
    """Sales/orders/payments money is in '000 IDR → full IDR bigint (×1000)."""
    if v is None or v == "":
        return None
    try:
        return int(round(float(v) * 1000))
    except (TypeError, ValueError):
        return None


def to_idr_full(v):
    """royalty_paid.royalty_idr is already full IDR — no ×1000."""
    if v is None or v == "":
        return None
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


# ── dates ───────────────────────────────────────────────────────────────────
UP_TO_2023 = "up to 2023"


def is_up_to_2023(v):
    return v is not None and str(v).strip().lower() == UP_TO_2023


def parse_date(v):
    """'yyyy.mm.dd' → date; 'yyyy.mm' → first of month; real datetime → date.
    Year-only ('2023.0'), placeholders ('—','X','#…'), empty → None."""
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    s = str(v).strip()
    if not s:
        return None
    m = re.fullmatch(r"(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\.?", s)
    if m:
        y, mo, d = int(m[1]), int(m[2]), int(m[3])
        if 1 <= mo <= 12 and 1 <= d <= 31:
            try:
                return date(y, mo, d).isoformat()
            except ValueError:
                return None
        return None
    m = re.fullmatch(r"(\d{4})[.\-/](\d{1,2})\.?", s)
    if m:
        y, mo = int(m[1]), int(m[2])
        if 1 <= mo <= 12:
            return date(y, mo, 1).isoformat()
    return None


def dt(v):
    """parse_date but as a timestamp string (midnight) for timestamptz columns."""
    d = parse_date(v)
    return f"{d}T00:00:00+00:00" if d else None


# ── phone (the customer dedup key) ────────────────────────────────────────────
def normalize_phone(raw):
    """Country-code form, no leading 0: 081… → 6281…, bare 8… → 628…, 62… kept.
    Returns the normalized digit string, or None when there is no usable number."""
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    s = re.split(r"[\/;]", s)[0]            # multi-number cell → first
    digits = re.sub(r"\D", "", s)
    if not digits:
        return None
    if digits.startswith("62"):
        n = digits
    elif digits.startswith("0"):
        n = "62" + digits[1:]
    elif digits.startswith("8"):
        n = "62" + digits
    else:
        n = digits                          # already-intl (+44 …) kept as-is
    if not (9 <= len(n) <= 15):
        return None
    return n


# ── customer label / channel ──────────────────────────────────────────────────
def name_from_label(label):
    """'Wijaya TN (4150)' → 'Wijaya TN'; compound 'A / B (5520)' kept whole (D6)."""
    s = clean(label)
    if not s:
        return None
    return re.sub(r"\s*\(\s*\d{2,5}\s*\)\s*$", "", s).strip() or s


_CH_ALIASES = {
    "WHATSAPP": ["WHATSAPP", "WA ", "WA", "WHATSAP", "WHATAPP", "WHATSAPP IRENE", "WHATSAPP ANDRIO"],
    "TOKOPEDIA": ["TOKOPEDIA", "TOKPED", "TOPED", "TPED", "TOKO"],
    "SHOPEE": ["SHOPEE", "SHOPPE", "SHOPE", "SPX"],
    "INSTAGRAM": ["DM IG", "IG", "INSTA", "INSTAGRAM"],
    "LINE": ["LINE@", "LINE @", "LINE2", "LINE"],
    "BLIBLI": ["BLIBLI"],
    "BUKALAPAK": ["BUKALAPAK"],
    "LAZADA": ["LAZADA"],
    "JD_ID": ["JD ID", "JD.ID", "JDID", "JD"],
    "BBM": ["BBM"],
    "WEBSITE": ["WEB", "WEBSITE"],
}


def canonical_channel(raw):
    """Return (canonical_channel, ig_handle). Unknown → 'OTHER'. Multi-value → first."""
    s = clean(raw)
    if not s:
        return None, None
    ig = None
    m = re.search(r"\(([^)]+)\)", s)               # 'DM IG (handle)'
    if m and re.search(r"\bIG\b", s, re.I):
        ig = m.group(1).strip()
    first = re.split(r"[\/\n]", s)[0].strip().upper()
    for canon, aliases in _CH_ALIASES.items():
        for a in aliases:
            if first == a or first.startswith(a):
                return canon, ig
    return "OTHER", ig


# ── courier / tracking ────────────────────────────────────────────────────────
def split_courier(cell):
    s = clean(cell)
    if not s:
        return None, None
    parts = [p.strip() for p in s.split("\n") if p.strip()]
    courier = parts[0] if parts else None
    tracking = parts[1].lstrip("#").strip() if len(parts) > 1 else None
    return courier, tracking


# ── barcodes (Catalog!ARTICLE NUMBER) ─────────────────────────────────────────
_BC_RE = re.compile(r"^\d{8,14}$")
_SUFFIX_RE = re.compile(r"[A-Za-z]+$")   # Andrio's manual collision tag (e.g. '...A'/'...B')


def parse_barcodes(cell):
    """Return (list_of_barcode_strings, had_marker). Strips ◼️ + spaces; keeps EAN/UPC/JAN.

    A token that isn't a clean barcode but is digits + a trailing letter (e.g.
    '6941499606509A'/'…B') is Andrio's manual collision annotation: it marks a SKU that
    SHARES this physical barcode. We strip the trailing letter(s) and keep the bare base, so
    both lettered SKUs collide on the same code — the importer then emits a plain
    (barcode, item_code) pair for each lettered SKU on that bare code (composite barcodes PK),
    and Receiving's resolveBarcode shows the "which SKU?" picker. Safe because a genuine
    EAN/UPC/JAN is all-digits, so a trailing letter is never part of a real barcode. Free-text
    notes (e.g. 'Also: SKU-002') don't end in a letter after stripping, so they're still ignored.
    """
    if cell is None:
        return [], False
    raw = str(cell)
    had = MARK in raw
    out = []
    for tok in raw.split(","):
        t = tok.replace(MARK, "").replace("️", "").strip().replace(" ", "")
        if _BC_RE.match(t):
            out.append(t)
        else:
            base = _SUFFIX_RE.sub("", t)
            if base != t and _BC_RE.match(base):
                out.append(base)
    return out, had


def strip_marker(cell):
    """Cleaned article-number text for catalogue.article_number (marker + spaces removed)."""
    s = clean(cell)
    if not s:
        return None
    s = s.replace(MARK, "").replace("️", "").strip(" ,")
    return s or None


# ── item_code resolution against the catalogue ────────────────────────────────
def resolve_item(raw, valid_codes):
    """→ (item_code|None, item_code_raw, matched_bool)."""
    s = clean(raw)
    if s and s in valid_codes:
        return s, s, True
    return None, s, False


# ── packed Item Name (OutboundData, one SKU per cell) ─────────────────────────
def parse_packed_item(cell):
    """'1　PIN-U1188　Pintoo U1188　Lilo' → (qty=1, code='PIN-U1188'). Delimiter = U+3000."""
    s = clean(cell)
    if not s:
        return None, None
    fields = [f for f in s.split(IDSP) if f.strip() != ""]
    if not fields:
        return None, None
    qty = to_int(fields[0])
    code = fields[1].strip() if len(fields) > 1 else None
    return qty, code


# ── flags / suppliers ─────────────────────────────────────────────────────────
_FLAG_RE = re.compile(r"^([\U0001F1E6-\U0001F1FF]{2}|🌎|🌏|🌍)\s*")
_FLAG_COUNTRY = {"🇨🇳": "China", "🇯🇵": "Japan", "🇹🇼": "Taiwan", "🇭🇰": "Hong Kong",
                 "🇰🇷": "Korea", "🇺🇸": "USA", "🌎": "Worldwide", "🌏": "Worldwide", "🌍": "Worldwide"}


def strip_flag(s):
    """('🇨🇳 1709-892-4989') → ('🇨🇳', '1709-892-4989')."""
    s = clean(s) or ""
    m = _FLAG_RE.match(s)
    if m:
        return m.group(1), s[m.end():].strip()
    return None, s


def country_from_flag(flag):
    return _FLAG_COUNTRY.get(flag) if flag else None


def supplier_type(name):
    n = (name or "").lower()
    if "amazon" in n:
        return "marketplace"
    if name and name.strip().lower() == "other":
        return "other"
    digits = re.sub(r"\D", "", name or "")
    if name and len(digits) >= max(7, len(re.sub(r"\s", "", name)) - 1):
        return "Taobao account"        # the name is essentially a phone/account number
    return "agent"


def normalize_country(c):
    c = clean(c)
    if not c:
        return None
    return {"hongkong": "Hong Kong", "hong kong": "Hong Kong"}.get(c.lower(), c)


# ── ship_id prefix (forwarder key) ────────────────────────────────────────────
def ship_prefix(ship_id):
    """'SUB 191' → 'SUB'; '📦2606009' → None (ad-hoc, no forwarder)."""
    s = clean(ship_id)
    if not s or s.startswith("📦"):
        return None
    m = re.match(r"([A-Za-z]{2,5})", s)
    return m.group(1).upper() if m else None


# ── sales NOTES → payments (D9) ───────────────────────────────────────────────
_METHODS = ["BCA", "Mandiri", "Shopee", "Tokopedia", "Deposit", "Website", "Cash", "Socmed", "BRI", "BNI"]
_DDMM = re.compile(r"\b(\d{1,2})[/.](\d{1,2})\b")


def _detect_method(line, fallback):
    for m in _METHODS:
        if re.search(rf"\b{re.escape(m)}\b", line, re.I):
            return m
    return fallback


def parse_payments(notes, sales_total_idr, method, status, order_date):
    """D9: only PAID orders get payments, and they sum to money actually received.
    If parseable DP/Lunas lines sum (±1k) to the order total → emit that breakdown;
    otherwise emit ONE Full payment = sales_total. Unpaid/Cancel → []."""
    if (clean(status) or "").lower() != "paid":
        return []
    total = sales_total_idr or 0
    base = {"method": clean(method), "paid_date": parse_date(order_date)}
    note = clean(notes) or ""

    lines = [l.strip() for l in note.split("\n") if l.strip()]
    parsed = []
    for ln in lines:
        if not re.search(r"\b(DP|Lunas|TF|Full|No DP)\b", ln, re.I):
            continue
        m = re.search(r"(\d[\d.,]*)", ln)
        amt = to_idr_thousands(m.group(1).replace(",", "")) if m else None
        if amt is None:
            continue
        t = "Settlement" if re.search(r"\blunas\b", ln, re.I) else ("DP" if re.search(r"\bDP\b", ln, re.I) else "Full")
        d = None
        dm = _DDMM.search(ln)
        if dm and base["paid_date"]:
            yr = base["paid_date"][:4]
            try:
                d = date(int(yr), int(dm[2]), int(dm[1])).isoformat()
            except ValueError:
                d = None
        parsed.append({"amount_idr": amt, "type": t, "method": _detect_method(ln, base["method"]),
                       "paid_date": d or base["paid_date"], "note": ln})

    if parsed and total and abs(sum(p["amount_idr"] for p in parsed) - total) <= 1000:
        return parsed
    # fall back to a single Full payment = order total (preserves sum = received)
    return [{"amount_idr": total, "type": "Full", "method": base["method"],
             "paid_date": base["paid_date"], "note": note or None}]
