/**
 * Rate Limiter for Claude/LLM API calls
 * 
 * Ensures that API calls do not exceed a configurable number of
 * requests per minute (default: 50). Requests that exceed the limit
 * are queued and delayed automatically using a sliding window algorithm.
 * 
 * Usage:
 *   import { claudeRateLimiter } from './rateLimiter.js';
 *   const result = await claudeRateLimiter.schedule(() => apiCall());
 */

export class RateLimiter {
  /**
   * @param {number} maxRequestsPerMinute - Maximum requests allowed per minute
   * @param {string} name - Name for logging purposes
   */
  constructor(maxRequestsPerMinute = 50, name = 'default') {
    this.maxRequestsPerMinute = maxRequestsPerMinute;
    this.name = name;
    this.windowMs = 60_000; // 1 minute sliding window
    this.timestamps = [];
    this.queue = [];
    this.processing = false;
  }

  /**
   * Remove timestamps that have fallen outside the sliding window.
   */
  _pruneTimestamps() {
    const cutoff = Date.now() - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
  }

  /**
   * Calculate how long to wait before the next request can be sent.
   * @returns {number} Wait time in ms (0 if a request can go immediately)
   */
  _getWaitTime() {
    this._pruneTimestamps();

    if (this.timestamps.length < this.maxRequestsPerMinute) {
      return 0;
    }

    // Wait until the oldest timestamp in the window expires
    const oldestInWindow = this.timestamps[0];
    const waitTime = oldestInWindow + this.windowMs - Date.now() + 1; // +1ms safety buffer
    return Math.max(0, waitTime);
  }

  /**
   * Record that a request was made right now.
   */
  _recordRequest() {
    this.timestamps.push(Date.now());
  }

  /**
   * Delay for a given number of milliseconds.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Process queued requests one at a time, respecting the rate limit.
   */
  async _processQueue() {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const waitTime = this._getWaitTime();

        if (waitTime > 0) {
          console.log(
            `[RateLimiter:${this.name}] Rate limit reached ` +
            `(${this.timestamps.length}/${this.maxRequestsPerMinute} req/min). ` +
            `Delaying next request by ${waitTime}ms. Queue depth: ${this.queue.length}`
          );
          await this._delay(waitTime);
        }

        const item = this.queue.shift();
        if (!item) break;

        this._recordRequest();

        try {
          const result = await item.execute();
          item.resolve(result);
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Schedule an async function to run within the rate limit.
   * If the limit is reached, the call is queued and will execute
   * once a slot becomes available.
   *
   * @template T
   * @param {() => Promise<T>} fn - The async function to execute
   * @returns {Promise<T>} The result of the function
   */
  schedule(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        execute: fn,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      });

      // Kick off queue processing (no-op if already running)
      this._processQueue();
    });
  }

  /**
   * Get the current status of the rate limiter.
   * @returns {{ requestsInWindow: number, maxRequestsPerMinute: number, queueDepth: number, isProcessing: boolean }}
   */
  getStatus() {
    this._pruneTimestamps();
    return {
      requestsInWindow: this.timestamps.length,
      maxRequestsPerMinute: this.maxRequestsPerMinute,
      queueDepth: this.queue.length,
      isProcessing: this.processing,
    };
  }
}

// ─── Singleton Instance for Claude API Calls ────────────────────────────────

const CLAUDE_MAX_REQUESTS_PER_MINUTE = parseInt(
  process.env.CLAUDE_RATE_LIMIT_PER_MINUTE || '50',
  10
);

export const claudeRateLimiter = new RateLimiter(
  CLAUDE_MAX_REQUESTS_PER_MINUTE,
  'claude'
);

export default claudeRateLimiter;