# Doc Generator fonts

## `jigzle-cjk.ttf`

A **subset** of WenQuanYi Zen Hei (`wqy-zenhei.ttc`, GPL/open) containing only the
Chinese/Latin characters used by the China customs documents (CN Packing List / Invoice /
Shipping) — labels **and** the fixed shipper/consignee/forwarder preset addresses. react-pdf's
built-in fonts have no CJK glyphs, so these docs register this font (see
`components/docs/cjkFont.ts`).

**Coverage (PR358):** the subset now includes the **entire GB2312 set** (all ~6763 common simplified
Chinese hanzi + symbols), CJK punctuation (U+3000–303F), fullwidth forms (U+FF00–FFEF), ASCII, and the
extra (mostly traditional) characters listed in `cjk-chars.txt`. That covers any normal
simplified-Chinese address a user types into **Settings → Doc Generator → CN addresses**, so the file is
now ~2.3 MB (was ~48 KB). It is still lazy-loaded only when a CN document is generated.

**Limitation:** a rare character outside GB2312 (e.g. an uncommon traditional hanzi not in
`cjk-chars.txt`) still renders as a blank box. To extend: add it to `cjk-chars.txt` and regenerate:

```sh
# needs: pip install fonttools ; a wqy-zenhei.ttc (Debian: fonts-wqy-zenhei)
python3 - <<'PY'
chars=set(chr(c) for c in range(0x20,0x7f))                 # ASCII
for hi in range(0xA1,0xFA):                                 # all GB2312 (simplified CN)
    for lo in range(0xA1,0xFF):
        try: chars.add(bytes([hi,lo]).decode('gb2312'))
        except Exception: pass
for c in range(0x3000,0x3040): chars.add(chr(c))            # CJK punctuation
for c in range(0xFF00,0xFFF0): chars.add(chr(c))            # fullwidth forms
chars|=set(open('cjk-chars.txt',encoding='utf-8').read()); chars.discard('\n')  # extras (traditional)
open('/tmp/subset-text.txt','w',encoding='utf-8').write(''.join(sorted(chars)))
PY
pyftsubset /usr/share/fonts/truetype/wqy/wqy-zenhei.ttc --font-number=0 \
  --output-file=jigzle-cjk.ttf --text-file=/tmp/subset-text.txt \
  --layout-features='' --no-hinting --desubroutinize --drop-tables+=GSUB,GPOS,GDEF,BDF,FFTM
```
