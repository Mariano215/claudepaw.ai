import path from 'node:path'
import { PROJECT_ROOT, readEnvFile } from '../env.js'
import type { CategoryId, TopicId, NewsletterConfig } from './types.js'

const env = readEnvFile()

// ---------------------------------------------------------------------------
// Feed URLs grouped by category
// ---------------------------------------------------------------------------

export const FEEDS: Record<CategoryId | 'google_news', string[]> = {
  research: [
    'https://aiweekly.co/issues.rss',
    'https://openai.com/news/rss.xml',
    'https://sans.org/newsletters/newsbites/rss',
    'http://export.arxiv.org/rss/cs.LG',
    'http://export.arxiv.org/rss/cs.AI',
    'http://export.arxiv.org/rss/cs.CR',
  ],
  cyber: [
    'https://www.darkreading.com/rss.xml',
    'https://krebsonsecurity.com/feed/',
    'https://threatpost.com/feed/',
    'https://www.csoonline.com/feed/',
    'https://www.infosecurity-magazine.com/rss/news/',
  ],
  ai: [
    'https://machinelearningmastery.com/blog/feed/',
    'https://news.mit.edu/rss/topic/artificial-intelligence2',
    'https://www.artificial-intelligence.blog/ai-news?format=rss',
    'https://www.marktechpost.com/feed/',
    'https://research.google/blog/rss/',
  ],
  google_news: [
    'https://news.google.com/rss/search?q=cybersecurity+OR+ai+OR+privacy+OR+Quantum+OR+CMMC+when:7d+-Trump+-stocks+-stock+-investment+-finance&hl=en-US&gl=US&ceid=US:en',
  ],
}

// ---------------------------------------------------------------------------
// Keyword hints for scoring (multi-word matches score +2, single +1)
// ---------------------------------------------------------------------------

export const CYBER_HINTS: string[] = [
  'zero day', 'zero-day', 'ransomware', 'breach', 'vulnerability', 'exploit',
  'malware', 'phishing', 'threat actor', 'apt', 'cve', 'patch', 'firewall',
  'intrusion', 'incident response', 'soc', 'siem', 'endpoint', 'encryption',
  'authentication', 'identity', 'access control', 'privilege escalation',
  'lateral movement', 'exfiltration', 'supply chain attack', 'botnet',
  'ddos', 'trojan', 'spyware', 'rootkit', 'backdoor', 'pentest',
  'penetration testing', 'red team', 'blue team', 'purple team',
  'threat intelligence', 'ioc', 'indicators of compromise', 'cisa',
  'nist', 'cmmc', 'compliance', 'audit', 'governance', 'risk management',
  'security operations', 'vulnerability management', 'attack surface',
  'cloud security', 'container security', 'devsecops', 'secure coding',
]

export const AI_HINTS: string[] = [
  'large language model', 'llm', 'generative ai', 'transformer',
  'neural network', 'deep learning', 'machine learning', 'nlp',
  'natural language processing', 'computer vision', 'reinforcement learning',
  'fine-tuning', 'fine tuning', 'rlhf', 'prompt engineering', 'rag',
  'retrieval augmented', 'vector database', 'embedding', 'diffusion model',
  'stable diffusion', 'midjourney', 'openai', 'anthropic', 'claude',
  'gpt', 'gemini', 'llama', 'mistral', 'hugging face', 'multimodal',
  'agent', 'agentic', 'autonomous', 'reasoning', 'chain of thought',
  'artificial intelligence', 'ai safety', 'alignment', 'hallucination',
  'benchmark', 'inference', 'training', 'foundation model',
]

export const RESEARCH_HINTS: string[] = [
  'arxiv', 'paper', 'study', 'research', 'peer-reviewed', 'peer reviewed',
  'journal', 'conference', 'proceedings', 'abstract', 'methodology',
  'dataset', 'benchmark', 'state-of-the-art', 'state of the art', 'sota',
  'novel approach', 'framework', 'architecture', 'preprint',
]

// ---------------------------------------------------------------------------
// Block terms -- articles containing any of these are discarded
// ---------------------------------------------------------------------------

export const BLOCK_TERMS: string[] = [
  'trump', 'stocks', 'stock', 'investment', 'investing', 'earnings',
  'dow jones', 'nasdaq', 's&p', 'wall street', 'etf', 'share price',
  'ipo', 'fed rate',
]

// ---------------------------------------------------------------------------
// Paywall / blocked hosts -- skip without probing
// ---------------------------------------------------------------------------

export const PAYWALL_HOSTS: string[] = [
  'wsj.com', 'ft.com', 'economist.com', 'bloomberg.com', 'nytimes.com',
]

// ---------------------------------------------------------------------------
// Paywall markers detected in page HTML
// ---------------------------------------------------------------------------

export const PAYWALL_MARKERS: string[] = [
  'subscribe to continue',
  'subscription required',
  'subscribe to read',
  'premium content',
  'members only',
  'paywall',
  'sign in to continue reading',
  'create a free account',
  'register to continue',
]

// ---------------------------------------------------------------------------
// Block markers detected in page HTML
// ---------------------------------------------------------------------------

export const BLOCK_MARKERS: string[] = [
  'access denied',
  'forbidden',
  'captcha',
  '403 forbidden',
  'bot detected',
  'automated access',
  'please verify you are human',
]

// ---------------------------------------------------------------------------
// Topic map for executive brief generation
// ---------------------------------------------------------------------------

export const TOPIC_MAP: Record<TopicId, string[]> = {
  identity: [
    'identity', 'authentication', 'mfa', 'sso', 'zero trust', 'credential',
    'password', 'passkey', 'biometric', 'oauth', 'saml', 'ldap', 'iam',
    'access management', 'privileged access',
  ],
  supply_chain: [
    'supply chain', 'third-party', 'vendor', 'dependency', 'sbom',
    'software bill of materials', 'solarwinds', 'open source risk',
    'package manager', 'npm', 'pypi', 'crate', 'dependency confusion',
  ],
  model_security: [
    'model security', 'adversarial', 'prompt injection', 'jailbreak',
    'model poisoning', 'data poisoning', 'backdoor', 'trojan model',
    'llm security', 'ai safety', 'alignment', 'guardrails', 'red teaming ai',
  ],
  data_governance: [
    'data governance', 'data privacy', 'gdpr', 'ccpa', 'data protection',
    'data classification', 'dlp', 'data loss prevention', 'pii',
    'encryption at rest', 'encryption in transit', 'data residency',
  ],
  ai_operations: [
    'mlops', 'ai operations', 'model deployment', 'inference',
    'model monitoring', 'drift detection', 'feature store', 'pipeline',
    'ci/cd', 'continuous integration', 'model registry', 'kubeflow',
  ],
  quantum_readiness: [
    'quantum', 'post-quantum', 'pqc', 'quantum computing', 'quantum key',
    'lattice-based', 'quantum resistant', 'quantum threat', 'nist pqc',
    'crystals-kyber', 'crystals-dilithium', 'quantum safe',
  ],
}

// ---------------------------------------------------------------------------
// Newsletter config from env
// ---------------------------------------------------------------------------

export const NEWSLETTER_CONFIG: NewsletterConfig = {
  recipientEmail: env.NEWSLETTER_RECIPIENT || '',
  perCategoryLimit: 8,
  probeTimeoutMs: 12_000,
  heroDir: path.join(PROJECT_ROOT, 'store', 'newsletter', 'heroes'),
  geminiModel: env.GEMINI_MODEL || 'gemini-3.1-flash-image-preview',
  geminiApiKey: env.GEMINI_API_KEY || '',
  templatePath: path.join(PROJECT_ROOT, 'assets', 'newsletter-template.html'),
  maxHeroBytes: 52_000,
}

// ---------------------------------------------------------------------------
// Adaptive lookback: Monday=4 days, Thursday=3 days, fallback=3
// ---------------------------------------------------------------------------

export function getLookbackDays(): number {
  const day = new Date().getDay() // 0=Sun, 1=Mon, ..., 4=Thu
  if (day === 1) return 7 // Monday -- week since Monday
  if (day === 4) return 5 // Thursday -- since last Thursday, minus some overlap
  return 5 // fallback for manual triggers
}
