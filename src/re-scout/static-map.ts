/**
 * static-map.ts
 * Render a 600x200 (or custom) static map for a lat/lon using OpenStreetMap tiles.
 * No API key. Tiles are fetched from tile.openstreetmap.org, composited with sharp,
 * and a red pin is drawn at the center.
 *
 * OSM tile usage policy: we identify with a User-Agent, we do weekly-scale volume
 * (~20 tiles/week), and we don't hammer. This is well within acceptable use.
 */
import sharp from 'sharp'

const TILE_SIZE = 256
const OSM_TILE_BASE = 'https://tile.openstreetmap.org'
const USER_AGENT = 'ClaudePaw/1.0 (+; re-scout weekly)'

export interface TileCoord {
  x: number
  y: number
}

export interface MapTilePlan {
  tiles: TileCoord[]
  cols: number
  rows: number
  /** Pixel location of the pin within the final cropped map image. */
  centerPx: { x: number; y: number }
  /** How far into the composed (full-tile) image the final crop starts. */
  cropOffset: { x: number; y: number }
}

/**
 * Convert lat/lon/zoom to fractional tile coordinates (Web Mercator).
 * The fractional part indicates the offset within the tile.
 */
export function lonLatToFractionalTile(
  lon: number,
  lat: number,
  zoom: number,
): { xf: number; yf: number } {
  const n = Math.pow(2, zoom)
  const xf = ((lon + 180) / 360) * n
  const latRad = (lat * Math.PI) / 180
  const yf =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  return { xf, yf }
}

/**
 * Compute the tiles needed to render a `width`x`height` pixel map centered
 * on (lat, lon) at the given zoom, and where the pin goes inside the crop.
 */
export function computeMapTiles(
  lon: number,
  lat: number,
  zoom: number,
  width: number,
  height: number,
): MapTilePlan {
  const { xf, yf } = lonLatToFractionalTile(lon, lat, zoom)
  const centerWorldPx = xf * TILE_SIZE
  const centerWorldPy = yf * TILE_SIZE
  const leftPx = centerWorldPx - width / 2
  const topPx = centerWorldPy - height / 2

  const tileMinX = Math.floor(leftPx / TILE_SIZE)
  const tileMaxX = Math.floor((leftPx + width - 1) / TILE_SIZE)
  const tileMinY = Math.floor(topPx / TILE_SIZE)
  const tileMaxY = Math.floor((topPx + height - 1) / TILE_SIZE)

  const cols = tileMaxX - tileMinX + 1
  const rows = tileMaxY - tileMinY + 1

  const tiles: TileCoord[] = []
  for (let ty = tileMinY; ty <= tileMaxY; ty++) {
    for (let tx = tileMinX; tx <= tileMaxX; tx++) {
      tiles.push({ x: tx, y: ty })
    }
  }

  const composedOriginPx = tileMinX * TILE_SIZE
  const composedOriginPy = tileMinY * TILE_SIZE

  return {
    tiles,
    cols,
    rows,
    centerPx: {
      x: Math.round(centerWorldPx - leftPx),
      y: Math.round(centerWorldPy - topPx),
    },
    cropOffset: {
      x: Math.round(leftPx - composedOriginPx),
      y: Math.round(topPx - composedOriginPy),
    },
  }
}

async function fetchTile(x: number, y: number, zoom: number): Promise<Buffer> {
  const url = `${OSM_TILE_BASE}/${zoom}/${x}/${y}.png`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) {
    throw new Error(
      `OSM tile fetch failed: ${zoom}/${x}/${y}: ${res.status} ${res.statusText}`,
    )
  }
  const arr = await res.arrayBuffer()
  return Buffer.from(arr)
}

function buildPinSvg(
  cx: number,
  cy: number,
  width: number,
  height: number,
): string {
  // 24x32 red drop-pin with white dot. Tip points to (cx, cy); body hangs above.
  const pinW = 24
  const pinH = 32
  const left = cx - pinW / 2
  const top = cy - pinH
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <g transform="translate(${left}, ${top})">
    <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20c0-6.6-5.4-12-12-12z" fill="#d93025" stroke="#ffffff" stroke-width="1.5"/>
    <circle cx="12" cy="12" r="4.5" fill="#ffffff"/>
  </g>
</svg>`
}

export interface RenderStaticMapOptions {
  lat: number
  lon: number
  zoom?: number
  width?: number
  height?: number
}

/**
 * Render a static map PNG centered on lat/lon with a red pin.
 */
export async function renderStaticMap(
  opts: RenderStaticMapOptions,
): Promise<Buffer> {
  const { lat, lon, zoom = 16, width = 600, height = 200 } = opts
  const plan = computeMapTiles(lon, lat, zoom, width, height)

  // Fetch tiles (cap concurrency at 4 to be polite)
  const tileBuffers: Buffer[] = new Array(plan.tiles.length)
  const chunkSize = 4
  for (let i = 0; i < plan.tiles.length; i += chunkSize) {
    const chunk = plan.tiles.slice(i, i + chunkSize)
    const results = await Promise.all(
      chunk.map((t) => fetchTile(t.x, t.y, zoom)),
    )
    for (let j = 0; j < results.length; j++) {
      tileBuffers[i + j] = results[j]
    }
  }

  // Composite tiles into a single full-size image
  const fullWidth = plan.cols * TILE_SIZE
  const fullHeight = plan.rows * TILE_SIZE
  const full = await sharp({
    create: {
      width: fullWidth,
      height: fullHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(
      plan.tiles.map((_, i) => ({
        input: tileBuffers[i],
        top: Math.floor(i / plan.cols) * TILE_SIZE,
        left: (i % plan.cols) * TILE_SIZE,
      })),
    )
    .png()
    .toBuffer()

  // Crop to desired viewport
  const cropped = await sharp(full)
    .extract({
      left: plan.cropOffset.x,
      top: plan.cropOffset.y,
      width,
      height,
    })
    .toBuffer()

  // Overlay pin
  const pin = buildPinSvg(plan.centerPx.x, plan.centerPx.y, width, height)
  return sharp(cropped)
    .composite([{ input: Buffer.from(pin), top: 0, left: 0 }])
    .png()
    .toBuffer()
}
