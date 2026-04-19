// src/security/scanners/ssl-check.ts
import * as tls from 'node:tls';
import type {
  SecurityScanner,
  ScanContext,
  ScanResult,
  Finding,
  Severity,
} from '../types.js';
import { createFinding } from '../types.js';

const SCANNER_ID = 'ssl-check';
const CONNECT_TIMEOUT = 10_000;
const DAYS_CRITICAL = 0; // expired
const DAYS_HIGH = 14;
const DAYS_MEDIUM = 30;

interface CertCheckResult {
  domain: string;
  valid: boolean;
  daysUntilExpiry: number;
  validFrom: string;
  validTo: string;
  issuer: string;
  subject: string;
  error?: string;
}

/** Connect to a domain on port 443 and read certificate info. */
function checkCert(domain: string): Promise<CertCheckResult> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      443,
      domain,
      { servername: domain, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();

        if (!cert || !cert.valid_to) {
          socket.destroy();
          resolve({
            domain,
            valid: false,
            daysUntilExpiry: -1,
            validFrom: '',
            validTo: '',
            issuer: '',
            subject: '',
            error: 'No certificate returned',
          });
          return;
        }

        const now = Date.now();
        const expiryDate = new Date(cert.valid_to).getTime();
        const daysUntilExpiry = Math.floor(
          (expiryDate - now) / (1000 * 60 * 60 * 24),
        );

        const issuerStr =
          typeof cert.issuer === 'object' && cert.issuer !== null
            ? (cert.issuer as Record<string, string>).O ??
              (cert.issuer as Record<string, string>).CN ??
              JSON.stringify(cert.issuer)
            : String(cert.issuer ?? '');

        const subjectStr =
          typeof cert.subject === 'object' && cert.subject !== null
            ? (cert.subject as Record<string, string>).CN ??
              JSON.stringify(cert.subject)
            : String(cert.subject ?? '');

        socket.destroy();
        resolve({
          domain,
          valid: daysUntilExpiry > 0,
          daysUntilExpiry,
          validFrom: cert.valid_from,
          validTo: cert.valid_to,
          issuer: issuerStr,
          subject: subjectStr,
        });
      },
    );

    socket.setTimeout(CONNECT_TIMEOUT, () => {
      socket.destroy();
      resolve({
        domain,
        valid: false,
        daysUntilExpiry: -1,
        validFrom: '',
        validTo: '',
        issuer: '',
        subject: '',
        error: 'Connection timed out',
      });
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve({
        domain,
        valid: false,
        daysUntilExpiry: -1,
        validFrom: '',
        validTo: '',
        issuer: '',
        subject: '',
        error: err.message,
      });
    });
  });
}

/** Determine severity based on days until expiry. */
function expiryToSeverity(days: number): Severity | null {
  if (days <= DAYS_CRITICAL) return 'critical';
  if (days <= DAYS_HIGH) return 'high';
  if (days <= DAYS_MEDIUM) return 'medium';
  return null; // No issue
}

const sslCheckScanner: SecurityScanner = {
  id: SCANNER_ID,
  name: 'SSL Certificate Check',
  description:
    'Checks SSL/TLS certificates for expiry on configured domains.',
  scope: 'daily',

  async run(context: ScanContext): Promise<ScanResult> {
    const start = Date.now();
    const domains = context.domains;

    if (domains.length === 0) {
      return {
        findings: [],
        summary: 'No domains configured for SSL checking.',
        durationMs: Date.now() - start,
      };
    }

    const findings: Finding[] = [];
    const results = await Promise.allSettled(domains.map((d) => checkCert(d)));

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const domain = domains[i];

      if (result.status === 'rejected') {
        findings.push(
          createFinding({
            scannerId: SCANNER_ID,
            severity: 'high',
            title: `SSL check failed: ${domain}`,
            description: `Could not check certificate for ${domain}: ${result.reason}`,
            target: domain,
            autoFixable: false,
            metadata: { domain, error: String(result.reason) },
          }),
        );
        continue;
      }

      const certResult = result.value;

      if (certResult.error) {
        findings.push(
          createFinding({
            scannerId: SCANNER_ID,
            severity: 'high',
            title: `SSL connection error: ${domain}`,
            description: `Error connecting to ${domain}:443 -- ${certResult.error}`,
            target: domain,
            autoFixable: false,
            metadata: { domain, error: certResult.error },
          }),
        );
        continue;
      }

      const severity = expiryToSeverity(certResult.daysUntilExpiry);

      if (severity) {
        const title =
          certResult.daysUntilExpiry <= 0
            ? `SSL certificate EXPIRED: ${domain}`
            : `SSL certificate expiring soon: ${domain} (${certResult.daysUntilExpiry} days)`;

        const description =
          certResult.daysUntilExpiry <= 0
            ? `Certificate for ${domain} expired on ${certResult.validTo}. Issuer: ${certResult.issuer}.`
            : `Certificate for ${domain} expires on ${certResult.validTo} (${certResult.daysUntilExpiry} days remaining). Issuer: ${certResult.issuer}.`;

        findings.push(
          createFinding({
            scannerId: SCANNER_ID,
            severity,
            title,
            description,
            target: domain,
            autoFixable: false,
            metadata: {
              domain,
              daysUntilExpiry: certResult.daysUntilExpiry,
              validFrom: certResult.validFrom,
              validTo: certResult.validTo,
              issuer: certResult.issuer,
              subject: certResult.subject,
            },
          }),
        );
      }
    }

    const durationMs = Date.now() - start;
    const summary =
      `Checked ${domains.length} domain(s). ` +
      `${findings.length} certificate issue(s) found.`;

    return { findings, summary, durationMs };
  },

  // No autoFix for SSL -- certificate renewal must be done externally
};

export default sslCheckScanner;
