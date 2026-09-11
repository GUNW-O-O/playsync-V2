import { describe, it, expect } from 'vitest';
import { formatDuration } from '@/lib/format-duration';

describe('formatDuration', () => {
  it('분과 초를 함께 적는다', () => {
    expect(formatDuration(192_000)).toBe('3분 12초');
  });

  /** 「0분 7초」와 「3분 0초」는 둘 다 읽는 사람을 한 번 멈춰 세운다. */
  it('한쪽이 0이면 그쪽을 적지 않는다', () => {
    expect(formatDuration(7_000)).toBe('7초');
    expect(formatDuration(180_000)).toBe('3분');
  });

  /**
   * **버린다.** 반올림하면 2분 40초가 「3분」이 되어 실제보다 길게 들린다.
   * 이 값이 쓰이는 자리가 "얼마나 놓쳤나"라 짧게 말하는 쪽이 안전하다.
   */
  it('초 미만을 버린다 — 반올림하지 않는다', () => {
    expect(formatDuration(160_000)).toBe('2분 40초');
    expect(formatDuration(7_999)).toBe('7초');
  });

  it('음수와 0은 0초다', () => {
    expect(`${formatDuration(0)} ${formatDuration(-5)}`).toBe('0초 0초');
  });
});
