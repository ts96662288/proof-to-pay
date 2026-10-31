/**
 * Proof-to-Pay v3.1 — Secure HTTP Server & REST API Controller (`src/server.mjs`)
 *
 * Implements all 12 required backend endpoints + PayPal connection verification + security hardening:
 * - `GET  /api/health`
 * - `GET  /api/paypal/test-connection` (and `POST /api/paypal/test-connection`)
 * - `GET  /api/projects`
 * - `POST /api/projects/extract`
 * - `POST /api/agent/chat`
 * - `POST /api/agent/tool`
 * - `POST /api/agent/approve`
 * - `PUT  /api/projects/:id/scope`
 * - `POST /api/projects/:id/approve`
 * - `POST /api/projects/:id/paypal/draft`
 * - `POST /api/projects/:id/paypal/send`
 * - `POST /api/projects/:id/paypal/remind`
 * - `POST /api/projects/:id/paypal/cancel`
 * - `POST /api/projects/:id/paypal/sync`
 * - `POST /api/webhooks/paypal`
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBriefInput, ValidationError } from './schema.mjs';
import { extractStructuredScope } from './ai-extractor.mjs';
import {
  PayPalSandboxClient,
  MissingPayPalCredentialsError,
  PayPalApiError
} from './paypal-client.mjs';
import {
  createProjectRecord,
  updateProjectScope,
  approveAndLockScope,
  executeCreatePayPalDraft,
  executeSendPayPalInvoice,
  executeSendInvoiceReminder,
  executeCancelPayPalInvoice,
  syncCanonicalInvoiceStatus,
  processPayPalWebhookEvent
} from './state-machine.mjs';
import {
  AGENT_TOOL_DEFINITIONS,
  executeAgentTool,
  approvePendingToolAction,
  handleAgentConversation
} from './agent-tools.mjs';
import { ProjectStore, DEMO_BRIEFS, DEFAULT_OWNER_ID } from './store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadEnvFile(envPath = path.resolve(__dirname, '../.env')) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

loadEnvFile();

export function createAppServer(deps = {}) {
  const store = deps.store || new ProjectStore(deps.dataPath);
  const paypalClient = deps.paypalClient || new PayPalSandboxClient(deps.paypalConfig);
  const publicDir = deps.publicDir || path.resolve(__dirname, '../public');
  const requiredApiKey = deps.apiKey ?? process.env.FREELANCER_API_KEY ?? '';
  const rateLimitMax = Number(deps.rateLimitMaxPerMinute || process.env.RATE_LIMIT_MAX_PER_MIN || 180);
  const allowedOrigins = new Set(
    (deps.allowedOrigins || process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  );

  /** @type {Map<string, { count: number, resetAt: number }>} */
  const rateLimitBuckets = new Map();

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // 1. Security Headers & CORS Origin Restriction
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');

    const requestOrigin = req.headers.origin;
    if (requestOrigin) {
      const hostOrigin = `http://${req.headers.host}`;
      if (!allowedOrigins.has(requestOrigin) && requestOrigin !== hostOrigin) {
        return sendJson(res, 403, {
          error: `CORS policy blocked request from untrusted origin: ${requestOrigin}`,
          code: 'CORS_ORIGIN_FORBIDDEN'
        });
      }
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Freelancer-Key, X-Freelancer-Id'
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 2. Per-IP Rate Limiting
    const clientIp = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1');
    const nowMs = Date.now();
    let bucket = rateLimitBuckets.get(clientIp);
    if (!bucket || nowMs > bucket.resetAt) {
      bucket = { count: 0, resetAt: nowMs + 60_000 };
      rateLimitBuckets.set(clientIp, bucket);
    }
    bucket.count += 1;
    if (bucket.count > rateLimitMax) {
      res.setHeader('Retry-After', '60');
      return sendJson(res, 429, {
        error: 'Rate limit exceeded. Please wait before sending more requests.',
        code: 'RATE_LIMIT_EXCEEDED'
      });
    }

    // 3. Authentication & Project Ownership Context (for /api/* except PayPal webhook callbacks)
    const reqOwnerId = String(req.headers['x-freelancer-id'] || DEFAULT_OWNER_ID).trim();
    if (pathname.startsWith('/api/') && pathname !== '/api/webhooks/paypal' && requiredApiKey) {
      const authHeader = String(req.headers.authorization || '');
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const keyHeader = String(req.headers['x-freelancer-key'] || '').trim();
      if (bearerToken !== requiredApiKey && keyHeader !== requiredApiKey) {
        return sendJson(res, 401, {
          error: 'Unauthorized: Valid Authorization Bearer token or X-Freelancer-Key header is required.',
          code: 'UNAUTHORIZED'
        });
      }
    }

    try {
      // Endpoint 1: GET /api/health
      if (req.method === 'GET' && pathname === '/api/health') {
        const geminiConfigured = Boolean(
          process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.includes('your_')
        );
        const openaiConfigured = Boolean(
          process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.includes('your_')
        );
        const aiConfigured = geminiConfigured || openaiConfigured;
        return sendJson(res, 200, {
          status: 'ok',
          service: 'Proof-to-Pay Freelancer Business Assistant',
          timestamp: new Date().toISOString(),
          paypal: paypalClient.getCredentialStatus(),
          agentTools: AGENT_TOOL_DEFINITIONS,
          ai: {
            configured: aiConfigured,
            provider: geminiConfigured
              ? 'google-gemini'
              : openaiConfigured
              ? 'openai'
              : 'deterministic-fallback',
            liveAiUsed: aiConfigured
          }
        });
      }

      // Safe PayPal Connection Verification Endpoint (`GET` or `POST /api/paypal/test-connection`)
      if (
        (req.method === 'GET' || req.method === 'POST') &&
        pathname === '/api/paypal/test-connection'
      ) {
        const result = await paypalClient.testConnection();
        return sendJson(res, result.ok ? 200 : 502, result);
      }

      // Presets helper
      if (req.method === 'GET' && pathname === '/api/presets') {
        return sendJson(res, 200, { presets: DEMO_BRIEFS });
      }

      // Endpoint 2: GET /api/projects (Scoped to authenticated freelancer ownerId)
      if (req.method === 'GET' && pathname === '/api/projects') {
        return sendJson(res, 200, { projects: store.list(reqOwnerId) });
      }

      if (req.method === 'POST' && pathname === '/api/projects/reset') {
        const projects = store.resetToDemoSeed(reqOwnerId);
        return sendJson(res, 200, { projects });
      }

      // Endpoint 3: POST /api/projects/extract
      if (req.method === 'POST' && pathname === '/api/projects/extract') {
        const body = await readJsonBody(req);
        const validatedInput = validateBriefInput(body);
        const proposedBudget = body.proposedBudget ? Number(body.proposedBudget) : null;
        const { scope, analysisDetails, extractionMeta } = await extractStructuredScope({
          ...validatedInput,
          proposedBudget
        });
        const project = createProjectRecord({
          rawBrief: validatedInput.rawBrief,
          extractedScope: scope,
          analysisDetails,
          extractionMeta,
          proposedBudget
        });
        project.ownerId = reqOwnerId;
        await executeAgentTool({
          toolName: 'extract_project_requirements',
          args: { rawBrief: validatedInput.rawBrief, proposedBudget },
          project,
          paypalClient,
          reasoningSummary: 'Automatically ran extract_project_requirements() on newly created project.'
        });
        await executeAgentTool({
          toolName: 'identify_ambiguities',
          project,
          paypalClient,
          reasoningSummary: 'Automatically ran identify_ambiguities() to flag unclear requirements and missing info.'
        });
        store.upsert(project);
        return sendJson(res, 201, { project });
      }

      // Endpoint 4: POST /api/agent/chat
      if (req.method === 'POST' && pathname === '/api/agent/chat') {
        const body = await readJsonBody(req);
        const project = body.projectId ? store.getById(body.projectId) : store.list(reqOwnerId)[0];
        if (!project) {
          return sendJson(res, 404, { error: 'No active project found.' });
        }
        verifyProjectOwnership(project, reqOwnerId);
        const outcome = await handleAgentConversation({
          message: body.message,
          project,
          paypalClient
        });
        store.upsert(outcome.project);
        return sendJson(res, 200, outcome);
      }

      // Endpoint 5: POST /api/agent/tool
      if (req.method === 'POST' && pathname === '/api/agent/tool') {
        const body = await readJsonBody(req);
        const project = body.projectId ? store.getById(body.projectId) : store.list(reqOwnerId)[0];
        if (!project) {
          return sendJson(res, 404, { error: 'Project not found.' });
        }
        verifyProjectOwnership(project, reqOwnerId);
        // Note: Direct calls to /api/agent/tool NEVER receive verifiedApprovalId, so sensitive tools
        // always create a PENDING_HUMAN_APPROVAL record and cannot bypass human approval.
        const outcome = await executeAgentTool({
          toolName: body.toolName,
          args: body.args || {},
          project,
          paypalClient,
          verifiedApprovalId: null,
          reasoningSummary: body.reasoningSummary || ''
        });
        store.upsert(outcome.project);
        return sendJson(res, 200, outcome);
      }

      // Endpoint 6: POST /api/agent/approve
      if (req.method === 'POST' && pathname === '/api/agent/approve') {
        const body = await readJsonBody(req);
        const project = body.projectId ? store.getById(body.projectId) : store.list(reqOwnerId)[0];
        if (!project) {
          return sendJson(res, 404, { error: 'Project not found.' });
        }
        verifyProjectOwnership(project, reqOwnerId);
        const outcome = await approvePendingToolAction({
          project,
          paypalClient,
          approvalId: body.approvalId,
          decision: body.decision === 'REJECT' ? 'REJECT' : 'APPROVE',
          args: body.args || {}
        });
        store.upsert(outcome.project);
        return sendJson(res, 200, outcome);
      }

      // Project-specific routes (`/api/projects/:id...`)
      const projectMatch = pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)(?:\/(.*))?$/);
      if (projectMatch) {
        const projectId = projectMatch[1];
        const subRoute = projectMatch[2] || '';
        const project = store.getById(projectId);

        if (!project) {
          return sendJson(res, 404, { error: `Project ${projectId} not found.` });
        }
        verifyProjectOwnership(project, reqOwnerId);

        if (req.method === 'GET' && subRoute === '') {
          return sendJson(res, 200, { project });
        }

        // Endpoint 7: PUT /api/projects/:id/scope
        if (req.method === 'PUT' && subRoute === 'scope') {
          const body = await readJsonBody(req);
          const updated = updateProjectScope(project, body.scope || body);
          store.upsert(updated);
          return sendJson(res, 200, { project: updated });
        }

        // Endpoint 8: POST /api/projects/:id/approve
        if (req.method === 'POST' && subRoute === 'approve') {
          const body = await readJsonBody(req);
          const approved = approveAndLockScope(project, body);
          store.upsert(approved);
          return sendJson(res, 200, { project: approved });
        }

        // Endpoint 9: POST /api/projects/:id/paypal/draft
        if (req.method === 'POST' && subRoute === 'paypal/draft') {
          const body = await readJsonBody(req);
          const result = await executeCreatePayPalDraft(project, paypalClient, {
            allowDevFixture: Boolean(body.allowDevFixture)
          });
          const updatedProject = result.project || result;
          store.upsert(updatedProject);
          return sendJson(res, 200, {
            project: updatedProject,
            duplicatePrevented: Boolean(result.duplicatePrevented),
            message: result.message || null
          });
        }

        // Endpoint 10: POST /api/projects/:id/paypal/send
        if (req.method === 'POST' && subRoute === 'paypal/send') {
          const body = await readJsonBody(req);
          const updated = await executeSendPayPalInvoice(project, paypalClient, {
            confirmSend: Boolean(body.confirmSend),
            allowDevFixture: Boolean(body.allowDevFixture)
          });
          store.upsert(updated);
          return sendJson(res, 200, { project: updated });
        }

        if (req.method === 'POST' && subRoute === 'paypal/remind') {
          const body = await readJsonBody(req);
          const updated = await executeSendInvoiceReminder(project, paypalClient, {
            humanApproved: Boolean(body.humanApproved),
            allowDevFixture: Boolean(body.allowDevFixture),
            subject: body.subject,
            note: body.note
          });
          store.upsert(updated);
          return sendJson(res, 200, { project: updated });
        }

        if (req.method === 'POST' && subRoute === 'paypal/cancel') {
          const body = await readJsonBody(req);
          const updated = await executeCancelPayPalInvoice(project, paypalClient, {
            allowDevFixture: Boolean(body.allowDevFixture),
            subject: body.subject,
            note: body.note
          });
          store.upsert(updated);
          return sendJson(res, 200, { project: updated });
        }

        // Endpoint 11: POST /api/projects/:id/paypal/sync
        if (req.method === 'POST' && subRoute === 'paypal/sync') {
          const body = await readJsonBody(req);
          const updated = await syncCanonicalInvoiceStatus(project, paypalClient, {
            allowDevFixture: Boolean(body.allowDevFixture)
          });
          store.upsert(updated);
          return sendJson(res, 200, { project: updated });
        }
      }

      // Endpoint 12: POST /api/webhooks/paypal
      if (req.method === 'POST' && pathname === '/api/webhooks/paypal') {
        const body = await readJsonBody(req);
        const outcome = await processPayPalWebhookEvent({
          projects: store.list(),
          headers: req.headers,
          webhookEvent: body,
          paypalClient
        });
        store.save();
        return sendJson(res, outcome.statusCode || 200, outcome);
      }

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const indexPath = path.join(publicDir, 'index.html');
        if (fs.existsSync(indexPath)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(fs.readFileSync(indexPath, 'utf8'));
          return;
        }
      }

      return sendJson(res, 404, { error: `Route ${req.method} ${pathname} not found.` });
    } catch (err) {
      if (err.statusCode === 403) {
        return sendJson(res, 403, {
          error: err.message,
          code: 'FORBIDDEN_PROJECT_OWNERSHIP'
        });
      }
      if (err instanceof ValidationError) {
        return sendJson(res, err.statusCode || 400, {
          error: err.message,
          code: 'VALIDATION_ERROR',
          details: err.details,
          recoveryAction: err.recoveryAction || null
        });
      }
      if (err instanceof MissingPayPalCredentialsError) {
        return sendJson(res, err.statusCode || 428, {
          error: err.message,
          code: err.code,
          remediation:
            'Configure PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in server .env for Connected PayPal Sandbox Mode, or use Local Demo / Fixture Mode (Simulated) for local evaluation.'
        });
      }
      if (err instanceof PayPalApiError) {
        return sendJson(res, err.statusCode || 502, {
          error: err.message,
          code: 'PAYPAL_API_ERROR',
          paypalDebugId: err.paypalDebugId || null,
          details: err.details
        });
      }
      return sendJson(res, 400, {
        error: err.message || 'Request failed',
        code: 'AGENT_OR_WORKFLOW_ERROR',
        recoveryAction: err.recoveryAction || null,
        executionLog: err.executionLog || null
      });
    }
  });

  return { server, store, paypalClient };
}

function verifyProjectOwnership(project, reqOwnerId) {
  const projectOwner = project.ownerId || DEFAULT_OWNER_ID;
  if (projectOwner !== reqOwnerId) {
    const err = new Error('Forbidden: You do not have permission to access or modify this project.');
    err.statusCode = 403;
    throw err;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new ValidationError('Request payload too large.'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ValidationError('Malformed JSON in request body.'));
      }
    });
    req.on('error', reject);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const { server, paypalClient } = createAppServer();
  server.listen(port, () => {
    const status = paypalClient.getCredentialStatus();
    console.log(`\n======================================================================`);
    console.log(`  Proof-to-Pay v3.1 — AI Freelancer Business Assistant`);
    console.log(`  Local URL:        http://localhost:${port}`);
    console.log(`  PayPal Mode:      ${status.connectionLabel}`);
    console.log(`  Webhook Endpoint: POST http://localhost:${port}/api/webhooks/paypal`);
    console.log(`======================================================================\n`);
  });
}
