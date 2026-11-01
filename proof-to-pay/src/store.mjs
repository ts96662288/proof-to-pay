/**
 * Proof-to-Pay v3.2 — Persistent Freelancer Project & Workspace Settings Store (`src/store.mjs`)
 *
 * Ensures that:
 * 1. Project data, pending approvals, locked scope hashes, PayPal invoice references,
 *    processed webhook event IDs, and audit/execution logs are atomically persisted to disk (`data/projects.json`).
 * 2. Demo projects (`isDemo: true`) are explicitly distinguished from real freelancer workspace projects (`isDemo: false`)
 *    so clearing demo data never deletes real user projects.
 * 3. Business-critical Workspace Preferences, Notification Settings, and Security Settings are persisted
 *    to disk (`data/settings.json`), with full support for JSON/CSV export and backup/restore snapshots.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractScopeDeterministic } from './ai-extractor.mjs';
import { createProjectRecord } from './state-machine.mjs';
import { ValidationError } from './schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_PATH = path.resolve(__dirname, '../data/projects.json');
export const DEFAULT_OWNER_ID = 'freelancer-alex-rivera';

export const DEMO_BRIEFS = [
  {
    id: 'demo-startup-landing',
    channel: 'WhatsApp',
    label: 'Startup Landing Page ($450 — Unclear Copywriting & Revision Limit)',
    clientName: 'Jordan Vance (NovaPulse Startup)',
    clientEmail: 'jordan.vance-buyer@sandbox.paypal.com',
    projectTitle: 'Startup Landing Page (3 Sections)',
    proposedBudget: 450,
    rawBrief:
      'I need a landing page for my startup by next Friday. Three sections, mobile friendly, and I can pay $450. I may want copywriting too.'
  },
  {
    id: 'demo-saas-ui-kit',
    channel: 'Slack',
    label: 'SaaS Brand & Figma UI Kit ($850 — Missing Revision Cap & Assets)',
    clientName: 'Marcus Chen (VectorFlow Labs)',
    clientEmail: 'marcus.chen-buyer@sandbox.paypal.com',
    projectTitle: 'VectorFlow Brand Identity & Figma UI Kit',
    proposedBudget: 850,
    rawBrief:
      'Need a clean SVG logo system, color palette, and dark-mode Figma component library by 2026-11-10. I can pay $850 upon completion. Maybe we can also include animated icons if possible.'
  },
  {
    id: 'demo-shopify-redesign',
    channel: 'Email',
    label: 'E-Commerce Mobile Product Page Redesign ($1,200 — Unclear Backend Scope)',
    clientName: 'Elena Rostova (Lumen Studio)',
    clientEmail: 'elena.rostova-buyer@sandbox.paypal.com',
    projectTitle: 'Mobile Product Page & Cart Drawer Redesign',
    proposedBudget: 1200,
    rawBrief:
      'Hi! We need a complete redesign of our mobile product page and slide-out cart drawer in two weeks. Budget is $1,200. Must include mobile-first Figma layouts and clean HTML/CSS. We might also want custom inventory sync if possible.'
  }
];

export const DEFAULT_WORKSPACE_SETTINGS = Object.freeze({
  workspace: {
    workspaceName: 'Rivera Freelance Studio',
    freelancerName: 'Alex Rivera',
    invoicerEmail: 'alex@riverastudio.dev',
    defaultCurrency: 'USD',
    defaultInvoiceDuePeriod: 'DUE_ON_RECEIPT',
    dateFormat: 'YYYY-MM-DD',
    timeZone: 'America/New_York',
    defaultTaxPercentage: 0
  },
  notifications: {
    invoiceCreated: true,
    invoicePaid: true,
    paymentVerificationFailure: true,
    webhookFailure: true,
    pendingInvoiceReminders: true
  },
  security: {
    sessionTimeoutMinutes: 30,
    requireConfirmationOnDestructiveActions: true
  },
  updatedAt: new Date().toISOString()
});

const ALLOWED_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD']);
const ALLOWED_DUE_PERIODS = new Set(['DUE_ON_RECEIPT', 'NET_15', 'NET_30', 'DUE_ON_DATE_SPECIFIED', '50_50_SPLIT']);
const ALLOWED_DATE_FORMATS = new Set(['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY']);

export function validateWorkspaceSettingsInput(input = {}, current = DEFAULT_WORKSPACE_SETTINGS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Settings payload must be a JSON object.');
  }

  const wsIn = input.workspace || input;
  const notifIn = input.notifications || {};
  const secIn = input.security || {};

  const workspaceName = String(wsIn.workspaceName ?? current.workspace.workspaceName ?? 'Rivera Freelance Studio').trim();
  if (!workspaceName || workspaceName.length > 120) {
    throw new ValidationError('Workspace name must be between 1 and 120 characters.', ['workspaceName']);
  }

  const freelancerName = String(wsIn.freelancerName ?? current.workspace.freelancerName ?? 'Alex Rivera').trim();
  if (!freelancerName || freelancerName.length > 120) {
    throw new ValidationError('Freelancer / business name must be between 1 and 120 characters.', ['freelancerName']);
  }

  const invoicerEmail = String(wsIn.invoicerEmail ?? current.workspace.invoicerEmail ?? 'alex@riverastudio.dev').trim();
  if (invoicerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invoicerEmail)) {
    throw new ValidationError('Invoicer email must be a valid email address.', ['invoicerEmail']);
  }

  const defaultCurrency = String(wsIn.defaultCurrency ?? current.workspace.defaultCurrency ?? 'USD')
    .toUpperCase()
    .trim();
  if (!ALLOWED_CURRENCIES.has(defaultCurrency)) {
    throw new ValidationError(`Unsupported default currency: ${defaultCurrency}.`, ['defaultCurrency']);
  }

  const defaultInvoiceDuePeriod = String(
    wsIn.defaultInvoiceDuePeriod ?? current.workspace.defaultInvoiceDuePeriod ?? 'DUE_ON_RECEIPT'
  ).trim();
  if (!ALLOWED_DUE_PERIODS.has(defaultInvoiceDuePeriod)) {
    throw new ValidationError(`Unsupported invoice due period: ${defaultInvoiceDuePeriod}.`, [
      'defaultInvoiceDuePeriod'
    ]);
  }

  const dateFormat = String(wsIn.dateFormat ?? current.workspace.dateFormat ?? 'YYYY-MM-DD').trim();
  if (!ALLOWED_DATE_FORMATS.has(dateFormat)) {
    throw new ValidationError(`Unsupported date format: ${dateFormat}.`, ['dateFormat']);
  }

  const timeZone = String(wsIn.timeZone ?? current.workspace.timeZone ?? 'America/New_York').trim();
  if (!timeZone || timeZone.length > 80) {
    throw new ValidationError('A valid time zone is required.', ['timeZone']);
  }

  const defaultTaxPercentage = Number(wsIn.defaultTaxPercentage ?? current.workspace.defaultTaxPercentage ?? 0);
  if (!Number.isFinite(defaultTaxPercentage) || defaultTaxPercentage < 0 || defaultTaxPercentage > 50) {
    throw new ValidationError('Default tax percentage must be between 0 and 50.', ['defaultTaxPercentage']);
  }

  const sessionTimeoutMinutes = Number(
    secIn.sessionTimeoutMinutes ?? input.sessionTimeoutMinutes ?? current.security.sessionTimeoutMinutes ?? 30
  );
  if (!Number.isFinite(sessionTimeoutMinutes) || sessionTimeoutMinutes < 0 || sessionTimeoutMinutes > 1440) {
    throw new ValidationError('Session timeout must be between 0 and 1440 minutes.', ['sessionTimeoutMinutes']);
  }

  return {
    workspace: {
      workspaceName,
      freelancerName,
      invoicerEmail,
      defaultCurrency,
      defaultInvoiceDuePeriod,
      dateFormat,
      timeZone,
      defaultTaxPercentage: Number(defaultTaxPercentage.toFixed(2))
    },
    notifications: {
      invoiceCreated: Boolean(notifIn.invoiceCreated ?? current.notifications.invoiceCreated),
      invoicePaid: Boolean(notifIn.invoicePaid ?? current.notifications.invoicePaid),
      paymentVerificationFailure: Boolean(
        notifIn.paymentVerificationFailure ?? current.notifications.paymentVerificationFailure
      ),
      webhookFailure: Boolean(notifIn.webhookFailure ?? current.notifications.webhookFailure),
      pendingInvoiceReminders: Boolean(notifIn.pendingInvoiceReminders ?? current.notifications.pendingInvoiceReminders)
    },
    security: {
      sessionTimeoutMinutes: Math.round(sessionTimeoutMinutes),
      requireConfirmationOnDestructiveActions: Boolean(
        secIn.requireConfirmationOnDestructiveActions ?? current.security.requireConfirmationOnDestructiveActions ?? true
      )
    },
    updatedAt: new Date().toISOString()
  };
}

export class ProjectStore {
  constructor(filePath = DEFAULT_DATA_PATH) {
    this.filePath = filePath;
    this.settingsPath = path.join(path.dirname(filePath), 'settings.json');
    this.backupPath = path.join(path.dirname(filePath), 'backup-latest.json');
    this.projects = [];
    this.settings = structuredClone(DEFAULT_WORKSPACE_SETTINGS);
    this.systemAuditLog = [];
    this._init();
  }

  _init() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(this.settingsPath)) {
      try {
        const rawSettings = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
        this.settings = validateWorkspaceSettingsInput(rawSettings, DEFAULT_WORKSPACE_SETTINGS);
      } catch {
        this.settings = structuredClone(DEFAULT_WORKSPACE_SETTINGS);
      }
    } else {
      this._saveSettings();
    }

    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.projects = parsed.map((p) => ({
            ...p,
            ownerId: p.ownerId || DEFAULT_OWNER_ID,
            isDemo: p.isDemo !== undefined ? Boolean(p.isDemo) : p.id === 'P2P-DEMO01',
            pendingApprovals: Array.isArray(p.pendingApprovals) ? p.pendingApprovals : [],
            processedWebhookEventIds: Array.isArray(p.processedWebhookEventIds) ? p.processedWebhookEventIds : [],
            agentExecutionLog: Array.isArray(p.agentExecutionLog) ? p.agentExecutionLog : [],
            auditTrail: Array.isArray(p.auditTrail) ? p.auditTrail : []
          }));
          return;
        }
      } catch {
        // Re-seed if file is empty or unreadable
      }
    }
    this.resetToDemoSeed();
  }

  _saveSettings() {
    const tmpPath = `${this.settingsPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.settings, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.settingsPath);
  }

  getSettings() {
    return this.settings;
  }

  updateSettings(input) {
    this.settings = validateWorkspaceSettingsInput(input, this.settings);
    this._saveSettings();
    this.recordSystemAudit('WORKSPACE_SETTINGS_UPDATED', 'FREELANCER', 'SETTINGS_API', `Updated workspace settings (${this.settings.workspace.workspaceName}, ${this.settings.workspace.defaultCurrency}).`);
    return this.settings;
  }

  recordSystemAudit(event, actor, verifiedSource, summary) {
    const entry = {
      id: `AUD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      timestamp: new Date().toISOString(),
      event,
      actor,
      verifiedSource,
      summary
    };
    this.systemAuditLog.push(entry);
    if (this.projects[0]) {
      this.projects[0].auditTrail = this.projects[0].auditTrail || [];
      this.projects[0].auditTrail.push(entry);
      this.save();
    }
    return entry;
  }

  resetToDemoSeed(ownerId = DEFAULT_OWNER_ID) {
    const primary = DEMO_BRIEFS[0];
    const extracted = extractScopeDeterministic(primary);
    const primaryProject = createProjectRecord({
      rawBrief: primary.rawBrief,
      extractedScope: extracted.scope,
      analysisDetails: extracted.analysisDetails,
      extractionMeta: extracted.extractionMeta,
      proposedBudget: primary.proposedBudget
    });
    primaryProject.id = 'P2P-DEMO01';
    primaryProject.ownerId = ownerId;
    primaryProject.isDemo = true;
    primaryProject.agentExecutionLog = [
      {
        id: 'EXEC-INIT01',
        timestamp: primaryProject.createdAt,
        reasoningSummary:
          'Initial project analysis: ran extract_project_requirements() and identify_ambiguities() on the client WhatsApp brief.',
        toolSelected: 'extract_project_requirements',
        toolArguments: { projectId: 'P2P-DEMO01', proposedBudget: 450 },
        toolResult: {
          deliverablesCount: extracted.scope.deliverables.length,
          totalAmount: 450,
          ambiguitiesFound: extracted.scope.riskFlags.length,
          aiProvider: extracted.extractionMeta.provider,
          liveAiUsed: extracted.extractionMeta.liveAiUsed
        },
        humanApprovalStatus: 'NOT_REQUIRED',
        errorAndRecovery: null
      }
    ];

    // Preserve any non-demo (real user) projects if resetting demo seed
    const realProjects = this.projects.filter((p) => p.isDemo === false);
    this.projects = [primaryProject, ...realProjects];
    this.save();
    return this.projects;
  }

  /**
   * Clears ONLY demo projects (`isDemo === true`), strictly preserving real workspace projects (`isDemo === false`).
   */
  clearDemoProjects(ownerId = DEFAULT_OWNER_ID) {
    const beforeCount = this.projects.length;
    const realProjects = this.projects.filter((p) => p.isDemo === false);
    const removedCount = beforeCount - realProjects.length;
    this.projects = realProjects;
    this.save();
    return {
      removedDemoCount: removedCount,
      preservedRealCount: realProjects.length,
      projects: this.list(ownerId)
    };
  }

  createBackupSnapshot(ownerId = DEFAULT_OWNER_ID) {
    const snapshot = {
      backupVersion: '3.2',
      createdAt: new Date().toISOString(),
      settings: this.settings,
      projects: this.list(ownerId)
    };
    fs.writeFileSync(this.backupPath, JSON.stringify(snapshot, null, 2), 'utf8');
    this.recordSystemAudit('WORKSPACE_BACKUP_CREATED', 'FREELANCER', 'BACKUP_ENGINE', `Created backup snapshot with ${snapshot.projects.length} project(s).`);
    return snapshot;
  }

  restoreBackupSnapshot(snapshotPayload = null) {
    let data = snapshotPayload;
    if (!data || !Array.isArray(data.projects)) {
      if (!fs.existsSync(this.backupPath)) {
        throw new ValidationError('No backup snapshot found on disk to restore.');
      }
      data = JSON.parse(fs.readFileSync(this.backupPath, 'utf8'));
    }
    if (data.settings) {
      this.settings = validateWorkspaceSettingsInput(data.settings, this.settings);
      this._saveSettings();
    }
    if (Array.isArray(data.projects)) {
      this.projects = data.projects;
      this.save();
    }
    this.recordSystemAudit('WORKSPACE_BACKUP_RESTORED', 'FREELANCER', 'BACKUP_ENGINE', `Restored ${this.projects.length} project(s) from backup snapshot.`);
    return {
      settings: this.settings,
      projects: this.projects
    };
  }

  getAllAuditLogs(ownerId = null) {
    const projects = this.list(ownerId);
    const entries = projects.flatMap((p) =>
      (p.auditTrail || []).map((a) => ({
        ...a,
        projectId: p.id,
        projectTitle: p.scope?.projectTitle || p.id,
        clientName: p.scope?.clientName || 'Unknown Client',
        isDemo: Boolean(p.isDemo)
      }))
    );
    return entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  exportAsJson(ownerId = null) {
    const projects = this.list(ownerId);
    return {
      exportFormat: 'Proof-to-Pay Workspace Export v3.2',
      exportedAt: new Date().toISOString(),
      workspaceSettings: this.settings,
      summary: {
        totalProjects: projects.length,
        demoProjects: projects.filter((p) => p.isDemo).length,
        realProjects: projects.filter((p) => !p.isDemo).length
      },
      projects,
      auditLogs: this.getAllAuditLogs(ownerId)
    };
  }

  exportAsCsv(ownerId = null) {
    const projects = this.list(ownerId);
    const headers = [
      'Project ID',
      'Data Type',
      'Project Title',
      'Client Name',
      'Client Email',
      'State',
      'Currency',
      'Total Amount',
      'Payment Terms',
      'Deadline',
      'Revision Limit',
      'Scope Locked',
      'Invoice ID',
      'Invoice Number',
      'Invoice Status',
      'Verified Authentic Paid'
    ];
    const escapeCsv = (val) => {
      const str = String(val ?? '');
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    const rows = projects.map((p) => [
      p.id,
      p.isDemo ? 'DEMO' : 'WORKSPACE',
      p.scope?.projectTitle || '',
      p.scope?.clientName || '',
      p.scope?.clientEmail || '',
      p.state || '',
      p.scope?.currency || 'USD',
      Number(p.scope?.totalAmount || 0).toFixed(2),
      p.scope?.paymentTerms || '',
      p.scope?.deadline || '',
      p.scope?.revisionLimit ?? 2,
      p.scopeLock ? `Yes (v${p.scopeLock.version})` : 'No',
      p.paypalInvoice?.invoiceId || '',
      p.paypalInvoice?.invoiceNumber || '',
      p.paypalInvoice?.status || 'NONE',
      p.paypalInvoice?.paymentVerifiedAuthentic ? 'YES' : 'NO'
    ]);

    return [headers.map(escapeCsv).join(','), ...rows.map((r) => r.map(escapeCsv).join(','))].join('\n');
  }

  save() {
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.projects, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.filePath);
  }

  list(ownerId = null) {
    if (!ownerId) return this.projects;
    return this.projects.filter((p) => (p.ownerId || DEFAULT_OWNER_ID) === ownerId);
  }

  getById(id) {
    return this.projects.find((p) => p.id === id) || null;
  }

  upsert(project) {
    if (!project.ownerId) {
      project.ownerId = DEFAULT_OWNER_ID;
    }
    if (project.isDemo === undefined) {
      project.isDemo = false;
    }
    const idx = this.projects.findIndex((p) => p.id === project.id);
    if (idx >= 0) {
      this.projects[idx] = project;
    } else {
      this.projects.unshift(project);
    }
    this.save();
    return project;
  }
}
