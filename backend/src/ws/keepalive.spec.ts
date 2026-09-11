import { markAlive, socketPingMs, sweep, SOCKET_PING_MS, KeepaliveSocket } from './keepalive';

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
});
