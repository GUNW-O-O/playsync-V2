import { generatePlayerOtp, PLAYER_OTP_LENGTH } from './player-otp';

describe('generatePlayerOtp', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('항상 8자다', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePlayerOtp()).toHaveLength(PLAYER_OTP_LENGTH);
    }
  });

  it('숫자만 담는다', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePlayerOtp()).toMatch(/^\d{8}$/);
    }
  });

  // padStart가 없으면 randomInt가 뽑은 작은 수가 짧은 문자열이 되어
  // "8자리"라는 말이 거짓이 된다. 약 10%가 7자 이하로 나온다.
  it('앞자리 0을 지운 값을 만들지 않는다', () => {
    jest.spyOn(require('node:crypto'), 'randomInt').mockReturnValue(617 as never);
    expect(generatePlayerOtp()).toBe('00000617');
  });

  it('매번 같은 값을 주지 않는다', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePlayerOtp()));
    expect(seen.size).toBeGreaterThan(400);
  });
});
