// Minimal PDF generator fallback used by tests. Produces a Buffer from HTML.
export async function generatePdfBuffer(html: string): Promise<Buffer> {
  // In production this would call a headless chrome / wkhtmltopdf / external service.
  // For tests we simply return the HTML as a UTF-8 buffer so expectations can inspect it.
  return Buffer.from(String(html || ''), 'utf-8');
}

export default generatePdfBuffer;
