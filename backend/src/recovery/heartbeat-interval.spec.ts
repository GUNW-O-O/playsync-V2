import { heartbeatIntervalMs } from './heartbeat.service';

/**
 * T126 ⑤. `Number('')`는 0이고 `Number('abc')`는 NaN이다. 둘 다 `setInterval`에서
 * 약 1ms 주기가 되어 DB upsert와 Redis ping이 연달아 돈다.
 */
describe('heartbeatIntervalMs', () => {
  it.each([[undefined], [''], ['abc'], ['0'], ['-5'], ['1.5']])('%p면 기본값이다', (raw) => {
    expect(heartbeatIntervalMs(raw)).toBe(5000);
  });

  it('양의 정수는 그대로 쓴다 (반대 입력)', () => {
    expect(heartbeatIntervalMs('250')).toBe(250);
  });
});
