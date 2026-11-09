// src/security/scanners/tailscale-health.ts
import { execFile } from 'node:child_process';
import type {
  SecurityScanner,
  ScanContext,
  ScanResult,
  Finding,
  Severity,
} from '../types.js';
import { createFinding } from '../types.js';

const SCANNER_ID = 'tailscale-health';
const COMMAND_TIMEOUT = 15_000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

interface TailscaleStatus {
  Self?: TailscaleNode;
  Peer?: Record<string, TailscaleNode>;
}

interface TailscaleNode {
  HostName: string;
  DNSName: string;
  TailscaleIPs?: string[];
  Online: boolean;
  LastSeen?: string;
  Active?: boolean;
  OS?: string;
}

/** Run tailscale status --json and parse the output. */
function getTailscaleStatus(): Promise<TailscaleStatus> {
  return new Promise((resolve, reject) => {
    execFile(
      'tailscale',
      ['status', '--json'],
      { timeout: COMMAND_TIMEOUT, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`tailscale status failed: ${error.message}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`Failed to parse tailscale status JSON: ${e}`));
        }
      },
    );
  });
}

/** Normalize hostname for comparison (lowercase, strip trailing dots/domains). */
function normalizeHostname(name: string): string {
  // DNSName is like "macbook-pro.tail12345.ts.net." -- extract first segment
  const firstSegment = name.split('.')[0];
  return (firstSegment ?? name).toLowerCase();
}

const tailscaleHealthScanner: SecurityScanner = {
  id: SCANNER_ID,
  name: 'Tailscale Health',
  description:
    'Checks Tailscale network status and verifies expected nodes are online.',
  scope: 'daily',

  async run(context: ScanContext): Promise<ScanResult> {
    const start = Date.now();
    const expectedNodes = context.tailscaleNodes.map((n) => n.toLowerCase());

    if (expectedNodes.length === 0) {
      return {
        findings: [],
        summary: 'No expected Tailscale nodes configured.',
        durationMs: Date.now() - start,
      };
    }

    let status: TailscaleStatus;
    try {
      status = await getTailscaleStatus();
    } catch (err) {
      const finding = createFinding({
        scannerId: SCANNER_ID,
        severity: 'critical',
        title: 'Tailscale status check failed',
        description: `Could not query tailscale status: ${err instanceof Error ? err.message : String(err)}`,
        target: 'tailscale',
        autoFixable: false,
        metadata: {},
      });
      return {
        findings: [finding],
        summary: 'Tailscale status check failed.',
        durationMs: Date.now() - start,
      };
    }

    // Build a map of hostname -> node info from Self + Peers
    const nodeMap = new Map<string, TailscaleNode>();

    if (status.Self) {
      const hostname = normalizeHostname(
        status.Self.HostName || status.Self.DNSName,
      );
      nodeMap.set(hostname, status.Self);
    }

    if (status.Peer) {
      for (const peer of Object.values(status.Peer)) {
        const hostname = normalizeHostname(peer.HostName || peer.DNSName);
        nodeMap.set(hostname, peer);
      }
    }

    const findings: Finding[] = [];
    const now = Date.now();

    for (const expected of expectedNodes) {
      const node = nodeMap.get(expected);

      if (!node) {
        // Node is completely missing from the network
        // Low because this is almost always a hostname config mismatch, not a real threat
        findings.push(
          createFinding({
            scannerId: SCANNER_ID,
            severity: 'low',
            title: `Missing Tailscale node: ${expected}`,
            description: `Expected node "${expected}" was not found in Tailscale network status. Check SECURITY_TAILSCALE_NODES config matches actual hostnames.`,
            target: expected,
            autoFixable: false,
            metadata: { expectedNode: expected, availableNodes: [...nodeMap.keys()] },
          }),
        );
        continue;
      }

      if (!node.Online) {
        // Node exists but is offline -- check how long
        // Offline nodes are informational (low), not security incidents
        // Only bump to medium if offline for extended period (potential unplanned outage)
        let severity: Severity = 'low';
        let desc = `Node "${expected}" is offline.`;

        if (node.LastSeen) {
          const lastSeen = new Date(node.LastSeen).getTime();
          const offlineDuration = now - lastSeen;

          if (offlineDuration > FOUR_HOURS_MS) {
            severity = 'medium';
            const hours = Math.round(offlineDuration / (60 * 60 * 1000));
            desc = `Node "${expected}" has been offline for ~${hours} hours (last seen: ${node.LastSeen}).`;
          } else {
            const minutes = Math.round(offlineDuration / (60 * 1000));
            desc = `Node "${expected}" is offline (last seen ${minutes} minutes ago).`;
          }
        }

        findings.push(
          createFinding({
            scannerId: SCANNER_ID,
            severity,
            title: `Offline Tailscale node: ${expected}`,
            description: desc,
            target: expected,
            autoFixable: false,
            metadata: {
              hostname: expected,
              lastSeen: node.LastSeen ?? null,
              online: false,
            },
          }),
        );
      }
    }

    const durationMs = Date.now() - start;
    const onlineCount = expectedNodes.length - findings.length;
    const summary =
      `Checked ${expectedNodes.length} expected node(s): ` +
      `${onlineCount} online, ${findings.length} issue(s) found.`;

    return { findings, summary, durationMs };
  },

  // No autoFix for Tailscale -- nodes must be brought online manually
};

export default tailscaleHealthScanner;
