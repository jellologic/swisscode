// Port: wall-clock time, injected so cache TTLs are testable without waiting
// 24 hours. Constructed only inside catalog wiring — launching needs no clock.

/**
 * @typedef {Object} ClockPort
 * @property {() => number} now  epoch milliseconds
 */

export {}
