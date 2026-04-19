import { spawn } from 'child_process'
import type { IntegrationManifest } from '../schema.js'
import type { VerifyResult } from './api_key.js'

const ALLOWED_MCP_COMMANDS = new Set(['npx', 'node', 'uvx', 'python3', 'python'])

export function buildMcpEnv(envFromCredentials: string[], creds: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const ref of envFromCredentials) {
    const envName = ref.toUpperCase().replace(/[.-]/g, '_')
    if (creds[ref] !== undefined) {
      env[envName] = creds[ref]
    }
  }
  return env
}

function sanitize(message: string, creds: Record<string, string>): string {
  let out = message
  for (const v of Object.values(creds)) {
    if (v && v.length >= 6) out = out.split(v).join('[REDACTED]')
  }
  return out
}

export async function verifyMcpServerIntegration(
  manifest: IntegrationManifest,
  creds: Record<string, string>,
): Promise<VerifyResult> {
  if (manifest.kind !== 'mcp_server' || !manifest.mcp) {
    return { status: 'error', error: 'not an mcp_server manifest' }
  }
  if (manifest.verify.kind !== 'mcp_tool_call') {
    return { status: 'error', error: 'unexpected verify kind for mcp_server' }
  }
  if (!ALLOWED_MCP_COMMANDS.has(manifest.mcp.command)) {
    return { status: 'error', error: `disallowed MCP command: ${manifest.mcp.command}. Allowed: ${[...ALLOWED_MCP_COMMANDS].join(', ')}` }
  }
  const mcp = manifest.mcp
  const verify = manifest.verify
  const env = { ...process.env, ...buildMcpEnv(mcp.env_from_credentials, creds) }
  const cmdLine = `${mcp.command} ${mcp.args.join(' ')}`
  const timeoutMs = verify.timeout_ms

  return new Promise<VerifyResult>((resolve) => {
    let stderrBuf = ''
    let stdoutBuf = ''
    let settled = false
    let initSeen = false

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(mcp.command, mcp.args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err: any) {
      resolve({ status: 'error', error: `Failed to spawn MCP server. Command: ${cmdLine}\nError: ${sanitize(err.message ?? String(err), creds)}` })
      return
    }

    const finish = (result: VerifyResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGTERM') } catch { /* */ }
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* */ } }, 500)
      resolve(result)
    }

    const timer = setTimeout(() => {
      finish({
        status: 'error',
        error: `MCP server did not respond within ${timeoutMs}ms. Command: ${cmdLine}\nStderr (last 20 lines):\n${stderrBuf.split('\n').slice(-20).join('\n')}`,
      })
    }, timeoutMs)

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += sanitize(chunk.toString('utf8'), creds)
    })

    child.on('error', (err: Error) => {
      finish({
        status: 'error',
        error: `Failed to spawn MCP server. Command: ${cmdLine}\nError: ${sanitize(err.message, creds)}`,
      })
    })

    child.on('exit', (code: number | null) => {
      if (settled) return
      // Process exited before verify completed -- treat as error regardless of exit code.
      // A zero exit before the tool call responds would be a false positive 'connected'.
      finish({
        status: 'error',
        error: `MCP server exited (code ${code}) before verify completed. Command: ${cmdLine}\nStderr (last 20 lines):\n${stderrBuf.split('\n').slice(-20).join('\n')}`,
      })
    })

    // Minimal JSON-RPC handshake: initialize then call verify tool
    const initMsg = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claudepaw-verify', version: '1.0' } },
    }) + '\n'
    const toolMsg = JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: verify.tool, arguments: verify.args },
    }) + '\n'

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8')
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === 1 && !initSeen) {
            initSeen = true
            try { child.stdin?.write(toolMsg) } catch { /* pipe closed */ }
          } else if (msg.id === 2) {
            if (msg.error) {
              finish({ status: 'error', error: `tool call failed: ${JSON.stringify(msg.error).slice(0, 300)}` })
            } else {
              finish({ status: 'connected' })
            }
          }
        } catch { /* not JSON, ignore */ }
      }
    })

    try { child.stdin?.write(initMsg) } catch { /* pipe closed before handshake */ }
  })
}
