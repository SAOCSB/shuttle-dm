// Global speed limit (token bucket). rate = 0 means unlimited.
import { sleep } from '../common/util.js';

export class Limiter {
  constructor(bytesPerSec = 0) {
    this.setRate(bytesPerSec);
  }

  setRate(bps) {
    this.rate = bps > 0 ? bps : 0;
    this.tokens = this.rate / 4;
    this.last = performance.now();
  }

  async take(n, signal) {
    if (!this.rate) return;
    const now = performance.now();
    // allow bursts of up to 0.25 s
    this.tokens = Math.min(this.rate / 4, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    this.tokens -= n;
    if (this.tokens < 0) await sleep((-this.tokens / this.rate) * 1000, signal);
  }
}
