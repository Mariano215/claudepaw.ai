import { describe, it, expect } from 'vitest'
import { brokerPaws } from './broker-paw-defs.js'

describe('brokerPaws', () => {
  it('keeps only re-property-scout active, spec section 8; every other broker routine seeds paused', () => {
    const active = brokerPaws.filter((paw) => paw.status !== 'paused').map((paw) => paw.id)
    expect(active).toEqual(['re-property-scout'])
  })
})
