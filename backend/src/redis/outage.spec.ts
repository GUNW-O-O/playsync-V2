import { EventEmitter } from 'events';
import { RedisOutage } from './outage';

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
    expect(down).toHaveBeenCalledWith(5000);
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
    client.emit('reconnecting');
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
    o.on('up', up);
    client.emit('reconnecting');
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
});
