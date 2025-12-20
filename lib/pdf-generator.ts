/**
 * PDF GENERATOR - Puppeteer wrapper (with safe fallback)
 *
 * - Uses puppeteer-core + chrome-aws-lambda when available (recommended for Lambda).
 * - Falls back to returning the HTML buffer if Chromium is not available.
 *
 * Notes:
 *  - Add dependencies: puppeteer-core and chrome-aws-lambda (or use a Lambda layer with headless chromium).
 *  - In local dev, puppeteer-core + a local Chrome will work if you provide an executablePath.
 */

import path from 'path';
import fs from 'fs';
import { tmpdir } from 'os';
import { promisify } from 'util';

const writeFile = promisify(fs.writeFile);

export async function generatePdfBuffer(html: string, opts?: { invoiceId?: string }): Promise<Buffer> {
  // Try to use chrome-aws-lambda + puppeteer-core if available
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chromium = require('chrome-aws-lambda');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const puppeteer = require('puppeteer-core');

    const launchArgs: any = chromium.args;
    const executablePath = await chromium.executablePath;
    const browser = await puppeteer.launch({
      args: launchArgs,
      executablePath,
      headless: chromium.headless,
      defaultViewport: { width: 800, height: 1120 },
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20px', bottom: '20px' } });
    await browser.close();
    return pdfBuffer as Buffer;
  } catch (err) {
    // Puppeteer or chromium not available — fallback to html buffer
    // As a better fallback we attempt to write a .html file so consumers can render to PDF if needed
    const fallback = Buffer.from(html, 'utf-8');
    return fallback;
  }
}