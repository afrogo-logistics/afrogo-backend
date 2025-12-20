# Integration Test Checklist - Billing Service

These tests require AWS resources (DynamoDB, S3, SES sandbox/verified address). Run in an isolated test account or use localstack.

1. Setup:
   - Deploy DynamoDB table `INVOICES_TABLE` with GSI `StatusIndex` (partition: status, sort: createdAt)
   - Create S3 bucket `INVOICES_BUCKET`
   - Ensure SES source email verified
   - Provide PG_SECRET_ARN pointing to a test Postgres instance with table `merchant_ledger` (idempotent key: invoice_id)

2. Test scenarios:
   - generateInvoice: POST to /generateInvoice -> 201, S3 object exists, Dynamo item exists
   - getInvoice: GET /invoice/:invoiceId -> returns metadata and s3Key
   - paymentWebhook: POST webhook with signed payload -> updates invoice to PAID and writes merchant_ledger row
   - reconcilePendingPayments: ensure query on StatusIndex returns pending invoices

3. Teardown:
   - Remove S3 objects and Dynamo test items

Note: Use test harness or infra automation to run these steps automatically.