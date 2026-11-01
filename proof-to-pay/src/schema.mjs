/**
 * Proof-to-Pay — Runtime Schema Validation & PayPal Invoicing v2 Payload Mapper (`src/schema.mjs`)
 *
 * Maps the approved project scope into PayPal Invoicing v2 format:
 * - Client name
 * - Client email
 * - Project title
 * - Deliverables
 * - Line items (quantity, unit price, currency)
 * - Total amount
 * - Payment terms & due date
 * - Notes to client
 */

const VALID_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'SGD']);
const VALID_PAYMENT_TERMS = new Set([
  'DUE_ON_RECEIPT',
  'DUE_ON_DATE_SPECIFIED',
  'NET_10',
  'NET_15',
  'NET_30',
  'NET_45',
  'NET_60',
  'NET_90'
]);
const VALID_SEVERITIES = new Set(['HIGH', 'MEDIUM', 'LOW']);
const VALID_CONFIDENCE = new Set(['EXPLICIT', 'INFERRED', 'AMBIGUOUS']);

export class ValidationError extends Error {
  /**
   * @param {string} message
   * @param {string[]} [details]
   */
  constructor(message, details = []) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
    this.statusCode = 400;
  }
}

export function validateBriefInput(input) {
  const errors = [];
  if (!input || typeof input !== 'object') {
    throw new ValidationError('Request body must be a JSON object.', ['body']);
  }
  const rawBrief = typeof input.rawBrief === 'string' ? input.rawBrief.trim() : '';
  if (rawBrief.length < 10) {
    errors.push('rawBrief must be a string of at least 10 characters.');
  }
  if (rawBrief.length > 15000) {
    errors.push('rawBrief must not exceed 15,000 characters.');
  }
  const clientName = typeof input.clientName === 'string' ? input.clientName.trim() : '';
  const clientEmail = typeof input.clientEmail === 'string' ? input.clientEmail.trim() : '';
  if (clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
    errors.push('clientEmail must be a valid email address when provided.');
  }
  if (errors.length > 0) {
    throw new ValidationError('Invalid client brief input.', errors);
  }
  return {
    rawBrief,
    clientName: clientName || null,
    clientEmail: clientEmail || null,
    projectTitle: typeof input.projectTitle === 'string' ? input.projectTitle.trim() : null
  };
}

export function validateScopeCard(scope) {
  const errors = [];
  if (!scope || typeof scope !== 'object') {
    throw new ValidationError('Scope card must be an object.', ['scope']);
  }

  const clientName = String(scope.clientName || 'Client Stakeholder').trim();
  const clientEmail = String(scope.clientEmail || '').trim();
  if (!clientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
    errors.push('A valid clientEmail (e.g., client@sandbox.example.com) is required for PayPal invoicing.');
  }

  const projectTitle = String(scope.projectTitle || '').trim();
  if (projectTitle.length < 3) {
    errors.push('projectTitle must be at least 3 characters.');
  }

  const projectSummary = String(
    scope.projectSummary || `Scope of Work for ${projectTitle || 'Freelance Project'}.`
  ).trim();
  if (projectSummary.length < 5) {
    errors.push('projectSummary must be at least 5 characters.');
  }

  const currency = String(scope.currency || 'USD').toUpperCase().trim();
  if (!VALID_CURRENCIES.has(currency)) {
    errors.push(`currency must be one of: ${Array.from(VALID_CURRENCIES).join(', ')}`);
  }

  const paymentTerms = String(scope.paymentTerms || 'DUE_ON_RECEIPT').toUpperCase().trim();
  if (!VALID_PAYMENT_TERMS.has(paymentTerms)) {
    errors.push(`paymentTerms must be one of: ${Array.from(VALID_PAYMENT_TERMS).join(', ')}`);
  }

  const deadline = String(scope.deadline || '').trim();
  if (!deadline) {
    errors.push('deadline is required (ISO date YYYY-MM-DD or explicit milestone date).');
  }

  if (!Array.isArray(scope.deliverables) || scope.deliverables.length === 0) {
    errors.push('deliverables must be a non-empty array of scope deliverables.');
  }
  const deliverables = (Array.isArray(scope.deliverables) ? scope.deliverables : []).map((d, idx) => {
    if (typeof d === 'string') {
      return {
        id: `DEL-${idx + 1}`,
        title: d.trim(),
        description: d.trim(),
        sourceQuote: 'User edited',
        confidence: 'EXPLICIT'
      };
    }
    const title = String(d?.title || '').trim();
    if (!title) {
      errors.push(`deliverables[${idx}].title is required.`);
    }
    const confidence = VALID_CONFIDENCE.has(d?.confidence) ? d.confidence : 'EXPLICIT';
    return {
      id: String(d?.id || `DEL-${idx + 1}`),
      title,
      description: String(d?.description || title).trim(),
      sourceQuote: String(d?.sourceQuote || 'Direct client brief').trim(),
      confidence
    };
  });

  if (!Array.isArray(scope.lineItems) || scope.lineItems.length === 0) {
    errors.push('lineItems must contain at least one billable item.');
  }
  let computedTotal = 0;
  const lineItems = (Array.isArray(scope.lineItems) ? scope.lineItems : []).map((item, idx) => {
    const name = String(item?.name || '').trim();
    if (!name) {
      errors.push(`lineItems[${idx}].name is required.`);
    }
    const quantity = Number(item?.quantity ?? 1);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.push(`lineItems[${idx}].quantity must be a positive number.`);
    }
    const unitPrice = Number(item?.unitPrice ?? item?.unit_amount?.value ?? 0);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      errors.push(`lineItems[${idx}].unitPrice must be a non-negative number.`);
    }
    const subtotal = Math.round(quantity * unitPrice * 100) / 100;
    computedTotal += subtotal;
    return {
      id: String(item?.id || `ITEM-${idx + 1}`),
      name,
      description: String(item?.description || '').trim(),
      quantity: String(quantity),
      unitPrice: Number(unitPrice.toFixed(2)),
      subtotal: Number(subtotal.toFixed(2)),
      confidence: VALID_CONFIDENCE.has(item?.confidence) ? item.confidence : 'EXPLICIT',
      optional: Boolean(item?.optional)
    };
  });

  computedTotal = Number(computedTotal.toFixed(2));
  if (computedTotal <= 0) {
    errors.push('Total invoice amount across lineItems must be greater than 0.00.');
  }

  const exclusions = (Array.isArray(scope.exclusions) ? scope.exclusions : [])
    .map((e) => String(e || '').trim())
    .filter(Boolean);

  const milestones = (Array.isArray(scope.milestones) ? scope.milestones : []).map((m, idx) => ({
    id: String(m?.id || `MS-${idx + 1}`),
    title: String(m?.title || `Milestone ${idx + 1}`).trim(),
    dueDate: String(m?.dueDate || deadline).trim(),
    verificationCriteria: String(m?.verificationCriteria || 'Client sign-off on deliverable').trim()
  }));

  const acceptanceCriteria = (Array.isArray(scope.acceptanceCriteria) ? scope.acceptanceCriteria : [])
    .map((c) => String(c || '').trim())
    .filter(Boolean);

  const riskFlags = (Array.isArray(scope.riskFlags) ? scope.riskFlags : []).map((r, idx) => ({
    id: String(r?.id || `RISK-${idx + 1}`),
    field: String(r?.field || 'scope').trim(),
    severity: VALID_SEVERITIES.has(r?.severity) ? r.severity : 'MEDIUM',
    issue: String(r?.issue || '').trim(),
    sourceQuote: String(r?.sourceQuote || '').trim(),
    recommendation: String(r?.recommendation || '').trim(),
    resolved: Boolean(r?.resolved),
    resolutionNote: String(r?.resolutionNote || '').trim()
  }));

  if (errors.length > 0) {
    throw new ValidationError('Scope validation failed.', errors);
  }

  return {
    clientName,
    clientEmail,
    projectTitle,
    projectSummary,
    deliverables,
    exclusions,
    milestones,
    deadline,
    currency,
    totalAmount: computedTotal,
    paymentTerms,
    acceptanceCriteria,
    lineItems,
    riskFlags,
    revisionLimit: Number.isFinite(Number(scope.revisionLimit)) ? Number(scope.revisionLimit) : 2,
    notesToClient: String(
      scope.notesToClient ||
        `Project: ${projectTitle} | Target Due Date: ${deadline} | Total: ${currency} $${computedTotal.toFixed(
          2
        )} | Deliverables: ${deliverables.map((d) => d.title).join('; ')} | Up to ${
          scope.revisionLimit ?? 2
        } revision rounds included.`
    ).trim()
  };
}

/**
 * Maps an approved ScopeCard into the official PayPal Invoicing v2 API payload:
 * - Client name & email (`primary_recipients[0].billing_info`)
 * - Project title & deliverables (`detail.memo`, `detail.note`, `detail.terms_and_conditions`)
 * - Line items, quantity, unit price, currency (`items[]`)
 * - Total amount (`amount`)
 * - Payment terms & due date (`detail.payment_term`)
 * - Notes to client (`detail.note`)
 */
export function buildPayPalInvoiceV2Payload(approvedScope, invoicerConfig = {}, scopeHash = '') {
  const cleanName = approvedScope.clientName.replace(/\([^)]*\)/g, '').trim();
  const nameParts = cleanName.split(/\s+/);
  const clientGivenName = nameParts[0] || 'Client';
  const clientSurname = nameParts.slice(1).join(' ') || 'Stakeholder';

  const invoiceDate = new Date().toISOString().slice(0, 10);
  const isDateSpecified = approvedScope.paymentTerms === 'DUE_ON_DATE_SPECIFIED';

  const paymentTermObj = isDateSpecified
    ? {
        term_type: 'DUE_ON_DATE_SPECIFIED',
        due_date: approvedScope.deadline
      }
    : {
        term_type: approvedScope.paymentTerms
      };

  const deliverablesSummary = approvedScope.deliverables.map((d, i) => `${i + 1}. ${d.title}`).join('; ');

  const invoicerObj = {
    name: {
      given_name: invoicerConfig.givenName || 'Alex',
      surname: invoicerConfig.surname || 'Rivera'
    },
    business_name: invoicerConfig.businessName || 'Rivera Freelance Studio'
  };
  if (invoicerConfig.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invoicerConfig.email)) {
    invoicerObj.email_address = invoicerConfig.email;
  }

  return {
    detail: {
      invoice_number: `P2P-${Date.now().toString().slice(-6)}`,
      reference: `SCOPE-${String(scopeHash).slice(0, 10).toUpperCase()}`,
      invoice_date: invoiceDate,
      currency_code: approvedScope.currency,
      memo: `Project: ${approvedScope.projectTitle} (Due: ${approvedScope.deadline})`.slice(0, 500),
      note: approvedScope.notesToClient.slice(0, 4000),
      terms_and_conditions: [
        `Project Title: ${approvedScope.projectTitle}`,
        `Due Date: ${approvedScope.deadline}`,
        `Deliverables: ${deliverablesSummary}`,
        `Revision Limit: ${approvedScope.revisionLimit} rounds`,
        `Exclusions: ${approvedScope.exclusions.join(' | ')}`,
        `Scope Lock SHA-256: ${scopeHash}`
      ]
        .join('\n')
        .slice(0, 4000),
      payment_term: paymentTermObj
    },
    invoicer: invoicerObj,
    primary_recipients: [
      {
        billing_info: {
          name: {
            given_name: clientGivenName,
            surname: clientSurname
          },
          email_address: approvedScope.clientEmail
        }
      }
    ],
    items: approvedScope.lineItems.map((li) => ({
      name: li.name.slice(0, 200),
      description: (li.description || `${approvedScope.projectTitle} — ${li.name}`).slice(0, 1000),
      quantity: String(li.quantity),
      unit_amount: {
        currency_code: approvedScope.currency,
        value: Number(li.unitPrice).toFixed(2)
      },
      unit_of_measure: 'QUANTITY'
    })),
    amount: {
      currency_code: approvedScope.currency,
      value: Number(approvedScope.totalAmount).toFixed(2)
    },
    configuration: {
      partial_payment: {
        allow_partial_payment: false
      },
      allow_tip: false,
      tax_calculated_after_discount: true,
      tax_inclusive: false
    }
  };
}
