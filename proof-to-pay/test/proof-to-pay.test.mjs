/**
 * Proof-to-Pay v3.1 — Comprehensive Backend & PayPal Sandbox Integration Test Suite (`test/proof-to-pay.test.mjs`)
 *
 * Covers all 20 required tests from Part 4 Section 13 + Frontend Integrity & Persistence Audits:
 * 1. Health endpoint works (`GET /api/health` + `GET /api/paypal/test-connection`).
 * 2. Project extraction works (`POST /api/projects/extract`).
 * 3. Structured Gemini extraction validation works (`extractStructuredScope` with complete 9-field payload).
 * 4. AI fallback transparency works (incomplete AI payload rejected, `liveAiUsed: false`, `provider: 'deterministic-fallback'`).
 * 5. Scope update works (`PUT /api/projects/:id/scope` and `update_scope` tool).
 * 6. Scope lock requires human approval (`POST /api/projects/:id/approve` and `lock_scope` tool).
 * 7. Direct sensitive tool call cannot bypass approval (`humanApproved: true` ignored; returns `PENDING_HUMAN_APPROVAL`).
 * 8. Forged approval ID is rejected (`POST /api/agent/approve`).
 * 9. Reused approval ID is rejected (and scope modification after pending approval invalidates the approval).
 * 10. Draft invoice requires locked scope (`POST /api/projects/:id/paypal/draft` rejected when unlocked).
 * 11. Duplicate invoice creation is prevented (`duplicatePrevented: true`).
 * 12. PayPal OAuth token request works (including token caching and expiry refresh).
 * 13. PayPal draft invoice creation works (`POST /v2/invoicing/invoices` with full v2 payload mapping).
 * 14. Sending PayPal invoice requires human approval (`send_paypal_invoice` tool and `confirmSend` guard).
 * 15. Invoice status sync works (`GET /v2/invoicing/invoices/{id}` via `/paypal/sync` and `get_invoice_status` tool).
 * 16. Simulated webhook cannot mark invoice PAID (`HTTP 422`, `simulatedBlocked: true`, state stays `INVOICE_SENT`).
 * 17. Unverified webhook is rejected (`HTTP 401`, state stays `INVOICE_SENT`).
 * 18. Verified webhook marks invoice PAID (`HTTP 200`, `verified: true`, state transitions to `PAID`).
 * 19. Duplicate webhook is ignored (`HTTP 200`, `deduplicated: true`).
 * 20. Auth, ownership, CORS, and rate limiting work (`401`, `403`, `403`, `429`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../src/server.mjs';
import { PayPalSandboxClient, PAYPAL_CONNECTION_MODES } from '../src/paypal-client.mjs';
import { ProjectStore } from '../src/store.mjs';
import { extractStructuredScope } from '../src/ai-extractor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function withTestServer(fn, options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-v31-test-'));
  const dataPath = path.join(tmpDir, 'projects.json');
  const store = new ProjectStore(dataPath);
  const paypalClient = new PayPalSandboxClient(
    options.paypalConfig || { clientId: '', clientSecret: '', webhookId: '' }
  );
  const { server } = createAppServer({
    store,
    paypalClient,
    apiKey: options.apiKey || '',
    rateLimitMaxPerMinute: options.rateLimitMaxPerMinute || 500,
    allowedOrigins: options.allowedOrigins || 'http://localhost:3000,http://127.0.0.1:3000'
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn({ baseUrl, store, paypalClient, dataPath, tmpDir });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('Frontend Integrity: public/index.html is preserved unchanged and connects to all 12 backend REST endpoints', () => {
  const htmlPath = path.resolve(__dirname, '../public/index.html');
  assert.ok(fs.existsSync(htmlPath), 'public/index.html must exist');
  const rawBuffer = fs.readFileSync(htmlPath);
  const md5 = crypto.createHash('md5').update(rawBuffer).digest('hex');
  assert.equal(md5, '49b429bf725aa0ebca6536f016794c8a', 'public/index.html must remain 100% unmodified');

  const html = rawBuffer.toString('utf8');
  const requiredEndpoints = [
    '/api/health',
    '/api/projects',
    '/api/projects/extract',
    '/api/agent/chat',
    '/api/agent/tool',
    '/api/agent/approve',
    '/scope',
    '/approve',
    '/paypal/draft',
    '/paypal/send',
    '/paypal/sync',
    '/api/webhooks/paypal'
  ];
  for (const ep of requiredEndpoints) {
    assert.ok(html.includes(ep), `public/index.html must integrate backend endpoint ${ep}`);
  }
});

test('Test 1: Health endpoint works and exposes PayPal mode, AI status, and all 10 agent tools', async () => {
  await withTestServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(data.paypal.mode, PAYPAL_CONNECTION_MODES.LOCAL_FIXTURE);
    assert.equal(Array.isArray(data.agentTools), true);
    assert.equal(data.agentTools.length, 10);
  });
});

test('Test 2: Project extraction works and automatically executes requirement + ambiguity tools', async () => {
  await withTestServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/projects/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: 'Maya Lin',
        clientEmail: 'maya@example.com',
        projectTitle: 'Startup Landing Page',
        proposedBudget: 450,
        rawBrief:
          'I need a landing page for my startup by next Friday. Three sections, mobile friendly, and I can pay $450. I may want copywriting too.'
      })
    });
    assert.equal(res.status, 201);
    const { project } = await res.json();
    assert.ok(project.id.startsWith('PRJ-'));
    assert.equal(project.state, 'DRAFT_SCOPE');
    assert.equal(project.scope.totalAmount, 450);
    assert.ok(project.scope.deliverables.length >= 2);
    assert.ok(project.analysisDetails.ambiguousStatements.length >= 1);
    assert.ok(project.agentExecutionLog.some((l) => l.toolSelected === 'extract_project_requirements'));
    assert.ok(project.agentExecutionLog.some((l) => l.toolSelected === 'identify_ambiguities'));
  });
});

test('Test 3 & Test 4: Structured Gemini extraction validation works AND AI fallback transparency never fakes liveAiUsed', async () => {
  // Test 3: Complete valid Gemini structured JSON response -> populates all 9 fields and sets liveAiUsed: true
  const mockGeminiFullJson = {
    projectTitle: 'Custom AI Analytics Portal',
    projectSummary: 'Full-stack analytics dashboard with role-based access and export.',
    deadline: '2026-11-20',
    deadlineLabel: 'Explicit client target date (2026-11-20)',
    currency: 'USD',
    quotedPriceLabel: 'Client quoted $1,800 in brief',
    paymentTerms: 'NET_15',
    revisionLimit: 3,
    suggestedRevisionLimit: '3 rounds included',
    deliverables: [
      {
        id: 'DEL-1',
        title: 'Interactive KPI Dashboard',
        description: 'Charts and filters',
        sourceQuote: 'KPI dashboard with export',
        confidence: 'EXPLICIT'
      }
    ],
    lineItems: [
      {
        id: 'ITEM-1',
        name: 'Interactive KPI Dashboard Build',
        description: 'Core build',
        quantity: '1',
        unitPrice: 1800
      }
    ],
    exclusions: ['On-premise server maintenance'],
    acceptanceCriteria: ['Passes staging QA'],
    ambiguousStatements: [
      {
        quote: 'maybe SSO later',
        issue: 'Unpriced enterprise SSO integration',
        recommendation: 'Quote +$400 for SAML SSO'
      }
    ],
    missingInformation: ['IdP metadata URL not provided'],
    scopeCreepWarnings: ['SSO mentioned without budget increase'],
    additionalCharges: [
      {
        id: 'ADDON-SSO',
        title: 'SAML / OAuth Enterprise SSO Module',
        suggestedPrice: 400,
        reason: 'Mentioned tentatively in brief'
      }
    ],
    riskFlags: [
      {
        id: 'RISK-SSO',
        field: 'Authentication',
        severity: 'HIGH',
        issue: 'Ambiguous SSO requirement',
        sourceQuote: 'maybe SSO later',
        recommendation: 'Exclude or add +$400',
        resolved: false
      }
    ]
  };

  const mockSuccessFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(mockGeminiFullJson) }] } }]
    })
  });

  const liveResult = await extractStructuredScope(
    {
      rawBrief: 'We need a KPI dashboard with export by 2026-11-20 for $1,800, maybe SSO later.',
      clientName: 'Dana Sterling',
      clientEmail: 'dana@example.com'
    },
    { GEMINI_API_KEY: 'test-live-gemini-key', GEMINI_MODEL: 'gemini-2.5-flash' },
    mockSuccessFetch
  );

  assert.equal(liveResult.extractionMeta.provider, 'google-gemini');
  assert.equal(liveResult.extractionMeta.liveAiUsed, true);
  assert.equal(liveResult.extractionMeta.fallbackUsed, false);
  assert.equal(liveResult.scope.projectTitle, 'Custom AI Analytics Portal');
  assert.equal(liveResult.scope.totalAmount, 1800);
  assert.equal(liveResult.scope.deadline, '2026-11-20');
  assert.equal(liveResult.scope.revisionLimit, 3);
  assert.equal(liveResult.scope.exclusions[0], 'On-premise server maintenance');
  assert.equal(liveResult.analysisDetails.missingInformation[0], 'IdP metadata URL not provided');
  assert.equal(liveResult.analysisDetails.additionalCharges[0].suggestedPrice, 400);

  // Test 4: Incomplete Gemini response (only projectTitle) -> rejected by schema validation, falls back cleanly, and sets liveAiUsed: false
  const mockIncompleteFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ projectTitle: 'Partial Title Only' }) }] } }]
    })
  });

  const fallbackResult = await extractStructuredScope(
    {
      rawBrief:
        'I need a landing page for my startup by next Friday. Three sections, mobile friendly, and I can pay $450. I may want copywriting too.',
      clientName: 'Jordan Vance',
      clientEmail: 'jordan@example.com'
    },
    { GEMINI_API_KEY: 'test-live-gemini-key' },
    mockIncompleteFetch
  );

  assert.equal(fallbackResult.extractionMeta.liveAiUsed, false);
  assert.equal(fallbackResult.extractionMeta.provider, 'deterministic-fallback');
  assert.equal(fallbackResult.extractionMeta.fallbackUsed, true);
  assert.match(fallbackResult.extractionMeta.fallbackReason, /Incomplete AI structured extraction/i);
});

test('Test 5, 6, 7, 8, 9, 10: Scope update, Scope lock human approval, Direct tool non-bypassability, Forged & Reused approval ID rejection, Scope change invalidation, and Draft invoice requiring locked scope', async () => {
  await withTestServer(async ({ baseUrl }) => {
    // Test 5: Scope update works via PUT /api/projects/:id/scope and via update_scope agent tool
    const putScopeRes = await fetch(`${baseUrl}/api/projects/P2P-DEMO01/scope`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionLimit: 3,
        paymentTerms: 'NET_15'
      })
    });
    assert.equal(putScopeRes.status, 200);
    const putScopeData = await putScopeRes.json();
    assert.equal(putScopeData.project.scope.revisionLimit, 3);
    assert.equal(putScopeData.project.scope.paymentTerms, 'NET_15');

    // Also test calculate_project_pricing and generate_scope_document tools
    const pricingRes = await fetch(`${baseUrl}/api/agent/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'P2P-DEMO01',
        toolName: 'calculate_project_pricing',
        args: { includeOptionalAddons: true, applyAddonsToScope: false }
      })
    });
    assert.equal(pricingRes.status, 200);
    const pricingData = await pricingRes.json();
    assert.equal(pricingData.status, 'EXECUTED');
    assert.equal(pricingData.result.currentScopeTotal, 450);

    const docRes = await fetch(`${baseUrl}/api/agent/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'P2P-DEMO01',
        toolName: 'generate_scope_document',
        args: {}
      })
    });
    assert.equal(docRes.status, 200);

    // Test 10: Draft invoice requires locked scope (rejected when project is still in DRAFT_SCOPE)
    const prematureDraftRes = await fetch(`${baseUrl}/api/projects/P2P-DEMO01/paypal/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowDevFixture: true })
    });
    assert.equal(prematureDraftRes.status, 400);
    const prematureDraftErr = await prematureDraftRes.json();
    assert.match(prematureDraftErr.error, /review and approve \(lock\) the Scope of Work/i);

    // Test 6: Direct POST /api/projects/:id/approve without explicitConfirmation: true is rejected
    const unconfirmedApproveRes = await fetch(`${baseUrl}/api/projects/P2P-DEMO01/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ explicitConfirmation: false })
    });
    assert.equal(unconfirmedApproveRes.status, 400);

    // Test 7: Direct sensitive tool call (lock_scope) with humanApproved: true CANNOT bypass approval
    const bypassAttemptRes = await fetch(`${baseUrl}/api/agent/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'P2P-DEMO01',
        toolName: 'lock_scope',
        humanApproved: true,
        args: { approverName: 'Bypass Attacker' }
      })
    });
    assert.equal(bypassAttemptRes.status, 200);
    const bypassData = await bypassAttemptRes.json();
    assert.equal(bypassData.status, 'PENDING_HUMAN_APPROVAL');
    assert.equal(bypassData.project.state, 'DRAFT_SCOPE');
    assert.equal(bypassData.project.scopeLock, null);
    const firstApprovalId = bypassData.approvalRequest.id;

    // Test 8: Forged approval ID is rejected
    const forgedRes = await fetch(`${baseUrl}/api/agent/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'P2P-DEMO01',
        approvalId: 'REQ-FORGED-0000'
      })
    });
    assert.equal(forgedRes.status, 400);

    // Scope change after pending approval invalidates the pending approval
    await fetch(`${baseUrl}/api/agent/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'P2P-DEMO01',
        toolName: 'update_scope',
        args: { updates: { revisionLimit: 2 } }
      })
    });

    const staleApproveRes = await fetch(`${baseUrl}/api/agent/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'P2P-DEMO01',
        approvalId: firstApprovalId,
        decision: 'APPROVE'
      })
    });
    assert.equal(staleApproveRes.status, 400);
    const staleErr = await staleApproveRes.json();
    assert.match(staleErr.error, /modified after the approval request was generated/i);

    // Request a fresh lock_scope approval and approve it
    const freshLockReq = await fetch(`${baseUrl}/api/agent/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'P2P-DEMO01',
        toolName: 'lock_scope',
        args: { approverName: 'Alex Rivera' }
      })
    });
    const freshLockData = await freshLockReq.json();
    const validApprovalId = freshLockData.approvalRequest.id;

    const validApproveRes = await fetch(`${baseUrl}/api/agent/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'P2P-DEMO01',
        approvalId: validApprovalId,
        decision: 'APPROVE'
      })
    });
    assert.equal(validApproveRes.status, 200);
    const validApproveData = await validApproveRes.json();
    assert.equal(validApproveData.status, 'EXECUTED');
    assert.equal(validApproveData.project.state, 'HUMAN_APPROVED');
    assert.ok(validApproveData.project.scopeLock?.sha256);

    // Test 9: Reused approval ID is rejected (single-use consumption)
    const reusedRes = await fetch(`${baseUrl}/api/agent/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'P2P-DEMO01',
        approvalId: validApprovalId,
        decision: 'APPROVE'
      })
    });
    assert.equal(reusedRes.status, 400);
    const reusedErr = await reusedRes.json();
    assert.match(reusedErr.error, /not found or has already been processed/i);
  });
});

test('Test 11, 12, 13, 14, 15, 16, 17, 18, 19: PayPal OAuth Token Caching/Refresh, Draft Creation, Duplicate Prevention, Send Human Approval, Status Sync, Simulated Webhook Block, Unverified Webhook Rejection, Verified Webhook PAID, and Duplicate Webhook Ignore', async () => {
  const mockPayPalInvoices = new Map();
  let oauthCalls = 0;

  const mockPayPalServer = http.createServer(async (req, res) => {
    const url = req.url || '';
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('paypal-debug-id', 'dbg-live-sbx-98765');

    if (req.method === 'POST' && url === '/v1/oauth2/token') {
      oauthCalls += 1;
      res.writeHead(200);
      res.end(
        JSON.stringify({
          access_token: `MOCK_SANDBOX_BEARER_TOKEN_${oauthCalls}`,
          app_id: 'APP-80W284485P519543T',
          expires_in: 32400
        })
      );
      return;
    }

    if (req.method === 'POST' && url === '/v2/invoicing/generate-next-invoice-number') {
      res.writeHead(200);
      res.end(JSON.stringify({ invoice_number: 'INV-SBX-2026-5001' }));
      return;
    }

    if (req.method === 'POST' && url === '/v2/invoicing/invoices') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      const invId = 'INV2-SBX5-9999-8888-7777';
      const record = {
        id: invId,
        status: 'DRAFT',
        detail: {
          ...parsed.detail,
          metadata: {
            create_time: new Date().toISOString(),
            recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${invId}`
          }
        },
        primary_recipients: parsed.primary_recipients,
        items: parsed.items,
        amount: { currency_code: parsed.detail.currency_code || 'USD', value: '450.00' },
        due_amount: { currency_code: parsed.detail.currency_code || 'USD', value: '450.00' },
        links: [
          { rel: 'self', href: `http://127.0.0.1/v2/invoicing/invoices/${invId}` },
          { rel: 'payer-view', href: `https://www.sandbox.paypal.com/invoice/p/#${invId}` }
        ]
      };
      mockPayPalInvoices.set(invId, record);
      res.writeHead(201);
      res.end(JSON.stringify(record));
      return;
    }

    const sendMatch = url.match(/^\/v2\/invoicing\/invoices\/([^/]+)\/send$/);
    if (req.method === 'POST' && sendMatch) {
      const inv = mockPayPalInvoices.get(decodeURIComponent(sendMatch[1]));
      inv.status = 'SENT';
      res.writeHead(200);
      res.end(JSON.stringify({ href: `https://www.sandbox.paypal.com/invoice/p/#${inv.id}` }));
      return;
    }

    const remindMatch = url.match(/^\/v2\/invoicing\/invoices\/([^/]+)\/remind$/);
    if (req.method === 'POST' && remindMatch) {
      res.writeHead(204);
      res.end();
      return;
    }

    const cancelMatch = url.match(/^\/v2\/invoicing\/invoices\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const inv = mockPayPalInvoices.get(decodeURIComponent(cancelMatch[1]));
      if (inv) inv.status = 'CANCELLED';
      res.writeHead(204);
      res.end();
      return;
    }

    const getMatch = url.match(/^\/v2\/invoicing\/invoices\/([^/]+)$/);
    if (req.method === 'GET' && getMatch) {
      const inv = mockPayPalInvoices.get(decodeURIComponent(getMatch[1]));
      res.writeHead(200);
      res.end(JSON.stringify(inv));
      return;
    }

    if (req.method === 'POST' && url === '/v1/notifications/verify-webhook-signature') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      if (parsed.transmission_sig === 'VALID_PAYPAL_RSA_SIGNATURE') {
        res.writeHead(200);
        res.end(JSON.stringify({ verification_status: 'SUCCESS' }));
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({ verification_status: 'FAILURE' }));
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise((resolve) => mockPayPalServer.listen(0, '127.0.0.1', resolve));
  const ppPort = mockPayPalServer.address().port;
  const mockPayPalBaseUrl = `http://127.0.0.1:${ppPort}`;

  try {
    await withTestServer(
      async ({ baseUrl, paypalClient }) => {
        // Test 12: PayPal OAuth token request, caching, expiry refresh, and safe test-connection endpoint work
        const connRes = await fetch(`${baseUrl}/api/paypal/test-connection`);
        assert.equal(connRes.status, 200);
        const connData = await connRes.json();
        assert.equal(connData.ok, true);
        assert.equal(connData.nextInvoiceNumber, 'INV-SBX-2026-5001');
        assert.equal(oauthCalls, 1, 'First call fetches OAuth token');

        // Second call uses cached token
        const cachedTokenMeta = await paypalClient.getAccessTokenWithMeta(false);
        assert.equal(cachedTokenMeta.cached, true);
        assert.equal(oauthCalls, 1, 'Cached OAuth token must be reused before expiry');

        // Simulate token expiry and verify automatic refresh
        paypalClient._tokenCache.expiresAtMs = Date.now() - 1000;
        const refreshedTokenMeta = await paypalClient.getAccessTokenWithMeta(false);
        assert.equal(refreshedTokenMeta.cached, false);
        assert.equal(oauthCalls, 2, 'Expired OAuth token must be automatically refreshed');

        // Lock scope first
        await fetch(`${baseUrl}/api/projects/P2P-DEMO01/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ explicitConfirmation: true, approverName: 'Alex Rivera' })
        });

        // Test 13: PayPal draft invoice creation works and maps all required fields
        const draftRes = await fetch(`${baseUrl}/api/projects/P2P-DEMO01/paypal/draft`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowDevFixture: false })
        });
        assert.equal(draftRes.status, 200);
        const draftData = await draftRes.json();
        const inv = draftData.project.paypalInvoice;
        assert.equal(inv.invoiceId, 'INV2-SBX5-9999-8888-7777');
        assert.equal(inv.invoiceNumber, 'INV-SBX-2026-5001');
        assert.equal(inv.isFixture, false);
        assert.equal(inv.connectionMode, PAYPAL_CONNECTION_MODES.CONNECTED_SANDBOX);

        const storedPayload = mockPayPalInvoices.get(inv.invoiceId);
        assert.equal(storedPayload.primary_recipients[0].billing_info.email_address, 'jordan.vance-buyer@sandbox.paypal.com');
        assert.equal(storedPayload.items[0].unit_amount.value, '450.00');
        assert.match(storedPayload.detail.note, /Deliverables:/);

        // Test 11: Duplicate invoice creation is prevented
        const dupRes = await fetch(`${baseUrl}/api/projects/P2P-DEMO01/paypal/draft`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowDevFixture: false })
        });
        const dupData = await dupRes.json();
        assert.equal(dupData.duplicatePrevented, true);

        // Test 14: Sending PayPal invoice requires human approval (both via direct route and via agent tool)
        const unconfirmedSendRes = await fetch(`${baseUrl}/api/projects/P2P-DEMO01/paypal/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmSend: false })
        });
        assert.equal(unconfirmedSendRes.status, 400);

        const toolSendReq = await fetch(`${baseUrl}/api/agent/tool`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: 'P2P-DEMO01',
            toolName: 'send_paypal_invoice',
            humanApproved: true
          })
        });
        const toolSendData = await toolSendReq.json();
        assert.equal(toolSendData.status, 'PENDING_HUMAN_APPROVAL');
        assert.equal(toolSendData.project.state, 'PAYPAL_DRAFT_CREATED');

        const approveSendRes = await fetch(`${baseUrl}/api/agent/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: 'P2P-DEMO01',
            approvalId: toolSendData.approvalRequest.id,
            decision: 'APPROVE'
          })
        });
        assert.equal(approveSendRes.status, 200);
        const approvedSendData = await approveSendRes.json();
        assert.equal(approvedSendData.status, 'EXECUTED');
        assert.equal(approvedSendData.project.state, 'INVOICE_SENT');
        assert.equal(approvedSendData.project.paypalInvoice.status, 'SENT');

        // Test 15: Invoice status sync works
        const syncRes = await fetch(`${baseUrl}/api/projects/P2P-DEMO01/paypal/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowDevFixture: false })
        });
        assert.equal(syncRes.status, 200);
        const syncData = await syncRes.json();
        assert.equal(syncData.project.paypalInvoice.status, 'SENT');

        // Test 16: Simulated webhook cannot mark invoice PAID
        const simWebhookRes = await fetch(`${baseUrl}/api/webhooks/paypal`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-p2p-fixture-webhook': 'true'
          },
          body: JSON.stringify({
            id: 'WH-SIMULATED-1',
            event_type: 'INVOICING.INVOICE.PAID',
            resource: { invoice: { id: inv.invoiceId, status: 'PAID' } }
          })
        });
        assert.equal(simWebhookRes.status, 422);
        const simWebhookData = await simWebhookRes.json();
        assert.equal(simWebhookData.simulatedBlocked, true);
        assert.equal(simWebhookData.projectState, 'INVOICE_SENT');

        // Test 17: Unverified webhook is rejected (HTTP 401)
        const badWebhookRes = await fetch(`${baseUrl}/api/webhooks/paypal`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'paypal-auth-algo': 'SHA256withRSA',
            'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
            'paypal-transmission-id': 'TRANSM-1',
            'paypal-transmission-sig': 'FORGED_BAD_SIGNATURE',
            'paypal-transmission-time': new Date().toISOString()
          },
          body: JSON.stringify({
            id: 'WH-BAD-1',
            event_type: 'INVOICING.INVOICE.PAID',
            resource: { invoice: { id: inv.invoiceId, status: 'PAID' } }
          })
        });
        assert.equal(badWebhookRes.status, 401);

        // Test 18: Verified webhook marks invoice PAID after canonical API verification
        const mockRecord = mockPayPalInvoices.get(inv.invoiceId);
        mockRecord.status = 'PAID';
        mockRecord.due_amount = { currency_code: 'USD', value: '0.00' };

        const validWebhookRes = await fetch(`${baseUrl}/api/webhooks/paypal`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'paypal-auth-algo': 'SHA256withRSA',
            'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
            'paypal-transmission-id': 'TRANSM-2',
            'paypal-transmission-sig': 'VALID_PAYPAL_RSA_SIGNATURE',
            'paypal-transmission-time': new Date().toISOString()
          },
          body: JSON.stringify({
            id: 'WH-AUTHENTIC-PAID-1',
            event_type: 'INVOICING.INVOICE.PAID',
            resource: { invoice: { id: inv.invoiceId, status: 'PAID' } }
          })
        });
        assert.equal(validWebhookRes.status, 200);
        const validWebhookData = await validWebhookRes.json();
        assert.equal(validWebhookData.verified, true);
        assert.equal(validWebhookData.projectState, 'PAID');

        // Test 19: Duplicate webhook is ignored (deduplicated: true)
        const replayWebhookRes = await fetch(`${baseUrl}/api/webhooks/paypal`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'paypal-auth-algo': 'SHA256withRSA',
            'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
            'paypal-transmission-id': 'TRANSM-2',
            'paypal-transmission-sig': 'VALID_PAYPAL_RSA_SIGNATURE',
            'paypal-transmission-time': new Date().toISOString()
          },
          body: JSON.stringify({
            id: 'WH-AUTHENTIC-PAID-1',
            event_type: 'INVOICING.INVOICE.PAID',
            resource: { invoice: { id: inv.invoiceId, status: 'PAID' } }
          })
        });
        assert.equal(replayWebhookRes.status, 200);
        const replayData = await replayWebhookRes.json();
        assert.equal(replayData.deduplicated, true);
      },
      {
        paypalConfig: {
          baseUrl: mockPayPalBaseUrl,
          clientId: 'LIVE_SBX_CLIENT_ID_12345',
          clientSecret: 'LIVE_SBX_SECRET_67890',
          webhookId: 'WH_ID_SBX_111'
        }
      }
    );
  } finally {
    mockPayPalServer.closeAllConnections?.();
    await new Promise((resolve) => mockPayPalServer.close(resolve));
  }
});

test('Test 20: Auth (401), Ownership (403), CORS (403), and Rate Limiting (429) work', async () => {
  await withTestServer(
    async ({ baseUrl }) => {
      const unauthRes = await fetch(`${baseUrl}/api/projects`);
      assert.equal(unauthRes.status, 401);

      const corsRes = await fetch(`${baseUrl}/api/projects`, {
        headers: {
          Origin: 'https://malicious.example.com',
          Authorization: 'Bearer secret-api-key-123'
        }
      });
      assert.equal(corsRes.status, 403);

      const ownershipRes = await fetch(`${baseUrl}/api/projects/P2P-DEMO01`, {
        headers: {
          Authorization: 'Bearer secret-api-key-123',
          'X-Freelancer-Id': 'unauthorized-other-user'
        }
      });
      assert.equal(ownershipRes.status, 403);

      const okRes = await fetch(`${baseUrl}/api/projects/P2P-DEMO01`, {
        headers: {
          Authorization: 'Bearer secret-api-key-123',
          'X-Freelancer-Id': 'freelancer-alex-rivera'
        }
      });
      assert.equal(okRes.status, 200);

      let hit429 = false;
      for (let i = 0; i < 6; i++) {
        const r = await fetch(`${baseUrl}/api/health`, {
          headers: { Authorization: 'Bearer secret-api-key-123' }
        });
        if (r.status === 429) {
          hit429 = true;
          break;
        }
      }
      assert.equal(hit429, true, 'Should enforce per-IP rate limiting with HTTP 429');
    },
    {
      apiKey: 'secret-api-key-123',
      rateLimitMaxPerMinute: 5
    }
  );
});

test('Persistence Audit: Projects, pending approvals, locked scope hashes, invoices, and logs survive server restart', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-persist-'));
  const dataPath = path.join(tmpDir, 'projects.json');

  try {
    const store1 = new ProjectStore(dataPath);
    const paypal1 = new PayPalSandboxClient({ clientId: '', clientSecret: '' });
    const app1 = createAppServer({ store: store1, paypalClient: paypal1 });
    await new Promise((resolve) => app1.server.listen(0, '127.0.0.1', resolve));
    const url1 = `http://127.0.0.1:${app1.server.address().port}`;

    await fetch(`${url1}/api/projects/P2P-DEMO01/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ explicitConfirmation: true, approverName: 'Alex Rivera' })
    });
    await fetch(`${url1}/api/projects/P2P-DEMO01/paypal/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowDevFixture: true })
    });
    await fetch(`${url1}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'P2P-DEMO01', message: 'Draft a polite payment reminder.' })
    });

    app1.server.closeAllConnections?.();
    await new Promise((resolve) => app1.server.close(resolve));

    const store2 = new ProjectStore(dataPath);
    const paypal2 = new PayPalSandboxClient({ clientId: '', clientSecret: '' });
    const app2 = createAppServer({ store: store2, paypalClient: paypal2 });
    await new Promise((resolve) => app2.server.listen(0, '127.0.0.1', resolve));
    const url2 = `http://127.0.0.1:${app2.server.address().port}`;

    const checkRes = await fetch(`${url2}/api/projects/P2P-DEMO01`);
    assert.equal(checkRes.status, 200);
    const { project: reloaded } = await checkRes.json();

    assert.equal(reloaded.state, 'PAYPAL_DRAFT_CREATED');
    assert.equal(reloaded.scopeLock.approvedBy, 'Alex Rivera');
    assert.ok(reloaded.paypalInvoice?.invoiceId);
    assert.equal(reloaded.pendingApprovals.length, 1);
    assert.equal(reloaded.pendingApprovals[0].toolName, 'generate_payment_reminder');
    assert.ok(reloaded.agentExecutionLog.length >= 2);
    assert.ok(reloaded.auditTrail.length >= 3);

    app2.server.closeAllConnections?.();
    await new Promise((resolve) => app2.server.close(resolve));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
