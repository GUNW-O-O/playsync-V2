import { EventEmitter } from 'events';
import { RedisOutage } from './outage';
import { RedisService } from './redis.service';

/** ioredis 클라이언트 대역. 이벤트와 `status`만 쓴다. */
function fakeClient(status = 'connecting') {
  const e = new EventEmitter() as EventEmitter & { status: string };
  e.status = status;
  return e;
}

describe('RedisOutage', () => {
  it('부팅 중 첫 ready는 복구를 부르지 않는다 (반대 입력)', () => {
    const client = fakeClient();
    const o = new RedisOutage(client as never, () => 1000);
    const up = jest.fn();
    o.on('up', up);
    client.emit('ready');
    expect(`${o.phase} up호출 ${up.mock.calls.length}`).toBe('up up호출 0');
  });

  it('이미 연결된 클라이언트로 만들면 up에서 시작한다', () => {
    expect(new RedisOutage(fakeClient('ready') as never, () => 0).phase).toBe('up');
  });

  it('up에서 reconnecting → down, 세대 +1, 감지 시각', () => {
    const client = fakeClient('ready');
    const o = new RedisOutage(client as never, () => 5000);
    const down = jest.fn();
    o.on('down', down);
    client.emit('reconnecting');
    expect([o.phase, o.generation, o.downSince, o.isUp()]).toEqual(['down', 1, 5000, false]);
    // 둘째 인자는 끊기기 직전 상태다. 첫 인자만 받는 리스너도 그대로 돈다.
    expect(down).toHaveBeenCalledWith(5000, 'up');
  });

  it('down에서 ready → recovering, up 발행. markRecovered → up, recovered 발행', () => {
    const client = fakeClient('ready');
    const o = new RedisOutage(client as never, () => 0);
    const up = jest.fn();
    const recovered = jest.fn();
    o.on('up', up);
    o.on('recovered', recovered);
    client.emit('reconnecting');
    client.emit('ready');
    expect([o.phase, up.mock.calls.length]).toEqual(['recovering', 1]);
    o.markRecovered();
    expect([o.phase, o.downSince, recovered.mock.calls.length]).toEqual(['up', null, 1]);
  });

  it('복구 중 다시 끊기면 세대 +1, 감지 시각은 첫 장애 것을 유지한다', () => {
    let now = 1000;
    const client = fakeClient('ready');
    const o = new RedisOutage(client as never, () => now);
    client.emit('reconnecting');
    client.emit('ready');
    now = 9000;
    const down = jest.fn();
    o.on('down', down);
    client.emit('reconnecting');
    expect(down).toHaveBeenCalledWith(1000, 'recovering');
    expect([o.phase, o.generation, o.downSince]).toEqual(['down', 2, 1000]);
  });

  it('down 중 reconnecting이 반복돼도 세대는 한 번만 오른다', () => {
    const client = fakeClient('ready');
    const o = new RedisOutage(client as never, () => 0);
    client.emit('reconnecting');
    client.emit('reconnecting');
    client.emit('reconnecting');
    expect(o.generation).toBe(1);
  });

  it('부팅 중 끊기면 down이 되고, 돌아오면 복구한다', () => {
    const client = fakeClient();
    const o = new RedisOutage(client as never, () => 7);
    const up = jest.fn();
    const down = jest.fn();
    o.on('up', up);
    o.on('down', down);
    client.emit('reconnecting');
    expect(down).toHaveBeenCalledWith(7, 'booting');
    client.emit('ready');
    expect([o.phase, up.mock.calls.length]).toEqual(['recovering', 1]);
  });

  it('종료(quit)는 장애가 아니다 — close/end만 오고 reconnecting이 없다 (반대 입력)', () => {
    const client = fakeClient('ready');
    const o = new RedisOutage(client as never, () => 0);
    client.emit('close');
    client.emit('end');
    expect([o.phase, o.generation]).toEqual(['up', 0]);
  });

  it('같은 클라이언트의 RedisService 둘은 장애 상태 하나를 같이 본다', () => {
    // 프로덕션도 둘이다(`RedisModule` · `DealerModule`). 따로 들면 한쪽만 복구된다.
    const client = fakeClient('ready');
    const a = new RedisService(client as never);
    const b = new RedisService(client as never);
    client.emit('reconnecting');
    expect([a.outage === b.outage, b.outage.phase, client.listenerCount('ready')]).toEqual([true, 'down', 1]);
  });
});

describe('RedisOutage — 기다리는 쪽', () => {
  it('up이면 whenUp이 곧바로 풀린다 (반대 입력)', async () => {
    const o = new RedisOutage(fakeClient('ready') as never, () => 0);
    await expect(o.whenUp()).resolves.toBeUndefined();
  });

  it('down이면 whenUp은 markRecovered에서야 풀린다', async () => {
    const client = fakeClient('ready');
    const o = new RedisOutage(client as never, () => 0);
    client.emit('reconnecting');
    let done = false;
    const waiting = o.whenUp().then(() => { done = true; });
    client.emit('ready');
    await Promise.resolve();
    expect(`recovering에서 ${done}`).toBe('recovering에서 false');
    o.markRecovered();
    await waiting;
    expect(done).toBe(true);
  });

  /**
   * **부팅에서 건 `whenUp`도 첫 `ready`에 풀린다**(T103 최종 리뷰 I4).
   *
   * `isUp()`은 `'up'`만 참이라 `booting` 동안에도 `whenUp()`을 거는 경로가
   * 있다(`SessionService.finishClose` — Redis가 죽은 채로 프로세스가 떠도 앱은
   * 요청을 받는다). 예전 `onReady`는 `booting`에서 `phase`만 `'up'`으로 바꾸고
   * 대기자를 안 비워서, 그 대기가 **다음 진짜 장애의 복구까지** 안 풀렸다 —
   * 닫은 대회의 Redis 키 정리가 통째로 사라지는 경로다.
   */
  it('부팅 중에 건 whenUp은 첫 ready에 풀린다', async () => {
    const client = fakeClient();   // status가 'ready'가 아니라 booting에서 시작한다
    const o = new RedisOutage(client as never, () => 0);
    expect(`${o.phase} isUp ${o.isUp()}`).toBe('booting isUp false');

    let done = false;
    const waiting = o.whenUp().then(() => { done = true; });
    client.emit('ready');
    await waiting;

    expect(`${o.phase} 풀림 ${done}`).toBe('up 풀림 true');
  });

  it('onceDown은 다음 끊김에 한 번만 부르고, 해제하면 안 부른다', () => {
    const client = fakeClient('ready');
    const o = new RedisOutage(client as never, () => 0);
    const kept = jest.fn();
    const dropped = jest.fn();
    o.onceDown(kept);
    const off = o.onceDown(dropped);
    off();
    client.emit('reconnecting');
    client.emit('ready');
    o.markRecovered();
    client.emit('reconnecting');
    expect(`${kept.mock.calls.length} ${dropped.mock.calls.length}`).toBe('1 0');
  });

  it('대기자가 많아도 EventEmitter 리스너를 늘리지 않는다', () => {
    const o = new RedisOutage(fakeClient('ready') as never, () => 0);
    for (let i = 0; i < 50; i++) o.onceDown(() => {});
    expect(o.listenerCount('down')).toBe(0);
  });

  it('던지는 onceDown 대기자가 있어도 다른 대기자와 down 이벤트는 마저 돈다', () => {
    const client = fakeClient('ready');
    const o = new RedisOutage(client as never, () => 0);
    const down = jest.fn();
    o.on('down', down);
    o.onceDown(() => { throw new Error('던짐'); });
    const second = jest.fn();
    o.onceDown(second);

    client.emit('reconnecting');

    expect(`${second.mock.calls.length} ${down.mock.calls.length}`).toBe('1 1');
  });
});
