// CN Shipping PDF (PR204) — the forwarder's own debit note (Guangdong Oriental Union Logistics
// letterhead, constant), no Jigzle logo. Freight = rate/kg × chargeable weight; customs = fee/box ×
// packages; total in RMB. PCS/GW correlate with the CN Packing List.

import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { ensureCjkFont, CJK } from './cjkFont';
import { ORIENTAL } from './cnConstants';

export type CnShippingDocProps = {
  messers: string;
  debitNo: string;
  dateStr: string;
  destOrigin: string;
  hawb: string;
  packages: number;
  grossWeight: number;
  volumeWeight: number;
  chargeWeight: number;
  ratePerKg: number;
  feePerBox: number;
};

const B = '#000';
const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const s = StyleSheet.create({
  page: { paddingVertical: 26, paddingHorizontal: 34, fontFamily: CJK, fontSize: 9, color: '#000' },

  head: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 4 },
  logo: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#c0281f', alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  logoTxt: { color: '#fff', fontSize: 18 },
  coEn: { fontSize: 11, fontWeight: 700 },
  coCn: { fontSize: 12, fontWeight: 700 },
  coAddr: { fontSize: 8.5 },
  coTel: { fontSize: 8.5 },

  invTitle: { textAlign: 'center', fontSize: 13, fontWeight: 700, marginVertical: 4 },

  topRow: { flexDirection: 'row' },
  messersBox: { width: '52%', borderWidth: 1, borderColor: B, minHeight: 78, padding: 5 },
  metaBox: { flexGrow: 1, padding: 5 },
  metaLine: { flexDirection: 'row', marginBottom: 3, fontSize: 8.5 },
  metaLab: { width: 92, fontStyle: 'italic' },

  descHead: { borderWidth: 1, borderColor: B, textAlign: 'center', paddingVertical: 2, fontWeight: 700, marginTop: 6 },
  descGrid: { borderWidth: 1, borderTopWidth: 0, borderColor: B, flexDirection: 'row', padding: 6 },
  descCol: { width: '50%' },
  dLine: { flexDirection: 'row', marginBottom: 3, fontSize: 8.5 },
  dLab: { width: 84, fontStyle: 'italic' },

  partHead: { flexDirection: 'row', borderWidth: 1, borderTopWidth: 0, borderColor: B, fontWeight: 700 },
  partRow: { flexDirection: 'row', borderBottomWidth: 1, borderColor: B, minHeight: 16 },
  pPart: { flexGrow: 1, borderRightWidth: 1, borderColor: B, paddingHorizontal: 4, paddingVertical: 2 },
  pCur: { width: 44, borderRightWidth: 1, borderColor: B, paddingHorizontal: 4, paddingVertical: 2, textAlign: 'center' },
  pAmt: { width: 96, paddingHorizontal: 4, paddingVertical: 2, textAlign: 'right' },
  partWrap: { borderWidth: 1, borderTopWidth: 0, borderColor: B },

  totalRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8, alignItems: 'center' },
  totalLab: { fontSize: 9, fontStyle: 'italic', marginRight: 8 },
  totalVal: { width: 96, borderWidth: 1, borderColor: B, textAlign: 'right', paddingHorizontal: 4, paddingVertical: 3, fontWeight: 700 },

  footer: { marginTop: 40, alignItems: 'flex-end' },
  footItalic: { fontSize: 8.5, fontStyle: 'italic', color: '#1f3b8c' },
  sigLine: { width: 150, borderTopWidth: 1, borderColor: B, marginTop: 30, paddingTop: 2, textAlign: 'center', fontSize: 8, fontStyle: 'italic', color: '#1f3b8c' },
});

function D({ lab, val }: { lab: string; val: string }) {
  return <View style={s.dLine}><Text style={s.dLab}>{lab}</Text><Text>: {val}</Text></View>;
}

export default function CnShippingDoc({ messers, debitNo, dateStr, destOrigin, hawb, packages, grossWeight, volumeWeight, chargeWeight, ratePerKg, feePerBox }: CnShippingDocProps) {
  ensureCjkFont();
  const freight = r2((Number(ratePerKg) || 0) * (Number(chargeWeight) || 0));
  const customs = r2((Number(feePerBox) || 0) * (Number(packages) || 0));
  const total = r2(freight + customs);
  return (
    <Document>
      <Page size="A4" style={s.page}>
        {/* letterhead */}
        <View style={s.head}>
          <View style={s.logo}><Text style={s.logoTxt}>{ORIENTAL.logo}</Text></View>
          <View>
            <Text style={s.coEn}>{ORIENTAL.en}</Text>
            <Text style={s.coCn}>{ORIENTAL.cn}</Text>
            <Text style={s.coAddr}>{ORIENTAL.addr}</Text>
            <Text style={s.coTel}>{ORIENTAL.tel}      {ORIENTAL.fax}</Text>
          </View>
        </View>

        <Text style={s.invTitle}>INVOICE</Text>

        {/* messers + debit-note meta */}
        <View style={s.topRow}>
          <View style={s.messersBox}>
            <View style={{ flexDirection: 'row' }}><Text style={{ fontStyle: 'italic' }}>Messers</Text><Text> : {messers}</Text></View>
            <View style={{ marginTop: 'auto' }}>
              <Text style={{ fontStyle: 'italic', fontSize: 8.5 }}>ATTN :</Text>
              <Text style={{ fontStyle: 'italic', fontSize: 8.5 }}>TEL :</Text>
            </View>
          </View>
          <View style={s.metaBox}>
            <View style={s.metaLine}><Text style={s.metaLab}>DEBIT NOTE NO</Text><Text>: {debitNo}</Text></View>
            <View style={s.metaLine}><Text style={s.metaLab}>DATE</Text><Text>: {dateStr}</Text></View>
            <View style={s.metaLine}><Text style={s.metaLab}>SALESMAN</Text><Text>:</Text></View>
            <View style={s.metaLine}><Text style={s.metaLab}>PREPARED BY</Text><Text>:</Text></View>
          </View>
        </View>

        {/* description */}
        <Text style={s.descHead}>DESCRIPTION</Text>
        <View style={s.descGrid}>
          <View style={s.descCol}>
            <D lab="Job No" val="" />
            <D lab="MAWB No" val="" />
            <D lab="HAWB No" val={hawb} />
            <D lab="Flight No" val="" />
          </View>
          <View style={s.descCol}>
            <D lab="Dest/Origin" val={destOrigin} />
            <View style={s.dLine}><Text style={s.dLab}>PCS/G.W.</Text><Text>: {packages}件/{grossWeight} Kg</Text></View>
            <View style={s.dLine}><Text style={s.dLab}>Volume Weight</Text><Text>: {volumeWeight} Kg</Text></View>
            <View style={s.dLine}><Text style={s.dLab}>Charge Weight</Text><Text>: {chargeWeight} Kg</Text></View>
          </View>
        </View>

        {/* particulars */}
        <View style={[s.partHead, { marginTop: 8 }]}>
          <Text style={[s.pPart, { textAlign: 'center', fontStyle: 'italic' }]}>Particulars</Text>
          <Text style={[s.pCur, { fontStyle: 'italic' }]}>Cur.</Text>
          <Text style={[s.pAmt, { textAlign: 'center', fontStyle: 'italic' }]}>Amount</Text>
        </View>
        <View style={s.partWrap}>
          <View style={s.partRow}>
            <Text style={s.pPart}>运费   {ratePerKg ? `${r2(ratePerKg)} / KG` : ''}</Text>
            <Text style={s.pCur}>RMB</Text>
            <Text style={s.pAmt}>{freight ? money(freight) : ''}</Text>
          </View>
          <View style={s.partRow}>
            <Text style={s.pPart}>报关费   {feePerBox ? r2(feePerBox) : ''}</Text>
            <Text style={s.pCur}>RMB</Text>
            <Text style={s.pAmt}>{customs ? money(customs) : ''}</Text>
          </View>
          {[0, 1, 2].map((i) => (
            <View key={i} style={[s.partRow, ...(i === 2 ? [{ borderBottomWidth: 0 }] : [])]}>
              <Text style={s.pPart}> </Text><Text style={s.pCur}> </Text><Text style={s.pAmt}> </Text>
            </View>
          ))}
        </View>

        <View style={s.totalRow}>
          <Text style={s.totalLab}>Total Amount (RMB)</Text>
          <Text style={s.totalVal}>{money(total)}</Text>
        </View>

        <View style={s.footer}>
          <Text style={s.footItalic}>{ORIENTAL.footer1}</Text>
          <Text style={s.footItalic}>{ORIENTAL.footer2}</Text>
          <Text style={s.sigLine}>Authorised Signature</Text>
        </View>
      </Page>
    </Document>
  );
}
