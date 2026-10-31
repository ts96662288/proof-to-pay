#!/usr/bin/env node
/**
 * Proof-to-Pay v3.1 — PayPal Sandbox Verification Script (`scripts/verify-live-paypal-sandbox.mjs`)
 *
 * Implements Part 1 Section 3 & Part 3 Section 12:
 * - Reads PayPal credentials from environment variables (`.env` or process environment).
 * - Validates required variables (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_API_BASE_URL`).
 * - Requests an OAuth 2.0 access token from `POST /v1/oauth2/token` (`grant_type=client_credentials`).
 * - Performs a safe, non-financial verification request (`POST /v2/invoicing/generate-next-invoice-number`).
 * - Does NOT send invoices or perform financial operations just to test connectivity.
 * - Prints clear diagnostic output without ever exposing secrets or OAuth access tokens.
 * - Exits cleanly with appropriate status codes (0 when verified or cleanly skipped with `--if-configured`).
 */

import { loadEnvFile } from '../src/server.mjs';
import { PayPalSandboxClient } from '../src/paypal-client.mjs';

loadEnvFile();

async function runVerification() {
  const client = new PayPalSandboxClient();
  const status = client.getCredentialStatus();

  console.log('======================================================================');
  console.log('  Proof-to-Pay v3.1 — PayPal Sandbox Connectivity Verification');
  console.log(`  Environment:     ${status.environment}`);
  console.log(`  API Base URL:    ${status.apiBaseUrl}`);
  console.log(`  Connection Mode: ${status.connectionLabel}`);
  console.log('======================================================================');

  if (!client.hasRealCredentials()) {
    console.log(
      '[SKIPPED] PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set in the environment.\n' +
        '          Proof-to-Pay will run in Local Demo / Fixture Mode (Simulated) until credentials are provided in .env.'
    );
    process.exit(process.argv.includes('--require-live') ? 1 : 0);
  }

  // Diagnostic warning if Client ID and Secret are identical (common copy-paste mistake in Developer Dashboard)
  if (
    process.env.PAYPAL_CLIENT_ID &&
    process.env.PAYPAL_CLIENT_SECRET &&
    process.env.PAYPAL_CLIENT_ID.trim() === process.env.PAYPAL_CLIENT_SECRET.trim()
  ) {
    console.warn(
      '[DIAGNOSTIC NOTICE] PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env appear to be identical strings.\n' +
        '                    In PayPal Developer Dashboard (Apps & Credentials -> Sandbox), verify that PAYPAL_CLIENT_SECRET\n' +
        '                    is set to the App Secret rather than a duplicate of the Client ID.'
    );
  }

  console.log('1. Requesting OAuth 2.0 access token (POST /v1/oauth2/token)...');
  console.log('2. Running safe, non-financial verification request (POST /v2/invoicing/generate-next-invoice-number)...');

  const result = await client.testConnection();

  if (result.ok) {
    console.log(`   [OK] OAuth 2.0 Token Handshake succeeded (cached=${result.tokenCached}, expiresIn=${result.tokenExpiresInSeconds}s)`);
    console.log(`   [OK] Safe Invoicing v2 Verification (${result.verificationEndpoint}) -> Next Invoice #: ${result.nextInvoiceNumber}`);
    console.log('\n[SUCCESS] Connected PayPal Sandbox Mode is verified and ready.');
    process.exit(0);
  } else {
    console.error(`\n[VERIFICATION FAILED] ${result.message}`);
    if (result.statusCode) {
      console.error(`   HTTP Status: ${result.statusCode}`);
    }
    if (result.paypalDebugId) {
      console.error(`   PayPal Debug ID: ${result.paypalDebugId}`);
    }
    process.exit(1);
  }
}

runVerification();
