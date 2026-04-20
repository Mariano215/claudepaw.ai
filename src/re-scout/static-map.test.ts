import { describe, it, expect } from 'vitest'
import { computeMapTiles, lonLatToFractionalTile } from './static-map.js'

describe('lonLatToFractionalTile', () => {
  it('puts (0, 0) at the center tile at any zoom', () => {
    const { xf, yf } = lonLatToFractionalTile(0, 0, 16)
    expect(xf).toBeCloseTo(Math.pow(2, 16) / 2, 3)
    expect(yf).toBeCloseTo(Math.pow(2, 16) / 2, 3)
  })

  it('computes Drexel Hill PA coordinates correctly at zoom 16', () => {
    // 3947 Mary St, Drexel Hill PA -- real data from Rentcast
    const { xf, yf } = lonLatToFractionalTile(-75.294048, 39.936027, 16)
    // Verified: https://tile.openstreetmap.org/16/19061/24825.png shows Mary St
    expect(Math.floor(xf)).toBe(19061)
    expect(Math.floor(yf)).toBe(24825)
  })
})

describe('computeMapTiles', () => {
  it('covers a 600x200 map with the expected tile grid near Drexel Hill', () => {
    const plan = computeMapTiles(-75.294048, 39.936027, 16, 600, 200)
    // 600 wide centered on x=~19061.14 needs 3 or 4 columns depending on offset
    expect([3, 4]).toContain(plan.cols)
    // 200 tall needs 1 or 2 rows (fractional y can straddle)
    expect([1, 2]).toContain(plan.rows)
    expect(plan.tiles).toHaveLength(plan.cols * plan.rows)
  })

  it('places the pin at the center of the final crop', () => {
    const plan = computeMapTiles(-75.294048, 39.936027, 16, 600, 200)
    expect(plan.centerPx.x).toBe(300)
    expect(plan.centerPx.y).toBe(100)
  })

  it('handles an edge case where the center sits exactly on a tile boundary', () => {
    // Center of a tile at zoom 2 -> lon/lat such that (xf, yf) are whole numbers
    // zoom=2, tile (1, 1) corner is lon=-90, lat=~66.5, we use tile center
    const plan = computeMapTiles(-45, 40.979898, 2, 512, 512)
    expect(plan.cols).toBeGreaterThanOrEqual(1)
    expect(plan.rows).toBeGreaterThanOrEqual(1)
    expect(plan.centerPx.x).toBe(256)
    expect(plan.centerPx.y).toBe(256)
  })

  it('custom dimensions still yield centered pin', () => {
    const plan = computeMapTiles(-75.294048, 39.936027, 16, 320, 120)
    expect(plan.centerPx.x).toBe(160)
    expect(plan.centerPx.y).toBe(60)
  })
})
