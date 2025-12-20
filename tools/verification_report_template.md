```markdown
# Backend Verification Report — Headless War Games

Project: AfroGoBackend v1 (Headless UAT)
Environment: Dev
Date: <YYYY-MM-DD>
Run by: <name>

---

## Summary
- Deployment: (brief note: CloudFormation/Serverless deployed)
- Base URL used: `{{baseUrl}}`
- Postman/Newman run ID: (if applicable)
- Overall result: PASS / FAIL

---

## Scenario 1 — "Township Long-Haul" (Model C validation)
- Inputs:
  - plannedDistanceKm: 180
  - parcelCount: 35
  - modelC formula: Driver Pay = R30 + (0.125 × plannedDistanceKm)
- Expected:
  - perParcelPayout = 52.50
  - totalPayout = 1837.50
- Evidence:
  - API request payload (rate quote): (attach)
  - API response (quote): (attach JSON)
  - CloudWatch logs snippet showing calculation:
    ```
    <paste logs here>
    ```
- SQL / CSV from Aurora (driver_payouts):
  - Export file: `driver_payouts_scenario1.csv`
  - Key rows: (paste or summarize)
- Result: PASS / FAIL
- Notes:

---

## Scenario 2 — "Mileage Padder" (Fraud detection)
- Inputs:
  - plannedDistanceKm: 100
  - driver reported odometerKm: 150
- Expected:
  - variancePct ≈ 50%
  - payout marked ON_HOLD/REVIEW and appears in `/ops/payouts/pending-review`
- Evidence:
  - Route complete request payload: (attach)
  - Ops endpoint response (list): (attach)
  - CloudWatch logs snippet showing variance detection:
    ```
    <paste logs here>
    ```
- SQL Export: `driver_payouts_scenario2.csv`
- Result: PASS / FAIL
- Notes:

---

## Scenario 3 — "Ghost Parcel" (Reconciliation guardrail)
- Inputs:
  - 10 parcels on route; 9 scanned DELIVERED; 1 left ON_ROUTE
- Expected:
  - Finalize payouts call returns error (409/422) indicating UNRECONCILED_INVENTORY
  - No rows inserted into `driver_payouts` or `merchant_ledger` for that route
- Evidence:
  - Finalize request/response (attach)
  - CloudWatch logs snippet showing rejection:
    ```
    <paste logs here>
    ```
  - SQL / CSV: `driver_payouts_scenario3.csv` (should show no finalized payout)
- Result: PASS / FAIL
- Notes:

---

## Exported artifacts (attach or list paths)
- Aurora CSV exports:
  - `driver_payouts_scenario1.csv`
  - `merchant_ledger_scenario1.csv`
  - etc.
- CloudWatch log groups & time window:
  - `/aws/lambda/<function-name>` — time range
- Postman/Newman run output: (attach)

---

## Conclusion & Next Steps
- Recommended status: [Green / Yellow / Red]
- If Green: proceed to UI & Driver App build using locked v1 spec.
- If Yellow/Red: list fixes and re-run verification.

Prepared by: __________________
Reviewed by: __________________
```