# Proof-to-Pay v3.0 — AI Freelancer Business Assistant & PayPal Invoicing Agent

**License:** MIT | **Target User:** Independent Freelancers | **Stack:** Node.js 18+ (Zero-Dependency ES Modules), Official PayPal Invoicing REST API v2, Cryptographic Webhook Verification v1, 9-Tool AI Agent Engine (`src/agent-tools.mjs`), AG Grid v31.3

> **Product Mission:** Proof-to-Pay is an AI-powered freelancer business assistant that converts messy client conversations (from WhatsApp, email, or Slack) into structured Scope-of-Work agreements, protects freelancers against scope creep, generates verified PayPal invoices, and manages the payment lifecycle with strict human supervision.

## 1. Freelancer-First Workflow (5 Steps)

1. **Step 1: Create a Project**
   - Enter client name, client email, paste a WhatsApp/email/Slack conversation (or upload a `.txt`/`.md` brief file), and enter a proposed budget if not mentioned by the client.
2. **Step 2: AI Scope Analysis**
   - Automatically extracts project requirements, deliverables, deadlines, and quoted prices.
   - Identifies ambiguous statements (with exact quotes), missing information, scope creep warnings, suggested revision limits, and recommended additional charges.
3. **Step 3: Review & Approve Scope**
   - Generates an editable professional Scope-of-Work document (project title, client details, deliverables, timeline, payment terms, revision limits, exclusions, and total project cost).
   - Requires explicit human approval (`lock_scope`) before locking the scope. Editing any field after approval automatically unlocks the scope for re-approval.
4. **Step 4: Generate PayPal Invoice**
   - Generates a PayPal draft invoice (`POST /v2/invoicing/invoices`) with a sequential invoice number (`POST /v2/invoicing/generate-next-invoice-number`), approved deliverables, and exclusions.
   - Prevents duplicate invoice creation on the same project.
   - Shows a full pre-send preview and requires explicit human approval (`send_paypal_invoice`) before sending.
5. **Step 5: Track Payment**
   - Displays invoice status, amount due, creation date, payment confirmation status, and client payment link.
   - **Strict Payment Honesty:** Payment is **only** marked `PAID` after verification through an authentic PayPal API response or a cryptographically verified PayPal webhook (`POST /v1/notifications/verify-webhook-signature`). Simulated events are blocked (`HTTP 422`) and never treated as real payment confirmations.

## 2. Genuine Tool-Using AI Agent (`src/agent-tools.mjs`)

The AI Assistant (`POST /api/agent/chat` & `POST /api/agent/tool`) selects and executes real backend tools based on project state:

| Tool Name | Requires Human Approval | Function |
| :--- | :--- | :--- |
| `extract_project_requirements()` | No | Parses client brief and proposed budget into deliverables, deadlines, and pricing. |
| `identify_ambiguities()` | No | Detects ambiguous statements, missing information, scope creep warnings, and revision limits. |
| `calculate_project_pricing()` | No | Evaluates base line items and calculates recommended additional charges for extra requests. |
| `generate_scope_document()` | No | Generates the structured Scope-of-Work document for freelancer review. |
| `update_scope()` | No | Updates deliverables, exclusions, deadlines, revision limits, or line items on an unlocked scope. |
| `lock_scope()` | **Yes (Mandatory)** | Explains the final scope terms and pauses until the freelancer approves locking the scope. |
| `create_paypal_invoice()` | No (Requires Locked Scope) | Creates a PayPal draft invoice and prevents duplicate invoice creation. |
| `send_paypal_invoice()` | **Yes (Mandatory)** | Explains the invoice details and pauses until the freelancer approves sending to the client. |
| `get_invoice_status()` | No | Retrieves canonical invoice status and authentic payment verification state. |
| `generate_payment_reminder()` | **Yes (Before Sending)** | Drafts a polite payment reminder from project data and requests human approval before dispatching via PayPal (`/remind`). |

Every tool call records a complete execution log entry (`reasoningSummary`, `toolSelected`, `toolArguments`, `toolResult`, `humanApprovalStatus`, `errorAndRecovery`).

## 3. Visible 3-Tier PayPal Connection Modes (`src/paypal-client.mjs`)

All PayPal OAuth 2.0 credentials live strictly on the backend server (`.env`) and are never stored in browser storage or frontend code:

1. **Local Demo / Fixture Mode (`LOCAL_DEMO_FIXTURE_MODE`):** Active when `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are not set in `.env`. All invoices (`SIM-INV-...`) and previews are clearly labeled as simulated and cannot be marked as real `PAID` transactions.
2. **Connected PayPal Sandbox Mode (`CONNECTED_PAYPAL_SANDBOX_MODE`):** Active when `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are configured in `.env` with `PAYPAL_ENV=sandbox` (`https://api-m.sandbox.paypal.com`).
3. **Live PayPal Mode (`LIVE_PAYPAL_MODE`):** Active only when `PAYPAL_ENV=live` and production credentials are configured on the server (`https://api-m.paypal.com`).

## 4. Quick Start & Running Tests

```bash
cd proof-to-pay
cp .env.example .env
npm test
npm start
```
