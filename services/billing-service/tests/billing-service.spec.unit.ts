/**
 * Unit tests for billing service helpers
 *
 * - calcTotal
 * - HTML generation (basic)
 * - render fallback behavior of pdf-generator (mocked)
 *
 * Uses Jest (add to package.json test script: "jest")
 */

import { calcTotal } from '../src/handlers/index'; // adjust exports if needed
import { renderInvoiceHtml } from '../src/handlers/index';
import { generatePdfBuffer } from '../src/lib/pdf-generator';

describe('Billing helpers', () => {
  test('calcTotal sums items correctly', () => {
    const items = [
      { description: 'A', qty: 2, unitPrice: 10 },
      { description: 'B', qty: 1, unitPrice: 5.5 },
    ];
    expect(calcTotal(items)).toBe(25.5);
  });

  test('renderInvoiceHtml contains invoice id and total', () => {
    const inv: any = {
      invoiceId: 'INVOICE#1',
      merchantId: 'M1',
      customerName: 'Alice',
      items: [{ description: 'X', qty: 1, unitPrice: 10 }],
      totalAmount: 10,
      currency: 'ZAR',
      createdAt: new Date().toISOString(),
    };
    const html = renderInvoiceHtml(inv);
    expect(html).toContain('INVOICE#1');
    expect(html).toContain('10.00');
  });

  test('generatePdfBuffer fallback returns buffer for simple HTML', async () => {
    const html = '<html><body><h1>Test</h1></body></html>';
    const buf = await generatePdfBuffer(html, { invoiceId: 'INVOICE#1' });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString('utf-8')).toContain('<h1>Test</h1>');
  });
});