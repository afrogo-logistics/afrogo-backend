afrogo-backend/
├─ services/
│  ├─ rate-engine/
│  │  ├─ src/
│  │  │  ├─ engine-domain.ts
│  │  │  ├─ engine-modelc.ts
│  │  │  ├─ lambda-quote-handler.ts
│  │  │  │   → HTTP in: /rate-engine/quote
│  │  │  │   → Uses payout model (Model C) & guardrails
│  │  │  │   → No direct DB (pure compute) – returns quote JSON
│  │  │  ├─ lambda-finalize-handler.ts
│  │  │  │   → HTTP/Event in: route completion
│  │  │  │   → Aurora: driver_payouts (INSERT/UPDATE)
│  │  │  │   → May emit events to Ops/Routing (depending on your impl)
│  │  │  ├─ routing-rate-engine-integration.txt
│  │  │  └─ RATE_ENGINE_RFC_V1_Version2.txt
│  │
│  ├─ routing-service/
│  │  └─ src/
│  │     ├─ generate-routes.ts
│  │     │   → HTTP in: /routing/routes/batch-generate
│  │     │   → DynamoDB: Routes (ROUTES_TABLE_NAME, default "Routes")
│  │     │   → SQS: OPS_REVIEW_QUEUE_URL (Ops review queue for rejected routes)
│  │     │   → CloudWatch: AfroGo/Routing metrics
│  │     │   → HTTP out: Rate Engine (RATE_ENGINE_API_URL) via rate-engine-client-hardened
│  │     ├─ route-engine-finalize.ts
│  │     │   → Event/HTTP in: route finalization trigger
│  │     │   → DynamoDB: Routes (update actuals, status, payoutSnapshot linkage)
│  │     └─ routes-dynamo-schema.txt
│  │
│  ├─ parcel-service/
│  │  └─ src/
│  │     └─ parcel-service-complete.ts
│  │         → HTTP in: /parcels/*
│  │         → DynamoDB: Parcels table (as defined inside file)
│  │         → May publish:
│  │            - Events to SQS / EventBridge (e.g. PARCEL_CREATED, OUT_FOR_DELIVERY)
│  │            - Inputs to Notification Service (via queue or HTTP)
│  │
│  ├─ merchant-service/
│  │  └─ src/
│  │     └─ merchant-service-complete.ts
│  │         → HTTP in: /merchants/*
│  │         → DynamoDB: Merchants / MerchantConfig tables
│  │         → Possibly Aurora: merchant_ledger read side (for merchant balances)
│  │
│  ├─ driver-service/
│  │  └─ src/
│  │     ├─ driver-service-complete.ts
│  │     │   → HTTP in: /drivers/*
│  │     │   → DynamoDB: Drivers table (profiles, status, documents, zones)
│  │     ├─ driver-earnings-history-api.ts
│  │     │   → HTTP in: /drivers/{id}/earnings
│  │     │   → Aurora: driver_payouts (history, totals)
│  │     ├─ finalize-payout-handler-hardened.ts
│  │     │   → Event in: route completion / nightly job
│  │     │   → Aurora: driver_payouts (finalization, marking PAID/FINAL)
│  │     └─ driver-payouts-schema.txt
│  │
│  ├─ notification-service/
│  │  └─ src/
│  │     ├─ notification-service-complete.ts
│  │     │   → SQS in: Notifications queue
│  │     │   → DynamoDB: NOTIFICATIONS_TABLE_NAME (default "Notifications")
│  │     │       - In-app notifications
│  │     │       - Idempotency markers (NOTIF_MARKER#...)
│  │     │   → SES: outbound email (SES_SOURCE_EMAIL)
│  │     │   → SNS: outbound SMS
│  │     │   → FCM / EXTERNAL_PUSH_ENDPOINT: push notifications
│  │     │   → Secrets Manager: FCM_SECRET_ARN
│  │     └─ notification-service-handler.ts (earlier version / entry point)
│  │
│  ├─ billing-service/
│  │  └─ src/
│  │     ├─ billing-service-complete.ts            # façade if you keep one
│  │     ├─ billing-service-handlers.ts            # ✅ latest with ledger + reconcile
│  │     │   → generateInvoice (HTTP)
│  │     │      - DynamoDB: Invoices (INVOICES_TABLE_NAME)
│  │     │      - S3: INVOICES_BUCKET (store HTML-as-PDF)
│  │     │      - SES: invoice email with S3 link
│  │     │   → getInvoice (HTTP)
│  │     │      - DynamoDB: Invoices (read)
│  │     │      - Returns bucket + key for presign
│  │     │   → paymentWebhook (HTTP)
│  │     │      - DynamoDB: Invoices (GetItem + UpdateItem)
│  │     │      - Aurora: merchant_ledger via upsertMerchantLedger()
│  │     │      - Secrets Manager: PAYMENT_PROVIDER_SECRET_ARN (webhook secrets)
│  │     │      - External: Payment provider webhook (MPesa/gateway)
│  │     │   → reconcilePendingPayments (HTTP/scheduled)
│  │     │      - DynamoDB: Invoices (Scan PENDING)
│  │     │      - Secrets Manager: PAYMENT_PROVIDER_POLL_SECRET_ARN (poll config)
│  │     │      - External: payment status API (axios GET /payments/status)
│  │     │      - Aurora: merchant_ledger via same upsert flow
│  │     ├─ pdf-generator.ts                        # HTML → PDF helper
│  │     └─ tests/
│  │        ├─ billing-service.spec.unit.ts
│  │        └─ billing-service.spec.integration.md
│  │
│  ├─ ops-service/
│  │  └─ src/
│  │     ├─ variance-review.ts                      # ✅ pooled pg version
│  │     │   → listPendingPayouts (HTTP)
│  │     │      - Aurora: driver_payouts (SELECT variance/pending)
│  │     │   → approvePayout (HTTP)
│  │     │      - Aurora: driver_payouts (UPDATE payout_status=APPROVED)
│  │     │      - DynamoDB: PayoutAuditLog (AUDIT_TABLE_NAME)
│  │     │   → topupPayout (HTTP)
│  │     │      - Aurora:
│  │     │          • payout_topups (INSERT with idempotency_key ON CONFLICT)
│  │     │          • driver_payouts (UPDATE total_payout, payout_status)
│  │     │      - DynamoDB: PayoutAuditLog
│  │     ├─ ops-variance-review-dashboard-api.ts
│  │     │   → HTTP in: dashboard endpoints
│  │     │   → Aurora: driver_payouts, maybe merchant_ledger (aggregated views)
│  │     └─ variance-review_Version2.ts (archived)
│  │
│  ├─ tracking-service/
│  │  └─ src/
│  │     └─ tracking-service-complete.ts
│  │         → HTTP/Events in: location updates, parcel tracking queries
│  │         → DynamoDB: tracking tables (e.g. ParcelTracking, DriverLocation)
│  │         → Possibly Kinesis / EventBridge for analytics (depending on impl)
│  │
│  ├─ analytics-service/
│  │  └─ src/
│  │     └─ analytics-service-complete.ts
│  │         → HTTP in: analytics/reporting endpoints
│  │         → Aurora: driver_payouts, merchant_ledger
│  │         → DynamoDB: Parcels, Routes, Notifications for operational stats
│  │
│  ├─ admin-service/
│  │  └─ src/
│  │     └─ admin-service-complete.ts
│  │         → HTTP in: internal/admin APIs
│  │         → DynamoDB: configuration tables (feature flags, zone definitions, etc.)
│  │         → Aurora: potentially read-only financial views
│  │
│  ├─ integration-service/
│  │  └─ src/
│  │     └─ integration-service-complete.ts
│  │         → HTTP/Webhooks in: third-party platforms, marketplaces, partners
│  │         → Outbound: 3rd party APIs (couriers, ERPs, accounting, etc.)
│  │         → SQS/EventBridge: publish events into AfroGo core services
│  │
│  ├─ support-service/
│  │  └─ src/
│  │     └─ support-service-complete.ts
│  │         → HTTP in: support tickets, CS tools
│  │         → DynamoDB: SupportTickets table
│  │         → May talk to: Parcels, Drivers, Merchants tables for context
│  │
│  └─ driver-app-backend/
│     └─ src/
│        ├─ driver-app-route-offers-api.ts
│        │   → HTTP in: route offers list/accept/decline
│        │   → DynamoDB: Routes (read/patch status: OFFERED → ACCEPTED)
│        │   → Aurora: driver_payouts (maybe preview earnings per route)
│        └─ driver-earnings-history-api.ts
│            → HTTP in: /driver/me/earnings
│            → Aurora: driver_payouts
│
├─ lib/
│  ├─ pg-client.ts
│  │   → Secrets Manager: PG_SECRET_ARN
│  │   → Provides:
│  │      - withPgClient(fn)  → pooled connection per use
│  │      - pgQueryWithRetry  → backoff retry wrapper
│  ├─ rate-engine-client-hardened.ts
│  │   → Secrets Manager: RATE_ENGINE_API_SECRET_ARN
│  │   → HTTP out: Rate Engine (auth, timeouts, safe errors)
│  ├─ pdf-generator.ts
│  │   → Shared HTML→PDF helper for billing (if centralised)
│  └─ …
│
├─ infra/
│  ├─ cdk-infrastructure-complete.txt
│  │   → Defines:
│  │      - Lambda functions for each service
│  │      - API Gateway routes
│  │      - DynamoDB tables
│  │      - SQS queues, SNS topics
│  │      - Aurora cluster (Postgres)
│  │      - S3 buckets (invoices, logs, assets)
│  ├─ serverless-complete.txt
│  │   → Alternative/complimentary infra as code config
│  ├─ ssm-parameters.yaml
│  │   → SSM Parameter Store keys for env/config
│  ├─ PRODUCTION_CHECKLIST.md
│  └─ PRODUCTION_DEPLOYMENT_COMPLETE.md
│
├─ docs/
│  ├─ routes-dynamo-schema.txt
│  ├─ routing-rate-engine-integration.txt
│  ├─ driver-payouts-schema.txt
│  ├─ RATE_ENGINE_RFC_V1_Version2.txt
│  └─ AfroGo Brand Identity.pdf
│
└─ apps/
   └─ driver-app/
      ├─ driver-app-route-acceptance-screen.tsx
      └─ …
