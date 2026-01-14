```markdown
# Env & Config (tiny)

This file lists the minimal env vars required for local runs and AWS Dev stage.

Place a copy of `.env.example` at the project root as `.env` for local/testing.

Minimum required for the War Games runs (dev):
- REGION / AWS_REGION
- API_BASE_URL + API_VERSION (lock your Gateway to `{{API_BASE_URL}}{{API_VERSION}}`, e.g. https://api-dev.afrogo.co.za/v1)
- INVOICES_TABLE_NAME
- PG_SECRET_ARN (Secrets Manager ARN with Postgres connection JSON)
- PAYMENT_PROVIDER_POLL_SECRET_ARN (for reconcile job)
- INVOICES_BUCKET
- SES_SOURCE_EMAIL
- AUDIT_TABLE_NAME
- OPTIONAL: AUTH_TOKEN (if your API is secured for UAT)

API version lock:
- Ensure API Gateway stage or mapping uses a fixed path prefix `/v1`.
- Do NOT redeploy v1 endpoints under new base paths; create v2 if/when you change contracts.
```# CI Fixes Applied

