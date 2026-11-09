import { z } from 'zod'

const credentialFieldSchema = z.object({
  service: z.string(),
  key: z.string(),
  label: z.string(),
  help_url: z.string().url().optional(),
  input_type: z.enum(['text', 'password', 'url']),
})

const oauthBlockSchema = z.object({
  provider: z.string(),
  scopes: z.array(z.string()),
})

const apiKeyBlockSchema = z.object({
  credential_key: z.string(),
  test_endpoint: z.string().url(),
  test_header: z.string(),
})

const mcpBlockSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  env_from_credentials: z.array(z.string()),
  transport: z.literal('stdio'),
})

const verifyOauthProfile = z.object({
  kind: z.literal('oauth_profile'),
  endpoint: z.string().url(),
  account_field: z.string(),
})
const verifyHttpGet = z.object({
  kind: z.literal('http_get'),
  endpoint: z.string().url(),
  header_template: z.string(),
  expect_status: z.number().int().positive(),
  account_field: z.string().optional(),
})
const verifyMcpToolCall = z.object({
  kind: z.literal('mcp_tool_call'),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  timeout_ms: z.number().int().positive(),
})

export const manifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  category: z.enum(['payments', 'social', 'dev-tools', 'communication', 'analytics', 'storage', 'ai', 'other']),
  icon: z.string(),
  description: z.string(),
  kind: z.enum(['oauth', 'api_key', 'mcp_server']),
  oauth: oauthBlockSchema.optional(),
  api_key: apiKeyBlockSchema.optional(),
  mcp: mcpBlockSchema.optional(),
  setup: z.object({
    credentials_required: z.array(credentialFieldSchema),
    instructions: z.string().optional(),
  }),
  verify: z.discriminatedUnion('kind', [verifyOauthProfile, verifyHttpGet, verifyMcpToolCall]),
}).refine(
  (m) => (m.kind === 'oauth' && !!m.oauth) || (m.kind === 'api_key' && !!m.api_key) || (m.kind === 'mcp_server' && !!m.mcp),
  { message: 'kind-specific block must be populated' }
)

export type IntegrationManifest = z.infer<typeof manifestSchema>
