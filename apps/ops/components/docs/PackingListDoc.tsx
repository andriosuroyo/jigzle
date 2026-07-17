// CN Packing List PDF (PR203) — bilingual (EN + 中文), no Jigzle logo. Mirrors the sheet template:
// a MARK&NO / DESCRIPTION / L·W·H / VOLUME W. / GROSS W. table, a country-of-origin band, and a
// packages / net-weight / gross-weight summary beside the shipper-signature box.

import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { ensureCjkFont, CJK } from './cjkFont';

export type PackingBox = { desc: string; p: number; l: number; t: number; realWeight: number };
export type PackingListDocProps = { markNo: string; boxes: PackingBox[]; divisor: number; trackings: string[] };

const B = '#000';
const s = StyleSheet.create({
  page: { paddingVertical: 28, paddingHorizontal: 34, fontFamily: CJK, fontSize: 9, color: '#000' },
  // PR360 — the Latin title uses the built-in Helvetica-Bold, not the CJK subset font: pdf.js mis-rendered
  // the bold title in the large WQY subset ("PACKING LIST" → "KING LIST" in the preview). The download was
  // fine, but a built-in standard font renders correctly everywhere.
  title: { textAlign: 'center', fontSize: 15, fontFamily: 'Helvetica-Bold' },
  titleCn: { textAlign: 'center', fontSize: 15, letterSpacing: 6, marginBottom: 8 },

  table: { borderWidth: 1, borderColor: B },
  hRow: { flexDirection: 'row', borderBottomWidth: 1, borderColor: B },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderColor: B, minHeight: 26 },
  cell: { paddingHorizontal: 4, paddingVertical: 3, borderRightWidth: 1, borderColor: B, justifyContent: 'center' },
  cellLast: { paddingHorizontal: 4, paddingVertical: 3, justifyContent: 'center' },
  en: { fontSize: 8.5 },
  cn: { fontSize: 8.5 },
  num: { fontSize: 9, textAlign: 'center' },

  // column widths (sum ≈ full content width)
  cMark: { width: 96 }, cDesc: { width: 120 }, cDim: { width: 52 }, cVol: { width: 70 }, cGross: { width: 70 },

  originBand: { borderWidth: 1, borderTopWidth: 0, borderColor: B, paddingVertical: 5, alignItems: 'center' },

  footRow: { flexDirection: 'row', borderWidth: 1, borderTopWidth: 0, borderColor: B },
  footLeft: { width: 250, borderRightWidth: 1, borderColor: B, padding: 6 },
  footRight: { flexGrow: 1, padding: 6 },
  fLine: { flexDirection: 'row', marginBottom: 3, alignItems: 'flex-end' },
  fLabel: { fontSize: 8.5 },
  fVal: { fontSize: 9, marginLeft: 6 },
  fUnit: { fontSize: 8.5, marginLeft: 6 }, // trailing unit (BOX / KG) to the right of each value
});

type RStyle = (typeof s)[keyof typeof s];
const r2 = (n: number) => Math.round(n * 100) / 100;

function HeadCell({ en, cn, style, last }: { en: string; cn: string; style: RStyle; last?: boolean }) {
  return (
    <View style={[last ? s.cellLast : s.cell, style]}>
      <Text style={s.en}>{en}</Text>
      <Text style={s.cn}>{cn}</Text>
    </View>
  );
}

export default function PackingListDoc({ markNo, boxes, divisor, trackings }: PackingListDocProps) {
  ensureCjkFont();
  const vol = (b: PackingBox) => r2((Number(b.p) || 0) * (Number(b.l) || 0) * (Number(b.t) || 0) / divisor);
  const netWeight = r2(boxes.reduce((sum, b) => sum + vol(b), 0));
  const grossWeight = r2(boxes.reduce((sum, b) => sum + (Number(b.realWeight) || 0), 0));
  // PR354 — box trackings come from the tab's single comma-separated field; one line per number.
  const trackingText = [...new Set(trackings.map((t) => t.trim()).filter(Boolean))].join('\n');

  return (
    <Document>
      <Page size="A4" style={s.page}>
        <Text style={s.title}>PACKING LIST</Text>
        <Text style={s.titleCn}>包 装 清 单</Text>

        <View style={s.table}>
          {/* header */}
          <View style={s.hRow}>
            <HeadCell en="MARK&NO:" cn="麦头" style={s.cMark} />
            <HeadCell en="DESCRIPTION" cn="品名" style={s.cDesc} />
            <HeadCell en="LENGTH" cn="长度" style={s.cDim} />
            <HeadCell en="WIDTH" cn="宽度" style={s.cDim} />
            <HeadCell en="HEIGHT" cn="高度" style={s.cDim} />
            <HeadCell en="VOLUME W." cn="体积重量" style={s.cVol} />
            <HeadCell en="GROSS W." cn="毛重" style={s.cGross} last />
          </View>
          {/* rows */}
          {boxes.map((b, i) => (
            <View key={i} style={s.row} wrap={false}>
              {/* PR352 — every carton carries the ship-id; additional cartons get a "(1)", "(2)"… suffix. */}
              <View style={[s.cell, s.cMark]}><Text style={s.en}>{i === 0 ? markNo : `${markNo} (${i})`}</Text></View>
              <View style={[s.cell, s.cDesc]}><Text style={s.en}>{b.desc.trim() || 'JIGSAW PUZZLE'}</Text></View>
              <View style={[s.cell, s.cDim]}><Text style={s.num}>{Number(b.p) || ''}</Text></View>
              <View style={[s.cell, s.cDim]}><Text style={s.num}>{Number(b.l) || ''}</Text></View>
              <View style={[s.cell, s.cDim]}><Text style={s.num}>{Number(b.t) || ''}</Text></View>
              <View style={[s.cell, s.cVol]}><Text style={s.num}>{vol(b) || ''}</Text></View>
              <View style={[s.cellLast, s.cGross]}><Text style={s.num}>{Number(b.realWeight) || ''}</Text></View>
            </View>
          ))}
        </View>

        {/* country of origin */}
        <View style={s.originBand}>
          <Text style={s.en}>COUNTRY OF ORIGIN: CHINA</Text>
          <Text style={s.cn}>（起　始　地）</Text>
        </View>

        {/* packages / weights + signature. PR352 — the unit (BOX / KG) trails each value; the box
            tracking prints on its own labelled line under gross weight. */}
        <View style={s.footRow}>
          <View style={s.footLeft}>
            <View style={s.fLine}><Text style={s.fLabel}>NUMBER OF PACKAGES 箱数:</Text><Text style={s.fVal}>{boxes.length}</Text><Text style={s.fUnit}>BOX</Text></View>
            <View style={s.fLine}><Text style={s.fLabel}>NET WEIGHT 净重:</Text><Text style={s.fVal}>{netWeight}</Text><Text style={s.fUnit}>KG</Text></View>
            <View style={s.fLine}><Text style={s.fLabel}>GROSS WEIGHT 毛重:</Text><Text style={s.fVal}>{grossWeight}</Text><Text style={s.fUnit}>KG</Text></View>
            <View style={[s.fLine, { alignItems: 'flex-start' }]}><Text style={s.fLabel}>TRACKING NUMBER 运单号：</Text>{trackingText ? <Text style={s.fVal}>{trackingText}</Text> : null}</View>
          </View>
          <View style={s.footRight}>
            <Text style={s.en}>SHIPPER`S SIGNATURE</Text>
            <Text style={s.en}>OR COMPANY STAMP</Text>
            <Text style={s.cn}>(托运人签名或公章)</Text>
          </View>
        </View>
      </Page>
    </Document>
  );
}
