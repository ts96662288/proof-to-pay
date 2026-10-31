/**
 * Proof-to-Pay v3.1 — Complete Structured AI Scope & Ambiguity Extractor (`src/ai-extractor.mjs`)
 *
 * Implements full structured extraction for all 9 required categories:
 * 1. Project title (`projectTitle`)
 * 2. Deliverables (`deliverables`)
 * 3. Deadlines (`deadline`, `deadlineLabel`)
 * 4. Pricing (`currency`, `totalAmount`, `lineItems`, `quotedPriceLabel`)
 * 5. Exclusions (`exclusions`)
 * 6. Ambiguities (`ambiguousStatements` & `riskFlags`)
 * 7. Missing information (`missingInformation`)
 * 8. Revision limits (`revisionLimit`, `suggestedRevisionLimit`, `scopeCreepWarnings`)
 * 9. Additional charges (`additionalCharges`)
 *
 * STRICT HONESTY & SCHEMA VALIDATION:
 * - Validates the complete AI response against `validateScopeCard()` and `validateAnalysisDetails()`.
 * - NEVER silently substitutes a deterministic result while reporting `liveAiUsed: true`.
 * - Clearly exposes `extractionMeta.provider` (`google-gemini` | `openai` | `deterministic-fallback`),
 *   `extractionMeta.liveAiUsed` (`true` | `false`), and `extractionMeta.fallbackReason`.
 */

import { validateScopeCard, ValidationError } from './schema.mjs';

const STRUCTURED_EXTRACTION_PROMPT = `You are the Proof-to-Pay AI Scope Analysis Engine for independent freelancers.
Analyze the client's message and return a single valid JSON object containing ALL of the following fields:
{
  "projectTitle": "string (at least 3 chars)",
  "projectSummary": "string (at least 10 chars)",
  "deadline": "YYYY-MM-DD (resolve relative dates against reference date 2026-10-31)",
  "deadlineLabel": "string explaining how the deadline was determined",
  "currency": "USD | EUR | GBP | CAD",
  "quotedPriceLabel": "string explaining quoted price or proposed budget",
  "paymentTerms": "DUE_ON_RECEIPT | NET_15 | NET_30 | DUE_ON_DATE_SPECIFIED",
  "revisionLimit": 2,
  "suggestedRevisionLimit": "string explaining revision policy",
  "deliverables": [
    {
      "id": "DEL-1",
      "title": "string",
      "description": "string",
      "sourceQuote": "exact quote from brief",
      "confidence": "EXPLICIT | INFERRED"
    }
  ],
  "lineItems": [
    {
      "id": "ITEM-1",
      "name": "string",
      "description": "string",
      "quantity": "1",
      "unitPrice": 450
    }
  ],
  "exclusions": ["string"],
  "acceptanceCriteria": ["string"],
  "ambiguousStatements": [
    {
      "quote": "exact ambiguous quote from brief",
      "issue": "string",
      "recommendation": "string"
    }
  ],
  "missingInformation": ["string"],
  "scopeCreepWarnings": ["string"],
  "additionalCharges": [
    {
      "id": "ADDON-1",
      "title": "string",
      "suggestedPrice": 150,
      "reason": "string"
    }
  ],
  "riskFlags": [
    {
      "id": "RISK-1",
      "field": "string",
      "severity": "HIGH | MEDIUM | LOW",
      "issue": "string",
      "sourceQuote": "string",
      "recommendation": "string",
      "resolved": false
    }
  ]
}`;

export function resolveDeadlineFromText(briefText, refDate = new Date('2026-10-31T12:00:00Z')) {
  const isoMatch = briefText.match(/\b(202\d-\d{2}-\d{2})\b/);
  if (isoMatch) {
    return { date: isoMatch[1], confidence: 'EXPLICIT', quote: isoMatch[1], label: `Explicit date (${isoMatch[1]})` };
  }

  const lower = briefText.toLowerCase();
  if (lower.includes('next friday')) {
    const d = new Date(refDate);
    const day = d.getUTCDay();
    const daysUntilFriday = ((5 - day + 7) % 7) || 7;
    d.setUTCDate(d.getUTCDate() + daysUntilFriday);
    const iso = d.toISOString().slice(0, 10);
    return {
      date: iso,
      confidence: 'INFERRED',
      quote: 'by next Friday',
      label: `${iso} (calculated from "by next Friday")`
    };
  }

  if (lower.includes('two weeks') || lower.includes('2 weeks')) {
    const d = new Date(refDate);
    d.setUTCDate(d.getUTCDate() + 14);
    const iso = d.toISOString().slice(0, 10);
    return {
      date: iso,
      confidence: 'INFERRED',
      quote: 'in two weeks',
      label: `${iso} (calculated from "in two weeks")`
    };
  }

  const fallback = new Date(refDate);
  fallback.setUTCDate(fallback.getUTCDate() + 7);
  const iso = fallback.toISOString().slice(0, 10);
  return {
    date: iso,
    confidence: 'INFERRED',
    quote: 'Not specified in brief',
    label: `${iso} (suggested 7-day delivery window)`
  };
}

/**
 * Validates and normalizes the complete structured AI response (both ScopeCard and AnalysisDetails).
 * Throws a ValidationError if required extraction fields are missing or invalid.
 */
export function validateFullAiExtractionResponse(rawAiJson, inputContext = {}) {
  if (!rawAiJson || typeof rawAiJson !== 'object') {
    throw new ValidationError('AI response must be a JSON object.');
  }

  const errors = [];
  if (typeof rawAiJson.projectTitle !== 'string' || rawAiJson.projectTitle.trim().length < 3) {
    errors.push('AI response missing valid projectTitle.');
  }
  if (!Array.isArray(rawAiJson.deliverables) || rawAiJson.deliverables.length === 0) {
    errors.push('AI response must include a non-empty deliverables array.');
  }
  if (typeof rawAiJson.deadline !== 'string' || !rawAiJson.deadline.trim()) {
    errors.push('AI response must include a deadline.');
  }
  if (!Array.isArray(rawAiJson.lineItems) || rawAiJson.lineItems.length === 0) {
    errors.push('AI response must include a non-empty lineItems array for pricing.');
  }
  if (!Array.isArray(rawAiJson.exclusions)) {
    errors.push('AI response must include an exclusions array.');
  }
  if (!Array.isArray(rawAiJson.missingInformation)) {
    errors.push('AI response must include a missingInformation array.');
  }
  if (!Array.isArray(rawAiJson.additionalCharges)) {
    errors.push('AI response must include an additionalCharges array.');
  }

  if (errors.length > 0) {
    throw new ValidationError('Incomplete AI structured extraction response.', errors);
  }

  const validatedScope = validateScopeCard({
    clientName: rawAiJson.clientName || inputContext.clientName || 'Client Stakeholder',
    clientEmail: rawAiJson.clientEmail || inputContext.clientEmail || 'client@sandbox.paypal.com',
    projectTitle: rawAiJson.projectTitle,
    projectSummary:
      rawAiJson.projectSummary ||
      `Scope of Work for ${rawAiJson.projectTitle} (${rawAiJson.deliverables.length} deliverables, due ${rawAiJson.deadline}).`,
    deliverables: rawAiJson.deliverables,
    exclusions: rawAiJson.exclusions,
    milestones: rawAiJson.milestones || [
      {
        id: 'MS-1',
        title: 'Final Delivery & Acceptance',
        dueDate: rawAiJson.deadline,
        verificationCriteria: 'All deliverables verified against acceptance criteria.'
      }
    ],
    deadline: rawAiJson.deadline,
    currency: rawAiJson.currency || 'USD',
    paymentTerms: rawAiJson.paymentTerms || 'DUE_ON_RECEIPT',
    acceptanceCriteria:
      Array.isArray(rawAiJson.acceptanceCriteria) && rawAiJson.acceptanceCriteria.length > 0
        ? rawAiJson.acceptanceCriteria
        : [
            'All listed deliverables completed and verified',
            `Includes up to ${rawAiJson.revisionLimit ?? 2} consolidated rounds of revisions`
          ],
    lineItems: rawAiJson.lineItems,
    riskFlags: Array.isArray(rawAiJson.riskFlags) ? rawAiJson.riskFlags : [],
    revisionLimit: Number.isFinite(Number(rawAiJson.revisionLimit)) ? Number(rawAiJson.revisionLimit) : 2
  });

  const ambiguousStatements = Array.isArray(rawAiJson.ambiguousStatements)
    ? rawAiJson.ambiguousStatements.map((a) => ({
        quote: String(a?.quote || '').trim(),
        issue: String(a?.issue || '').trim(),
        recommendation: String(a?.recommendation || '').trim()
      }))
    : validatedScope.riskFlags
        .filter((r) => r.sourceQuote)
        .map((r) => ({
          quote: r.sourceQuote,
          issue: r.issue,
          recommendation: r.recommendation
        }));

  const additionalCharges = rawAiJson.additionalCharges.map((c, idx) => ({
    id: String(c?.id || `ADDON-${idx + 1}`),
    title: String(c?.title || 'Additional Scope Item').trim(),
    suggestedPrice: Number(c?.suggestedPrice || 0),
    reason: String(c?.reason || 'Optional client request').trim()
  }));

  const analysisDetails = {
    extractedRequirements: validatedScope.deliverables.map((d) => d.title),
    deadlineLabel: String(rawAiJson.deadlineLabel || validatedScope.deadline),
    quotedPriceLabel: String(
      rawAiJson.quotedPriceLabel || `${validatedScope.currency} $${validatedScope.totalAmount.toFixed(2)}`
    ),
    ambiguousStatements,
    missingInformation: rawAiJson.missingInformation.map((m) => String(m).trim()).filter(Boolean),
    scopeCreepWarnings: Array.isArray(rawAiJson.scopeCreepWarnings)
      ? rawAiJson.scopeCreepWarnings.map((w) => String(w).trim()).filter(Boolean)
      : [],
    suggestedRevisionLimit: String(
      rawAiJson.suggestedRevisionLimit || `${validatedScope.revisionLimit} consolidated rounds of revisions`
    ),
    additionalCharges
  };

  return { scope: validatedScope, analysisDetails };
}

/**
 * Deterministic fallback scope analyzer used ONLY when no live AI credentials are configured
 * or when a live AI call fails. Always sets `liveAiUsed: false`.
 */
export function extractScopeDeterministic({
  rawBrief,
  clientName,
  clientEmail,
  projectTitle,
  proposedBudget,
  fallbackReason = 'No GEMINI_API_KEY or OPENAI_API_KEY configured in server environment.'
}) {
  const text = String(rawBrief || '').trim();
  const lower = text.toLowerCase();

  const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  const resolvedEmail = clientEmail || (emailMatch ? emailMatch[1] : 'client@sandbox.paypal.com');
  const resolvedName = clientName || 'Jordan Vance';

  let currency = 'USD';
  if (text.includes('€') || /\bEUR\b/i.test(text)) currency = 'EUR';
  else if (text.includes('£') || /\bGBP\b/i.test(text)) currency = 'GBP';

  const priceMatches = [
    ...text.matchAll(/(?:\$|€|£|USD\s*|EUR\s*|GBP\s*)(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/gi)
  ];
  const budgetFromInput = Number(proposedBudget);
  const hasQuotedPrice = priceMatches.length > 0;
  const primaryPrice = hasQuotedPrice
    ? Number(priceMatches[0][1].replace(/,/g, ''))
    : Number.isFinite(budgetFromInput) && budgetFromInput > 0
    ? budgetFromInput
    : 450;

  const priceSourceLabel = hasQuotedPrice
    ? `Client quoted ${priceMatches[0][0]} in message`
    : Number.isFinite(budgetFromInput) && budgetFromInput > 0
    ? `Freelancer proposed budget ($${budgetFromInput.toFixed(2)})`
    : 'Suggested baseline estimate ($450.00)';

  const deadlineInfo = resolveDeadlineFromText(text);

  const deliverables = [];
  const exclusions = [];
  const riskFlags = [];
  const lineItems = [];
  const missingInformation = [];
  const scopeCreepWarnings = [];
  const additionalCharges = [];

  const isLandingPageBrief =
    lower.includes('landing page') && (lower.includes('three sections') || lower.includes('3 sections'));

  if (isLandingPageBrief) {
    deliverables.push(
      {
        id: 'DEL-1',
        title: 'Startup Landing Page (3 Core Sections)',
        description:
          'Custom design and front-end build of 3 sections: Hero Banner, Features/Benefits Grid, and Call-to-Action.',
        sourceQuote: 'I need a landing page for my startup by next Friday. Three sections',
        confidence: 'EXPLICIT'
      },
      {
        id: 'DEL-2',
        title: 'Mobile-Responsive Layout Optimization',
        description: 'Responsive styling tested across mobile phones, tablets, and desktop screens.',
        sourceQuote: 'Three sections, mobile friendly',
        confidence: 'EXPLICIT'
      },
      {
        id: 'DEL-3',
        title: 'Up to 2 Rounds of Revisions',
        description: 'Two consolidated feedback rounds on design and layout before final handoff.',
        sourceQuote: 'Suggested protection (client did not specify a revision limit)',
        confidence: 'INFERRED'
      }
    );

    lineItems.push({
      id: 'ITEM-1',
      name: 'Startup Landing Page (3 Sections, Mobile-Friendly)',
      description: 'Design and responsive build of 3 landing page sections. Excludes copywriting unless added.',
      quantity: '1',
      unitPrice: primaryPrice,
      subtotal: primaryPrice,
      confidence: hasQuotedPrice ? 'EXPLICIT' : 'INFERRED',
      optional: false
    });
  } else {
    const sentences = text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 4 && !/\b(may want|might want|maybe|possibly|not sure)\b/i.test(s));

    if (sentences.length > 0) {
      sentences.slice(0, 3).forEach((s, idx) => {
        deliverables.push({
          id: `DEL-${idx + 1}`,
          title: s.length > 72 ? `${s.slice(0, 69)}...` : s.replace(/[.!?]+$/, ''),
          description: s,
          sourceQuote: s,
          confidence: 'EXPLICIT'
        });
      });
    } else {
      deliverables.push({
        id: 'DEL-1',
        title: projectTitle || 'Core Freelance Project Deliverable',
        description: text,
        sourceQuote: text.slice(0, 100),
        confidence: 'EXPLICIT'
      });
    }

    deliverables.push({
      id: `DEL-${deliverables.length + 1}`,
      title: 'Up to 2 Rounds of Revisions',
      description: 'Two consolidated revision rounds included in the base project fee.',
      sourceQuote: 'Suggested protection (revision cap omitted by client)',
      confidence: 'INFERRED'
    });

    lineItems.push({
      id: 'ITEM-1',
      name: projectTitle || deliverables[0].title,
      description: `Core project scope (${deliverables.length} deliverables) as outlined in Scope of Work.`,
      quantity: '1',
      unitPrice: primaryPrice,
      subtotal: primaryPrice,
      confidence: hasQuotedPrice ? 'EXPLICIT' : 'INFERRED',
      optional: false
    });
  }

  if (/\bcopywriting\b/i.test(text)) {
    const quoteMatch = text.match(/[^.?!]*\bcopywriting\b[^.?!]*/i);
    const quote = quoteMatch ? quoteMatch[0].trim() : 'I may want copywriting too.';
    exclusions.push('Custom website copywriting and brand messaging (unless added as a +$150 line item)');
    scopeCreepWarnings.push(
      'Client mentioned "I may want copywriting too" without increasing the $450 budget. Writing copy for 3 sections typically takes 3–4 extra hours.'
    );
    additionalCharges.push({
      id: 'ADDON-COPY',
      title: 'Conversion Copywriting for 3 Landing Page Sections',
      suggestedPrice: 150,
      reason: 'Client said "I may want copywriting too" — should be billed separately or explicitly excluded.'
    });
    riskFlags.push({
      id: 'RISK-1',
      field: 'Copywriting Scope',
      severity: 'HIGH',
      issue: 'Unpriced Copywriting Request ("I may want copywriting too")',
      sourceQuote: quote,
      recommendation:
        'Either keep copywriting in Exclusions (client supplies final text) or add the suggested +$150 Copywriting charge before locking the scope.',
      resolved: false,
      resolutionNote: '',
      suggestedAddonTitle: 'Conversion Copywriting (3 Sections)',
      suggestedAddonPrice: 150
    });
  }

  if (!/\bcopywriting\b/i.test(text) && /\b(might|maybe|if possible|potentially)\b/i.test(text)) {
    const hedgedMatch = text.match(/[^.?!]*\b(might|maybe|if possible|potentially)\b[^.?!]*/i);
    const hedgedQuote = hedgedMatch ? hedgedMatch[0].trim() : 'Optional additional scope mentioned';
    exclusions.push(`Optional items mentioned tentatively ("${hedgedQuote}") unless added as a separate line item`);
    scopeCreepWarnings.push(
      `Tentative request detected ("${hedgedQuote}"). Lock this out of the base price or quote an additional fee.`
    );
    additionalCharges.push({
      id: 'ADDON-EXTRA',
      title: 'Additional Optional Feature / Module',
      suggestedPrice: 200,
      reason: `Tentatively requested in brief: "${hedgedQuote}"`
    });
    riskFlags.push({
      id: `RISK-${riskFlags.length + 1}`,
      field: 'Additional Scope',
      severity: 'HIGH',
      issue: `Unclear Optional Requirement ("${hedgedQuote}")`,
      sourceQuote: hedgedQuote,
      recommendation: 'Exclude from base scope or add +$200 to the project total.',
      resolved: false,
      resolutionNote: '',
      suggestedAddonTitle: 'Additional Optional Scope Module',
      suggestedAddonPrice: 200
    });
  }

  if (!/\brevision|\bround|\biteration/i.test(text)) {
    missingInformation.push('Number of included revision rounds was not mentioned by the client.');
    scopeCreepWarnings.push(
      'No revision limit stated — without a cap, clients often request 5+ rounds of changes at no extra pay.'
    );
    riskFlags.push({
      id: `RISK-${riskFlags.length + 1}`,
      field: 'Revision Limit',
      severity: 'HIGH',
      issue: 'Missing Revision Limit in Client Brief',
      sourceQuote: 'Not mentioned in client message',
      recommendation: 'Include a clear cap of 2 revision rounds in the Scope of Work ($75/hr for extra rounds).',
      resolved: false,
      resolutionNote: ''
    });
  }

  if (!/\b(logo|brand|figma|hosting|domain|assets)\b/i.test(text)) {
    missingInformation.push('Brand assets (logo, fonts, images) and final hosting/deployment handoff details are missing.');
    exclusions.push('Paid stock photos, premium font licenses, and ongoing web hosting/domain fees');
  }

  if (deadlineInfo.confidence === 'INFERRED') {
    missingInformation.push(`Exact calendar deadline date was phrased relatively ("${deadlineInfo.quote}").`);
    riskFlags.push({
      id: `RISK-${riskFlags.length + 1}`,
      field: 'Timeline',
      severity: 'MEDIUM',
      issue: `Relative Deadline ("${deadlineInfo.quote}")`,
      sourceQuote: deadlineInfo.quote,
      recommendation: `Confirm calendar delivery date of ${deadlineInfo.date} with the client.`,
      resolved: false,
      resolutionNote: ''
    });
  }

  if (!hasQuotedPrice) {
    missingInformation.push('Client did not state a budget in the message (using your proposed budget).');
  }

  if (exclusions.length === 0) {
    exclusions.push(
      'Any additional pages, features, or integrations not listed under Deliverables',
      'Revisions beyond the 2 included rounds (billed at $75/hr)'
    );
  }

  const resolvedTitle =
    projectTitle ||
    (isLandingPageBrief ? 'Startup Landing Page (3 Sections)' : 'Freelance Client Project');

  const { scope, analysisDetails } = validateFullAiExtractionResponse(
    {
      clientName: resolvedName,
      clientEmail: resolvedEmail,
      projectTitle: resolvedTitle,
      projectSummary: isLandingPageBrief
        ? `Design and build a mobile-friendly 3-section startup landing page by ${deadlineInfo.date} for ${currency} $${primaryPrice.toFixed(
            2
          )}. Includes up to 2 revision rounds; copywriting is excluded unless added.`
        : `Scope of Work for ${resolvedName}: ${deliverables.length} deliverables scheduled for ${deadlineInfo.date} at ${currency} $${primaryPrice.toFixed(2)}.`,
      deadline: deadlineInfo.date,
      deadlineLabel: deadlineInfo.label,
      currency,
      quotedPriceLabel: priceSourceLabel,
      paymentTerms: 'DUE_ON_RECEIPT',
      revisionLimit: 2,
      suggestedRevisionLimit: '2 consolidated rounds of revisions (additional changes billed at $75/hr)',
      deliverables,
      lineItems,
      exclusions,
      acceptanceCriteria: [
        'All listed deliverables completed and responsive across mobile and desktop screens',
        'Includes up to 2 consolidated rounds of revisions',
        'Out-of-scope requests or extra revision rounds require a separate written estimate'
      ],
      ambiguousStatements: riskFlags
        .filter((r) => r.sourceQuote && !r.sourceQuote.startsWith('Not '))
        .map((r) => ({
          quote: r.sourceQuote,
          issue: r.issue,
          recommendation: r.recommendation
        })),
      missingInformation,
      scopeCreepWarnings,
      additionalCharges,
      riskFlags
    },
    { clientName: resolvedName, clientEmail: resolvedEmail }
  );

  return {
    scope,
    analysisDetails,
    extractionMeta: {
      provider: 'deterministic-fallback',
      model: 'deterministic-clause-analyzer-v3.1',
      liveAiUsed: false,
      fallbackUsed: true,
      fallbackReason,
      extractedAt: new Date().toISOString()
    }
  };
}

/**
 * Performs structured AI extraction using Google Gemini (`GEMINI_API_KEY`) or OpenAI (`OPENAI_API_KEY`),
 * validating the complete response against `validateFullAiExtractionResponse`.
 * Never claims `liveAiUsed: true` unless the full LLM response succeeded and passed validation.
 */
export async function extractStructuredScope(input, env = process.env, customFetch = fetch) {
  const geminiKey = env.GEMINI_API_KEY && !env.GEMINI_API_KEY.includes('your_') ? env.GEMINI_API_KEY : '';
  const openaiKey = env.OPENAI_API_KEY && !env.OPENAI_API_KEY.includes('your_') ? env.OPENAI_API_KEY : '';

  const userContextPrompt = [
    `Client Brief:\n"""\n${input.rawBrief}\n"""`,
    `Client Name: ${input.clientName || 'Client Stakeholder'}`,
    `Client Email: ${input.clientEmail || 'client@sandbox.paypal.com'}`,
    `Freelancer Proposed Budget: ${input.proposedBudget || 'Not specified'}`,
    `Reference Date: 2026-10-31`
  ].join('\n');

  let fallbackReason = 'No GEMINI_API_KEY or OPENAI_API_KEY configured in server environment.';

  if (geminiKey) {
    const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
      const res = await customFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${STRUCTURED_EXTRACTION_PROMPT}\n\n${userContextPrompt}` }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
        })
      });

      if (!res.ok) {
        throw new Error(`Gemini API HTTP ${res.status}`);
      }
      const data = await res.json();
      const textOut = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!textOut) {
        throw new Error('Gemini response did not contain JSON text.');
      }

      const parsed = JSON.parse(textOut);
      const validated = validateFullAiExtractionResponse(parsed, input);
      return {
        scope: validated.scope,
        analysisDetails: validated.analysisDetails,
        extractionMeta: {
          provider: 'google-gemini',
          model,
          liveAiUsed: true,
          fallbackUsed: false,
          fallbackReason: null,
          extractedAt: new Date().toISOString()
        }
      };
    } catch (err) {
      fallbackReason = `Gemini extraction failed validation or network call: ${err.message}`;
    }
  }

  if (openaiKey) {
    const model = env.OPENAI_MODEL || 'gpt-4o-mini';
    try {
      const res = await customFetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: STRUCTURED_EXTRACTION_PROMPT },
            { role: 'user', content: userContextPrompt }
          ]
        })
      });

      if (!res.ok) {
        throw new Error(`OpenAI API HTTP ${res.status}`);
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('OpenAI response did not contain JSON content.');
      }

      const parsed = JSON.parse(content);
      const validated = validateFullAiExtractionResponse(parsed, input);
      return {
        scope: validated.scope,
        analysisDetails: validated.analysisDetails,
        extractionMeta: {
          provider: 'openai',
          model,
          liveAiUsed: true,
          fallbackUsed: false,
          fallbackReason: null,
          extractedAt: new Date().toISOString()
        }
      };
    } catch (err) {
      fallbackReason = `OpenAI extraction failed validation or network call: ${err.message}`;
    }
  }

  return extractScopeDeterministic({
    ...input,
    fallbackReason
  });
}
