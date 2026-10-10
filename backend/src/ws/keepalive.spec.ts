import { isSilent, markAlive, probe, socketPingMs, sweep, SOCKET_PING_MS, KeepaliveSocket } from './keepalive';

function fake(): KeepaliveSocket & { pings: number; terminated: boolean; sent: string[] } {
  const s: any = {
    readyState: 1,
    pings: 0,
    terminated: false,
    sent: [] as string[],
    ping() { s.pings += 1; },
    terminate() { s.terminated = true; },
    send(m: string) { s.sent.push(m); },
  };
  markAlive(s);
  return s;
}

describe('keepalive sweep', () => {
  it('pong이 없던 소켓은 다음 틱에 끊는다', () => {
    const s = fake();
    sweep([s], 'm'); // 첫 틱: ping을 보내고 "답을 기다린다"로 표시
    const dead = sweep([s], 'm'); // 두 번째 틱: 답이 없었다
    expect(dead).toEqual([s]);
    expect(s.terminated).toBe(true);
  });

  /**
   * **반대 입력.** 이것이 없으면 "매 틱 전부 끊는다"도 위 검사를 통과한다.
   */
  it('틱 사이에 pong을 받은 소켓은 살려 두고 신호를 보낸다', () => {
    const s = fake();
    sweep([s], 'm');
    markAlive(s); // pong 도착
    const dead = sweep([s], 'm');
    expect(dead).toEqual([]);
    expect(s.terminated).toBe(false);
    expect(s.pings).toBe(2);
    expect(s.sent).toEqual(['m', 'm']);
  });

  /**
   * 마지막으로 응답한 시각(T121). 회선이 끊겨 대회를 멈출 때 「언제부터 끊겼나」의
   * 근거다 — 서버가 소켓을 끊는 것은 그보다 10~20초 뒤다.
   */
  it('응답한 시각을 적고, 틱은 그 시각을 건드리지 않는다', () => {
    const s = fake();
    markAlive(s, 1_000);
    sweep([s], 'm');
    sweep([s], 'm'); // 끊겼다
    expect(s.aliveAt).toBe(1_000);
  });

  /**
   * 딜러만 빠르게 확인한다(T121). 회선이 끊긴 것을 아는 데 10~20초가 걸리면 그 사이
   * 마감이 온 사람이 접힌다. **끊지는 않는다** — 침묵인지만 말한다.
   */
  describe('딜러 빠른 확인', () => {
    it('연달아 두 번 답이 없으면 침묵이다 — 한 번으로는 아니다', () => {
      const s = fake();
      markAlive(s, 1_000);
      probe(s, 2_000);              // 첫 확인을 보낸다
      probe(s, 4_000);              // 답이 없었다 (1)
      expect(`한 번 ${isSilent(s)}`).toBe('한 번 false');
      probe(s, 6_000);              // 또 없었다 (2)
      expect(`두 번 ${isSilent(s)} 끊음 ${s.terminated} ping ${s.pings}`).toBe('두 번 true 끊음 false ping 3');
    });

    /** 반대 입력 — 「확인할 때마다 센다」가 위를 통과한다. */
    it('사이에 답하면 다시 0부터 센다', () => {
      const s = fake();
      markAlive(s, 1_000);
      probe(s, 2_000);
      probe(s, 4_000);              // (1)
      markAlive(s, 4_500);          // pong
      probe(s, 6_000);              // 답했다 → 0
      probe(s, 8_000);              // (1)
      expect(`${s.probeMisses} ${isSilent(s)}`).toBe('1 false');
    });

    it('ping이 던져도 던지지 않는다', () => {
      const s = fake();
      s.ping = () => { throw new Error('boom'); };
      expect(() => probe(s, 1_000)).not.toThrow();
    });
  });

  it('이미 닫힌 소켓에는 보내지 않고 끊은 목록에 넣는다', () => {
    const s = fake();
    s.readyState = 3;
    expect(sweep([s], 'm')).toEqual([s]);
    expect(s.sent).toEqual([]);
  });

  it('ping이 던져도 나머지 소켓을 계속 돈다', () => {
    const bad = fake();
    bad.ping = () => { throw new Error('boom'); };
    const good = fake();
    const dead = sweep([bad, good], 'm');
    expect(dead).toEqual([bad]);
    expect(good.pings).toBe(1);
  });

  it('주기는 기본 10초, 환경 변수로 덮고, 잘못된 값이면 기본으로 돌아간다', () => {
    expect(SOCKET_PING_MS).toBe(10_000);
    expect(socketPingMs(undefined)).toBe(10_000);
    expect(socketPingMs('50')).toBe(50);
    expect(socketPingMs('abc')).toBe(10_000);
    expect(socketPingMs('0')).toBe(10_000);
  });

  /**
   * 이 환경 변수는 줄이는 용도뿐이다. 늘린 값을 그대로 받으면 조용한
   * 테이블의 태블릿이 전부 `SOCKET_SILENCE_MS`마다 끊기고 다시 붙는다(M4).
   */
  it('SOCKET_PING_MS보다 큰 값은 거절하고 기본으로 돌아간다', () => {
    expect(socketPingMs(String(SOCKET_PING_MS + 1))).toBe(SOCKET_PING_MS);
    expect(socketPingMs(String(SOCKET_PING_MS))).toBe(SOCKET_PING_MS);
  });
});
