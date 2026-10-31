/**
 * Proof-to-Pay v3.1 — Freelancer Project & Payment Lifecycle State Machine (`src/state-machine.mjs`)
 *
 * Enforces:
 * 1. Explicit Human Approval before locking the scope (`lock_scope`).
 * 2. Idempotency & Duplicate Invoice Protection: prevents creating a second PayPal invoice if an active
 *    draft or sent invoice already exists for the project.
 * 3. Explicit Human Approval before sending an invoice (`send_paypal_invoice`) or sending a reminder.
 * 4. Strict Payment Verification: Payment is ONLY marked `PAID` after verification through an authentic
 *    PayPal API response (`isFixture === false`) or a cryptographically verified PayPal webhook.
 *    Simulated events are NEVER treated as real `PAID` confirmations.
 */

import crypto from 'node:crypto';
import { validateScopeCard, buildPayPalInvoiceV2Payload, ValidationError } from './schema.mjs';

export const PROJECT_STATES = Object.freeze({
  DRAFT_SCOPE: 'DRAFT_SCOPE',
  HUMAN_APPROVED: 'HUMAN_APPROVED',
  PAYPAL_DRAFT_CREATED: 'PAYPAL_DRAFT_CREATED',
  INVOICE_SENT: 'INVOICE_SENT',
  PAID: 'PAID',
  CANCELLED: 'CANCELLED',
  REFUNDED: 'REFUNDED'
});

export function computeScopeHash(scope) {
  const canonicalJson = JSON.stringify({
    clientName: scope.clientName,
    clientEmail: scope.clientEmail,
    projectTitle: scope.projectTitle,
    deliverables: scope.deliverables.map((d) => ({ title: d.title, description: d.description })),
    exclusions: scope.exclusions,
    deadline: scope.deadline,
    currency: scope.currency,
    totalAmount: scope.totalAmount,
    paymentTerms: scope.paymentTerms,
    acceptanceCriteria: scope.acceptanceCriteria,
    lineItems: scope.lineItems.map((li) => ({
      name: li.name,
      quantity: li.quantity,
      unitPrice: li.unitPrice,
      subtotal: li.subtotal
    })),
    revisionLimit: scope.revisionLimit
  });
  return crypto.createHash('sha256').update(canonicalJson).digest('hex');
}

export function createProjectRecord({
  rawBrief,
  extractedScope,
  analysisDetails,
  extractionMeta,
  proposedBudget
}) {
  const now = new Date().toISOString();
  const validatedScope = validateScopeCard(extractedScope);
  const projectId = `PRJ-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  return {
    id: projectId,
    createdAt: now,
    updatedAt: now,
    state: PROJECT_STATES.DRAFT_SCOPE,
    rawBrief,
    proposedBudget: proposedBudget || null,
    analysisDetails: analysisDetails || null,
    extractionMeta,
    scope: validatedScope,
    scopeLock: null,
    paypalInvoice: null,
    processedWebhookEventIds: [],
    pendingApprovals: [],
    agentExecutionLog: [],
    timeline: [
      {
        step: 'DRAFT_SCOPE',
        label: '1. Project Created & AI Scope Analyzed',
        status: 'COMPLETED',
        timestamp: now,
        actor: 'AI Scope Assistant',
        detail: `Extracted ${validatedScope.deliverables.length} deliverables (${validatedScope.currency} $${validatedScope.totalAmount.toFixed(
          2
        )}) and identified ${validatedScope.riskFlags.length} scope/ambiguity items.`
      },
      {
        step: 'HUMAN_APPROVED',
        label: '2. Scope Reviewed & Locked',
        status: 'PENDING',
        timestamp: null,
        actor: 'Freelancer',
        detail: 'Awaiting your review and approval to lock the final Scope of Work.'
      },
      {
        step: 'PAYPAL_DRAFT_CREATED',
        label: '3. PayPal Invoice Draft Generated',
        status: 'PENDING',
        timestamp: null,
        actor: 'PayPal Invoicing API',
        detail: 'Generates a unique invoice number and draft invoice after scope lock.'
      },
      {
        step: 'INVOICE_SENT',
        label: '4. Invoice Sent to Client',
        status: 'PENDING',
        timestamp: null,
        actor: 'Freelancer + PayPal',
        detail: 'Requires your explicit confirmation before sending to the client.'
      },
      {
        step: 'PAYMENT_STATUS',
        label: '5. Verified Payment Confirmation',
        status: 'PENDING',
        timestamp: null,
        actor: 'PayPal Verification',
        detail: 'Marked PAID only after authentic PayPal API or cryptographically verified webhook confirmation.'
      }
    ],
    auditTrail: [
      {
        id: `AUD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
        timestamp: now,
        event: 'PROJECT_CREATED',
        actor: 'AI_ASSISTANT',
        verifiedSource: extractionMeta?.provider || 'scope-analyzer',
        summary: `Created project ${projectId} for ${validatedScope.clientName} (${validatedScope.currency} $${validatedScope.totalAmount.toFixed(2)}).`
      }
    ]
  };
}

export function updateProjectScope(project, updatedScopeInput) {
  if (
    project.state !== PROJECT_STATES.DRAFT_SCOPE &&
    project.state !== PROJECT_STATES.HUMAN_APPROVED
  ) {
    throw new ValidationError(
      `Scope cannot be modified because invoice ${project.paypalInvoice?.invoiceId} has already been created.`
    );
  }

  if (updatedScopeInput?.state === 'PAID' || updatedScopeInput?.paypalInvoice?.status === 'PAID') {
    throw new ValidationError('SECURITY VIOLATION: Cannot mark an invoice PAID through scope updates.');
  }

  const validated = validateScopeCard({
    ...project.scope,
    ...updatedScopeInput
  });
  const now = new Date().toISOString();
  const wasApproved = project.state === PROJECT_STATES.HUMAN_APPROVED;

  project.scope = validated;
  project.updatedAt = now;

  if (wasApproved) {
    project.state = PROJECT_STATES.DRAFT_SCOPE;
    project.scopeLock = null;
    updateTimelineStep(project, 'HUMAN_APPROVED', {
      status: 'PENDING',
      timestamp: null,
      detail: 'Scope was edited after approval; please review and lock the updated scope.'
    });
    project.auditTrail.push({
      id: `AUD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      timestamp: now,
      event: 'SCOPE_EDITED_UNLOCKED',
      actor: 'FREELANCER',
      verifiedSource: 'SCOPE_EDITOR',
      summary: `Scope updated (${validated.currency} $${validated.totalAmount.toFixed(2)}); previous lock cleared so you can re-approve.`
    });
  } else {
    project.auditTrail.push({
      id: `AUD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      timestamp: now,
      event: 'SCOPE_UPDATED',
      actor: 'FREELANCER',
      verifiedSource: 'SCOPE_EDITOR',
      summary: `Updated scope details (${validated.lineItems.length} item(s), total ${validated.currency} $${validated.totalAmount.toFixed(2)}).`
    });
  }

  return project;
}

export function approveAndLockScope(project, approvalInput = {}) {
  if (project.state !== PROJECT_STATES.DRAFT_SCOPE && project.state !== PROJECT_STATES.HUMAN_APPROVED) {
    throw new ValidationError(`Scope is already locked to an active invoice in state ${project.state}.`);
  }

  if (approvalInput.explicitConfirmation !== true) {
    throw new ValidationError(
      'Explicit human approval is required before locking the final scope (explicitConfirmation must be true).',
      ['explicitConfirmation']
    );
  }

  const approverName = String(approvalInput.approverName || 'Freelancer').trim();
  const validatedScope = validateScopeCard(approvalInput.scope || project.scope);
  const scopeHash = computeScopeHash(validatedScope);
  const approvalToken = `LOCK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const now = new Date().toISOString();
  const nextVersion = (project.scopeLock?.version || 0) + 1;

  project.scope = validatedScope;
  project.state = PROJECT_STATES.HUMAN_APPROVED;
  project.updatedAt = now;
  project.scopeLock = {
    version: nextVersion,
    sha256: scopeHash,
    approvedAt: now,
    approvedBy: approverName,
    approvalToken,
    lockedTotal: `${validatedScope.currency} ${validatedScope.totalAmount.toFixed(2)}`
  };

  updateTimelineStep(project, 'HUMAN_APPROVED', {
    status: 'COMPLETED',
    timestamp: now,
    actor: approverName,
    detail: `Scope v${nextVersion} approved and locked by ${approverName} for ${validatedScope.currency} $${validatedScope.totalAmount.toFixed(2)}.`
  });

  project.auditTrail.push({
    id: `AUD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    timestamp: now,
    event: 'SCOPE_LOCKED_BY_HUMAN',
    actor: approverName,
    verifiedSource: approvalToken,
    summary: `Approved and locked Scope v${nextVersion} (${validatedScope.currency} $${validatedScope.totalAmount.toFixed(2)}).`
  });

  return project;
}

/**
 * Generates a PayPal Draft Invoice (`POST /v2/invoicing/invoices`).
 * Enforces idempotency / protection against duplicate invoice creation:
 * If the project already has an active invoice (`DRAFT`, `SENT`, `UNPAID`, `PAID`),
 * returns `{ project, duplicatePrevented: true }` instead of creating a duplicate!
 */
export async function executeCreatePayPalDraft(project, paypalClient, options = {}) {
  // Protection against duplicate invoice creation
  if (
    project.paypalInvoice?.invoiceId &&
    project.paypalInvoice.status !== 'CANCELLED'
  ) {
    return {
      project,
      duplicatePrevented: true,
      message: `Invoice ${project.paypalInvoice.invoiceId} already exists for this project. Duplicate invoice creation prevented.`
    };
  }

  if (project.state !== PROJECT_STATES.HUMAN_APPROVED || !project.scopeLock) {
    throw new ValidationError(
      'You must review and approve (lock) the Scope of Work before generating a PayPal invoice.'
    );
  }

  const currentHash = computeScopeHash(project.scope);
  if (currentHash !== project.scopeLock.sha256) {
    throw new ValidationError(
      'The Scope of Work was modified since it was locked. Please re-approve the scope before generating an invoice.'
    );
  }

  const nextNumResult = await paypalClient.generateNextInvoiceNumber({
    allowDevFixture: Boolean(options.allowDevFixture)
  });

  const payload = buildPayPalInvoiceV2Payload(
    project.scope,
    paypalClient.invoicerConfig,
    project.scopeLock.sha256
  );
  payload.detail.invoice_number = nextNumResult.invoiceNumber;

  const idempotencyKey = `p2p-inv-${project.id}-v${project.scopeLock.version}`;
  const draftResult = await paypalClient.createDraftInvoice(payload, {
    allowDevFixture: Boolean(options.allowDevFixture),
    idempotencyKey
  });

  const now = new Date().toISOString();
  project.state = PROJECT_STATES.PAYPAL_DRAFT_CREATED;
  project.updatedAt = now;
  project.paypalInvoice = {
    invoiceId: draftResult.invoiceId,
    invoiceNumber: draftResult.invoiceNumber || nextNumResult.invoiceNumber,
    status: draftResult.status || 'DRAFT',
    connectionMode: draftResult.connectionMode,
    environment: draftResult.environment,
    isFixture: Boolean(draftResult.isFixture),
    paypalDebugId: draftResult.paypalDebugId || null,
    currency: draftResult.currency,
    totalAmount: draftResult.totalAmount,
    dueAmount: draftResult.dueAmount || draftResult.totalAmount,
    payerViewUrl: draftResult.payerViewUrl,
    createdAt: draftResult.createdAt || now,
    sentAt: null,
    paidAt: null,
    paymentVerifiedAuthentic: false,
    reminderCount: 0,
    lastReminderSentAt: null,
    lastVerifiedAt: now,
    scopeHashLocked: project.scopeLock.sha256,
    scopeVersionLocked: project.scopeLock.version
  };

  const modeTag = draftResult.isFixture ? 'Simulated Local Fixture' : 'PayPal Sandbox API';
  updateTimelineStep(project, 'PAYPAL_DRAFT_CREATED', {
    status: 'COMPLETED',
    timestamp: now,
    actor: modeTag,
    detail: `Generated draft invoice ${draftResult.invoiceId} (#${project.paypalInvoice.invoiceNumber}) for ${draftResult.currency} $${draftResult.totalAmount}.`
  });

  project.auditTrail.push({
    id: `AUD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    timestamp: now,
    event: 'INVOICE_DRAFT_CREATED',
    actor: modeTag,
    verifiedSource: `${draftResult.environment}:${draftResult.invoiceId}`,
    summary: `Created draft invoice ${draftResult.invoiceId} (#${project.paypalInvoice.invoiceNumber}) in ${modeTag}.`
  });

  return project;
}

export async function executeSendPayPalInvoice(project, paypalClient, options = {}) {
  if (project.state !== PROJECT_STATES.PAYPAL_DRAFT_CREATED || !project.paypalInvoice?.invoiceId) {
    throw new ValidationError(
      `Cannot send invoice: Please generate a draft invoice first (current state: ${project.state}).`
    );
  }

  if (options.confirmSend !== true) {
    throw new ValidationError(
      'Explicit human approval is required before sending the invoice to the client (confirmSend must be true).'
    );
  }

  const sendResult = await paypalClient.sendInvoice(project.paypalInvoice.invoiceId, {
    allowDevFixture: Boolean(options.allowDevFixture),
    idempotencyKey: `p2p-send-${project.paypalInvoice.invoiceId}`,
    subject: `Invoice #${project.paypalInvoice.invoiceNumber} for ${project.scope.projectTitle}`,
    note: project.scope.notesToClient
  });

  const now = new Date().toISOString();
  project.state = PROJECT_STATES.INVOICE_SENT;
  project.updatedAt = now;
  project.paypalInvoice = {
    ...project.paypalInvoice,
    status: sendResult.status || 'SENT',
    payerViewUrl: sendResult.payerViewUrl || project.paypalInvoice.payerViewUrl,
    paypalDebugId: sendResult.paypalDebugId || project.paypalInvoice.paypalDebugId,
    sentAt: sendResult.sentAt || now,
    lastVerifiedAt: now
  };

  const modeTag = project.paypalInvoice.isFixture ? 'Simulated Local Fixture' : 'PayPal Sandbox API';
  updateTimelineStep(project, 'INVOICE_SENT', {
    status: 'COMPLETED',
    timestamp: now,
    actor: modeTag,
    detail: `Invoice ${project.paypalInvoice.invoiceId} sent to ${project.scope.clientEmail} (${modeTag}).`
  });

  updateTimelineStep(project, 'PAYMENT_STATUS', {
    status: 'IN_PROGRESS',
    timestamp: now,
    actor: 'Payment Tracker',
    detail: project.paypalInvoice.isFixture
      ? 'Invoice sent in Local Demo / Fixture Mode. Authentic PAID status requires Connected PayPal Sandbox Mode.'
      : `Awaiting client payment via PayPal (${project.paypalInvoice.status}).`
  });

  project.auditTrail.push({
    id: `AUD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    timestamp: now,
    event: 'INVOICE_SENT_TO_CLIENT',
    actor: 'FREELANCER',
    verifiedSource: `${sendResult.environment}:${project.paypalInvoice.invoiceId}`,
    summary: `Confirmed and sent invoice ${project.paypalInvoice.invoiceId} to ${project.scope.clientEmail}.`
  });

  return project;
}

export async function executeSendInvoiceReminder(project, paypalClient, options = {}) {
  if (project.state !== PROJECT_STATES.INVOICE_SENT || !project.paypalInvoice?.invoiceId) {
    throw new ValidationError('Can only send a payment reminder for an invoice that has been sent and is unpaid.');
  }

  if (options.humanApproved !== true) {
    throw new ValidationError('Explicit human approval is required before sending a payment reminder to the client.');
  }

  const reminderResult = await paypalClient.sendInvoiceReminder(project.paypalInvoice.invoiceId, {
    allowDevFixture: Boolean(options.allowDevFixture),
    subject: options.subject || `Polite reminder: Invoice #${project.paypalInvoice.invoiceNumber} (${project.scope.projectTitle})`,
    note:
      options.note ||
      `Hi ${project.scope.clientName}, hope your week is going well! This is a polite reminder regarding Invoice #${project.paypalInvoice.invoiceNumber} (${project.scope.currency} $${project.scope.totalAmount.toFixed(2)}) due on ${project.scope.deadline}.`
  });

  const now = new Date().toISOString();
  project.updatedAt = now;
  project.paypalInvoice.reminderCount = (project.paypalInvoice.reminderCount || 0) + 1;
  project.paypalInvoice.lastReminderSentAt = reminderResult.remindedAt || now;

  project.auditTrail.push({
    id: `AUD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    timestamp: now,
    event: 'PAYMENT_REMINDER_SENT',
    actor: 'FREELANCER',
    verifiedSource: `${reminderResult.environment}:${project.paypalInvoice.invoiceId}`,
    summary: `Approved and sent payment reminder #${project.paypalInvoice.reminderCount} to ${project.scope.clientEmail}.`
  });

  return project;
}

/**
 * Cancels an unpaid or draft PayPal invoice (`POST /v2/invoicing/invoices/{id}/cancel`).
 */
export async function executeCancelPayPalInvoice(project, paypalClient, options = {}) {
  if (!project.paypalInvoice?.invoiceId) {
    throw new ValidationError('Project does not have an active invoice to cancel.');
  }
  if (project.state === PROJECT_STATES.PAID) {
    throw new ValidationError('Cannot cancel an invoice that has already been verified as PAID.');
  }

  const cancelResult = await paypalClient.cancelSentInvoice(project.paypalInvoice.invoiceId, {
    allowDevFixture: Boolean(options.allowDevFixture),
    subject: options.subject || `Cancelled: Invoice #${project.paypalInvoice.invoiceNumber}`,
    note: options.note || `Invoice #${project.paypalInvoice.invoiceNumber} has been cancelled.`
  });

  const now = new Date().toISOString();
  project.state = PROJECT_STATES.CANCELLED;
  project.updatedAt = now;
  project.paypalInvoice.status = 'CANCELLED';
  project.paypalInvoice.cancelledAt = cancelResult.cancelledAt || now;
  project.paypalInvoice.lastVerifiedAt = now;

  updateTimelineStep(project, 'PAYMENT_STATUS', {
    status: 'CANCELLED',
    timestamp: now,
    actor: 'Freelancer + PayPal',
    detail: `Invoice ${project.paypalInvoice.invoiceId} was cancelled.`
  });

  project.auditTrail.push({
    id: `AUD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    timestamp: now,
    event: 'INVOICE_CANCELLED',
    actor: 'FREELANCER',
    verifiedSource: `${cancelResult.environment}:${project.paypalInvoice.invoiceId}`,
    summary: `Cancelled invoice ${project.paypalInvoice.invoiceId}.`
  });

  return project;
}

export async function syncCanonicalInvoiceStatus(project, paypalClient, options = {}) {
  if (!project.paypalInvoice?.invoiceId) {
    throw new ValidationError('Project does not have an invoice to check.');
  }

  const canonical = await paypalClient.getInvoice(project.paypalInvoice.invoiceId, {
    allowDevFixture: Boolean(options.allowDevFixture)
  });

  applyCanonicalPayPalStatus(project, canonical, 'CANONICAL_API_CHECK');
  return project;
}

/**
 * Processes an incoming PayPal Webhook event (`POST /api/webhooks/paypal`).
 * CRITICAL REQUIREMENT (Section 2 Step 5 & Section 4):
 * "Payment must only be marked PAID after verification through an authentic PayPal API response
 *  or a cryptographically verified PayPal webhook. Never treat a simulated event as real payment confirmation."
 */
export async function processPayPalWebhookEvent({
  projects,
  headers,
  webhookEvent,
  paypalClient
}) {
  if (!webhookEvent || typeof webhookEvent !== 'object' || !webhookEvent.id || !webhookEvent.event_type) {
    throw new ValidationError('Invalid PayPal webhook event payload: missing id or event_type.');
  }

  const eventId = String(webhookEvent.id);
  const eventType = String(webhookEvent.event_type);
  const resource = webhookEvent.resource?.invoice || webhookEvent.resource || {};
  const invoiceId = resource.id || webhookEvent.resource?.id;

  if (!invoiceId) {
    throw new ValidationError('Webhook event resource does not contain an invoice ID.');
  }

  const project = projects.find((p) => p.paypalInvoice?.invoiceId === invoiceId);
  if (!project) {
    return {
      handled: false,
      statusCode: 404,
      reason: `No project found matching invoice ID ${invoiceId}.`
    };
  }

  // 1. Deduplicate by event ID
  if (project.processedWebhookEventIds.includes(eventId)) {
    return {
      handled: true,
      deduplicated: true,
      statusCode: 200,
      projectId: project.id,
      invoiceId,
      eventId,
      reason: `Duplicate webhook event ${eventId} ignored (already processed).`
    };
  }

  // 2. Reject simulated events from ever marking an invoice PAID
  if (headers['x-p2p-fixture-webhook'] === 'true' || project.paypalInvoice?.isFixture) {
    const now = new Date().toISOString();
    project.auditTrail.push({
      id: `AUD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      timestamp: now,
      event: 'SIMULATED_WEBHOOK_BLOCKED_FROM_MARKING_PAID',
      actor: 'PAYMENT_VERIFICATION_GUARD',
      verifiedSource: 'SIMULATED_EVENT_GUARD',
      summary: `Simulated event ${eventId} (${eventType}) recorded as a test log only. Payment is NEVER marked PAID from a simulated event.`
    });
    return {
      handled: false,
      verified: false,
      simulatedBlocked: true,
      statusCode: 422,
      projectId: project.id,
      invoiceId,
      eventId,
      projectState: project.state,
      reason:
        'Simulated events are never treated as real payment confirmation. Payment is only marked PAID via an authentic PayPal API response or cryptographically verified PayPal webhook.'
    };
  }

  // 3. Cryptographically verify webhook signature with PayPal
  const verification = await paypalClient.verifyWebhookSignature(headers, webhookEvent);
  const now = new Date().toISOString();

  if (!verification.verified) {
    project.auditTrail.push({
      id: `AUD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      timestamp: now,
      event: 'WEBHOOK_REJECTED_UNVERIFIED_SIGNATURE',
      actor: 'SECURITY_GUARD',
      verifiedSource: verification.verificationStatus,
      summary: `Rejected unverified webhook ${eventId} (${eventType}): ${verification.reason}`
    });
    return {
      handled: false,
      verified: false,
      statusCode: 401,
      projectId: project.id,
      invoiceId,
      eventId,
      projectState: project.state,
      reason: verification.reason
    };
  }

  // 4. Fetch canonical invoice status from PayPal before updating state
  const canonicalInvoice = await paypalClient.getInvoice(invoiceId, { allowDevFixture: false });
  project.processedWebhookEventIds.push(eventId);
  applyCanonicalPayPalStatus(project, canonicalInvoice, `VERIFIED_PAYPAL_WEBHOOK:${eventType} (${eventId})`);

  return {
    handled: true,
    verified: true,
    deduplicated: false,
    statusCode: 200,
    projectId: project.id,
    invoiceId,
    eventId,
    eventType,
    canonicalStatus: canonicalInvoice.status,
    projectState: project.state
  };
}

export function applyCanonicalPayPalStatus(project, canonical, triggerSource) {
  const now = new Date().toISOString();
  const status = String(canonical.status || '').toUpperCase();
  const isAuthenticPayPal = canonical.isFixture === false;

  project.paypalInvoice = {
    ...project.paypalInvoice,
    status,
    dueAmount: canonical.dueAmount ?? project.paypalInvoice.dueAmount,
    payerViewUrl: canonical.payerViewUrl || project.paypalInvoice.payerViewUrl,
    lastVerifiedAt: now
  };

  // CRITICAL: Only mark PAID if verified from an authentic PayPal API response (isFixture === false)
  if ((status === 'PAID' || status === 'MARKED_AS_PAID') && isAuthenticPayPal) {
    project.state = PROJECT_STATES.PAID;
    project.paypalInvoice.paidAt = project.paypalInvoice.paidAt || now;
    project.paypalInvoice.paymentVerifiedAuthentic = true;
    project.paypalInvoice.dueAmount = '0.00';
    updateTimelineStep(project, 'PAYMENT_STATUS', {
      status: 'COMPLETED',
      timestamp: now,
      actor: `PayPal Verified (${canonical.environment})`,
      detail: `Authentic payment confirmed for invoice ${canonical.invoiceId} (${canonical.currency} $${canonical.totalAmount}) via ${triggerSource}.`
    });
  } else if (status === 'CANCELLED') {
    project.state = PROJECT_STATES.CANCELLED;
    updateTimelineStep(project, 'PAYMENT_STATUS', {
      status: 'CANCELLED',
      timestamp: now,
      actor: 'PayPal Status Check',
      detail: `Invoice ${canonical.invoiceId} was cancelled.`
    });
  } else if (status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED') {
    project.state = PROJECT_STATES.REFUNDED;
    updateTimelineStep(project, 'PAYMENT_STATUS', {
      status: 'REFUNDED',
      timestamp: now,
      actor: 'PayPal Status Check',
      detail: `Invoice ${canonical.invoiceId} was marked ${status}.`
    });
  }

  project.updatedAt = now;
  project.auditTrail.push({
    id: `AUD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    timestamp: now,
    event: `STATUS_CHECK_${status}`,
    actor: 'PAYPAL_VERIFIER',
    verifiedSource: `${triggerSource} (${canonical.environment})`,
    summary: `Checked invoice ${canonical.invoiceId}: status is ${status} (${
      isAuthenticPayPal ? 'Authentic PayPal API' : 'Local Simulated Fixture'
    }).`
  });
}

function updateTimelineStep(project, stepName, updates) {
  const step = project.timeline.find((t) => t.step === stepName);
  if (step) {
    Object.assign(step, updates);
  }
}
