/**
 * Proof-to-Pay — Official PayPal Invoicing REST API Client (`src/paypal-client.mjs`)
 *
 * Implements:
 * 1. Genuine OAuth 2.0 authentication (`POST /v1/oauth2/token`) with token caching & automatic expiry refresh.
 *    Never logs or exposes Client Secret or access tokens.
 * 2. Complete PayPal Invoicing v2 API operations:
 *    - `generateNextInvoiceNumber` (`POST /v2/invoicing/generate-next-invoice-number`)
 *    - `createDraftInvoice` (`POST /v2/invoicing/invoices`)
 *    - `getInvoice` (`GET /v2/invoicing/invoices/{id}`)
 *    - `sendInvoice` (`POST /v2/invoicing/invoices/{id}/send`)
 *    - `sendInvoiceReminder` (`POST /v2/invoicing/invoices/{id}/remind`)
 *    - `cancelSentInvoice` (`POST /v2/invoicing/invoices/{id}/cancel`)
 *    - `testConnection` (Authenticates + performs safe non-financial API check)
 *    - `verifyWebhookSignature` (`POST /v1/notifications/verify-webhook-signature`)
 * 3. Distinct Operating Modes:
 *    - `LOCAL_DEMO_FIXTURE_MODE` (Simulated local development only; never treated as genuine payment)
 *    - `CONNECTED_PAYPAL_SANDBOX_MODE` (Uses real PayPal Sandbox API calls at `https://api-m.sandbox.paypal.com`)
 *    - `LIVE_PAYPAL_MODE` (Requires explicit production configuration `PAYPAL_ENV=live`; never activates automatically)
 */

import crypto from 'node:crypto';

export const PAYPAL_CONNECTION_MODES = Object.freeze({
  LOCAL_DEMO_FIXTURE: 'LOCAL_DEMO_FIXTURE_MODE',
  LOCAL_FIXTURE: 'LOCAL_DEMO_FIXTURE_MODE',
  CONNECTED_SANDBOX: 'CONNECTED_PAYPAL_SANDBOX_MODE',
  LIVE_PRODUCTION: 'LIVE_PAYPAL_MODE'
});

export class MissingPayPalCredentialsError extends Error {
  constructor(
    message = 'PayPal Sandbox credentials (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET) are not configured in server .env.'
  ) {
    super(message);
    this.name = 'MissingPayPalCredentialsError';
    this.code = 'MISSING_PAYPAL_CREDENTIALS';
    this.statusCode = 428;
  }
}

export class PayPalApiError extends Error {
  constructor(message, statusCode = 502, details = null, paypalDebugId = null) {
    super(message);
    this.name = 'PayPalApiError';
    this.statusCode = statusCode;
    this.details = details;
    this.paypalDebugId = paypalDebugId;
  }
}

export class PayPalSandboxClient {
  constructor(config = {}) {
    this.envMode = String(config.env ?? process.env.PAYPAL_ENV ?? 'sandbox').toLowerCase().trim();
    const defaultBaseUrl =
      this.envMode === 'live' || this.envMode === 'production'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';

    this.baseUrl = (config.baseUrl || process.env.PAYPAL_API_BASE_URL || defaultBaseUrl).replace(/\/+$/, '');
    this.clientId = String(config.clientId ?? process.env.PAYPAL_CLIENT_ID ?? '').trim();
    this.clientSecret = String(config.clientSecret ?? process.env.PAYPAL_CLIENT_SECRET ?? '').trim();
    this.webhookId = String(config.webhookId ?? process.env.PAYPAL_WEBHOOK_ID ?? '').trim();
    this.customFetch = config.fetch || fetch;

    this.invoicerConfig = {
      email: config.invoicerEmail || process.env.PAYPAL_INVOICER_EMAIL || '',
      givenName: config.invoicerGivenName || process.env.PAYPAL_INVOICER_GIVEN_NAME || 'Alex',
      surname: config.invoicerSurname || process.env.PAYPAL_INVOICER_SURNAME || 'Rivera',
      businessName:
        config.invoicerBusinessName || process.env.PAYPAL_INVOICER_BUSINESS_NAME || 'Rivera Freelance Studio'
    };

    /** @type {{ token: string, expiresAt: number, expiresAtMs: number, expiresInSeconds: number, appId: string|null, debugId: string|null } | null} */
    this._tokenCache = null;

    /**
     * Strictly isolated store for `LOCAL_DEMO_FIXTURE_MODE` only.
     * Never mixed with genuine Sandbox invoices.
     * @type {Map<string, any>}
     */
    this._fixtureInvoices = new Map();
    this._fixtureInvoiceSeq = 1042;
  }
  updateInvoicerConfig({ businessName, freelancerName, email } = {}) {
    if (businessName && String(businessName).trim()) {
      this.invoicerConfig.businessName = String(businessName).trim();
    }

    if (freelancerName && String(freelancerName).trim()) {
      const nameParts = String(freelancerName).trim().split(/\s+/);

      this.invoicerConfig.givenName = nameParts[0];
      this.invoicerConfig.surname =
        nameParts.slice(1).join(' ') || this.invoicerConfig.surname;
    }

    if (email && String(email).trim()) {
      this.invoicerConfig.email = String(email).trim();
    }

    return { ...this.invoicerConfig };
  }
  hasRealCredentials() {
    return Boolean(
      this.clientId &&
        this.clientSecret &&
        !this.clientId.includes('your_paypal_sandbox') &&
        !this.clientSecret.includes('your_paypal_sandbox')
    );
  }

  getConnectionMode() {
    if (!this.hasRealCredentials()) {
      return {
        mode: PAYPAL_CONNECTION_MODES.LOCAL_DEMO_FIXTURE,
        label: 'Local Demo / Fixture Mode (Simulated)',
        isRealPayPal: false,
        isSandbox: false,
        isLive: false,
        description:
          'Server .env does not have PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET configured. Invoices and payment links in this mode are local simulations for development only.'
      };
    }

    const isLiveUrl = this.baseUrl.includes('api-m.paypal.com') && !this.baseUrl.includes('sandbox');
    if (isLiveUrl && (this.envMode === 'live' || this.envMode === 'production')) {
      return {
        mode: PAYPAL_CONNECTION_MODES.LIVE_PRODUCTION,
        label: 'Live PayPal Mode',
        isRealPayPal: true,
        isSandbox: false,
        isLive: true,
        description: 'Connected to live PayPal production API (api-m.paypal.com) using server-side credentials.'
      };
    }

    return {
      mode: PAYPAL_CONNECTION_MODES.CONNECTED_SANDBOX,
      label: 'Connected PayPal Sandbox Mode',
      isRealPayPal: true,
      isSandbox: true,
      isLive: false,
      description: 'Connected to official PayPal Sandbox API (api-m.sandbox.paypal.com) using server-side OAuth 2.0.'
    };
  }

  /**
   * Returns safe credential & mode metadata. Never exposes clientSecret or accessToken.
   */
  getCredentialStatus() {
    const conn = this.getConnectionMode();
    return {
      configured: this.hasRealCredentials(),
      mode: conn.mode,
      connectionMode: conn.mode,
      connectionLabel: conn.label,
      connectionDescription: conn.description,
      isRealPayPal: conn.isRealPayPal,
      environment: conn.isLive ? 'LIVE' : conn.isSandbox ? 'SANDBOX' : 'LOCAL_SIMULATION',
      baseUrl: this.baseUrl,
      apiBaseUrl: this.baseUrl,
      webhookConfigured: Boolean(this.webhookId && !this.webhookId.includes('your_paypal_sandbox')),
      clientIdPreview: this.hasRealCredentials() ? `${this.clientId.slice(0, 4)}...${this.clientId.slice(-4)}` : null,
      identicalIdAndSecretWarning:
        this.hasRealCredentials() && this.clientId === this.clientSecret
          ? 'Warning: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env are identical strings. PayPal Sandbox requires the distinct Secret value associated with the Client ID.'
          : null,
      invoicerBusinessName: this.invoicerConfig.businessName,
      invoicerEmail: this.invoicerConfig.email || 'Not configured in .env'
    };
  }

  /**
   * Authenticates with PayPal OAuth 2.0 (`POST /v1/oauth2/token`).
   * Caches the token until 30 seconds before expiry and refreshes automatically when expired.
   * Never logs or exposes credentials or the raw token in error messages.
   */
  async getAccessTokenWithMeta(forceRefresh = false) {
    if (!this.hasRealCredentials()) {
      throw new MissingPayPalCredentialsError();
    }

    const now = Date.now();
    if (this._tokenCache) {
      const effectiveExpiry = Math.min(
        this._tokenCache.expiresAtMs ?? Infinity,
        this._tokenCache.expiresAt ?? Infinity
      );
      if (!forceRefresh && effectiveExpiry > now + 30_000) {
        return {
          token: this._tokenCache.token,
          cached: true,
          appId: this._tokenCache.appId,
          debugId: this._tokenCache.debugId,
          expiresInSeconds: Math.max(0, Math.round((effectiveExpiry - now) / 1000))
        };
      }
    }

    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    let response;
    try {
      response = await this.customFetch(`${this.baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          Accept: 'application/json',
          'Accept-Language': 'en_US',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
      });
    } catch (netErr) {
      throw new PayPalApiError(
        `Unable to reach PayPal API server (${this.baseUrl}): ${netErr.message}`,
        503,
        { networkError: netErr.code || netErr.message },
        null
      );
    }

    const debugId = response.headers?.get?.('paypal-debug-id') || null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      this._tokenCache = null;
      throw new PayPalApiError(
        `PayPal OAuth2 authentication failed (${response.status}): ${
          data.error_description || data.error || data.message || 'Invalid client credentials'
        }`,
        response.status || 401,
        {
          error: data.error || 'OAUTH_ERROR',
          error_description: data.error_description || data.message || null,
          paypalDebugId: debugId
        },
        debugId
      );
    }

    const expiresInSec = Math.max(60, Number(data.expires_in) || 32400);
    const expiresAtMs = now + expiresInSec * 1000;
    this._tokenCache = {
      token: data.access_token,
      appId: data.app_id || null,
      debugId,
      expiresInSeconds: expiresInSec,
      expiresAt: expiresAtMs,
      expiresAtMs
    };
    return {
      token: this._tokenCache.token,
      cached: false,
      appId: this._tokenCache.appId,
      debugId: this._tokenCache.debugId,
      expiresInSeconds: expiresInSec
    };
  }

  async getAccessToken(forceRefresh = false) {
    const meta = await this.getAccessTokenWithMeta(forceRefresh);
    return meta.token;
  }

  /**
   * Performs a safe, non-financial connectivity check against PayPal Sandbox:
   * 1. Authenticates via OAuth 2.0 (`POST /v1/oauth2/token`)
   * 2. Performs a safe verification request (`POST /v2/invoicing/generate-next-invoice-number`)
   * Returns connection status and environment without exposing secrets or tokens.
   */
  async testConnection() {
    const status = this.getCredentialStatus();
    if (!this.hasRealCredentials()) {
      const msg = 'PayPal Sandbox credentials (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET) are not configured in .env.';
      return {
        ok: false,
        connected: false,
        connectionMode: status.connectionMode,
        environment: status.environment,
        baseUrl: this.baseUrl,
        apiBaseUrl: this.baseUrl,
        verifiedAt: new Date().toISOString(),
        message: msg,
        error: msg
      };
    }

    try {
      const tokenMeta = await this.getAccessTokenWithMeta(false);
      const nextNum = await this.generateNextInvoiceNumber({ allowDevFixture: false });
      return {
        ok: true,
        connected: true,
        connectionMode: status.connectionMode,
        environment: status.environment,
        baseUrl: this.baseUrl,
        apiBaseUrl: this.baseUrl,
        appId: tokenMeta.appId,
        tokenCached: tokenMeta.cached,
        tokenExpiresInSeconds: tokenMeta.expiresInSeconds,
        oauthDebugId: tokenMeta.debugId,
        verificationEndpoint: 'POST /v2/invoicing/generate-next-invoice-number',
        nextInvoiceNumber: nextNum.invoiceNumber,
        sampleNextInvoiceNumber: nextNum.invoiceNumber,
        verificationDebugId: nextNum.paypalDebugId,
        verifiedAt: new Date().toISOString(),
        message: `Connected to ${status.connectionLabel} (${this.baseUrl}). Verified OAuth 2.0 token and Invoicing v2 endpoint.`,
        error: null
      };
    } catch (err) {
      return {
        ok: false,
        connected: false,
        connectionMode: status.connectionMode,
        environment: status.environment,
        baseUrl: this.baseUrl,
        apiBaseUrl: this.baseUrl,
        statusCode: err.statusCode || 502,
        paypalDebugId: err.paypalDebugId || null,
        identicalIdAndSecretWarning: status.identicalIdAndSecretWarning,
        verifiedAt: new Date().toISOString(),
        message: err.message,
        error: err.message,
        errorDetails: err.details || null
      };
    }
  }

  async generateNextInvoiceNumber(options = {}) {
    if (!this.hasRealCredentials()) {
      if (options.allowDevFixture) {
        this._fixtureInvoiceSeq += 1;
        return {
          invoiceNumber: `INV-SIM-${this._fixtureInvoiceSeq}`,
          connectionMode: PAYPAL_CONNECTION_MODES.LOCAL_DEMO_FIXTURE,
          environment: 'LOCAL_DEMO_FIXTURE_MODE',
          isFixture: true,
          paypalDebugId: null
        };
      }
      throw new MissingPayPalCredentialsError();
    }

    const token = await this.getAccessToken();
    const response = await this.customFetch(`${this.baseUrl}/v2/invoicing/generate-next-invoice-number`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    const debugId = response.headers?.get?.('paypal-debug-id') || null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new PayPalApiError(
        `PayPal Generate Next Invoice Number failed (${response.status}): ${data.message || JSON.stringify(data)}`,
        response.status,
        data,
        debugId
      );
    }

    const conn = this.getConnectionMode();
    return {
      invoiceNumber: data.invoice_number || `INV-${Date.now().toString().slice(-6)}`,
      connectionMode: conn.mode,
      environment: conn.mode,
      isFixture: false,
      paypalDebugId: debugId
    };
  }

  extractInvoiceLinks(links = []) {
    const payerView = links.find((l) => l.rel === 'payer-view')?.href || null;
    const selfLink = links.find((l) => l.rel === 'self')?.href || null;
    const sendLink = links.find((l) => l.rel === 'send')?.href || null;
    return {
      payerViewUrl: payerView,
      selfUrl: selfLink,
      sendUrl: sendLink
    };
  }

  async createDraftInvoice(invoicePayload, options = {}) {
  console.log("PAYPAL INVOICE DEBUG:", JSON.stringify({
  currency: invoicePayload.detail?.currency_code,
  paymentTerm: invoicePayload.detail?.payment_term,
  items: invoicePayload.items?.map(item => ({
    name: item.name,
    quantity: item.quantity,
    unit_amount: item.unit_amount
  })),
  amount: invoicePayload.amount
}, null, 2));

  if (!this.hasRealCredentials()) {
      if (options.allowDevFixture) {
        return this._createFixtureDraftInvoice(invoicePayload);
      }
      throw new MissingPayPalCredentialsError();
    }

    const token = await this.getAccessToken();
    const requestId = options.idempotencyKey || `p2p-draft-${crypto.randomUUID()}`;
    const { amount, ...paypalRequestPayload } = invoicePayload;
    const response = await this.customFetch(`${this.baseUrl}/v2/invoicing/invoices`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        'PayPal-Request-Id': requestId
      },
      body: JSON.stringify(paypalRequestPayload)
    });

    const debugId = response.headers?.get?.('paypal-debug-id') || null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new PayPalApiError(
        `PayPal Create Draft Invoice failed (${response.status}): ${data.message || JSON.stringify(data)}`,
        response.status,
        data,
        debugId
      );
    }

    let invoiceId = data.id;
    if (!invoiceId && data.href) {
      invoiceId = data.href.split('/').pop();
    }
    if (!invoiceId && Array.isArray(data.links)) {
      const selfHref = data.links.find((l) => l.rel === 'self')?.href;
      if (selfHref) invoiceId = selfHref.split('/').pop();
    }

    const canonical = invoiceId ? await this.getInvoice(invoiceId) : null;
    const invoiceResource = canonical?.raw || data;
    const links = this.extractInvoiceLinks(invoiceResource.links);
    const conn = this.getConnectionMode();

    return {
      invoiceId: invoiceId || invoiceResource.id,
      invoiceNumber: invoiceResource?.detail?.invoice_number || invoicePayload?.detail?.invoice_number,
      status: invoiceResource.status || 'DRAFT',
      connectionMode: conn.mode,
      environment: conn.mode,
      isFixture: false,
      paypalDebugId: debugId || canonical?.paypalDebugId || null,
      currency: invoiceResource?.amount?.currency_code || invoicePayload.detail.currency_code,
      totalAmount: invoiceResource?.amount?.value || invoicePayload.items?.[0]?.unit_amount?.value,
      dueAmount: invoiceResource?.due_amount?.value || invoiceResource?.amount?.value,
      payerViewUrl: invoiceResource?.detail?.metadata?.recipient_view_url || links.payerViewUrl,
      selfUrl: links.selfUrl,
      createdAt: invoiceResource?.detail?.metadata?.create_time || new Date().toISOString(),
      raw: invoiceResource
    };
  }

  async sendInvoice(invoiceId, options = {}) {
    if (!this.hasRealCredentials()) {
      if (options.allowDevFixture) {
        return this._sendFixtureInvoice(invoiceId);
      }
      throw new MissingPayPalCredentialsError();
    }

    if (String(invoiceId).startsWith('SIM-INV-')) {
      throw new PayPalApiError(
        'Cannot send a simulated fixture invoice through the live PayPal Sandbox API.',
        400
      );
    }

    const token = await this.getAccessToken();
    const requestId = options.idempotencyKey || `p2p-send-${crypto.randomUUID()}`;
    const sendBody = {
      send_to_recipient: true,
      send_to_invoicer: true
    };
    if (options.subject) sendBody.subject = options.subject;
    if (options.note) sendBody.note = options.note;

    const response = await this.customFetch(
      `${this.baseUrl}/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'PayPal-Request-Id': requestId
        },
        body: JSON.stringify(sendBody)
      }
    );

    const debugId = response.headers?.get?.('paypal-debug-id') || null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 202) {
      throw new PayPalApiError(
        `PayPal Send Invoice failed (${response.status}): ${data.message || JSON.stringify(data)}`,
        response.status,
        data,
        debugId
      );
    }

    const canonical = await this.getInvoice(invoiceId);
    const sendPayerLink = Array.isArray(data?.links)
      ? data.links.find((l) => l.rel === 'payer-view')?.href
      : null;

    return {
      ...canonical,
      paypalDebugId: debugId || canonical.paypalDebugId,
      payerViewUrl: sendPayerLink || canonical.payerViewUrl,
      sentAt: new Date().toISOString()
    };
  }

  async sendInvoiceReminder(invoiceId, options = {}) {
    if (!this.hasRealCredentials()) {
      if (options.allowDevFixture) {
        const existing = this._fixtureInvoices.get(invoiceId);
        if (!existing) {
          throw new PayPalApiError(`Simulated invoice ${invoiceId} does not exist.`, 404);
        }
        const now = new Date().toISOString();
        existing.lastReminderSentAt = now;
        existing.reminderCount = (existing.reminderCount || 0) + 1;
        this._fixtureInvoices.set(invoiceId, existing);
        return {
          invoiceId,
          remindedAt: now,
          reminderCount: existing.reminderCount,
          environment: PAYPAL_CONNECTION_MODES.LOCAL_DEMO_FIXTURE,
          isFixture: true,
          subject: options.subject || 'Polite Payment Reminder',
          note: options.note || ''
        };
      }
      throw new MissingPayPalCredentialsError();
    }

    const token = await this.getAccessToken();
    const remindBody = {
      send_to_recipient: true,
      send_to_invoicer: true,
      subject: options.subject || 'Polite reminder regarding your invoice',
      note:
        options.note ||
        'Hi! Just a polite reminder regarding our approved project scope and invoice. Please let me know if you have any questions.'
    };

    const response = await this.customFetch(
      `${this.baseUrl}/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/remind`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(remindBody)
      }
    );

    const debugId = response.headers?.get?.('paypal-debug-id') || null;
    if (!response.ok && response.status !== 204 && response.status !== 202) {
      const data = await response.json().catch(() => ({}));
      throw new PayPalApiError(
        `PayPal Send Invoice Reminder failed (${response.status}): ${data.message || JSON.stringify(data)}`,
        response.status,
        data,
        debugId
      );
    }

    const conn = this.getConnectionMode();
    return {
      invoiceId,
      remindedAt: new Date().toISOString(),
      environment: conn.mode,
      isFixture: false,
      paypalDebugId: debugId,
      subject: remindBody.subject,
      note: remindBody.note
    };
  }

  /**
   * Cancels a sent invoice (`POST /v2/invoicing/invoices/{id}/cancel`).
   */
  async cancelSentInvoice(invoiceId, options = {}) {
    if (!this.hasRealCredentials()) {
      if (options.allowDevFixture) {
        const existing = this._fixtureInvoices.get(invoiceId);
        if (!existing) {
          throw new PayPalApiError(`Simulated invoice ${invoiceId} does not exist.`, 404);
        }
        const now = new Date().toISOString();
        existing.status = 'CANCELLED';
        existing.lastUpdatedAt = now;
        existing.raw.status = 'CANCELLED';
        this._fixtureInvoices.set(invoiceId, existing);
        return existing;
      }
      throw new MissingPayPalCredentialsError();
    }

    const token = await this.getAccessToken();
    const cancelBody = {
      subject: options.subject || 'Invoice cancelled',
      note: options.note || 'This invoice was cancelled by the freelancer.',
      send_to_invoicer: true,
      send_to_recipient: true
    };

    const response = await this.customFetch(
      `${this.baseUrl}/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/cancel`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(cancelBody)
      }
    );

    const debugId = response.headers?.get?.('paypal-debug-id') || null;
    if (!response.ok && response.status !== 204 && response.status !== 202) {
      const data = await response.json().catch(() => ({}));
      throw new PayPalApiError(
        `PayPal Cancel Invoice failed (${response.status}): ${data.message || JSON.stringify(data)}`,
        response.status,
        data,
        debugId
      );
    }

    return this.getInvoice(invoiceId);
  }

  async getInvoice(invoiceId, options = {}) {
    // Do not mix fixture and genuine Sandbox data:
    if (String(invoiceId).startsWith('SIM-INV-')) {
      if (this._fixtureInvoices.has(invoiceId)) {
        return this._fixtureInvoices.get(invoiceId);
      }
      throw new PayPalApiError(`Simulated fixture invoice ${invoiceId} not found.`, 404);
    }

    if (!this.hasRealCredentials()) {
      if (options.allowDevFixture && this._fixtureInvoices.has(invoiceId)) {
        return this._fixtureInvoices.get(invoiceId);
      }
      throw new MissingPayPalCredentialsError();
    }

    const token = await this.getAccessToken();
    const response = await this.customFetch(
      `${this.baseUrl}/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const debugId = response.headers?.get?.('paypal-debug-id') || null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new PayPalApiError(
        `PayPal Get Invoice failed (${response.status}): ${data.message || JSON.stringify(data)}`,
        response.status,
        data,
        debugId
      );
    }

    const links = this.extractInvoiceLinks(data.links);
    const metadata = data?.detail?.metadata || {};
    const conn = this.getConnectionMode();

    return {
      invoiceId: data.id || invoiceId,
      invoiceNumber: data?.detail?.invoice_number || null,
      status: data.status || 'UNKNOWN',
      connectionMode: conn.mode,
      environment: conn.mode,
      isFixture: false,
      paypalDebugId: debugId,
      currency: data?.amount?.currency_code || data?.detail?.currency_code || 'USD',
      totalAmount: data?.amount?.value || '0.00',
      dueAmount: data?.due_amount?.value || '0.00',
      payerViewUrl: metadata.recipient_view_url || links.payerViewUrl,
      invoicerViewUrl: metadata.invoicer_view_url || null,
      selfUrl: links.selfUrl,
      createdAt: metadata.create_time || null,
      lastUpdatedAt: metadata.last_update_time || new Date().toISOString(),
      payments: data?.payments || null,
      refunds: data?.refunds || null,
      raw: data
    };
  }

  async verifyWebhookSignature(headers, webhookEventBody) {
    const getHeader = (name) => {
      const val = headers[name.toLowerCase()] || headers[name];
      return Array.isArray(val) ? val[0] : val || '';
    };

    const authAlgo = getHeader('paypal-auth-algo');
    const certUrl = getHeader('paypal-cert-url');
    const transmissionId = getHeader('paypal-transmission-id');
    const transmissionSig = getHeader('paypal-transmission-sig');
    const transmissionTime = getHeader('paypal-transmission-time');

    if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
      return {
        verified: false,
        verificationStatus: 'MISSING_SIGNATURE_HEADERS',
        reason:
          'Webhook request is missing required PayPal cryptographic headers (PAYPAL-TRANSMISSION-ID, PAYPAL-TRANSMISSION-SIG, PAYPAL-TRANSMISSION-TIME, PAYPAL-CERT-URL, PAYPAL-AUTH-ALGO).'
      };
    }

    if (!this.hasRealCredentials() || !this.webhookId) {
      return {
        verified: false,
        verificationStatus: 'MISSING_PAYPAL_WEBHOOK_CONFIG',
        reason:
          'Authentic PayPal webhook verification requires PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and PAYPAL_WEBHOOK_ID in server .env. Simulated webhooks are never treated as real payment confirmations.'
      };
    }

    const token = await this.getAccessToken();
    const verifyPayload = {
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: this.webhookId,
      webhook_event: webhookEventBody
    };

    const response = await this.customFetch(`${this.baseUrl}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(verifyPayload)
    });

    const data = await response.json().catch(() => ({}));
    const isSuccess = response.ok && data.verification_status === 'SUCCESS';

    return {
      verified: isSuccess,
      verificationStatus: data.verification_status || 'FAILURE',
      reason: isSuccess
        ? 'PayPal /v1/notifications/verify-webhook-signature returned SUCCESS.'
        : `PayPal signature verification returned ${data.verification_status || response.status}.`
    };
  }

  _createFixtureDraftInvoice(invoicePayload) {
    const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    const invoiceId = `SIM-INV-${suffix}`;
    const total = (invoicePayload.items || []).reduce(
      (sum, item) => sum + Number(item.quantity || 1) * Number(item.unit_amount?.value || 0),
      0
    );
    const currency = invoicePayload.detail?.currency_code || 'USD';
    const now = new Date().toISOString();

    const record = {
      invoiceId,
      invoiceNumber: invoicePayload.detail?.invoice_number || `INV-SIM-${++this._fixtureInvoiceSeq}`,
      status: 'DRAFT',
      connectionMode: PAYPAL_CONNECTION_MODES.LOCAL_DEMO_FIXTURE,
      environment: PAYPAL_CONNECTION_MODES.LOCAL_DEMO_FIXTURE,
      isFixture: true,
      paypalDebugId: null,
      currency,
      totalAmount: total.toFixed(2),
      dueAmount: total.toFixed(2),
      payerViewUrl: `#simulated-invoice-preview-${invoiceId}`,
      selfUrl: null,
      createdAt: now,
      lastUpdatedAt: now,
      reminderCount: 0,
      raw: {
        id: invoiceId,
        status: 'DRAFT',
        simulated: true,
        detail: invoicePayload.detail,
        invoicer: invoicePayload.invoicer,
        primary_recipients: invoicePayload.primary_recipients,
        items: invoicePayload.items,
        amount: { currency_code: currency, value: total.toFixed(2) },
        due_amount: { currency_code: currency, value: total.toFixed(2) }
      }
    };

    this._fixtureInvoices.set(invoiceId, record);
    return record;
  }

  _sendFixtureInvoice(invoiceId) {
    const existing = this._fixtureInvoices.get(invoiceId);
    if (!existing) {
      throw new PayPalApiError(`Simulated invoice ${invoiceId} does not exist.`, 404);
    }
    const now = new Date().toISOString();
    existing.status = 'SENT';
    existing.sentAt = now;
    existing.lastUpdatedAt = now;
    existing.raw.status = 'SENT';
    this._fixtureInvoices.set(invoiceId, existing);
    return existing;
  }
}
