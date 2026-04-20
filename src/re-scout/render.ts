/**
 * render.ts
 * Deterministic HTML + inline-image rendering for the weekly Property Scout email.
 *
 * Input: structured JSON produced by the re-property-scout Paw's ACT phase.
 * Output: HTML (with cid: image refs) and a list of PNG buffers to embed.
 *
 * No LLM involvement here -- purely data-in, email-out.
 */
import type { InlineImage } from '../google/types.js'
import { renderStaticMap } from './static-map.js'

export interface PropertyFinding {
  /** Stable slug used for the inline-image Content-ID. */
  id: string
  address: string
  zip: string
  price: number
  beds: number | null
  baths: number | null
  sqft: number | null
  property_type: string
  days_on_market: number | null
  /** 1 (skip) .. 5 (strong fixer under $200k). Only >= 2 are shown. */
  severity: number
  /** Short headline, e.g. "3947 Mary St -- $225,000" or "PRICE DROP: ..." */
  title: string
  why_flagged: string
  est_rent_per_mo: number | null
  arv_estimate: number | null
  max_offer_70_pct: number | null
  /** "deal" | "stretch" | "pass" */
  deal_verdict: string | null
  latitude: number
  longitude: number
  sources: string[]
  listing_url: string | null
}

export interface ReportData {
  report_date: string
  zip_quarter?: string[]
  properties: PropertyFinding[]
}

export interface RenderedEmail {
  subject: string
  html: string
  inlineImages: InlineImage[]
}

const SEVERITY_LABEL: Record<number, string> = {
  5: 'Fixer under $200k',
  4: 'Fixer $200k-$250k / small multi',
  3: 'Motivated seller / stretch',
  2: 'Awareness',
}

const SEVERITY_BG: Record<number, string> = {
  5: '#d93025',
  4: '#e8710a',
  3: '#f9ab00',
  2: '#5f6368',
}

/** Escape HTML-sensitive characters so LLM-authored strings can't break the page. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtMoney(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '--'
  return `$${Math.round(n).toLocaleString('en-US')}`
}

function fmtSqft(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '--'
  return `${Math.round(n).toLocaleString('en-US')} sqft`
}

function pricePerSqft(price: number, sqft: number | null): string {
  if (!sqft || sqft <= 0) return '--'
  return `$${Math.round(price / sqft)}/sqft`
}

function gmapsLink(address: string): string {
  return `https://maps.google.com/?q=${encodeURIComponent(address)}`
}

function zillowFallback(address: string): string {
  return `https://www.zillow.com/homes/${encodeURIComponent(
    address.replace(/\s+/g, '-'),
  )}_rb/`
}

function renderPropertyCard(p: PropertyFinding, cidIndex: number): string {
  const sev = Math.max(2, Math.min(5, Math.round(p.severity)))
  const badgeColor = SEVERITY_BG[sev] ?? SEVERITY_BG[2]
  const badgeLabel = SEVERITY_LABEL[sev] ?? `Severity ${sev}`
  const listingUrl = p.listing_url || zillowFallback(p.address)

  const stats: string[] = [fmtMoney(p.price)]
  if (p.beds != null && p.baths != null) {
    stats.push(`${p.beds}bd / ${p.baths}ba`)
  }
  stats.push(fmtSqft(p.sqft))
  if (p.days_on_market != null) stats.push(`${p.days_on_market} DOM`)
  stats.push(pricePerSqft(p.price, p.sqft))

  const rentLine = p.est_rent_per_mo
    ? `<div style="color:#188038;font-size:13px;margin-top:6px;">Est. rent: ${fmtMoney(p.est_rent_per_mo)}/mo (${esc(p.zip)} median${p.beds ? ` for ${p.beds}BR` : ''})</div>`
    : ''

  const verdictBg =
    p.deal_verdict === 'deal'
      ? '#e6f4ea'
      : p.deal_verdict === 'stretch'
        ? '#fef7e0'
        : '#fce8e6'
  const verdictLabel = p.deal_verdict
    ? p.deal_verdict.charAt(0).toUpperCase() + p.deal_verdict.slice(1)
    : null
  const rule70 =
    p.arv_estimate && p.max_offer_70_pct
      ? `<div style="background:${verdictBg};padding:8px 12px;border-radius:4px;margin-top:8px;font-size:13px;">
           <strong>70% Rule:</strong> At ${fmtMoney(p.price)} list, ARV ~${fmtMoney(p.arv_estimate)}, max offer = ${fmtMoney(p.max_offer_70_pct)} - reno.
           ${verdictLabel ? ` <strong>${esc(verdictLabel)}</strong>` : ''}
         </div>`
      : ''

  const cid = `map-${cidIndex}`

  return `
<div style="border:1px solid #dadce0;border-radius:8px;padding:16px;margin:16px 0;background:#ffffff;">
  <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;">
    <h3 style="margin:0;color:#1f3764;font-size:18px;font-family:Calibri,Arial,sans-serif;">${esc(p.title)}</h3>
    <span style="background:${badgeColor};color:#ffffff;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;letter-spacing:0.3px;text-transform:uppercase;">${esc(badgeLabel)}</span>
  </div>
  <div style="color:#5f6368;font-size:13px;margin:4px 0 12px;">${esc(p.address)}
    &middot; <a href="${esc(gmapsLink(p.address))}" style="color:#1a73e8;text-decoration:none;">Directions</a>
    &middot; <a href="${esc(listingUrl)}" style="color:#1a73e8;text-decoration:none;">${esc(p.listing_url ? new URL(p.listing_url).host.replace(/^www\./, '') : 'Zillow')}</a>
  </div>
  <img src="cid:${cid}" alt="Map of ${esc(p.address)}" width="600" height="200" style="display:block;max-width:100%;height:auto;border-radius:4px;border:1px solid #dadce0;">
  <div style="font-size:14px;color:#202124;margin-top:12px;">${stats.map(esc).join(' &nbsp;&middot;&nbsp; ')}</div>
  <div style="color:#202124;font-size:14px;margin-top:8px;">${esc(p.why_flagged)}</div>
  ${rentLine}
  ${rule70}
</div>`
}

/**
 * Render the full Property Scout report HTML.
 * Fetches OSM tiles to build one static map per property (parallel).
 */
export async function renderReport(data: ReportData): Promise<RenderedEmail> {
  const sorted = [...data.properties].sort((a, b) => b.severity - a.severity)
  const count = sorted.length

  // Fetch all maps in parallel. Each renderStaticMap already caps its own
  // tile-fetch concurrency internally.
  const inlineImages: InlineImage[] = await Promise.all(
    sorted.map(async (p, i): Promise<InlineImage> => {
      const png = await renderStaticMap({
        lat: p.latitude,
        lon: p.longitude,
        width: 600,
        height: 200,
        zoom: 16,
      })
      return {
        cid: `map-${i}`,
        contentType: 'image/png',
        data: png,
      }
    }),
  )

  const cards = sorted.map((p, i) => renderPropertyCard(p, i)).join('\n')

  const reportDate = data.report_date
  const subject = `Property Scout: ${count} fixer-upper${count === 1 ? '' : 's'} -- ${reportDate}`

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f1f3f4;font-family:Calibri,Arial,sans-serif;color:#202124;">
<div style="max-width:640px;margin:0 auto;padding:24px 16px;">
  <h1 style="color:#1f3764;margin:0 0 4px;font-size:24px;">Example Real Estate -- Weekly Property Scout</h1>
  <div style="color:#5f6368;font-size:13px;margin-bottom:16px;">
    ${esc(reportDate)} &middot; ${count} propert${count === 1 ? 'y' : 'ies'} flagged across Delaware County PA
  </div>
  ${cards}
  <div style="color:#5f6368;font-size:12px;margin-top:32px;text-align:center;">
    Reply to @YourBot: <em>analyze [address]</em> for full BRRRR analysis.<br>
    Maps &copy; OpenStreetMap contributors.
  </div>
</div>
</body>
</html>`

  return { subject, html, inlineImages }
}
