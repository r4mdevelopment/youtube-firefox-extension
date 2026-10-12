import { expect, it } from 'vitest';
import { shouldRetry, retryDelayMs } from '../../src/download/retry.js';
it.each([429, 500, 502, 503, 504])('retries transient HTTP %s up to three times', status => {
  expect([0, 1, 2, 3].map(n => shouldRetry({ status }, n))).toEqual([true, true, true, false]);
});
it.each([400, 401, 403, 404, 410])('does not retry permanent %s', status => expect(shouldRetry({ status }, 0)).toBe(false));
it('retries network errors but never abort or integrity failure', () => {
  expect(shouldRetry(new TypeError('network'), 0)).toBe(true);
  expect(shouldRetry({ code: 'CANCELLED' }, 0)).toBe(false);
  expect(shouldRetry({ code: 'TRUNCATED_RESPONSE' }, 0)).toBe(false);
});
it('uses monotonically increasing bounded backoff', () => {
  expect([0, 1, 2, 20].map(retryDelayMs)).toEqual([500, 1000, 2000, 8000]);
});
