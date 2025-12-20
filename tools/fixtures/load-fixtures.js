/**
 * Simple CLI fixture loader for headless UAT
 *
 * Usage:
 *   - copy .env.example -> .env and fill API_BASE_URL (/no trailing slash), AUTH_TOKEN (if required)
 *   - npm install node-fetch dotenv   (if running on Node <18)
 *   - node tools/load-fixtures.js
 *
 * This script:
 *  - creates the sample merchant (id MERCHANT_UAT_1 is inserted by SQL seed but we call POST for idempotency)
 *  - posts the parcels from tools/fixtures/parcels.json to the API
 */

import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const base = (process.env.API_BASE_URL || 'http://localhost:3000') + (process.env.API_VERSION || '/v1');
const authToken = process.env.AUTH_TOKEN || '';

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  console.log(url, '->', res.status);
  return { status: res.status, body: json };
}

async function run() {
  console.log('Base URL:', base);

  // Create merchant (idempotent if API is designed to upsert or returns existing)
  const merchant = {
    id: 'MERCHANT_UAT_1',
    name: 'TestMerchant - Soweto',
    legalName: 'TestMerchantPtyLtd',
  contactEmail: 'ops+merchant1@afrogo.co.za',
    contactPhone: '+27821234567',
    payoutBankAccount: { bank: 'FNB', accountNumber: '123456789', branchCode: '250655' },
    defaultPickupAddress: { line1: '123 Vilakazi St', city: 'Soweto', province: 'Gauteng', postalCode: '1804' },
    metadata: { onboardingSource: 'internal_uat' }
  };

  try {
    await postJson(`${base}/merchants`, merchant);
  } catch (e) {
    console.error('Failed to create merchant:', String(e));
  }

  // Load parcels fixture
  const fixturesPath = path.resolve('./tools/fixtures/parcels.json');
  const raw = fs.readFileSync(fixturesPath, 'utf8');
  const parcels = JSON.parse(raw);

  for (const p of parcels) {
    try {
      const res = await postJson(`${base}/parcels`, p);
      console.log('Created parcel', (res.body && (res.body.parcelId || res.body.id)) || 'unknown id');
    } catch (e) {
      console.error('Error creating parcel:', e);
    }
  }

  console.log('Fixtures load complete.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});