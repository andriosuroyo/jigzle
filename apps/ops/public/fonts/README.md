# Doc Generator fonts

## `jigzle-cjk.ttf`

A **subset** of WenQuanYi Zen Hei (`wqy-zenhei.ttc`, GPL/open) containing only the
Chinese/Latin characters used by the China customs documents (CN Packing List / Invoice /
Shipping) — labels **and** the fixed shipper/consignee/forwarder preset addresses. react-pdf's
built-in fonts have no CJK glyphs, so these docs register this font (see
`components/docs/cjkFont.ts`).

It is deliberately tiny (~48 KB) by subsetting to a fixed character set. **Limitation:** if a
Chinese character that isn't in `cjk-chars.txt` is typed (e.g. a brand-new preset address), it
renders as a blank box. To extend: add the characters to `cjk-chars.txt` and regenerate:

```sh
# needs: pip install fonttools ; a wqy-zenhei.ttc (Debian: fonts-wqy-zenhei)
python3 - <<'PY'
chars=set(open('cjk-chars.txt',encoding='utf-8').read()); chars.discard('\n')
for c in range(0x20,0x7f): chars.add(chr(c))
open('/tmp/subset-text.txt','w',encoding='utf-8').write(''.join(sorted(chars)))
PY
pyftsubset /usr/share/fonts/truetype/wqy/wqy-zenhei.ttc --font-number=0 \
  --output-file=jigzle-cjk.ttf --text-file=/tmp/subset-text.txt \
  --layout-features='' --no-hinting --desubroutinize --drop-tables+=GSUB,GPOS,GDEF,BDF,FFTM
```
