# Proof-to-Pay v3.2.0 — AI Freelancer Business Assistant & PayPal Invoicing Platform

**Version:** 3.2.0 | **License:** MIT | **Target User:** Independent Freelancers | **Stack:** Node.js 18+ (Zero-Dependency ES Modules), Official PayPal Invoicing REST API v2, Cryptographic Webhook Verification v1, 10-Tool AI Agent Engine (`src/agent-tools.mjs`), AG Grid v31.3

> **Product Mission:** Proof-to-Pay converts unstructured client messages (from WhatsApp, email, or Slack) into structured, editable Scope-of-Work agreements, flags ambiguous requests and scope creep risks, locks approved scopes with SHA-256 fingerprints, and creates/sends PayPal invoices with mandatory human confirmation.

## 1. Freelancer-First Workflow (5 Steps)

1. **Step 1: Create a Project**
   - Enter client name, client email, paste a WhatsApp/email/Slack conversation (or upload a `.txt`/`.md` brief file), and enter a proposed budget if not mentioned by the client.
2. **Step 2: AI Scope Analysis**
   - Extracts project requirements, deliverables, deadlines, and quoted prices via `extractStructuredScope()` (supports Google Gemini API, OpenAI API, or transparent deterministic clause extraction when no AI API key is configured).
   - Identifies ambiguous statements (with exact quotes), missing information, scope creep warnings, suggested revision limits, and recommended additional charges.
3. **Step 3: Review & Approve Scope**
   - Generates an editable Scope-of-Work document (project title, client details, deliverables, timeline, payment terms, revision limits, exclusions, and total project cost).
   - Requires explicit human approval (`lock_scope`) before locking the scope with a SHA-256 hash. Editing any field after approval automatically unlocks the scope for re-approval.
4. **Step 4: Generate PayPal Invoice**
   - Generates a PayPal draft invoice (`POST /v2/invoicing/invoices`) with a sequential invoice number (`POST /v2/invoicing/generate-next-invoice-number`), approved deliverables, and exclusions.
   - Prevents duplicate invoice creation on the same project.
   - Shows a full pre-send preview and requires explicit human approval (`send_paypal_invoice`) before dispatching.
5. **Step 5: Track Payment**
   - Displays invoice status, amount due, creation date, payment confirmation status, and client payment link.
   - **Strict Payment Verification:** Payment is **only** marked `PAID` after verification through an authentic PayPal API response (`GET /v2/invoicing/invoices/{id}`) or a cryptographically verified PayPal webhook (`POST /v1/notifications/verify-webhook-signature`). Simulated events are blocked (`HTTP 422`) and never treated as real payment confirmations.

## 2. 10-Tool AI Agent Engine (`src/agent-tools.mjs`)

The AI Assistant (`POST /api/agent/chat`, `POST /api/agent/tool`, and `POST /api/agent/approve`) selects and executes 10 validated backend tools against persisted project records:

| # | Tool Name | Requires Human Approval | Function |
| :--- | :--- | :--- | :--- |
| 1 | `extract_project_requirements` | No | Parses client brief and proposed budget into deliverables, deadlines, and pricing. |
| 2 | `identify_ambiguities` | No | Detects ambiguous statements, missing information, scope creep warnings, and revision limits. |
| 3 | `calculate_project_pricing` | No | Evaluates base line items and calculates recommended additional charges for extra requests. |
| 4 | `generate_scope_document` | No | Compiles the structured Scope-of-Work summary for freelancer review. |
| 5 | `update_scope` | No | Updates deliverables, exclusions, deadlines, revision limits, or line items on an unlocked scope. |
| 6 | `lock_scope` | **Yes (`PENDING_HUMAN_APPROVAL`)** | Creates a server-side approval token bound to the current scope SHA-256 hash; rejects forged, reused, or stale approvals if scope changed after request creation. |
| 7 | `create_paypal_invoice` | No (Requires Locked Scope) | Creates a PayPal draft invoice and prevents duplicate invoice creation. |
| 8 | `send_paypal_invoice` | **Yes (`PENDING_HUMAN_APPROVAL`)** | Creates a server-side approval request before emailing the invoice to the client via PayPal. |
| 9 | `get_invoice_status` | No | Retrieves canonical invoice status (`GET /v2/invoicing/invoices/{id}`) and payment verification state. |
| 10 | `generate_payment_reminder` | **Yes (`PENDING_HUMAN_APPROVAL`)** | Drafts a polite payment reminder from project data and requires explicit human approval before sending via PayPal (`/remind`). Reminders are manual and human-triggered (no background auto-scheduler). |

Every tool call records a structured entry in `project.agentExecutionLog` (`reasoningSummary`, `toolSelected`, `toolArguments`, `toolResult`, `humanApprovalStatus`, `errorAndRecovery`) and `project.auditTrail`.

## 3. Unified PayPal Environment & Connection Verification (`src/paypal-client.mjs`)

All PayPal OAuth 2.0 credentials live strictly on the backend server (`.env`) and are never exposed to the browser. Both the application header, Settings page, and `GET /api/health` consume the same backend status object (`getCredentialStatus()`):

1. **Local Demo / Fixture Mode (`LOCAL_DEMO_FIXTURE_MODE`):** Active when `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are not configured in `.env`. All invoices (`SIM-INV-...`) are clearly labeled as local simulations and cannot be marked as real `PAID` transactions.
2. **Connected PayPal Sandbox Mode (`CONNECTED_PAYPAL_SANDBOX_MODE`):** Configured when `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are set in `.env` (`PAYPAL_ENV=sandbox`, `https://api-m.sandbox.paypal.com`). **Credentials alone never count as a verified connection**—the status remains `UNVERIFIED` until OAuth 2.0 authentication (`POST /v1/oauth2/token`) and a non-financial API check (`POST /v2/invoicing/generate-next-invoice-number` via `POST /api/paypal/test-connection`) succeed.
3. **Live PayPal Mode (`LIVE_PAYPAL_MODE`):** Active only when `PAYPAL_ENV=live`, `PAYPAL_API_BASE_URL=https://api-m.paypal.com`, and live OAuth 2.0 connectivity is verified.

API connection status (`apiConnectionStatus`) and webhook signature verification readiness (`webhookVerificationStatus`) are tracked and displayed separately.

## 4. Security, Settings & Public Deployment Notes

- **API Authentication (`FREELANCER_API_KEY`):** In local development (`NODE_ENV=development`), `FREELANCER_API_KEY` is optional. In public or production deployments (`NODE_ENV=production` or `PUBLIC_DEPLOYMENT=true`), sensitive `/api/*` operations require a configured `FREELANCER_API_KEY` passed via `Authorization: Bearer <key>` or `X-Freelancer-Key: <key>` (`HTTP 401` if missing). `POST /api/webhooks/paypal` uses its separate PayPal RSA signature verification flow (`POST /v1/notifications/verify-webhook-signature`).
- **Workspace Screen Lock vs. Server Authentication:** The inactivity timer in Settings locks the local browser UI screen (`#modal-inactivity-lock`) and blocks client-side mutating actions until unlocked; server-side API authentication is enforced via `FREELANCER_API_KEY`.
- **Demo Data vs. Real Workspace Data:** Fresh installations seed a clearly labeled sample project (`P2P-DEMO01`, `isDemo: true`) and demo workspace identity (`Rivera Freelance Studio (Demo)`, `isDemoIdentity: true`). Clearing demo data (`POST /api/projects/clear-demo`) removes only demo projects, preserves all real workspace projects (`isDemo: false`), and keeps an intentionally empty `projects.json` array (`[]`) empty across restarts.

## 5. Quick Start & Running Tests

```bash
cd proof-to-pay
cp .env.example .env
npm install
npm test
npm run verify:sandbox
npm start
```
