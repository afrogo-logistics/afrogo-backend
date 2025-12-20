export interface MerchantLedgerRow {
    ledgerId: string;
    merchantId: string;
    month: string;
    revenue: number;
    cost: number;
    margin: number;
    updatedAt: string | Date;
}
export interface InvoiceItem {
    id: string;
    description: string;
    amount: number;
}
export interface InvoiceRecord {
    invoiceId: string;
    merchantId: string;
    createdAt?: string | Date;
    dueDate?: string;
    status?: string;
    currency?: string;
    total?: number;
    items?: InvoiceItem[];
}
//# sourceMappingURL=billing.d.ts.map