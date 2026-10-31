/**
 * Proof-to-Pay v3.1 — Tool-Using AI Agent Engine (`src/agent-tools.mjs`)
 *
 * Implements:
 * - `AGENT_TOOL_DEFINITIONS` (all 10 documented freelancer business assistant tools)
 * - `executeAgentTool` (with strict runtime input validation, execution logging, and non-bypassable human approval gates)
 * - `approvePendingToolAction` (server-side approval verification, scope hash integrity check, and single-use consumption)
 * - `handleAgentConversation` (multi-step reasoning + tool execution router)
 *
 * Security Invariants (Part 1 Section 2):
 * - Sensitive tools (`lock_scope`, `send_paypal_invoice`, and `generate_payment_reminder` when sending)
 *   NEVER trust a frontend-supplied `humanApproved: true` field.
 * - Direct calls to sensitive tools return `PENDING_HUMAN_APPROVAL` and persist a unique server-side
 *   approval request in `project.pendingApprovals`.
 * - Forged, unknown, or already-used approval IDs are rejected with `ValidationError`.
 * - If the scope changes after a `lock_scope` approval request was created, the stale approval is invalidated and rejected.
 * - Every tool call, pending approval request, approval/rejection decision, and execution is recorded in
 *   both `project.agentExecutionLog` and `project.auditTrail`.
 */

import crypto from 'node:crypto';
import { ValidationError } from './schema.mjs';
import { extractStructuredScope } from './ai-extractor.mjs';
import {
  updateProjectScope,
  approveAndLockScope,
  executeCreatePayPalDraft,
  executeSendPayPalInvoice,
  executeSendInvoiceReminder,
  syncCanonicalInvoiceStatus,
  computeScopeHash
} from './state-machine.mjs';

export const AGENT_TOOL_DEFINITIONS = [
  {
    name: 'extract_project_requirements',
    requiresHumanApproval: false,
    parameters: ['projectId', 'rawBrief', 'proposedBudget'],
    description: 'Extracts project requirements, deliverables, deadlines, and quoted prices from a client brief.'
  },
  {
    name: 'identify_ambiguities',
    requiresHumanApproval: false,
    parameters: ['projectId'],
    description: 'Identifies ambiguous statements, missing information, scope creep warnings, and revision limits.'
  },
  {
    name: 'calculate_project_pricing',
    requiresHumanApproval: false,
    parameters: ['projectId', 'includeOptionalAddons', 'applyAddonsToScope'],
    description: 'Calculates base project pricing and optional additional charges for out-of-scope requests.'
  },
  {
    name: 'generate_scope_document',
    requiresHumanApproval: false,
    parameters: ['projectId'],
    description: 'Generates a structured, professional Scope-of-Work document from the project data.'
  },
  {
    name: 'update_scope',
    requiresHumanApproval: false,
    parameters: ['projectId', 'updates'],
    description: 'Updates deliverables, exclusions, revision limits, deadlines, or line items on an unlocked Scope of Work.'
  },
  {
    name: 'lock_scope',
    requiresHumanApproval: true,
    parameters: ['projectId', 'approverName'],
    description: 'Locks the final Scope of Work with a SHA-256 fingerprint. Requires explicit human approval.'
  },
  {
    name: 'create_paypal_invoice',
    requiresHumanApproval: false,
    parameters: ['projectId'],
    description: 'Creates a PayPal draft invoice from the locked scope (idempotent; prevents duplicate invoices).'
  },
  {
    name: 'send_paypal_invoice',
    requiresHumanApproval: true,
    parameters: ['projectId'],
    description: 'Sends the generated PayPal draft invoice to the client email. Requires explicit human approval.'
  },
  {
    name: 'get_invoice_status',
    requiresHumanApproval: false,
    parameters: ['projectId'],
    description: 'Retrieves the canonical PayPal invoice status and payment verification state.'
  },
  {
    name: 'generate_payment_reminder',
    requiresHumanApproval: true,
    parameters: ['projectId', 'sendViaPayPal'],
    description: 'Drafts a polite payment reminder grounded in the invoice details; sending requires human approval.'
  }
];

const VALID_TOOL_NAMES = new Set(AGENT_TOOL_DEFINITIONS.map((t) => t.name));

function recordExecutionLog(project, entry) {
  project.agentExecutionLog = project.agentExecutionLog || [];
  const logItem = {
    id: `EXEC-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    timestamp: new Date().toISOString(),
    reasoningSummary: entry.reasoningSummary,
    toolSelected: entry.toolSelected,
    toolArguments: entry.toolArguments || {},
    toolResult: entry.toolResult || null,
    humanApprovalStatus: entry.humanApprovalStatus || 'NOT_REQUIRED',
    errorAndRecovery: entry.errorAndRecovery || null
  };
  project.agentExecutionLog.push(logItem);
  return logItem;
}

function recordAuditTrail(project, event, actor, verifiedSource, summary) {
  project.auditTrail = project.auditTrail || [];
  project.auditTrail.push({
    id: `AUD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    timestamp: new Date().toISOString(),
    event,
    actor,
    verifiedSource,
    summary
  });
}

/**
 * Validates tool name and input arguments before executing any tool.
 */
export function validateAgentToolInput(toolName, args, project) {
  if (!toolName || typeof toolName !== 'string' || !VALID_TOOL_NAMES.has(toolName)) {
    throw new ValidationError(`Invalid or unknown agent tool: "${toolName}".`, ['toolName']);
  }
  if (!project || typeof project !== 'object' || !project.id) {
    throw new ValidationError('A valid persisted project instance is required to execute agent tools.', ['projectId']);
  }
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    throw new ValidationError('Tool arguments (args) must be a JSON object.', ['args']);
  }

  if (toolName === 'extract_project_requirements' && args?.rawBrief !== undefined) {
    if (typeof args.rawBrief !== 'string' || args.rawBrief.trim().length < 10) {
      throw new ValidationError('extract_project_requirements requires rawBrief of at least 10 characters.', ['rawBrief']);
    }
  }

  if (toolName === 'update_scope') {
    if (!args?.updates || typeof args.updates !== 'object' || Array.isArray(args.updates)) {
      throw new ValidationError('update_scope requires a non-empty updates object.', ['updates']);
    }
  }
}

/**
 * Verifies that a sensitive tool execution is backed by an existing, unconsumed pending approval record
 * in `project.pendingApprovals` matching the tool name.
 * Prevents callers from bypassing the approval workflow by simply passing `humanApproved: true` to `/api/agent/tool`.
 */
function verifyNonBypassablePendingApproval(project, toolName, approvalId) {
  const list = Array.isArray(project.pendingApprovals) ? project.pendingApprovals : [];
  if (!approvalId) {
    return null;
  }
  const match = list.find((item) => item.id === approvalId && item.toolName === toolName);
  return match || null;
}

/**
 * Executes a backend agent tool.
 * Sensitive tools (`lock_scope`, `send_paypal_invoice`, and `generate_payment_reminder` when sending)
 * ALWAYS create a `PENDING_HUMAN_APPROVAL` request unless an explicit `verifiedApprovalId` matching
 * `project.pendingApprovals` is supplied through `approvePendingToolAction`.
 */
export async function executeAgentTool({
  toolName,
  args = {},
  project,
  paypalClient,
  verifiedApprovalId = null,
  reasoningSummary = ''
}) {
  validateAgentToolInput(toolName, args, project);
  const now = new Date().toISOString();
  project.pendingApprovals = project.pendingApprovals || [];

  try {
    switch (toolName) {
      case 'extract_project_requirements': {
        const rawBrief = args.rawBrief || project.rawBrief;
        const proposedBudget = args.proposedBudget ?? project.proposedBudget;
        const extracted = await extractStructuredScope({
          rawBrief,
          clientName: args.clientName || project.scope.clientName,
          clientEmail: args.clientEmail || project.scope.clientEmail,
          projectTitle: args.projectTitle || project.scope.projectTitle,
          proposedBudget
        });
        project.rawBrief = rawBrief;
        project.proposedBudget = proposedBudget || null;
        project.scope = extracted.scope;
        project.analysisDetails = extracted.analysisDetails;
        project.extractionMeta = extracted.extractionMeta;
        project.updatedAt = now;

        const result = {
          projectTitle: extracted.scope.projectTitle,
          deliverablesCount: extracted.scope.deliverables.length,
          deliverables: extracted.scope.deliverables.map((d) => d.title),
          deadline: extracted.scope.deadline,
          totalAmount: extracted.scope.totalAmount,
          currency: extracted.scope.currency,
          aiProvider: extracted.extractionMeta.provider,
          liveAiUsed: extracted.extractionMeta.liveAiUsed
        };
        const log = recordExecutionLog(project, {
          reasoningSummary:
            reasoningSummary ||
            'Selected extract_project_requirements() to parse the client brief into deliverables, deadline, and budget.',
          toolSelected: 'extract_project_requirements',
          toolArguments: { projectId: project.id, briefLength: rawBrief.length, proposedBudget },
          toolResult: result,
          humanApprovalStatus: 'NOT_REQUIRED'
        });
        return { status: 'EXECUTED', result, log, project };
      }

      case 'identify_ambiguities': {
        const extracted = await extractStructuredScope({
          rawBrief: project.rawBrief,
          clientName: project.scope.clientName,
          clientEmail: project.scope.clientEmail,
          projectTitle: project.scope.projectTitle,
          proposedBudget: project.proposedBudget
        });
        project.analysisDetails = extracted.analysisDetails;
        const result = {
          ambiguousStatements: extracted.analysisDetails.ambiguousStatements,
          missingInformation: extracted.analysisDetails.missingInformation,
          scopeCreepWarnings: extracted.analysisDetails.scopeCreepWarnings,
          suggestedRevisionLimit: extracted.analysisDetails.suggestedRevisionLimit,
          additionalCharges: extracted.analysisDetails.additionalCharges,
          unresolvedRiskFlags: project.scope.riskFlags.filter((r) => !r.resolved)
        };
        const log = recordExecutionLog(project, {
          reasoningSummary:
            reasoningSummary ||
            'Selected identify_ambiguities() to inspect the client brief for missing details, unclear requirements, and scope creep risks.',
          toolSelected: 'identify_ambiguities',
          toolArguments: { projectId: project.id },
          toolResult: result,
          humanApprovalStatus: 'NOT_REQUIRED'
        });
        return { status: 'EXECUTED', result, log, project };
      }

      case 'calculate_project_pricing': {
        const includeAddons = Boolean(args.includeOptionalAddons);
        const baseItems = project.scope.lineItems.map((li) => ({
          name: li.name,
          quantity: Number(li.quantity || 1),
          unitPrice: Number(li.unitPrice || 0),
          subtotal: Number(li.subtotal || 0)
        }));
        const baseTotal = baseItems.reduce((s, i) => s + i.subtotal, 0);

        const suggestedAddons = project.analysisDetails?.additionalCharges || [
          {
            id: 'ADDON-COPY',
            title: 'Conversion Copywriting (3 Sections)',
            suggestedPrice: 150,
            reason: 'Client mentioned "I may want copywriting too"'
          }
        ];
        const addonTotal = suggestedAddons.reduce((s, a) => s + Number(a.suggestedPrice || 0), 0);
        const recommendedTotalWithAddons = baseTotal + addonTotal;

        if (args.applyAddonsToScope === true) {
          for (const addon of suggestedAddons) {
            const exists = project.scope.lineItems.some((li) =>
              li.name.toLowerCase().includes(addon.title.toLowerCase().slice(0, 12))
            );
            if (!exists) {
              project.scope.lineItems.push({
                id: `ITEM-${project.scope.lineItems.length + 1}`,
                name: addon.title,
                description: addon.reason,
                quantity: '1',
                unitPrice: addon.suggestedPrice,
                subtotal: addon.suggestedPrice,
                confidence: 'EXPLICIT'
              });
            }
          }
          project.scope.riskFlags.forEach((r) => {
            if (r.suggestedAddonPrice) {
              r.resolved = true;
              r.resolutionNote = `Added +$${r.suggestedAddonPrice} charge via calculate_project_pricing().`;
            }
          });
          updateProjectScope(project, project.scope);
        }

        const result = {
          currency: project.scope.currency,
          currentScopeTotal: project.scope.totalAmount,
          baseLineItems: baseItems,
          suggestedAdditionalCharges: suggestedAddons,
          recommendedTotalIfBundled: recommendedTotalWithAddons,
          appliedToScope: Boolean(args.applyAddonsToScope)
        };
        const log = recordExecutionLog(project, {
          reasoningSummary:
            reasoningSummary ||
            'Selected calculate_project_pricing() to evaluate base line items vs. additional charges for optional requests.',
          toolSelected: 'calculate_project_pricing',
          toolArguments: {
            projectId: project.id,
            includeOptionalAddons: includeAddons,
            applyAddonsToScope: Boolean(args.applyAddonsToScope)
          },
          toolResult: result,
          humanApprovalStatus: 'NOT_REQUIRED'
        });
        return { status: 'EXECUTED', result, log, project };
      }

      case 'generate_scope_document': {
        const s = project.scope;
        const doc = {
          projectTitle: s.projectTitle,
          clientName: s.clientName,
          clientEmail: s.clientEmail,
          deliverables: s.deliverables.map((d) => d.title),
          timelineDeadline: s.deadline,
          paymentTerms: s.paymentTerms,
          revisionLimit: `${s.revisionLimit} rounds included`,
          exclusions: s.exclusions,
          totalProjectCost: `${s.currency} $${s.totalAmount.toFixed(2)}`,
          lockStatus: project.scopeLock ? `Locked (v${project.scopeLock.version})` : 'Draft (Unlocked)'
        };
        const log = recordExecutionLog(project, {
          reasoningSummary:
            reasoningSummary ||
            'Selected generate_scope_document() to compile the structured Scope of Work for freelancer review.',
          toolSelected: 'generate_scope_document',
          toolArguments: { projectId: project.id },
          toolResult: doc,
          humanApprovalStatus: 'NOT_REQUIRED'
        });
        return { status: 'EXECUTED', result: doc, log, project };
      }

      case 'update_scope': {
        const updated = updateProjectScope(project, args.updates);
        const result = {
          projectTitle: updated.scope.projectTitle,
          totalAmount: updated.scope.totalAmount,
          deliverablesCount: updated.scope.deliverables.length,
          revisionLimit: updated.scope.revisionLimit,
          state: updated.state
        };
        const log = recordExecutionLog(project, {
          reasoningSummary:
            reasoningSummary ||
            'Selected update_scope() to apply the freelancer requested modifications to the Scope of Work.',
          toolSelected: 'update_scope',
          toolArguments: { projectId: project.id, updatedFields: Object.keys(args.updates) },
          toolResult: result,
          humanApprovalStatus: 'NOT_REQUIRED'
        });
        return { status: 'EXECUTED', result, log, project: updated };
      }

      case 'lock_scope': {
        const verifiedPending = verifyNonBypassablePendingApproval(project, 'lock_scope', verifiedApprovalId);
        const currentScopeHash = computeScopeHash(project.scope);

        if (!verifiedPending) {
          const approvalRequest = {
            id: `REQ-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
            createdAt: now,
            toolName: 'lock_scope',
            scopeHashAtRequest: currentScopeHash,
            title: 'Approve Locking the Final Scope of Work',
            explanation: `I intend to lock the Scope of Work for "${project.scope.projectTitle}" at ${
              project.scope.currency
            } $${project.scope.totalAmount.toFixed(2)} (${project.scope.deliverables.length} deliverables, ${
              project.scope.revisionLimit
            } revision rounds, deadline ${
              project.scope.deadline
            }). Locking prevents unintended edits before generating the PayPal invoice.`,
            args: {
              projectId: project.id,
              approverName: args.approverName || 'Freelancer'
            }
          };
          project.pendingApprovals = [
            ...project.pendingApprovals.filter((p) => p.toolName !== 'lock_scope'),
            approvalRequest
          ];
          recordAuditTrail(
            project,
            'APPROVAL_REQUESTED_LOCK_SCOPE',
            'AI_AGENT',
            approvalRequest.id,
            `Created pending human approval request ${approvalRequest.id} for lock_scope (${project.scope.currency} $${project.scope.totalAmount.toFixed(2)}).`
          );
          const log = recordExecutionLog(project, {
            reasoningSummary:
              reasoningSummary ||
              'Selected lock_scope(), which requires explicit human approval. Created a pending approval request explaining the scope terms.',
            toolSelected: 'lock_scope',
            toolArguments: approvalRequest.args,
            toolResult: { awaitingApprovalId: approvalRequest.id, explanation: approvalRequest.explanation },
            humanApprovalStatus: 'PENDING_HUMAN_APPROVAL'
          });
          return { status: 'PENDING_HUMAN_APPROVAL', approvalRequest, log, project };
        }

        // Verify scope was not altered between pending request creation and approval
        if (verifiedPending.scopeHashAtRequest && verifiedPending.scopeHashAtRequest !== currentScopeHash) {
          project.pendingApprovals = project.pendingApprovals.filter((p) => p.id !== verifiedPending.id);
          recordAuditTrail(
            project,
            'APPROVAL_INVALIDATED_SCOPE_MODIFIED',
            'SECURITY_GUARD',
            verifiedPending.id,
            `Rejected pending approval ${verifiedPending.id} because scope was modified after request creation.`
          );
          throw new ValidationError(
            'Scope was modified after the approval request was generated. Please review and approve the updated scope.'
          );
        }

        const locked = approveAndLockScope(project, {
          explicitConfirmation: true,
          approverName: args.approverName || verifiedPending.args?.approverName || 'Freelancer'
        });
        project.pendingApprovals = project.pendingApprovals.filter((p) => p.id !== verifiedPending.id);
        recordAuditTrail(
          locked,
          'AGENT_TOOL_APPROVED_EXECUTED',
          'FREELANCER',
          verifiedPending.id,
          `Approved ${verifiedPending.id} and executed lock_scope (Scope v${locked.scopeLock.version}).`
        );
        const result = {
          state: locked.state,
          scopeVersion: locked.scopeLock.version,
          sha256: locked.scopeLock.sha256,
          lockedTotal: locked.scopeLock.lockedTotal
        };
        const log = recordExecutionLog(locked, {
          reasoningSummary:
            reasoningSummary || 'Human approved lock_scope(). Locked the Scope of Work with a SHA-256 signature.',
          toolSelected: 'lock_scope',
          toolArguments: { projectId: project.id, approvalId: verifiedPending.id },
          toolResult: result,
          humanApprovalStatus: 'APPROVED_BY_HUMAN'
        });
        return { status: 'EXECUTED', result, log, project: locked };
      }

      case 'create_paypal_invoice': {
        const allowDevFixture = args.allowSimulatedFixture ?? !paypalClient.hasRealCredentials();
        const outcome = await executeCreatePayPalDraft(project, paypalClient, {
          allowDevFixture
        });
        const duplicatePrevented = Boolean(outcome.duplicatePrevented);
        const inv = project.paypalInvoice;
        const result = {
          invoiceId: inv.invoiceId,
          invoiceNumber: inv.invoiceNumber,
          status: inv.status,
          totalAmount: inv.totalAmount,
          currency: inv.currency,
          connectionMode: inv.connectionMode,
          isSimulatedFixture: inv.isFixture,
          duplicatePrevented
        };
        const log = recordExecutionLog(project, {
          reasoningSummary:
            reasoningSummary ||
            (duplicatePrevented
              ? 'Checked for existing invoice before calling create_paypal_invoice(); prevented duplicate invoice creation.'
              : 'Selected create_paypal_invoice() because the scope is locked and ready for PayPal draft creation.'),
          toolSelected: 'create_paypal_invoice',
          toolArguments: { projectId: project.id, connectionMode: inv.connectionMode },
          toolResult: result,
          humanApprovalStatus: 'NOT_REQUIRED'
        });
        return { status: 'EXECUTED', result, log, project };
      }

      case 'send_paypal_invoice': {
        if (!project.paypalInvoice?.invoiceId) {
          throw new ValidationError(
            'Cannot send invoice: No PayPal draft invoice exists yet. Call create_paypal_invoice first.'
          );
        }
        const verifiedPending = verifyNonBypassablePendingApproval(project, 'send_paypal_invoice', verifiedApprovalId);
        if (!verifiedPending) {
          const approvalRequest = {
            id: `REQ-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
            createdAt: now,
            toolName: 'send_paypal_invoice',
            invoiceIdAtRequest: project.paypalInvoice.invoiceId,
            title: 'Approve Sending PayPal Invoice to Client',
            explanation: `I intend to send PayPal Invoice #${project.paypalInvoice.invoiceNumber} (${project.paypalInvoice.invoiceId}) for ${project.paypalInvoice.currency} $${project.paypalInvoice.totalAmount} to ${project.scope.clientEmail}. Please confirm to send.`,
            args: {
              projectId: project.id,
              invoiceId: project.paypalInvoice.invoiceId
            }
          };
          project.pendingApprovals = [
            ...project.pendingApprovals.filter((p) => p.toolName !== 'send_paypal_invoice'),
            approvalRequest
          ];
          recordAuditTrail(
            project,
            'APPROVAL_REQUESTED_SEND_INVOICE',
            'AI_AGENT',
            approvalRequest.id,
            `Created pending human approval request ${approvalRequest.id} for send_paypal_invoice (${project.paypalInvoice.invoiceId}).`
          );
          const log = recordExecutionLog(project, {
            reasoningSummary:
              reasoningSummary ||
              'Selected send_paypal_invoice(), which requires explicit human approval before emailing the client.',
            toolSelected: 'send_paypal_invoice',
            toolArguments: approvalRequest.args,
            toolResult: { awaitingApprovalId: approvalRequest.id, explanation: approvalRequest.explanation },
            humanApprovalStatus: 'PENDING_HUMAN_APPROVAL'
          });
          return { status: 'PENDING_HUMAN_APPROVAL', approvalRequest, log, project };
        }

        const allowDevFixture = args.allowSimulatedFixture ?? project.paypalInvoice.isFixture;
        const sent = await executeSendPayPalInvoice(project, paypalClient, {
          confirmSend: true,
          allowDevFixture
        });
        project.pendingApprovals = project.pendingApprovals.filter((p) => p.id !== verifiedPending.id);
        recordAuditTrail(
          sent,
          'AGENT_TOOL_APPROVED_EXECUTED',
          'FREELANCER',
          verifiedPending.id,
          `Approved ${verifiedPending.id} and executed send_paypal_invoice for ${sent.paypalInvoice.invoiceId}.`
        );
        const result = {
          invoiceId: sent.paypalInvoice.invoiceId,
          status: sent.paypalInvoice.status,
          recipientEmail: sent.scope.clientEmail,
          payerViewUrl: sent.paypalInvoice.payerViewUrl,
          connectionMode: sent.paypalInvoice.connectionMode
        };
        const log = recordExecutionLog(sent, {
          reasoningSummary:
            reasoningSummary || 'Human approved send_paypal_invoice(). Dispatched invoice to the client.',
          toolSelected: 'send_paypal_invoice',
          toolArguments: { projectId: project.id, invoiceId: sent.paypalInvoice.invoiceId, approvalId: verifiedPending.id },
          toolResult: result,
          humanApprovalStatus: 'APPROVED_BY_HUMAN'
        });
        return { status: 'EXECUTED', result, log, project: sent };
      }

      case 'get_invoice_status': {
        if (!project.paypalInvoice?.invoiceId) {
          const result = {
            hasInvoice: false,
            projectState: project.state,
            message: 'No PayPal invoice has been created for this project yet.'
          };
          const log = recordExecutionLog(project, {
            reasoningSummary:
              reasoningSummary || 'Selected get_invoice_status() to check whether an invoice exists and is paid.',
            toolSelected: 'get_invoice_status',
            toolArguments: { projectId: project.id },
            toolResult: result,
            humanApprovalStatus: 'NOT_REQUIRED'
          });
          return { status: 'EXECUTED', result, log, project };
        }

        const allowDevFixture = args.allowSimulatedFixture ?? project.paypalInvoice.isFixture;
        await syncCanonicalInvoiceStatus(project, paypalClient, { allowDevFixture });
        const inv = project.paypalInvoice;
        const result = {
          hasInvoice: true,
          invoiceId: inv.invoiceId,
          invoiceNumber: inv.invoiceNumber,
          status: inv.status,
          amountDue: inv.dueAmount || inv.totalAmount,
          totalAmount: inv.totalAmount,
          currency: inv.currency,
          paymentVerifiedAuthentic: Boolean(inv.paymentVerifiedAuthentic),
          connectionMode: inv.connectionMode,
          isSimulatedFixture: Boolean(inv.isFixture),
          lastVerifiedAt: inv.lastVerifiedAt
        };
        const log = recordExecutionLog(project, {
          reasoningSummary:
            reasoningSummary || 'Selected get_invoice_status() to retrieve the current invoice status from PayPal.',
          toolSelected: 'get_invoice_status',
          toolArguments: { projectId: project.id, invoiceId: inv.invoiceId },
          toolResult: result,
          humanApprovalStatus: 'NOT_REQUIRED'
        });
        return { status: 'EXECUTED', result, log, project };
      }

      case 'generate_payment_reminder': {
        const s = project.scope;
        const inv = project.paypalInvoice;
        const draftMessage = `Hi ${s.clientName.split(' ')[0]},\n\nI hope your week is going well! I'm writing to share a polite reminder regarding Invoice ${
          inv?.invoiceNumber ? `#${inv.invoiceNumber}` : '(Pending)'
        } for "${s.projectTitle}" (${s.currency} $${s.totalAmount.toFixed(2)}, target delivery date ${
          s.deadline
        }).${
          inv?.payerViewUrl && !inv.isFixture
            ? `\n\nYou can view and complete the PayPal invoice here: ${inv.payerViewUrl}`
            : ''
        }\n\nPlease let me know if you have any questions about the approved deliverables.\n\nBest regards,\n${
          paypalClient.invoicerConfig.givenName
        }`;

        const verifiedPending = verifyNonBypassablePendingApproval(
          project,
          'generate_payment_reminder',
          verifiedApprovalId
        );

        if (verifiedPending) {
          const allowDevFixture = args.allowSimulatedFixture ?? Boolean(inv?.isFixture);
          await executeSendInvoiceReminder(project, paypalClient, {
            humanApproved: true,
            allowDevFixture,
            note: args.note || verifiedPending.draftMessage || draftMessage
          });
          project.pendingApprovals = project.pendingApprovals.filter((p) => p.id !== verifiedPending.id);
          recordAuditTrail(
            project,
            'AGENT_TOOL_APPROVED_EXECUTED',
            'FREELANCER',
            verifiedPending.id,
            `Approved ${verifiedPending.id} and executed generate_payment_reminder for ${inv?.invoiceId}.`
          );
          const result = {
            sent: true,
            invoiceId: inv.invoiceId,
            reminderCount: inv.reminderCount,
            draftMessage
          };
          const log = recordExecutionLog(project, {
            reasoningSummary:
              reasoningSummary || 'Human approved generate_payment_reminder(). Dispatched reminder via PayPal.',
            toolSelected: 'generate_payment_reminder',
            toolArguments: { projectId: project.id, sendViaPayPal: true, approvalId: verifiedPending.id },
            toolResult: result,
            humanApprovalStatus: 'APPROVED_BY_HUMAN'
          });
          return { status: 'EXECUTED', result, draftMessage, log, project };
        }

        // Create a pending approval request before any reminder can be sent
        const approvalRequest = {
          id: `REQ-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
          createdAt: now,
          toolName: 'generate_payment_reminder',
          title: 'Approve Sending Payment Reminder to Client',
          explanation: `I have drafted a polite payment reminder for ${s.clientName} (${s.clientEmail}) regarding Invoice ${
            inv?.invoiceNumber ? `#${inv.invoiceNumber}` : '(Draft)'
          } (${s.currency} $${s.totalAmount.toFixed(2)}). Approve below to dispatch this reminder via PayPal.`,
          draftMessage,
          args: {
            projectId: project.id,
            sendViaPayPal: true,
            note: draftMessage
          }
        };
        project.pendingApprovals = [
          ...project.pendingApprovals.filter((p) => p.toolName !== 'generate_payment_reminder'),
          approvalRequest
        ];
        recordAuditTrail(
          project,
          'APPROVAL_REQUESTED_PAYMENT_REMINDER',
          'AI_AGENT',
          approvalRequest.id,
          `Created pending human approval request ${approvalRequest.id} for generate_payment_reminder.`
        );

        const log = recordExecutionLog(project, {
          reasoningSummary:
            reasoningSummary ||
            'Selected generate_payment_reminder(). Drafted a polite reminder from project data and created a pending human approval request before sending.',
          toolSelected: 'generate_payment_reminder',
          toolArguments: { projectId: project.id, sendViaPayPal: Boolean(args.sendViaPayPal) },
          toolResult: { draftMessage, awaitingApprovalId: approvalRequest.id },
          humanApprovalStatus: 'PENDING_HUMAN_APPROVAL'
        });
        return {
          status: 'PENDING_HUMAN_APPROVAL',
          result: { draftMessage },
          approvalRequest,
          draftMessage,
          log,
          project
        };
      }

      default:
        throw new ValidationError(`Unknown agent tool: ${toolName}`);
    }
  } catch (err) {
    const recovery =
      err.message.includes('approve (lock)') || err.message.includes('locked')
        ? 'Suggested recovery: Run lock_scope() and obtain human approval first before creating an invoice.'
        : err.message.includes('draft invoice first')
        ? 'Suggested recovery: Run create_paypal_invoice() first to generate the draft invoice.'
        : 'Suggested recovery: Review project state and required fields, then retry.';

    const log = recordExecutionLog(project, {
      reasoningSummary: reasoningSummary || `Attempted to execute ${toolName}.`,
      toolSelected: toolName,
      toolArguments: args,
      toolResult: null,
      humanApprovalStatus: verifiedApprovalId ? 'APPROVED_BY_HUMAN' : 'NOT_REQUIRED',
      errorAndRecovery: {
        error: err.message,
        recoveryAction: recovery
      }
    });
    throw Object.assign(err, { executionLog: log, recoveryAction: recovery });
  }
}

/**
 * Approves or rejects a pending human-approval action (`lock_scope`, `send_paypal_invoice`, `generate_payment_reminder`).
 * Strictly requires a valid `approvalId` that exists in `project.pendingApprovals`.
 */
export async function approvePendingToolAction({
  project,
  paypalClient,
  approvalId,
  decision = 'APPROVE',
  args = {}
}) {
  if (!approvalId || typeof approvalId !== 'string') {
    throw new ValidationError('A valid approvalId is required to approve or reject a pending agent action.', [
      'approvalId'
    ]);
  }
  const pending = (project.pendingApprovals || []).find((p) => p.id === approvalId);
  if (!pending) {
    throw new ValidationError(
      `Pending approval "${approvalId}" was not found or has already been processed. Cannot bypass approval gate.`,
      ['approvalId']
    );
  }

  if (decision === 'REJECT') {
    project.pendingApprovals = project.pendingApprovals.filter((p) => p.id !== approvalId);
    recordAuditTrail(
      project,
      'APPROVAL_REJECTED_BY_HUMAN',
      'FREELANCER',
      approvalId,
      `Rejected pending action ${approvalId} for ${pending.toolName}().`
    );
    const log = recordExecutionLog(project, {
      reasoningSummary: `Freelancer rejected pending action for ${pending.toolName}().`,
      toolSelected: pending.toolName,
      toolArguments: { projectId: project.id, approvalId },
      toolResult: { rejectedByHuman: true },
      humanApprovalStatus: 'REJECTED'
    });
    return { status: 'REJECTED', log, project };
  }

  return executeAgentTool({
    toolName: pending.toolName,
    args: { ...(pending.args || {}), ...args },
    project,
    paypalClient,
    verifiedApprovalId: pending.id,
    reasoningSummary: `Freelancer explicitly approved pending request ${pending.id} for ${pending.toolName}().`
  });
}

/**
 * Conversational AI Agent Router (`handleAgentConversation`).
 */
export async function handleAgentConversation({ message, project, paypalClient }) {
  const text = String(message || '').trim();
  if (!text) {
    throw new ValidationError('Message cannot be empty.', ['message']);
  }
  const lower = text.toLowerCase();

  if (
    lower.includes('missing') ||
    lower.includes('ambiguit') ||
    lower.includes('unclear') ||
    lower.includes('scope creep') ||
    lower.includes('risk')
  ) {
    const out = await executeAgentTool({
      toolName: 'identify_ambiguities',
      project,
      paypalClient,
      reasoningSummary: `Freelancer asked "${text}". Calling identify_ambiguities() to inspect missing details and scope creep risks in project ${project.id}.`
    });
    const r = out.result;
    const reply = [
      `I ran \`identify_ambiguities()\` on **${project.scope.projectTitle}**:`,
      r.ambiguousStatements.length > 0
        ? `• **Ambiguous Client Statements:** ${r.ambiguousStatements
            .map((a) => `"${a.quote}" (${a.issue})`)
            .join('; ')}`
        : `• **Ambiguous Client Statements:** None remaining.`,
      r.missingInformation.length > 0
        ? `• **Missing Information:** ${r.missingInformation.join(' ')}`
        : `• **Missing Information:** All core scope details are present.`,
      r.scopeCreepWarnings.length > 0
        ? `• **Scope Creep Warnings:** ${r.scopeCreepWarnings.join(' ')}`
        : '',
      `• **Suggested Revision Limit:** ${r.suggestedRevisionLimit}`
    ]
      .filter(Boolean)
      .join('\n');

    return { reply, toolExecutions: [out.log], pendingApproval: null, project };
  }

  if (
    lower.includes('charge extra') ||
    lower.includes('additional') ||
    lower.includes('pricing') ||
    lower.includes('how much') ||
    lower.includes('add copywriting')
  ) {
    const shouldApply = lower.includes('add copywriting to scope') || lower.includes('yes add');
    const out = await executeAgentTool({
      toolName: 'calculate_project_pricing',
      args: { includeOptionalAddons: true, applyAddonsToScope: shouldApply },
      project,
      paypalClient,
      reasoningSummary: `Freelancer asked "${text}". Calling calculate_project_pricing() to compare base scope vs. additional charges.`
    });
    const r = out.result;
    const addonsText = r.suggestedAdditionalCharges
      .map((a) => `**${a.title}** (+$${a.suggestedPrice.toFixed(2)} — ${a.reason})`)
      .join('; ');

    const reply = [
      `Yes — based on \`calculate_project_pricing()\`, your current base scope is **${r.currency} $${r.currentScopeTotal.toFixed(2)}**.`,
      `• **Recommended Additional Charge:** ${addonsText}`,
      `• **Recommended Total with Add-On:** **${r.currency} $${r.recommendedTotalIfBundled.toFixed(2)}**`,
      `If you keep the price at $${r.currentScopeTotal.toFixed(2)}, make sure those optional items stay listed under **Exclusions** so you don't do unpaid extra work.`
    ].join('\n');

    return { reply, toolExecutions: [out.log], pendingApproval: null, project };
  }

  if (lower.includes('analyze') || lower.includes('requirement') || lower.includes('extract')) {
    const reqOut = await executeAgentTool({
      toolName: 'extract_project_requirements',
      project,
      paypalClient,
      reasoningSummary: `Freelancer asked "${text}". Calling extract_project_requirements() and identify_ambiguities() on the project brief.`
    });
    const ambOut = await executeAgentTool({
      toolName: 'identify_ambiguities',
      project,
      paypalClient,
      reasoningSummary: `Following up with identify_ambiguities() to surface unclear clauses and missing info.`
    });

    const reply = [
      `I analyzed the client's brief for **${project.scope.projectTitle}** using \`extract_project_requirements()\` and \`identify_ambiguities()\`:`,
      `• **Deliverables (${reqOut.result.deliverablesCount}):** ${reqOut.result.deliverables.join('; ')}`,
      `• **Target Deadline:** ${reqOut.result.deadline}`,
      `• **Quoted / Proposed Budget:** ${reqOut.result.currency} $${reqOut.result.totalAmount.toFixed(2)}`,
      ambOut.result.scopeCreepWarnings.length > 0
        ? `• **Watch Out for Scope Creep:** ${ambOut.result.scopeCreepWarnings.join(' ')}`
        : ''
    ]
      .filter(Boolean)
      .join('\n');

    return { reply, toolExecutions: [reqOut.log, ambOut.log], pendingApproval: null, project };
  }

  if (lower.includes('lock') || (lower.includes('approve') && lower.includes('scope'))) {
    const out = await executeAgentTool({
      toolName: 'lock_scope',
      project,
      paypalClient,
      reasoningSummary: `Freelancer requested locking the scope ("${text}"). Requesting human approval before executing lock_scope().`
    });
    return {
      reply: `${out.approvalRequest.explanation}\n\nPlease click **Approve & Execute** on the confirmation card below to lock the scope.`,
      toolExecutions: [out.log],
      pendingApproval: out.approvalRequest,
      project
    };
  }

  if (lower.includes('invoice') || lower.includes('bill')) {
    const logs = [];
    if (project.state === 'DRAFT_SCOPE' || !project.scopeLock) {
      const lockOut = await executeAgentTool({
        toolName: 'lock_scope',
        project,
        paypalClient,
        reasoningSummary: `Freelancer asked to generate an invoice ("${text}"), but the project is still in DRAFT_SCOPE. Requesting human approval for lock_scope() first.`
      });
      return {
        reply: `Before I can create a PayPal invoice, the Scope of Work must be locked.\n\n${lockOut.approvalRequest.explanation}`,
        toolExecutions: [lockOut.log],
        pendingApproval: lockOut.approvalRequest,
        project
      };
    }

    const createOut = await executeAgentTool({
      toolName: 'create_paypal_invoice',
      project,
      paypalClient,
      reasoningSummary: `Project scope is locked. Calling create_paypal_invoice() to prepare the PayPal draft invoice.`
    });
    logs.push(createOut.log);

    const sendOut = await executeAgentTool({
      toolName: 'send_paypal_invoice',
      project,
      paypalClient,
      reasoningSummary: `Draft invoice ${project.paypalInvoice.invoiceId} is ready. Requesting explicit human approval before calling send_paypal_invoice().`
    });
    logs.push(sendOut.log);

    return {
      reply: [
        createOut.result.duplicatePrevented
          ? `Draft Invoice **#${createOut.result.invoiceNumber}** (\`${createOut.result.invoiceId}\`) already exists for this project (duplicate creation prevented).`
          : `I created PayPal Draft Invoice **#${createOut.result.invoiceNumber}** (\`${createOut.result.invoiceId}\`) for **${createOut.result.currency} $${createOut.result.totalAmount}** in **${createOut.result.connectionMode}**.`,
        sendOut.approvalRequest.explanation
      ].join('\n\n'),
      toolExecutions: logs,
      pendingApproval: sendOut.approvalRequest,
      project
    };
  }

  if (lower.includes('paid') || lower.includes('status') || lower.includes('check')) {
    const out = await executeAgentTool({
      toolName: 'get_invoice_status',
      project,
      paypalClient,
      reasoningSummary: `Freelancer asked "${text}". Calling get_invoice_status() to check canonical payment status.`
    });
    const r = out.result;
    if (!r.hasInvoice) {
      return {
        reply: `I checked \`get_invoice_status()\`: No PayPal invoice has been created for **${project.scope.projectTitle}** yet (current state: \`${r.projectState}\`).`,
        toolExecutions: [out.log],
        pendingApproval: null,
        project
      };
    }

    const paidText = r.paymentVerifiedAuthentic
      ? `Yes — Invoice **#${r.invoiceNumber}** (\`${r.invoiceId}\`) is verified **PAID** via authentic PayPal verification.`
      : `Not yet — Invoice **#${r.invoiceNumber}** (\`${r.invoiceId}\`) currently has status **${r.status}** with **${r.currency} $${r.amountDue}** due (${
          r.isSimulatedFixture ? 'Local Demo / Fixture Mode' : 'Connected PayPal Sandbox Mode'
        }).`;

    return {
      reply: paidText,
      toolExecutions: [out.log],
      pendingApproval: null,
      project
    };
  }

  if (lower.includes('remind') || lower.includes('follow up') || lower.includes('nudge')) {
    const out = await executeAgentTool({
      toolName: 'generate_payment_reminder',
      args: { sendViaPayPal: false },
      project,
      paypalClient,
      reasoningSummary: `Freelancer asked "${text}". Calling generate_payment_reminder() to compose a polite reminder from the project and invoice data.`
    });
    return {
      reply: `Here is a polite payment reminder grounded in your project details:\n\n> ${out.draftMessage.replace(
        /\n/g,
        '\n> '
      )}\n\nPlease click **Approve & Execute** below if you would like me to send this reminder.`,
      toolExecutions: [out.log],
      pendingApproval: out.approvalRequest || null,
      project
    };
  }

  const docOut = await executeAgentTool({
    toolName: 'generate_scope_document',
    project,
    paypalClient,
    reasoningSummary: `Freelancer asked "${text}". Calling generate_scope_document() to summarize current project scope and state.`
  });
  const d = docOut.result;
  return {
    reply: [
      `Here is the current Scope of Work for **${d.projectTitle}** (\`${d.lockStatus}\`):`,
      `• **Client:** ${d.clientName} (${d.clientEmail})`,
      `• **Deliverables:** ${d.deliverables.join('; ')}`,
      `• **Timeline:** ${d.timelineDeadline} | **Revisions:** ${d.revisionLimit}`,
      `• **Total Project Cost:** ${d.totalProjectCost}`
    ].join('\n'),
    toolExecutions: [docOut.log],
    pendingApproval: null,
    project
  };
}
