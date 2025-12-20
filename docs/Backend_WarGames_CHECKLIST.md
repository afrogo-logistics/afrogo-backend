```markdown
AfroGo Backend v1 — Final "must have" checklist (headless / enterprise)

Files added in repo (this PR):
- openapi.yaml
- tools/postman/AfroGo_Backend_v1.postman_collection.json
- tools/postman/afrogo-dev.postman_environment.json
- tools/fixtures/parcels.json
- tools/load-fixtures.js
- seeds/seed_data.sql
- .env.example
- README_ENV.md
- package.json (scripts: test:headless-wargames, fixtures:load)

Final must-haves (DONE / included):
- [.env.example] — single canonical env file for local/dev
- [openapi.yaml] — v1 contract; set API Gateway to use `/v1` path (lock)
- [seed_data.sql] — minimal SQL to seed zones, rate_cards, merchant, driver
- [JSON fixtures] — example parcels to run War Games
- [Newman CLI] — `npm run test:headless-wargames`
- [Fixtures runner] — `npm run fixtures:load` to post parcels/merchant to API

Operational notes:
- Lock API version: deploy API Gateway stage so that routes use the base path `/v1` and do not change (create v2 for breaking changes).
- Secrets: fill PG_SECRET_ARN and provider secret ARNs in AWS Secrets Manager for dev.
- Run order for War Games:
  1. Deploy stack to dev
  2. Run seeds/seed_data.sql against Aurora
  3. npm run fixtures:load
  4. npm run test:headless-wargames

If you want I can:
- Add a GitHub Actions workflow to run Newman on each deploy.
- Add pre-request HMAC generation for the webhook tests.
- Produce JUnit/HTML reporters for CI.
```