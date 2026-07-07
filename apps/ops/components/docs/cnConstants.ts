// Constants + shared derivations for the China customs docs (PR204). The shipper/consignee/forwarder
// blocks are editable presets seeded from these defaults (persisted presets can come later). Weight
// roll-ups are shared so the CN Invoice + CN Shipping agree with the CN Packing List.

import type { CnBox } from '@/app/doc-generator/types';

const r2 = (n: number) => Math.round(n * 100) / 100;

// Packages / net (Σ volumetric) / gross (Σ real) / chargeable (max) — from the shared package rows.
export function cnWeights(boxes: CnBox[], divisor: number) {
  const parsed = boxes.filter((b) => b.p || b.l || b.t || b.realWeight);
  const vol = (b: CnBox) => r2((Number(b.p) || 0) * (Number(b.l) || 0) * (Number(b.t) || 0) / divisor);
  const netWeight = r2(parsed.reduce((s, b) => s + vol(b), 0));
  const grossWeight = r2(parsed.reduce((s, b) => s + (Number(b.realWeight) || 0), 0));
  return { packages: parsed.length, netWeight, grossWeight, chargeWeight: Math.max(grossWeight, netWeight) };
}

// forwarder prefix from a ship_id ("SUB 191" → "SUB") — used as Dest/Origin on the shipping note.
export function shipPrefix(shipId: string): string {
  return (shipId.match(/^[A-Za-z]+/) || [''])[0];
}

// CN Invoice shipper (China origin) + consignee (Indonesia importer) preset addresses.
export const CN_SHIPPER_DEFAULT =
  '广东省惠州惠城区水口街道东江高新科技产业园兴运东路1号鼎晟盛威智慧科技园3栋4楼';
export const CN_CONSIGNEE_DEFAULT =
  'Andrio Suroyo\nGrand City cluster Pineville L3/28, Kel. Graha Indah, Kec. Balikpapan Utara, Kota Balikpapan 76126\n0812-6000-2889';

// CN Shipping letterhead — the forwarder's own fixed identity (traditional Chinese).
export const ORIENTAL = {
  en: 'GUANGDONG ORIENTAL UNION LOGISTICS SERVICES LTD',
  cn: '廣東東聯運物流有限公司',
  addr: '廣州市白雲區機場路585號鵬景大廈902室',
  tel: 'Tel:(86) 3631 9288',
  fax: 'Fax:(86) 3631 9688',
  logo: '東',
  footer1: 'For and on behalf of',
  footer2: 'Oriental Union Logistics Services Ltd.',
};
