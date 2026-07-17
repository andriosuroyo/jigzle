// CN Invoice PDF (PR204) — bilingual, no Jigzle logo. Declared-value customs invoice keyed to the
// same shipment as the CN Packing List: shipper/consignee blocks, a declared qty/unit/amount table,
// and the packages/net/gross roll-up shared with the packing list. Amounts in USD.

import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { ensureCjkFont, CJK } from './cjkFont';

export type CnInvoiceLine = { description: string; qty: number; unitPrice: number };
export type CnInvoiceDocProps = {
  markNo: string;
  dateStr: string;
  hawb: string;
  shipper: string;
  consignee: string;
  lines: CnInvoiceLine[];
  packages: number;
  netWeight: number;
  grossWeight: number;
};

const B = '#000';
const r2 = (n: number) => Math.round(n * 100) / 100;
// PR356 — keep a long, space-less Chinese address inside its half-width cell instead of overflowing
// into the neighbouring one (the shipper block was bleeding into the consignee's).
const CJK_PER_LINE = 26; // CJK chars that fit one address cell line at 8.5pt
function cjkWrap(str: string): string {
  // react-pdf appends a hyphen at any mid-word soft break, so for a space-less CJK block we
  // insert REAL newlines to keep it inside its cell. Latin lines have spaces and wrap on their
  // own, so they are left untouched.
  return str.split('\n').map((seg) => {
    if (/\s/.test(seg) || seg.length <= CJK_PER_LINE) return seg;
    const rows: string[] = [];
    for (let i = 0; i < seg.length; i += CJK_PER_LINE) rows.push(seg.slice(i, i + CJK_PER_LINE));
    return rows.join('\n');
  }).join('\n');
}
const s = StyleSheet.create({
  page: { paddingVertical: 26, paddingHorizontal: 34, fontFamily: CJK, fontSize: 9, color: '#000' },
  // PR360 — Latin title in built-in Helvetica-Bold (not the CJK subset font) so pdf.js renders it right.
  title: { textAlign: 'center', fontSize: 15, fontFamily: 'Helvetica-Bold' },
  titleCn: { textAlign: 'center', fontSize: 15, letterSpacing: 8, marginBottom: 6 },

  metaRow: { flexDirection: 'row', borderWidth: 1, borderColor: B },
  metaCell: { width: '50%', padding: 5, borderColor: B },
  metaBorder: { borderRightWidth: 1 },
  lab: { fontSize: 8.5 },
  cn: { fontSize: 8.5 },
  val: { fontSize: 9 },

  addrRow: { flexDirection: 'row', borderWidth: 1, borderTopWidth: 0, borderColor: B },
  addrCell: { width: '50%', padding: 5, minHeight: 78, borderColor: B },
  addrBorder: { borderRightWidth: 1 },
  addrText: { fontSize: 8.5, marginTop: 3, lineHeight: 1.35 },

  table: { borderWidth: 1, borderTopWidth: 0, borderColor: B },
  hRow: { flexDirection: 'row', borderBottomWidth: 1, borderColor: B },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderColor: B, minHeight: 22 },
  cell: { paddingHorizontal: 4, paddingVertical: 3, borderRightWidth: 1, borderColor: B, justifyContent: 'center' },
  cellLast: { paddingHorizontal: 4, paddingVertical: 3, justifyContent: 'center' },
  cMark: { width: 96 }, cDesc: { flexGrow: 1 }, cQty: { width: 70, textAlign: 'right' }, cUnit: { width: 80, textAlign: 'right' }, cAmt: { width: 90, textAlign: 'right' },
  num: { fontSize: 9, textAlign: 'right' },

  noteBand: { borderWidth: 1, borderTopWidth: 0, borderColor: B, alignItems: 'center', paddingVertical: 4 },
  totalBand: { borderWidth: 1, borderTopWidth: 0, borderColor: B, alignItems: 'center', paddingVertical: 4 },

  footRow: { flexDirection: 'row', borderWidth: 1, borderTopWidth: 0, borderColor: B },
  footLeft: { width: 250, borderRightWidth: 1, borderColor: B, padding: 6 },
  footRight: { flexGrow: 1, padding: 6 },
  fLine: { flexDirection: 'row', marginBottom: 3, alignItems: 'flex-end' },
  fUnit: { fontSize: 8.5, marginLeft: 6 },
});

export default function CnInvoiceDoc({ markNo, dateStr, hawb, shipper, consignee, lines, packages, netWeight, grossWeight }: CnInvoiceDocProps) {
  ensureCjkFont();
  const total = r2(lines.reduce((sum, l) => sum + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0));
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <Text style={s.title}>INVOICE</Text>
        <Text style={s.titleCn}>发　票</Text>

        {/* date + HAWB */}
        <View style={s.metaRow}>
          <View style={[s.metaCell, s.metaBorder]}>
            <Text style={s.lab}>DATE:</Text><Text style={s.cn}>日期</Text>
            <Text style={s.val}>{dateStr}</Text>
          </View>
          <View style={s.metaCell}>
            <Text style={s.lab}>HAWB NO:</Text><Text style={s.cn}>运单号码</Text>
            <Text style={s.val}>{hawb}</Text>
          </View>
        </View>

        {/* shipper / consignee */}
        <View style={s.addrRow}>
          <View style={[s.addrCell, s.addrBorder]}>
            <Text style={s.lab}>SHIPPER`S NAME & ADDRESS:</Text><Text style={s.cn}>托运人名称、地址</Text>
            <Text style={s.addrText}>{cjkWrap(shipper)}</Text>
          </View>
          <View style={s.addrCell}>
            <Text style={s.lab}>CONSIGNEE`S NAME & ADDRESS:</Text><Text style={s.cn}>收件人名称，地址</Text>
            <Text style={s.addrText}>{cjkWrap(consignee)}</Text>
          </View>
        </View>

        {/* declared items */}
        <View style={s.table}>
          <View style={s.hRow}>
            <View style={[s.cell, s.cMark]}><Text style={s.lab}>MARK&NO:</Text><Text style={s.cn}>麦头</Text></View>
            <View style={[s.cell, s.cDesc]}><Text style={s.lab}>DESCRIPTION</Text><Text style={s.cn}>品名</Text></View>
            <View style={[s.cell, s.cQty]}><Text style={s.lab}>QUANTITY</Text><Text style={s.cn}>数量</Text></View>
            <View style={[s.cell, s.cUnit]}><Text style={s.lab}>UNITPRICE</Text><Text style={s.cn}>单价</Text></View>
            <View style={[s.cellLast, s.cAmt]}><Text style={s.lab}>AMOUNT</Text><Text style={s.cn}>总值</Text></View>
          </View>
          {lines.map((l, i) => (
            <View key={i} style={s.row} wrap={false}>
              <View style={[s.cell, s.cMark]}><Text style={s.val}>{i === 0 ? markNo : ''}</Text></View>
              <View style={[s.cell, s.cDesc]}><Text style={s.val}>{l.description}</Text></View>
              <View style={[s.cell, s.cQty]}><Text style={s.num}>{Number(l.qty) || ''}</Text></View>
              <View style={[s.cell, s.cUnit]}><Text style={s.num}>{l.unitPrice ? r2(l.unitPrice) : ''}</Text></View>
              <View style={[s.cellLast, s.cAmt]}><Text style={s.num}>{(Number(l.qty) || 0) * (Number(l.unitPrice) || 0) ? r2((Number(l.qty) || 0) * (Number(l.unitPrice) || 0)) : ''}</Text></View>
            </View>
          ))}
          {/* PR356 — a tall empty filler row so the items table has the roomy look of the reference doc */}
          <View style={[s.row, { minHeight: 170, borderBottomWidth: 0 }]}>
            <View style={[s.cell, s.cMark]} />
            <View style={[s.cell, s.cDesc]} />
            <View style={[s.cell, s.cQty]} />
            <View style={[s.cell, s.cUnit]} />
            <View style={[s.cellLast, s.cAmt]} />
          </View>
        </View>

        {/* PR356 — the customs note sits on its own band directly ABOVE the total line */}
        <View style={s.noteBand}><Text style={s.lab}>NO COMMERCIAL VALUE, FOR CUSTOM USE ONLY</Text></View>
        <View style={s.totalBand}><Text style={s.val}>TOTAL: USD 总计: {total}</Text></View>
        <View style={s.noteBand}><Text style={s.lab}>COUNTRY OF ORIGIN: CHINA</Text><Text style={s.cn}>（起　始　地）</Text></View>

        {/* packages / weights (shared with packing list) + signature */}
        <View style={s.footRow}>
          <View style={s.footLeft}>
            <View style={s.fLine}><Text style={s.lab}>NUMBER OF PACKAGES 箱数:</Text><Text style={[s.val, { marginLeft: 6 }]}>{packages}</Text><Text style={s.fUnit}>BOX</Text></View>
            <View style={s.fLine}><Text style={s.lab}>NET WEIGHT 净重:</Text><Text style={[s.val, { marginLeft: 6 }]}>{netWeight}</Text><Text style={s.fUnit}>KG</Text></View>
            <View style={s.fLine}><Text style={s.lab}>GROSS WEIGHT 毛重:</Text><Text style={[s.val, { marginLeft: 6 }]}>{grossWeight}</Text><Text style={s.fUnit}>KG</Text></View>
          </View>
          <View style={s.footRight}>
            <Text style={s.lab}>SHIPPER`S SIGNATURE</Text>
            <Text style={s.lab}>OR COMPANY STAMP</Text>
            <Text style={s.cn}>(托运人签名或公章)</Text>
          </View>
        </View>
      </Page>
    </Document>
  );
}
