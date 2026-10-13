import { answerPongWaiters, awaitPong, markAlive, socketPingMs, sweep, SOCKET_PING_MS, KeepaliveSocket } from './keepalive';

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
   * 접기 직전에 딜러에게 묻는다(T130). 2초마다 전 딜러를 확인하던 것을 그 순간의 확인
   * 하나로 바꿨다 — 모르는 동안에는 접지 않는다.
   */
  describe('awaitPong', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('기다리는 동안 pong이 오면 true다 — 늦게 와도 기다리는 동안이면', async () => {
      const s = fake();
      const answer = awaitPong(s, 1_500);
      jest.advanceTimersByTime(1_000);
      answerPongWaiters(s);
      expect(`답 ${await answer} ping ${s.pings}`).toBe('답 true ping 1');
    });

    /** 반대 입력 — 「언제나 true」가 위를 통과한다. */
    it('기다리는 동안 pong이 없으면 false다', async () => {
      const s = fake();
      const answer = awaitPong(s, 1_500);
      jest.advanceTimersByTime(1_500);
      answerPongWaiters(s); // 늦었다
      expect(`답 ${await answer}`).toBe('답 false');
    });

    it('열리지 않은 소켓에는 ping하지 않고 false다', async () => {
      const s = fake();
      s.readyState = 3;
      expect(`답 ${await awaitPong(s, 1_500)} ping ${s.pings}`).toBe('답 false ping 0');
    });

    it('ping이 던져도 던지지 않고 false다', async () => {
      const s = fake();
      s.ping = () => { throw new Error('boom'); };
      expect(`답 ${await awaitPong(s, 1_500)}`).toBe('답 false');
    });

    /** 끝난 대기는 남지 않는다 — 남으면 소켓마다 대기자가 쌓인다. */
    it('끝나면 대기자를 치운다', async () => {
      const s = fake();
      const a = awaitPong(s, 1_500);
      answerPongWaiters(s);
      await a;
      const b = awaitPong(s, 1_500);
      jest.advanceTimersByTime(1_500);
      await b;
      expect(`남은 대기 ${s.pongWaiters?.size ?? 0}`).toBe('남은 대기 0');
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
