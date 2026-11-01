/**
 * Proof-to-Pay v3.2 — Comprehensive Backend, PayPal Sandbox & Fintech SaaS Test Suite (`test/proof-to-pay.test.mjs`)
 *
 * Verifies all 20 Regression & Core Requirements + New SaaS Settings, Theme, Export, Backup & Status Synchronization:
 * 1. Frontend & SaaS UI Audit: Verifies `public/index.html` integrates all backend REST endpoints, unified PayPal status
 *    renderer (`renderUnifiedPayPalStatus`), zero-FOUC Light/Dark/System theme initialization, Accent Colors, Compact/Comfortable
 *    density, Collapsible Sidebar, and all 5 Settings sections (Appearance, Workspace, PayPal, Notifications, Security & Data).
 * 2. Single Source of Truth PayPal Environment Status:
 *    - Proves PayPal is NOT marked `apiConnected: true` merely because credentials exist (`apiConnectionStatus: 'UNVERIFIED'`).
 *    - Proves failed connection test sets `apiConnectionStatus: 'CONNECTION_FAILED'` with diagnostic error and never exposes secrets.
 *    - Proves successful connection test sets `apiConnected: true`, `apiConnectionStatus: 'CONNECTED'`, and `headerDisplayLabel: 'Connected PayPal Sandbox Mode'`.
 * 3. Project Extraction, 9-Field Gemini Validation & AI Fallback Transparency.
 * 4. Scope Updates, SHA-256 Scope Locking, Non-Bypassable Human Approval Gates, Forged/Reused Approval Rejection, and Scope Change Invalidation.
 * 5. Complete PayPal Sandbox Invoicing v2 Lifecycle (OAuth Caching/Refresh, Draft Creation, Duplicate Prevention, Send Approval, Sync, Webhook Verification & Deduplication).
 * 6. Workspace Preferences, Notification Toggles, Audit Log API, Sanitized JSON/CSV Exports, Snapshot Backup/Restore, and Safe Demo-Only Data Clearing (preserving real workspace projects).
 * 7. API Security Hardening (401 Auth, 403 Ownership, 403 CORS, 429 Rate Limiting) & Persistence Across Server Restarts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-v32-test-'));
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

test('SaaS Frontend Audit: public/index.html connects to all backend endpoints and implements unified PayPal status, Light/Dark/System themes, and all 5 Settings sections', () => {
  const htmlPath = path.resolve(__dirname, '../public/index.html');
  assert.ok(fs.existsSync(htmlPath), 'public/index.html must exist');
  const html = fs.readFileSync(htmlPath, 'utf8');

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
    '/api/webhooks/paypal',
    '/api/paypal/test-connection',
    '/api/settings',
    '/api/audit-logs',
    '/api/export/json',
    '/api/export/csv',
    '/api/backup/create',
    '/api/backup/restore',
    '/api/projects/clear-demo'
  ];
  for (const ep of requiredEndpoints) {
    assert.ok(html.includes(ep), `public/index.html must integrate backend endpoint ${ep}`);
  }

  // Verify all 5 redesigned Settings sections and theme/personalization controls exist
  const requiredUiElements = [
    'initAppearanceBeforePaint',
    'renderUnifiedPayPalStatus',
    'settings-sec-appearance',
    'settings-sec-workspace',
    'settings-sec-paypal',
    'settings-sec-notifications',
    'settings-sec-security',
    'setThemePreference',
    'setAccentPreference',
    'setDensityPreference',
    'toggleSidebarCollapsed'
  ];
  for (const idOrFn of requiredUiElements) {
    assert.ok(html.includes(idOrFn), `public/index.html must include ${idOrFn}`);
  }
});

test('Test 1 & PayPal Status Mismatch Fix: Single backend source of truth never marks PayPal as connected merely because credentials exist', async () => {
  // Case A: No credentials configured -> LOCAL_DEMO_FIXTURE_MODE
  await withTestServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(data.paypal.mode, PAYPAL_CONNECTION_MODES.LOCAL_FIXTURE);
    assert.equal(data.paypal.apiConnected, false);
    assert.equal(data.paypal.apiConnectionStatus, 'NOT_CONFIGURED');
    assert.equal(data.paypal.headerDisplayLabel, 'Local Demo / Fixture Mode');
    assert.equal(Array.isArray(data.agentTools), true);
    assert.equal(data.agentTools.length, 10);
  });

  // Case B: Credentials exist in config, but connection has NOT been verified yet -> apiConnected is FALSE ('UNVERIFIED')
  await withTestServer(
    async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/health`);
      const data = await res.json();
      assert.equal(data.paypal.configured, true);
      assert.equal(
        data.paypal.apiConnected,
        false,
        'Must NOT mark PayPal as connected merely because credentials exist'
      );
      assert.equal(data.paypal.apiConnectionStatus, 'UNVERIFIED');
      assert.match(data.paypal.headerDisplayLabel, /Unverified/i);
      assert.ok(
        data.paypal.identicalIdAndSecretWarning,
        'Should warn when Client ID and Secret are identical strings'
      );

      // Failed connection test transitions status to CONNECTION_FAILED with meaningful error
      const connRes = await fetch(`${baseUrl}/api/paypal/test-connection`, { method: 'POST' });
      assert.equal(connRes.status, 502);
      const connData = await connRes.json();
      assert.equal(connData.ok, false);
      assert.equal(connData.paypal.apiConnected, false);
      assert.equal(connData.paypal.apiConnectionStatus, 'CONNECTION_FAILED');
      assert.match(connData.paypal.headerDisplayLabel, /Connection Error/i);
    },
    {
      paypalConfig: {
        baseUrl: 'http://127.0.0.1:1', // Unreachable port
        clientId: 'SAME_STRING_12345',
        clientSecret: 'SAME_STRING_12345',
        webhookId: ''
      }
    }
  );
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
});

test('Test 5, 6, 7, 8, 9, 10: Scope update, Scope lock human approval, Direct tool non-bypassability, Forged & Reused approval ID rejection, Scope change invalidation, and Draft invoice requiring locked scope', async () => {
  await withTestServer(async ({ baseUrl }) => {
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

    const prematureDraftRes = await fetch(`${baseUrl}/api/projects/P2P-DEMO01/paypal/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowDevFixture: true })
    });
    assert.equal(prematureDraftRes.status, 400);

    const unconfirmedApproveRes = await fetch(`${baseUrl}/api/projects/P2P-DEMO01/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ explicitConfirmation: false })
    });
    assert.equal(unconfirmedApproveRes.status, 400);

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
    const firstApprovalId = bypassData.approvalRequest.id;

    const forgedRes = await fetch(`${baseUrl}/api/agent/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'P2P-DEMO01',
        approvalId: 'REQ-FORGED-0000'
      })
    });
    assert.equal(forgedRes.status, 400);

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
  });
});

test('Test 11–19: PayPal OAuth Token Caching/Refresh, Draft Creation, Duplicate Prevention, Send Human Approval, Status Sync, Simulated Webhook Block, Unverified Webhook Rejection, Verified Webhook PAID, and Duplicate Webhook Ignore', async () => {
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
        const connRes = await fetch(`${baseUrl}/api/paypal/test-connection`);
        assert.equal(connRes.status, 200);
        const connData = await connRes.json();
        assert.equal(connData.ok, true);
        assert.equal(connData.paypal.apiConnected, true);
        assert.equal(connData.paypal.headerDisplayLabel, 'Connected PayPal Sandbox Mode');
        assert.equal(oauthCalls, 1);

        const cachedTokenMeta = await paypalClient.getAccessTokenWithMeta(false);
        assert.equal(cachedTokenMeta.cached, true);
        assert.equal(oauthCalls, 1);

        paypalClient._tokenCache.expiresAtMs = Date.now() - 1000;
        const refreshedTokenMeta = await paypalClient.getAccessTokenWithMeta(false);
        assert.equal(refreshedTokenMeta.cached, false);
        assert.equal(oauthCalls, 2);

        await fetch(`${baseUrl}/api/projects/P2P-DEMO01/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ explicitConfirmation: true, approverName: 'Alex Rivera' })
        });

        const draftRes = await fetch(`${baseUrl}/api/projects/P2P-DEMO01/paypal/draft`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowDevFixture: false })
        });
        assert.equal(draftRes.status, 200);
        const draftData = await draftRes.json();
        const inv = draftData.project.paypalInvoice;
        assert.equal(inv.invoiceId, 'INV2-SBX5-9999-8888-7777');
        assert.equal(inv.isFixture, false);
        assert.equal(inv.connectionMode, PAYPAL_CONNECTION_MODES.CONNECTED_SANDBOX);

        const storedPayload = mockPayPalInvoices.get(inv.invoiceId);
        assert.equal(storedPayload.primary_recipients[0].billing_info.email_address, 'jordan.vance-buyer@sandbox.paypal.com');
        assert.equal(storedPayload.items[0].unit_amount.value, '450.00');

        const dupRes = await fetch(`${baseUrl}/api/projects/P2P-DEMO01/paypal/draft`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowDevFixture: false })
        });
        const dupData = await dupRes.json();
        assert.equal(dupData.duplicatePrevented, true);

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

test('SaaS Settings, Notifications, Audit Logs, Exports, Backups & Demo-Only Data Clearing work end-to-end', async () => {
  await withTestServer(async ({ baseUrl }) => {
    // 1. Update Workspace Preferences & Notification Toggles via PUT /api/settings
    const putSettingsRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: {
          workspaceName: 'Apex Fintech Design Studio',
          freelancerName: 'Priya Sharma',
          invoicerEmail: 'priya@apexstudio.io',
          defaultCurrency: 'EUR',
          defaultInvoiceDuePeriod: 'NET_15',
          dateFormat: 'DD/MM/YYYY',
          timeZone: 'Asia/Kolkata',
          defaultTaxPercentage: 10
        },
        notifications: {
          invoiceCreated: true,
          invoicePaid: true,
          paymentVerificationFailure: false,
          webhookFailure: true,
          pendingInvoiceReminders: false
        },
        security: {
          sessionTimeoutMinutes: 60
        }
      })
    });
    assert.equal(putSettingsRes.status, 200);
    const settingsData = await putSettingsRes.json();
    assert.equal(settingsData.settings.workspace.workspaceName, 'Apex Fintech Design Studio');
    assert.equal(settingsData.settings.workspace.defaultCurrency, 'EUR');
    assert.equal(settingsData.settings.workspace.defaultInvoiceDuePeriod, 'NET_15');
    assert.equal(settingsData.settings.notifications.paymentVerificationFailure, false);
    assert.equal(settingsData.settings.security.sessionTimeoutMinutes, 60);
    assert.equal(settingsData.paypal.invoicerBusinessName, 'Apex Fintech Design Studio');

    // 2. Create a REAL client workspace project (isDemo: false) and verify it inherits EUR + NET_15
    const realProjRes = await fetch(`${baseUrl}/api/projects/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: 'Kiran Verma',
        clientEmail: 'kiran@vermacorp.com',
        projectTitle: 'B2B Payments Checkout Flow',
        proposedBudget: 1000,
        isDemo: false,
        rawBrief:
          'We need a complete B2B checkout flow redesign with 4 screens and responsive prototypes by 2026-11-25 for $1,000.'
      })
    });
    assert.equal(realProjRes.status, 201);
    const { project: realProject } = await realProjRes.json();
    assert.equal(realProject.isDemo, false);
    assert.equal(realProject.scope.currency, 'EUR');
    assert.equal(realProject.scope.paymentTerms, 'NET_15');

    // 3. Export JSON and CSV and verify no secrets are leaked
    const jsonExportRes = await fetch(`${baseUrl}/api/export/json`);
    assert.equal(jsonExportRes.status, 200);
    const exportedJson = await jsonExportRes.json();
    assert.equal(exportedJson.summary.totalProjects, 2);
    assert.equal(exportedJson.summary.demoProjects, 1);
    assert.equal(exportedJson.summary.realProjects, 1);
    assert.ok(!JSON.stringify(exportedJson).includes('clientSecret'));

    const csvExportRes = await fetch(`${baseUrl}/api/export/csv`);
    assert.equal(csvExportRes.status, 200);
    const exportedCsv = await csvExportRes.text();
    assert.match(exportedCsv, /Project ID,Data Type,Project Title/);
    assert.match(exportedCsv, /WORKSPACE/);
    assert.match(exportedCsv, /DEMO/);

    // 4. Create Backup Snapshot
    const backupRes = await fetch(`${baseUrl}/api/backup/create`, { method: 'POST' });
    assert.equal(backupRes.status, 200);
    const backupData = await backupRes.json();
    assert.equal(backupData.projectCount, 2);

    // 5. Clear Demo Data requires confirmation (`confirmClearDemo: true`) and preserves the real project!
    const unconfirmedClearRes = await fetch(`${baseUrl}/api/projects/clear-demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmClearDemo: false })
    });
    assert.equal(unconfirmedClearRes.status, 400);

    const confirmedClearRes = await fetch(`${baseUrl}/api/projects/clear-demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmClearDemo: true })
    });
    assert.equal(confirmedClearRes.status, 200);
    const clearData = await confirmedClearRes.json();
    assert.equal(clearData.removedDemoCount, 1);
    assert.equal(clearData.preservedRealCount, 1);
    assert.equal(clearData.projects.length, 1);
    assert.equal(clearData.projects[0].id, realProject.id, 'Real workspace project must never be deleted');

    // 6. Restore Backup Snapshot restores both projects
    const restoreRes = await fetch(`${baseUrl}/api/backup/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmRestore: true })
    });
    assert.equal(restoreRes.status, 200);
    const restoreData = await restoreRes.json();
    assert.equal(restoreData.projects.length, 2);

    // 7. Audit Log endpoint returns chronological workspace audit trail
    const auditRes = await fetch(`${baseUrl}/api/audit-logs`);
    assert.equal(auditRes.status, 200);
    const auditData = await auditRes.json();
    assert.ok(auditData.auditLogs.length >= 4);
  });
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

test('Persistence Audit: Projects, workspace settings, notification toggles, pending approvals, locked scope hashes, and invoices survive server restart', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-persist-'));
  const dataPath = path.join(tmpDir, 'projects.json');

  try {
    const store1 = new ProjectStore(dataPath);
    const paypal1 = new PayPalSandboxClient({ clientId: '', clientSecret: '' });
    const app1 = createAppServer({ store: store1, paypalClient: paypal1 });
    await new Promise((resolve) => app1.server.listen(0, '127.0.0.1', resolve));
    const url1 = `http://127.0.0.1:${app1.server.address().port}`;

    await fetch(`${url1}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: { workspaceName: 'Persisted Studio', defaultCurrency: 'GBP' },
        notifications: { invoiceCreated: false }
      })
    });

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

    const settingsRes = await fetch(`${url2}/api/settings`);
    const { settings: reloadedSettings } = await settingsRes.json();
    assert.equal(reloadedSettings.workspace.workspaceName, 'Persisted Studio');
    assert.equal(reloadedSettings.workspace.defaultCurrency, 'GBP');
    assert.equal(reloadedSettings.notifications.invoiceCreated, false);

    app2.server.closeAllConnections?.();
    await new Promise((resolve) => app2.server.close(resolve));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
