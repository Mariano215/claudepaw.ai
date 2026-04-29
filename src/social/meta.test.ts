import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `claudepaw-meta-test-${process.pid}`)

vi.mock('../config.js', () => {
  const path = require('node:path')
  const os = require('node:os')
  const crypto = require('node:crypto')
  const dir = path.join(os.tmpdir(), `claudepaw-meta-test-${process.pid}`)
  return {
    STORE_DIR: dir,
    PROJECT_ROOT: dir,
    CREDENTIAL_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  }
})

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { postFacebook, postInstagram, deleteMetaPost } from './meta.js'
import type { MetaConfig } from './meta.js'
import { initDatabase, createProject } from '../db.js'
import { initCredentialStore, setCredential } from '../credentials.js'
import { resolveMetaConfig } from './resolve.js'

// ---------------------------------------------------------------------------
// Shared test config
// ---------------------------------------------------------------------------

const TEST_CONFIG: MetaConfig = {
  appId: 'app-123',
  appSecret: 'secret-abc',
  defaultPageId: 'page-001',
  defaultPageToken: 'page-token-xyz',
  igUserId: 'ig-user-001',
  pages: {
    'example-company': { pageId: 'page-001', accessToken: 'page-token-xyz' },
  },
}

// ---------------------------------------------------------------------------
// postFacebook
// ---------------------------------------------------------------------------

describe('postFacebook', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('posts text to page feed and returns PublishResult', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'page-001_post-999' }),
    }))

    const result = await postFacebook('Hello world', TEST_CONFIG)

    expect(result.success).toBe(true)
    expect(result.platform_post_id).toBe('page-001_post-999')
    expect(result.platform_url).toBe('https://www.facebook.com/page-001_post-999')

    const [url, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/page-001/feed')
    const body = new URLSearchParams(opts.body as string)
    expect(body.get('message')).toBe('Hello world')
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer page-token-xyz')
  })

  it('posts photo when mediaUrl is provided', async () => {
    // postFacebook now preprocesses the image first (size check + optional resize/proxy).
    // Call 0: preprocessImageForFacebook fetches the image to check its size.
    // Call 1: the actual Facebook Graph API call.
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1024), // 1 KB — well under 10 MB limit
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'page-001_photo-42' }),
      }),
    )

    const result = await postFacebook('A photo post', TEST_CONFIG, {
      mediaUrl: 'https://cdn.example.com/photo.jpg',
    })

    expect(result.success).toBe(true)
    // calls[1] is the Facebook API call (calls[0] was the image prefetch)
    const [url, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[1] as [string, RequestInit]
    expect(url).toContain('/page-001/photos')
    const body = new URLSearchParams(opts.body as string)
    // Small image from non-blocked host — URL passes through unchanged
    expect(body.get('url')).toBe('https://cdn.example.com/photo.jpg')
  })

  it('uses custom pageId and pageToken when provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'custom-page_post-1' }),
    }))

    await postFacebook('Custom page post', TEST_CONFIG, {
      pageId: 'custom-page',
      pageToken: 'custom-token',
    })

    const [url, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/custom-page/feed')
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer custom-token')
  })

  it('returns success: false on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"OAuthException"}}',
    }))

    const result = await postFacebook('Bad post', TEST_CONFIG)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Facebook API 400/)
  })

  it('returns success: false on API-level error in response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: { message: 'Invalid token' } }),
    }))

    const result = await postFacebook('Bad post', TEST_CONFIG)
    expect(result.success).toBe(false)
    expect(result.error).toBe('Invalid token')
  })

  it('returns success: false when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')))
    const result = await postFacebook('Throw post', TEST_CONFIG)
    expect(result.success).toBe(false)
    expect(result.error).toBe('network failure')
  })
})

// ---------------------------------------------------------------------------
// postInstagram
// ---------------------------------------------------------------------------

describe('postInstagram', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('does two-step create+publish and returns PublishResult', async () => {
    const fetchMock = vi.fn()
      // Step 1: container creation
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'container-111' }),
      })
      // Step 1.5: container status poll -> FINISHED
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status_code: 'FINISHED' }),
      })
      // Step 2: publish
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'media-222' }),
      })

    vi.stubGlobal('fetch', fetchMock)

    // _pollDelayMs=0 so the status poll loop doesn't sleep in tests
    const result = await postInstagram('Caption text', TEST_CONFIG, 'https://cdn.example.com/img.jpg', 0)

    expect(result.success).toBe(true)
    expect(result.platform_post_id).toBe('media-222')
    expect(result.platform_url).toBe('https://www.instagram.com/p/media-222/')

    // Step 1: container creation
    const [containerUrl, containerOpts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(containerUrl).toContain('/ig-user-001/media')
    const containerBody = new URLSearchParams(containerOpts.body as string)
    expect(containerBody.get('caption')).toBe('Caption text')
    expect(containerBody.get('image_url')).toBe('https://cdn.example.com/img.jpg')
    expect((containerOpts.headers as Record<string, string>)['Authorization']).toBe('Bearer page-token-xyz')

    // Step 1.5: status poll
    const [statusUrl] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(statusUrl).toContain('container-111')
    expect(statusUrl).toContain('status_code')

    // Step 2: publish (call index 2 now)
    const [publishUrl, publishOpts] = fetchMock.mock.calls[2] as [string, RequestInit]
    expect(publishUrl).toContain('/ig-user-001/media_publish')
    const publishBody = new URLSearchParams(publishOpts.body as string)
    expect(publishBody.get('creation_id')).toBe('container-111')
  })

  it('returns success: false if container creation fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    }))

    const result = await postInstagram('Caption', TEST_CONFIG, 'https://cdn.example.com/img.jpg')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Instagram container API 403/)
  })

  it('returns success: false if publish step fails', async () => {
    vi.stubGlobal('fetch', vi.fn()
      // Step 1: container creation
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'container-111' }),
      })
      // Step 1.5: status poll -> FINISHED
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status_code: 'FINISHED' }),
      })
      // Step 2: publish fails
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      }),
    )

    const result = await postInstagram('Caption', TEST_CONFIG, 'https://cdn.example.com/img.jpg', 0)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Instagram publish API 500/)
  })

  it('returns success: false if container returns API error body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: { message: 'Media type unsupported' } }),
    }))

    const result = await postInstagram('Caption', TEST_CONFIG, 'https://cdn.example.com/img.jpg')
    expect(result.success).toBe(false)
    expect(result.error).toBe('Media type unsupported')
  })

  it('returns success: false when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))
    const result = await postInstagram('Caption', TEST_CONFIG, 'https://cdn.example.com/img.jpg')
    expect(result.success).toBe(false)
    expect(result.error).toBe('timeout')
  })
})

// ---------------------------------------------------------------------------
// deleteMetaPost
// ---------------------------------------------------------------------------

describe('deleteMetaPost', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('calls DELETE on the correct endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await deleteMetaPost('post-123', 'token-abc')
    const [url, deleteOpts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/post-123')
    expect((deleteOpts.headers as Record<string, string>)['Authorization']).toBe('Bearer token-abc')
    expect(deleteOpts.method).toBe('DELETE')
  })

  it('does not throw on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, text: async () => 'Not Found' }))
    await expect(deleteMetaPost('bad-id', 'token')).resolves.toBeUndefined()
  })

  it('does not throw when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
    await expect(deleteMetaPost('post-id', 'token')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resolveMetaConfig
// ---------------------------------------------------------------------------

describe('resolveMetaConfig', () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    const db = initDatabase()
    initCredentialStore(db)
    createProject({
      id: 'meta-proj',
      name: 'meta-proj',
      slug: 'meta-proj',
      display_name: 'Meta Project',
    })
  })

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('returns null when meta creds are missing', () => {
    expect(resolveMetaConfig('meta-proj')).toBeNull()
  })

  it('returns null when page_id is missing but page_access_token present', () => {
    setCredential('meta-proj', 'meta', 'page_access_token', 'tok-abc')
    expect(resolveMetaConfig('meta-proj')).toBeNull()
  })

  it('returns full config when required creds are present', () => {
    setCredential('meta-proj', 'meta', 'page_id', 'pg-001')
    setCredential('meta-proj', 'meta', 'app_id', 'app-001')
    setCredential('meta-proj', 'meta', 'app_secret', 'sec-001')
    setCredential('meta-proj', 'meta', 'ig_user_id', 'ig-001')

    const cfg = resolveMetaConfig('meta-proj')
    expect(cfg).not.toBeNull()
    expect(cfg!.defaultPageId).toBe('pg-001')
    expect(cfg!.defaultPageToken).toBe('tok-abc')
    expect(cfg!.appId).toBe('app-001')
    expect(cfg!.appSecret).toBe('sec-001')
    expect(cfg!.igUserId).toBe('ig-001')
    expect(cfg!.pages['meta-proj']).toEqual({ pageId: 'pg-001', accessToken: 'tok-abc' })
  })

  it('includes optional pages when their creds are present', () => {
    setCredential('meta-proj', 'meta', 'evelyn_page_id', 'ev-pg')
    setCredential('meta-proj', 'meta', 'evelyn_page_token', 'ev-tok')

    const cfg = resolveMetaConfig('meta-proj')
    expect(cfg!.pages['evelyn']).toEqual({ pageId: 'ev-pg', accessToken: 'ev-tok' })
  })
})
