/**
 * Proof-to-Pay v3.1 — Persistent Freelancer Project Store (`src/store.mjs`)
 *
 * Ensures that project data, pending approvals, locked scope hashes, PayPal invoice references,
 * processed webhook event IDs, and audit/execution logs are atomically persisted to disk
 * (`data/projects.json`) and survive server restarts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractScopeDeterministic } from './ai-extractor.mjs';
import { createProjectRecord } from './state-machine.mjs';

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

export class ProjectStore {
  constructor(filePath = DEFAULT_DATA_PATH) {
    this.filePath = filePath;
    this.projects = [];
    this._init();
  }

  _init() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.projects = parsed.map((p) => ({
            ...p,
            ownerId: p.ownerId || DEFAULT_OWNER_ID,
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
    this.projects = [];
this.save();
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

    this.projects = [primaryProject];
    this.save();
    return this.projects;
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
