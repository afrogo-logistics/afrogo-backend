import fs from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

export async function generatePdf(content: string, _opts?: { invoiceId?: string }): Promise<Buffer> {
  // _opts parameter kept for backward compatibility but not used in this minimal implementation
  const dir = tmpdir();
  const tmpPath = path.join(dir, `afrogo-pdf-${Date.now()}.html`);
  await fs.writeFile(tmpPath, content, 'utf8');
  const buf = await fs.readFile(tmpPath);
  try {
    await fs.unlink(tmpPath);
  } catch {
    // ignore cleanup errors
  }
  return buf;
}

// Alias for compatibility with existing code
export const generatePdfBuffer = generatePdf;