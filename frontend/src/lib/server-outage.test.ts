import { describe, expect, it } from 'vitest';
import { isServerRecovering } from './server-outage';

describe('isServerRecovering', () => {
  it('503이면 참', () => expect(isServerRecovering({ status: 503 })).toBe(true));
  it.each([200, 404, 429, 500, 502])('%i는 거짓', (status) => expect(isServerRecovering({ status })).toBe(false));
});
