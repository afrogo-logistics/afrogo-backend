export function toNumber(val: number | string): number {
  if (typeof val === 'number') return val;
  const n = Number(val);
  if (Number.isNaN(n)) throw new Error('Invalid number');
  return n;
}

export function roundToCents(n: number): number {
  return Math.round(n * 100) / 100;
}

export function normalizeMoney(amount: number | string): number {
  const n = toNumber(amount);
  if (n < 0) throw new Error('Amount must not be negative');
  return roundToCents(n);
}

export function computeInvoiceTotal(items: Array<{ amount: number | string }> = []): number {
  const total = items.reduce((acc, it) => acc + normalizeMoney(it.amount), 0);
  return roundToCents(total);
}
