import type { ClockPort } from '../../ports/clock.ts'

export const systemClock: ClockPort = { now: () => Date.now() }
