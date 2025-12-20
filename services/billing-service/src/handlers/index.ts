// Lightweight handler helpers used by unit tests.
export function calcTotal(items: Array<{ qty: number; unitPrice: number }>): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce((s, it) => s + (Number(it.qty || 0) * Number(it.unitPrice || 0)), 0);
}

export function renderInvoiceHtml(invoice: any): string {
  const total = (invoice && invoice.totalAmount) || calcTotal(invoice?.items || []);
  return `<!doctype html><html><body><h1>Invoice ${invoice?.invoiceId || ''}</h1><div>Total: ${Number(total).toFixed(2)}</div></body></html>`;
}

export default {
  calcTotal,
  renderInvoiceHtml,
};
