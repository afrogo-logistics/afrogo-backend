```markdown
# AfroGo Headless War Games — Dev Tooling

This folder contains the artifacts to run the "Headless War Games" UAT for AfroGoBackend v1.

Files:
- `openapi.yaml` - OpenAPI v3 skeleton for v1 APIs (root of repo).
- `tools/postman/AfroGo_Backend_v1.postman_collection.json` - Postman collection including War Games tests.
- `tools/postman/afrogo-dev.postman_environment.json` - Postman / Newman environment (dev).
- `package.json` snippet (see below) to run Newman locally via `npm run test:headless-wargames`.
- `verification_report_template.md` - Template to capture results for CEO/CFO.

How to use
1. Import the Postman collection:
   - In Postman: File → Import → choose `tools/postman/AfroGo_Backend_v1.postman_collection.json`.
   - Import the environment: File → Import → choose `tools/postman/afrogo-dev.postman_environment.json`.
   - Set `{{baseUrl}}` to your deployed API Gateway URL if different.

2. Run War Games manually:
   - Use Postman Runner to run the collection, or run the specific requests in order:
     - Create merchant → Create parcels → Generate routes → Quote route (Model C) → Accept route → Scan parcels → Complete route → Finalize payouts → Generate invoice → Simulate payment webhook → Reconcile pending.

3. Automated CLI (Newman)
   - Install newman:
     ```
     npm install --save-dev newman
     ```
   - Add script to your root `package.json`:
     ```json
     {
       "scripts": {
         "test:headless-wargames": "newman run tools/postman/AfroGo_Backend_v1.postman_collection.json -e tools/postman/afrogo-dev.postman_environment.json --reporters cli"
       }
     }
     ```
   - Run:
     ```
     npm run test:headless-wargames
     ```

4. Running the three War Games scenarios (assertions included)
   - Scenario 1 (Model C math) is asserted in `Quote Route (ModelC) - War Games Test`.
   - Scenario 2 (Mileage Padder) requires completing route with padded odometer and then running `ListPendingPayouts` to assert flagged payout.
   - Scenario 3 (Ghost Parcel) uses `Finalize Payouts for ServiceDate` to assert an error when unreconciled inventory exists.

Tips
- For payment webhook HMAC tests, you can add a Postman pre-request script to compute HMAC with your webhook secret and set `payload.signature`.
- For bulk parcel creation, use Postman Runner with iterations and a CSV/JSON data file.

Deliverables checklist
- [ ] Import the collection & environment into Postman.
- [ ] Deploy backend to dev and set `baseUrl`.
- [ ] Run Headless War Games via Newman or Postman Runner.
- [ ] Export SQL/CSV from Aurora and Merchant ledger for CFO verification.
- [ ] Fill `verification_report_template.md` and share with CEO/CFO.

If you want, I can also:
- Convert the collection into Newman CI job (GitHub Actions).
- Add pre-request HMAC generation scripts.
- Produce a Newman run that outputs JUnit/HTML test reports for CI.
```