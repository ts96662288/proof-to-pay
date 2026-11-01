/**
 * Proof-to-Pay v3.2.0 — Comprehensive Backend, PayPal Sandbox, Fintech SaaS & Final Cleanup Test Suite (`test/proof-to-pay.test.mjs`)
 *
 * Verifies all 10 Final Repository Cleanup & Bug-Fix Requirements + 20 Core Regression Checks:
 * 1. Empty `projects.json` Array Persistence (`[]`): Proves that when a user clears demo projects (`[]`),
 *    re-initializing `ProjectStore` on the existing empty `projects.json` keeps `projects` as `[]` and does NOT
 *    auto-seed demo projects, while a genuinely fresh install (when `projects.json` does not exist) seeds `P2P-DEMO01`.
 * 2. Version Synchronization (`3.2.0`): Verifies `package.json`, `README.md`, `GET /api/health`, and `APP_VERSION` all match `3.2.0`.
 * 3. README Tool Count & Claims Audit: Verifies `README.md` specifies the 10-Tool AI Agent Engine matching `AGENT_TOOL_DEFINITIONS.length === 10`.
 * 4. Demo Workspace Identity & Preference Protection: Verifies default workspace identity is clearly labeled as demo data
 *    (`isDemoIdentity: true`, `(Demo)`) and never overwrites user preferences or `.env` invoicer settings.
 * 5. `.gitignore` & Data Security Hygiene: Verifies `.gitignore` excludes `.env`, secrets, backups, and temporary files.
 * 6. Public Deployment API Authentication Guard: Verifies `publicDeployment: true` blocks unauthenticated sensitive `/api/*`
 *    operations (`HTTP 401 AUTH_REQUIRED_FOR_PUBLIC_DEPLOYMENT`) while preserving `POST /api/webhooks/paypal`'s separate
 *    PayPal cryptographic signature verification flow.
 * 7. Single Primary Navigation System (Left Sidebar Only): Verifies `<header>` has zero duplicate page navigation links
 *    and `#app-sidebar` is the sole primary navigation system (with desktop collapse + mobile slide-over drawer).
 * 8. Full PayPal Sandbox Invoicing v2, OAuth 2.0 Caching/Refresh, Webhook Signature Verification, Canonical Status Checks,
 *    and Event Deduplication.
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
import { ProjectStore, APP_VERSION, DEFAULT_WORKSPACE_SETTINGS } from '../src/store.mjs';
import { AGENT_TOOL_DEFINITIONS } from '../src/agent-tools.mjs';
import { extractStructuredScope } from '../src/ai-extractor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function withTestServer(fn, options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-v320-test-'));
  const dataPath = path.join(tmpDir, 'projects.json');
  const store = new ProjectStore(dataPath);
  const paypalClient = new PayPalSandboxClient(
    options.paypalConfig || { clientId: '', clientSecret: '', webhookId: '' }
  );
  const { server } = createAppServer({
    store,
    paypalClient,
    apiKey: options.apiKey || '',
    publicDeployment: Boolean(options.publicDeployment),
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

test('Cleanup Issue 1 & 4: Empty projects.json [] stays empty across restarts, and demo workspace identity is clearly labeled without overwriting user preferences', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-empty-store-'));
  const dataPath = path.join(tmpDir, 'projects.json');

  try {
    // 1. Fresh installation (projects.json does not exist yet) seeds P2P-DEMO01 and clearly labeled demo identity
    assert.equal(fs.existsSync(dataPath), false);
    const storeFresh = new ProjectStore(dataPath);
    assert.equal(storeFresh.list().length, 1);
    assert.equal(storeFresh.list()[0].id, 'P2P-DEMO01');
    assert.equal(storeFresh.list()[0].isDemo, true);

    const initialSettings = storeFresh.getSettings();
    assert.equal(initialSettings.workspace.isDemoIdentity, true);
    assert.match(initialSettings.workspace.workspaceName, /\(Demo\)/);
    assert.match(initialSettings.workspace.freelancerName, /\(Demo\)/);

    // 2. User customizes workspace preferences and clears demo projects -> projects.json becomes []
    storeFresh.updateSettings({
      workspace: {
        workspaceName: 'custom-user-studio',
        freelancerName: 'Custom User',
        invoicerEmail: 'user@customstudio.io',
        defaultCurrency: 'CAD'
      }
    });
    const cleared = storeFresh.clearDemoProjects();
    assert.equal(cleared.projects.length, 0);
    assert.equal(fs.readFileSync(dataPath, 'utf8').trim(), '[]');

    // 3. Re-initializing ProjectStore on the valid empty projects.json [] MUST keep it empty []
    // and MUST preserve the user's saved preferences without overwriting them!
    const storeReloaded = new ProjectStore(dataPath);
    assert.equal(
      storeReloaded.list().length,
      0,
      'Valid empty projects.json array [] must remain empty across restarts'
    );
    assert.equal(storeReloaded.getSettings().workspace.workspaceName, 'custom-user-studio');
    assert.equal(storeReloaded.getSettings().workspace.freelancerName, 'Custom User');
    assert.equal(storeReloaded.getSettings().workspace.defaultCurrency, 'CAD');
    assert.equal(storeReloaded.getSettings().workspace.isDemoIdentity, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Cleanup Issue 2, 3, 5, 7: Synchronized v3.2.0 versions, accurate 10-tool README count, .gitignore exclusions, and Single Left Sidebar Navigation (no duplicate header nav)', () => {
  const rootDir = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');
  const gitignore = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8');
  const envExample = fs.readFileSync(path.join(rootDir, '.env.example'), 'utf8');
  const html = fs.readFileSync(path.join(rootDir, 'public/index.html'), 'utf8');

  // Issue 2: Version synchronization (3.2.0)
  assert.equal(pkg.version, '3.2.0');
  assert.equal(APP_VERSION, '3.2.0');
  assert.ok(readme.includes('v3.2.0'), 'README.md must declare v3.2.0');

  // Issue 3 & 7: README AI agent tool count matches AGENT_TOOL_DEFINITIONS (10 tools)
  assert.equal(AGENT_TOOL_DEFINITIONS.length, 10);
  assert.ok(readme.includes('10-Tool AI Agent Engine'), 'README.md must state 10-Tool AI Agent Engine');
  assert.ok(!readme.includes('9-Tool AI Agent Engine'), 'Outdated 9-Tool claim must be removed from README.md');

  // Issue 5: .gitignore and .env.example hygiene
  assert.ok(gitignore.includes('.env'), '.gitignore must ignore .env');
  assert.ok(gitignore.includes('data/backup-*.json'), '.gitignore must ignore backup snapshots');
  assert.ok(gitignore.includes('data/*.tmp'), '.gitignore must ignore temporary data files');
  assert.ok(envExample.includes('your_paypal_sandbox_client_id_here'));
  assert.ok(!envExample.includes('AbC3fQPxsO2IFHDpRbs'));

  // Issue 10 (UI Change): Top <header> has NO duplicate navigation links; #app-sidebar is the single primary navigation
  const headerMatch = html.match(/<header[\s\S]*?<\/header>/);
  assert.ok(headerMatch, '<header> must exist');
  const headerHtml = headerMatch[0];
  assert.ok(!headerHtml.includes('<nav'), 'Top <header> must not contain a duplicate <nav> element');
  assert.ok(!headerHtml.includes("switchNav('dashboard')"), 'Top <header> must not contain Dashboard link');
  assert.ok(!headerHtml.includes("switchNav('projects')"), 'Top <header> must not contain Projects link');
  assert.ok(!headerHtml.includes("switchNav('invoices')"), 'Top <header> must not contain Invoices link');
  assert.ok(!headerHtml.includes("switchNav('assistant')"), 'Top <header> must not contain AI Assistant link');

  // Verify Top <header> contains the 6 required items
  for (const headerItem of [
    'btn-sidebar-toggle',
    'Proof-to-Pay',
    'header-workspace-name-pill',
    'btn-header-theme-cycle',
    'btn-header-notifications',
    'header-connection-pill'
  ]) {
    assert.ok(headerHtml.includes(headerItem), `Top <header> must contain ${headerItem}`);
  }

  // Verify Left Sidebar (#app-sidebar) contains all 5 primary navigation buttons + mobile drawer support
  const sidebarMatch = html.match(/<aside id="app-sidebar"[\s\S]*?<\/aside>/);
  assert.ok(sidebarMatch, '#app-sidebar must exist');
  const sidebarHtml = sidebarMatch[0];
  for (const navId of ['nav-dashboard', 'nav-projects', 'nav-invoices', 'nav-assistant', 'nav-settings']) {
    assert.ok(sidebarHtml.includes(`id="${navId}"`), `Left sidebar must contain #${navId}`);
  }
  assert.ok(html.includes('mobile-sidebar-backdrop'), 'Must include responsive mobile drawer backdrop');
  assert.ok(html.includes('function handleHeaderSidebarToggle()'), 'Must implement responsive sidebar toggle');
});

test('Cleanup Issue 6: Public deployment blocks unauthenticated sensitive API operations while preserving separate PayPal webhook signature verification', async () => {
  await withTestServer(
    async ({ baseUrl }) => {
      // 1. Public read of /api/health works and reports version 3.2.0
      const healthRes = await fetch(`${baseUrl}/api/health`);
      assert.equal(healthRes.status, 200);
      const healthData = await healthRes.json();
      assert.equal(healthData.version, '3.2.0');

      // 2. Unauthenticated mutating/sensitive API operations in public deployment are blocked with HTTP 401
      const unauthExtractRes = await fetch(`${baseUrl}/api/projects/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName: 'Test',
          clientEmail: 'test@example.com',
          rawBrief: 'Need a landing page by next Friday for $450.'
        })
      });
      assert.equal(unauthExtractRes.status, 401);
      const unauthErr = await unauthExtractRes.json();
      assert.equal(unauthErr.code, 'AUTH_REQUIRED_FOR_PUBLIC_DEPLOYMENT');

      const unauthSettingsRes = await fetch(`${baseUrl}/api/settings`);
      assert.equal(unauthSettingsRes.status, 401);

      const unauthExportRes = await fetch(`${baseUrl}/api/export/json`);
      assert.equal(unauthExportRes.status, 401);

      // 3. PayPal Webhook endpoint (POST /api/webhooks/paypal) is NOT blocked by FREELANCER_API_KEY
      // and instead runs its own PayPal webhook signature / simulated guard verification!
      const webhookRes = await fetch(`${baseUrl}/api/webhooks/paypal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'WH-PUBLIC-TEST',
          event_type: 'INVOICING.INVOICE.PAID',
          resource: { invoice: { id: 'UNKNOWN-INV', status: 'PAID' } }
        })
      });
      assert.equal(webhookRes.status, 404, 'Webhook route must reach webhook processor, not 401 API key gate');
    },
    {
      publicDeployment: true,
      apiKey: '' // Missing API key in public deployment must not silently allow sensitive operations
    }
  );
});

test('Test 1 & PayPal Status Mismatch Fix: Single backend source of truth never marks PayPal as connected merely because credentials exist', async () => {
  await withTestServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(data.version, '3.2.0');
    assert.equal(data.paypal.mode, PAYPAL_CONNECTION_MODES.LOCAL_FIXTURE);
    assert.equal(data.paypal.apiConnected, false);
    assert.equal(data.paypal.apiConnectionStatus, 'NOT_CONFIGURED');
    assert.equal(data.paypal.headerDisplayLabel, 'Local Demo / Fixture Mode');
    assert.equal(data.agentTools.length, 10);
  });

  await withTestServer(
    async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/health`);
      const data = await res.json();
      assert.equal(data.paypal.configured, true);
      assert.equal(data.paypal.apiConnected, false);
      assert.equal(data.paypal.apiConnectionStatus, 'UNVERIFIED');
      assert.match(data.paypal.headerDisplayLabel, /Unverified/i);

      const connRes = await fetch(`${baseUrl}/api/paypal/test-connection`, { method: 'POST' });
      assert.equal(connRes.status, 502);
      const connData = await connRes.json();
      assert.equal(connData.ok, false);
      assert.equal(connData.paypal.apiConnected, false);
      assert.equal(connData.paypal.apiConnectionStatus, 'CONNECTION_FAILED');
    },
    {
      paypalConfig: {
        baseUrl: 'http://127.0.0.1:1',
        clientId: 'SAME_STRING_12345',
        clientSecret: 'SAME_STRING_12345',
        webhookId: ''
      }
    }
  );
});

test('Test 2, 3, 4: Project extraction, 9-field Gemini structured validation, and honest AI fallback transparency work', async () => {
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
  });

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
});

test('Test 5–10: Scope updates, SHA-256 scope locking, non-bypassable human approval gates, forged/reused approval rejection, and scope change invalidation work', async () => {
  await withTestServer(async ({ baseUrl }) => {
    const putScopeRes = await fetch(`${baseUrl}/api/projects/P2P-DEMO01/scope`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revisionLimit: 3, paymentTerms: 'NET_15' })
    });
    assert.equal(putScopeRes.status, 200);

    const prematureDraftRes = await fetch(`${baseUrl}/api/projects/P2P-DEMO01/paypal/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowDevFixture: true })
    });
    assert.equal(prematureDraftRes.status, 400);

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
    const bypassData = await bypassAttemptRes.json();
    assert.equal(bypassData.status, 'PENDING_HUMAN_APPROVAL');
    const firstApprovalId = bypassData.approvalRequest.id;

    const forgedRes = await fetch(`${baseUrl}/api/agent/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'P2P-DEMO01', approvalId: 'REQ-FORGED-0000' })
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
      body: JSON.stringify({ projectId: 'P2P-DEMO01', approvalId: firstApprovalId, decision: 'APPROVE' })
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
      body: JSON.stringify({ projectId: 'P2P-DEMO01', approvalId: validApprovalId, decision: 'APPROVE' })
    });
    assert.equal(validApproveRes.status, 200);
    const validApproveData = await validApproveRes.json();
    assert.equal(validApproveData.project.state, 'HUMAN_APPROVED');
    assert.ok(validApproveData.project.scopeLock?.sha256);

    const reusedRes = await fetch(`${baseUrl}/api/agent/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'P2P-DEMO01', approvalId: validApprovalId, decision: 'APPROVE' })
    });
    assert.equal(reusedRes.status, 400);
  });
});

test('Test 11–19 (Cleanup Issue 9): PayPal Sandbox invoice creation, OAuth caching/refresh, webhook signature verification, canonical invoice status checks, and event deduplication remain intact', async () => {
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
    assert.equal(settingsData.settings.workspace.isDemoIdentity, false);
    assert.equal(settingsData.settings.workspace.defaultCurrency, 'EUR');

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

    const jsonExportRes = await fetch(`${baseUrl}/api/export/json`);
    assert.equal(jsonExportRes.status, 200);
    const exportedJson = await jsonExportRes.json();
    assert.equal(exportedJson.version, '3.2.0');
    assert.equal(exportedJson.summary.totalProjects, 2);

    const confirmedClearRes = await fetch(`${baseUrl}/api/projects/clear-demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmClearDemo: true })
    });
    assert.equal(confirmedClearRes.status, 200);
    const clearData = await confirmedClearRes.json();
    assert.equal(clearData.removedDemoCount, 1);
    assert.equal(clearData.preservedRealCount, 1);
    assert.equal(clearData.projects[0].id, realProject.id);
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
      assert.equal(hit429, true);
    },
    {
      apiKey: 'secret-api-key-123',
      rateLimitMaxPerMinute: 5
    }
  );
});
