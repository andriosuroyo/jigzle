// The IDR / USD invoice PDF (PR202). Same layout for both; only the currency formatting + number
// prefix differ. Mirrors the sheet template: Jigzle letterhead, Send-to / Bill-to blocks, an item
// table (image · code · description · qty · unit price · amount), and a status / subtotal footer.

import { Document, Page, Text, View, Image, StyleSheet } from '@react-pdf/renderer';
import { JIGZLE, fmtMoney, type Currency } from './pdfUtil';

export type InvoiceParty = { recipient: string; address: string; phone: string; email: string };
export type InvoiceItem = { imageDataUrl: string | null; itemCode: string; name: string; qty: number; unitPrice: number };

export type InvoiceDocProps = {
  currency: Currency;
  invoiceNumber: string;
  dateStr: string;
  sendTo: InvoiceParty;
  billTo: InvoiceParty;
  items: InvoiceItem[];
  paymentStatus: string;
  paymentDetails: string;
  dpAmount?: number | null; // PR361 — when status is "Downpayment", the amount paid (display currency)
  logoDataUrl: string | null;
};

const GREY = '#ececeb';
const GREY2 = '#f5f5f4';
const LINE = '#d8d8d6';

const s = StyleSheet.create({
  page: { paddingTop: 28, paddingBottom: 36, paddingHorizontal: 30, fontSize: 8.5, fontFamily: 'Helvetica', color: '#111' },

  // ── letterhead ──
  headBand: { flexDirection: 'row', backgroundColor: GREY2, padding: 12, alignItems: 'flex-start' },
  logo: { width: 54, height: 54, marginRight: 10 },
  brandName: { fontSize: 20, fontFamily: 'Helvetica-Bold', letterSpacing: 1 },
  tagline: { fontSize: 9, marginLeft: 6, marginTop: 8, color: '#333' },
  addr: { fontSize: 8, color: '#333', marginTop: 1 },
  headRight: { marginLeft: 'auto', alignItems: 'flex-end' },
  invTitle: { fontSize: 18, fontFamily: 'Helvetica-Bold', marginBottom: 6 },
  metaRow: { fontSize: 8.5 },
  metaLabel: { fontFamily: 'Helvetica-Bold' },

  // ── client info ──
  clientBand: { backgroundColor: GREY, paddingHorizontal: 12, paddingVertical: 10, marginTop: 2 },
  bandLabel: { fontSize: 8, fontFamily: 'Helvetica-Bold', letterSpacing: 0.5, marginBottom: 6 },
  twoCol: { flexDirection: 'row' },
  col: { width: '50%', paddingRight: 12 },
  toLabel: { fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: '#555', marginBottom: 3, borderBottomWidth: 1, borderBottomColor: LINE, paddingBottom: 2 },
  party: { fontSize: 8, lineHeight: 1.35 },

  // ── item table ──
  section: { marginTop: 14 },
  tHead: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#888', paddingBottom: 3, marginBottom: 2 },
  th: { fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: '#444' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: '#efefef' },
  rowAlt: { backgroundColor: GREY2 },
  cImg: { width: 40, paddingRight: 4 },
  thumb: { width: 34, height: 34, objectFit: 'contain' },
  cCode: { width: 92, paddingRight: 4 },
  cDesc: { flexGrow: 1, flexShrink: 1, paddingRight: 4 },
  cQty: { width: 28, textAlign: 'right', paddingRight: 6 },
  cUnit: { width: 66, textAlign: 'right', paddingRight: 6 },
  cAmt: { width: 66, textAlign: 'right' },
  cell: { fontSize: 8 },

  // ── footer ──
  footer: { flexDirection: 'row', marginTop: 16, borderTopWidth: 1, borderTopColor: '#888', paddingTop: 8 },
  fCol: { flexGrow: 1, flexShrink: 1, paddingRight: 12 },
  fLabel: { fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: '#444', marginBottom: 3 },
  fVal: { fontSize: 8.5, lineHeight: 1.4 },
  subCol: { width: 165 },
  subRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  subLabel: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#444' },
  subVal: { fontSize: 12, fontFamily: 'Helvetica-Bold' },
  dpLabel: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#777' },
  dpVal: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: '#777' },
});

function Party({ label, p }: { label: string; p: InvoiceParty }) {
  return (
    <View style={s.col}>
      <Text style={s.toLabel}>{label}</Text>
      <View style={s.party}>
        {p.recipient ? <Text>{p.recipient}</Text> : null}
        {p.address ? <Text>{p.address}</Text> : null}
        {p.phone ? <Text>{p.phone}</Text> : null}
        {p.email ? <Text>{p.email}</Text> : null}
      </View>
    </View>
  );
}

export default function InvoiceDoc({ currency, invoiceNumber, dateStr, sendTo, billTo, items, paymentStatus, paymentDetails, dpAmount, logoDataUrl }: InvoiceDocProps) {
  const subtotal = items.reduce((sum, it) => sum + (Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 0);
  const dp = Number(dpAmount) || 0;
  const showDp = dp > 0;
  const balance = subtotal - dp;
  return (
    <Document>
      <Page size="A4" style={s.page}>
        {/* letterhead */}
        <View style={s.headBand}>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          {logoDataUrl ? <Image src={logoDataUrl} style={s.logo} /> : <View style={s.logo} />}
          <View>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
              <Text style={s.brandName}>{JIGZLE.name}</Text>
              <Text style={s.tagline}>{JIGZLE.tagline}</Text>
            </View>
            {JIGZLE.address.map((l, i) => <Text key={i} style={s.addr}>{l}</Text>)}
          </View>
          <View style={s.headRight}>
            <Text style={s.invTitle}>INVOICE</Text>
            <Text style={s.metaRow}><Text style={s.metaLabel}>Number: </Text>{invoiceNumber}</Text>
            <Text style={s.metaRow}><Text style={s.metaLabel}>Date: </Text>{dateStr}</Text>
          </View>
        </View>

        {/* client info */}
        <View style={s.clientBand}>
          <Text style={s.bandLabel}>CLIENT INFO</Text>
          <View style={s.twoCol}>
            <Party label="SEND TO:" p={sendTo} />
            <Party label="BILL TO:" p={billTo} />
          </View>
        </View>

        {/* items */}
        <View style={s.section}>
          <Text style={s.bandLabel}>ORDER INFO</Text>
          <View style={s.tHead}>
            <Text style={[s.th, s.cImg]}>IMAGE</Text>
            <Text style={[s.th, s.cCode]}>ITEM CODE</Text>
            <Text style={[s.th, s.cDesc]}>ITEM DESCRIPTION</Text>
            <Text style={[s.th, s.cQty]}>QTY</Text>
            <Text style={[s.th, s.cUnit]}>UNIT PRICE</Text>
            <Text style={[s.th, s.cAmt]}>AMOUNT</Text>
          </View>
          {items.map((it, i) => (
            <View key={i} style={[s.row, ...(i % 2 ? [s.rowAlt] : [])]} wrap={false}>
              <View style={s.cImg}>
                {/* eslint-disable-next-line jsx-a11y/alt-text */}
                {it.imageDataUrl ? <Image src={it.imageDataUrl} style={s.thumb} /> : null}
              </View>
              <Text style={[s.cell, s.cCode]}>{it.itemCode}</Text>
              <Text style={[s.cell, s.cDesc]}>{it.name}</Text>
              <Text style={[s.cell, s.cQty]}>{it.qty}</Text>
              <Text style={[s.cell, s.cUnit]}>{fmtMoney(currency, it.unitPrice)}</Text>
              <Text style={[s.cell, s.cAmt]}>{fmtMoney(currency, (Number(it.qty) || 0) * (Number(it.unitPrice) || 0))}</Text>
            </View>
          ))}
        </View>

        {/* footer: (notes column ignored) status · payment details · subtotal */}
        <View style={s.footer}>
          <View style={s.fCol}>
            <Text style={s.fLabel}>STATUS</Text>
            <Text style={s.fVal}>{paymentStatus ? paymentStatus.toUpperCase() : '—'}</Text>
            {paymentDetails ? (
              <>
                <Text style={[s.fLabel, { marginTop: 6 }]}>PAYMENT DETAILS</Text>
                <Text style={s.fVal}>{paymentDetails}</Text>
              </>
            ) : null}
          </View>
          <View style={s.subCol}>
            <View style={{ width: '100%' }}>
              <View style={s.subRow}>
                <Text style={s.subLabel}>SUBTOTAL</Text>
                <Text style={s.subVal}>{fmtMoney(currency, subtotal)}</Text>
              </View>
              {showDp ? (
                <>
                  <View style={[s.subRow, { marginTop: 4 }]}>
                    <Text style={s.dpLabel}>DP PAID</Text>
                    <Text style={s.dpVal}>{fmtMoney(currency, dp)}</Text>
                  </View>
                  <View style={[s.subRow, { marginTop: 2 }]}>
                    <Text style={s.subLabel}>BALANCE DUE</Text>
                    <Text style={s.subVal}>{fmtMoney(currency, balance)}</Text>
                  </View>
                </>
              ) : null}
            </View>
          </View>
        </View>
      </Page>
    </Document>
  );
}
