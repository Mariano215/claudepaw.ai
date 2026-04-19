import { describe, it, expect } from 'vitest'
import { isExplicitRememberSignal } from './realtime.js'

describe('isExplicitRememberSignal', () => {
  it('/remember', () => expect(isExplicitRememberSignal('/remember this')).toBe(true))
  it('remember:', () => expect(isExplicitRememberSignal('remember: May 15')).toBe(true))
  it('write this down', () => expect(isExplicitRememberSignal('write this down: passcode 1234')).toBe(true))
  it('save this', () => expect(isExplicitRememberSignal('save this for later')).toBe(true))
  it('none', () => expect(isExplicitRememberSignal('just chatting')).toBe(false))
})
