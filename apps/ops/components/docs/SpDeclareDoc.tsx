// SP Declare — Surat Pernyataan PDF (PR205). Indonesian customs declaration; no logo, no CJK (plain
// Helvetica). Recipient (KPPBC), the lump-sum reason, and the signing city are constant; the signer's
// identity (name / address / KTP / NPWP / phone) comes from the picked declaration user, and the
// shipment tracking + today's date are filled per document.

import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

export type SpDeclareDocProps = {
  name: string;
  address: string;
  ktp: string;
  npwp: string;
  phone: string;
  tracking: string;
  dateStr: string; // "07 July 2026"
};

const styles = StyleSheet.create({
  page: { paddingVertical: 40, paddingHorizontal: 54, fontFamily: 'Helvetica', fontSize: 10, color: '#000', lineHeight: 1.45 },
  title: { textAlign: 'center', fontSize: 13, fontFamily: 'Helvetica-Bold', marginBottom: 16 },
  recipient: { flexDirection: 'row', marginBottom: 14 },
  rTh: { width: 30, fontFamily: 'Helvetica-Bold' },
  rBody: { fontFamily: 'Helvetica-Bold' },
  para: { marginBottom: 8 },
  idRow: { flexDirection: 'row', marginBottom: 6 },
  idLabel: { width: 180 },
  idColon: { width: 10 },
  idVal: { flexGrow: 1, flexShrink: 1 },
  chkRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 4 },
  chkBox: { width: 9, height: 9, borderWidth: 1, borderColor: '#000', marginRight: 8, marginTop: 1, alignItems: 'center', justifyContent: 'center' },
  chkMark: { fontSize: 7, fontFamily: 'Helvetica-Bold', lineHeight: 1 },
  tracking: { fontFamily: 'Helvetica-Bold', marginBottom: 8 },
  bold: { fontFamily: 'Helvetica-Bold' },
  boldItalic: { fontFamily: 'Helvetica-BoldOblique' },
  sign: { marginTop: 26, alignItems: 'center', width: 220, alignSelf: 'flex-end' },
  signName: { marginTop: 54, textAlign: 'center' },
});

function Chk({ on }: { on?: boolean }) {
  return <View style={styles.chkBox}>{on ? <Text style={styles.chkMark}>X</Text> : null}</View>;
}

function IdRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.idRow}>
      <Text style={styles.idLabel}>{label}</Text>
      <Text style={styles.idColon}>:</Text>
      <Text style={styles.idVal}>{value}</Text>
    </View>
  );
}

export default function SpDeclareDoc({ name, address, ktp, npwp, phone, tracking, dateStr }: SpDeclareDocProps) {
  const hasNpwp = !!npwp.trim();
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>SURAT PERNYATAAN</Text>

        <View style={styles.recipient}>
          <Text style={styles.rTh}>Yth.</Text>
          <View>
            <Text style={styles.rBody}>KPPBC Tipe Madya Pabean C Kantor Pos Pasar Baru</Text>
            <Text style={styles.rBody}>Jl. Lapangan Banteng Utara Gedung Pos Ibukota Lt.3</Text>
            <Text style={styles.rBody}>Jakarta</Text>
          </View>
        </View>

        <Text style={styles.para}>Saya yang bertanda tangan di bawah ini :</Text>

        <IdRow label="Nama" value={name} />
        <IdRow label="Alamat" value={address} />
        <IdRow label="Nomor (KTP/SIM/Pasport/.....)" value={ktp} />
        <IdRow label="No. HP/Email" value={phone} />
        <View style={styles.idRow}>
          <Text style={styles.idLabel}>Mempunyai NPWP</Text>
          <Text style={styles.idColon}>:</Text>
          <View style={styles.idVal}>
            <View style={styles.chkRow}><Chk on={hasNpwp} /><Text>Punya, nomor NPWP : {npwp}................................................</Text></View>
            <View style={styles.chkRow}><Chk on={!hasNpwp} /><Text>Tidak</Text></View>
          </View>
        </View>

        <Text style={[styles.para, { marginTop: 8 }]}>Bertindak sebagai penerima barang kiriman pos Internasional dengan nomor :</Text>
        <Text style={styles.tracking}>{tracking}</Text>
        <Text style={styles.para}>Bersama ini menyatakan bahwa saya tidak dapat melampirkan bukti pendukung berupa bukti bayar ( transfer payment ) dikarenakan :</Text>

        <View style={styles.chkRow}><Chk /><Text>Barang kiriman tersebut adalah hadiah/ gift</Text></View>
        <View style={styles.chkRow}><Chk /><Text>Barang kiriman tersebut adalah free of charge</Text></View>
        <View style={styles.chkRow}><Chk /><Text>Barang kiriman tersebut adalah sampel/ barang contoh</Text></View>
        <View style={styles.chkRow}><Chk on /><Text>Lainnya : PEMBAYARAN BERUPA LUMP SUM................................................</Text></View>

        <Text style={[styles.para, { marginTop: 10 }]}>Dengan ini menyetujui nilai pabean barang kiriman tersebut untuk ditetapkan secara <Text style={styles.boldItalic}>official assesment</Text>.</Text>
        <Text style={styles.para}>Demikian surat pernyataan ini saya sampaikan untuk ditindaklanjuti.</Text>

        <View style={styles.sign}>
          <Text>Balikpapan, {dateStr}</Text>
          <Text>Hormat Saya,</Text>
          <Text style={styles.signName}>( {name} )</Text>
        </View>
      </Page>
    </Document>
  );
}
