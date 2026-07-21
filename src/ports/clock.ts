// Port: wall-clock time, injected so cache TTLs are testable without waiting
// 24 hours. Constructed only inside catalog wiring — launching needs no clock.

export type ClockPort = {
  /** epoch milliseconds */
  now: () => number
}

export {}
