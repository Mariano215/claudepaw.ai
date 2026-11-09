// src/security/scanners/port-scan.ts
// Scans Tailscale nodes for unexpected open ports using nmap

import { execFile } from 'node:child_process';
import type { SecurityScanner, ScanContext, ScanResult } from '../types.js';
import { createFinding } from '../types.js';

interface TailscaleStatus {
  Self: { TailscaleIPs?: string[]; HostName?: string; DNSName?: string };
  Peer: Record<string, { TailscaleIPs?: string[]; HostName?: string; DNSName?: string; Online?: boolean }>;
}

function getTailscaleStatus(): Promise<TailscaleStatus> {
  return new Promise((resolve, reject) => {
    execFile(
      'tailscale',
      ['status', '--json'],
      { timeout: 15_000 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`tailscale status failed: ${error.message}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Failed to parse tailscale status JSON'));
        }
      }
    );
  });
}

function resolveNodeIp(
  status: TailscaleStatus,
  nodeName: string
): string | null {
  // Check self
  const selfHost = status.Self?.HostName?.toLowerCase();
  if (selfHost === nodeName.toLowerCase()) {
    return status.Self.TailscaleIPs?.[0] ?? null;
  }

  // Check peers
  for (const peer of Object.values(status.Peer)) {
    const peerHost = peer.HostName?.toLowerCase();
    if (peerHost === nodeName.toLowerCase()) {
      return peer.TailscaleIPs?.[0] ?? null;
    }
  }

  return null;
}

interface OpenPort {
  port: number;
  protocol: string;
  service: string;
}

function runNmap(nodeIp: string): Promise<OpenPort[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'nmap',
      ['-sT', '--top-ports', '100', '-T4', '--open', '-oG', '-', nodeIp],
      { timeout: 60_000 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`nmap scan failed for ${nodeIp}: ${error.message}`));
          return;
        }

        const ports: OpenPort[] = [];

        // Parse grepable output: lines contain "Ports: 22/open/tcp//ssh///, 80/open/tcp//http///"
        for (const line of stdout.split('\n')) {
          if (!line.includes('Ports:')) continue;

          const portsSection = line.split('Ports:')[1];
          if (!portsSection) continue;

          // Each port entry is separated by ", " and looks like: 22/open/tcp//ssh///
          const portEntries = portsSection.trim().split(',');
          for (const entry of portEntries) {
            const trimmed = entry.trim();
            const parts = trimmed.split('/');
            // Format: port/state/protocol//service///
            if (parts.length >= 3 && parts[1] === 'open') {
              ports.push({
                port: parseInt(parts[0], 10),
                protocol: parts[2],
                service: parts[4] || 'unknown',
              });
            }
          }
        }

        resolve(ports);
      }
    );
  });
}

const scanner: SecurityScanner = {
  id: 'port-scan',
  name: 'Port Scanner',
  description: 'Scans Tailscale nodes for unexpected open ports using nmap',
  scope: 'weekly',

  async run(context: ScanContext): Promise<ScanResult> {
    const start = Date.now();
    const findings = [];
    const errors: string[] = [];

    let tsStatus: TailscaleStatus;
    try {
      tsStatus = await getTailscaleStatus();
    } catch (err) {
      return {
        findings: [],
        summary: `Port scan failed: could not get Tailscale status - ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
      };
    }

    for (const nodeName of context.tailscaleNodes) {
      const nodeIp = resolveNodeIp(tsStatus, nodeName);
      if (!nodeIp) {
        errors.push(`${nodeName}: could not resolve Tailscale IP`);
        continue;
      }

      try {
        const openPorts = await runNmap(nodeIp);
        const allowedPorts = context.expectedPorts[nodeName] ?? [];

        for (const openPort of openPorts) {
          const portStr = String(openPort.port);
          if (!allowedPorts.includes(portStr)) {
            findings.push(
              createFinding({
                scannerId: 'port-scan',
                severity: 'medium',
                title: `Unexpected open port ${openPort.port}/${openPort.protocol} on ${nodeName}`,
                description: `Port ${openPort.port} (${openPort.service}) is open on ${nodeName} (${nodeIp}) but not in the expected ports allowlist. If this port is expected, add it to SECURITY_EXPECTED_PORTS.`,
                target: `${nodeName}:${openPort.port}`,
                autoFixable: false,
                metadata: {
                  nodeName,
                  nodeIp,
                  port: openPort.port,
                  protocol: openPort.protocol,
                  service: openPort.service,
                },
              })
            );
          }
        }
      } catch (err) {
        errors.push(`${nodeName} (${nodeIp}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const durationMs = Date.now() - start;
    const errorSuffix = errors.length > 0 ? ` (${errors.length} errors: ${errors.join('; ')})` : '';

    return {
      findings,
      summary: `Port scan complete: ${findings.length} unexpected open ports across ${context.tailscaleNodes.length} nodes${errorSuffix}`,
      durationMs,
    };
  },
};

export default scanner;
