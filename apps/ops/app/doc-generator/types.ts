// Shared UI types for the Doc Generator (PR202). Phase 1 covers the IDR + USD invoices; the CN docs
// and SP Declare land in later phases.

export type InvoiceCustomerRow = { id: number; name: string | null; phone: string | null };

export type InvoiceAddress = {
  addressId: number;
  label: string | null;
  recipientName: string | null;
  contactPhone: string | null;
  rawAddress: string | null;
};

export type InvoiceLine = {
  lineId: number;
  orderId: string; // sales_id
  itemCode: string; // item_code_raw (as shown to the customer)
  name: string; // resolved catalogue name
  qty: number;
  imageUrl: string | null; // resolved sku-images CDN url, or null (blank cell)
};

export type InvoiceOrder = {
  orderId: string; // sales_id
  orderDate: string | null;
  lines: InvoiceLine[];
};

export type InvoiceCustomerData = {
  customerId: number;
  name: string | null;
  phone: string | null;
  addresses: InvoiceAddress[];
  orders: InvoiceOrder[];
};
