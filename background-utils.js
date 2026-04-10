/**
 * Reconnection delay calculation utility functions
 *
 * Exponential backoff + random jitter
 */

/**
 * Calculate reconnection delay (ms)
 * @param {number} attempt - Reconnection attempt count (starting from 0)
 * @param {object} options - Optional configuration
 * @param {number} options.baseMs - Base delay (default 1000ms)
 * @param {number} options.maxMs - Maximum delay (default 30000ms)
 * @param {number} options.jitterMs - Random jitter range (default 1000ms)
 * @returns {number}
 */
export function reconnectDelayMs(attempt, options = {}) {
  const { baseMs = 1000, maxMs = 30000, jitterMs = 1000 } = options
  const backoff = Math.min(baseMs * Math.pow(2, attempt), maxMs)
  const jitter = jitterMs * Math.random()
  return backoff + jitter
}

/**
 * Delay sequence for reattach attempts after navigation
 * @returns {number[]}
 */
export function reattachDelays() {
  return [200, 500, 1000, 2000, 4000]
}

// ============================================
// Restricted URL detection (shared by background.js and popup.js)
// ============================================

/** Restricted URL prefixes that cannot use chrome.debugger.attach */
export const RESTRICTED_URL_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "edge://",
  "about:",
  "devtools://",
  "chrome-search://",
  "view-source:",
]

/**
 * Check if URL is a restricted page (cannot use debugger attach)
 * @param {string} url
 * @returns {boolean}
 */
export function isRestrictedUrl(url) {
  // Empty string or about:blank is a normal loading/blank state, can attach normally
  if (!url || url === "about:blank") return false
  return RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix))
}
