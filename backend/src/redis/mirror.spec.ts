import { EventEmitter } from 'events';
import type { Logger } from '@nestjs/common';
import { RedisOutage } from './outage';
import { mirrorAfterCommit } from './mirror';

/** ioredis 클라이언트 대역. 이벤트와 `status`만 쓴다(`outage.spec.ts`와 같다). */
function fakeClient(status = 'ready') {
  const e = new EventEmitter() as EventEmitter & { status: string };
  e.status = status;
  return e;
}

const silentLogger = { error: jest.fn() } as unknown as Logger;

describe('mirrorAfterCommit', () => {
  beforeEach(() => { (silentLogger.error as jest.Mock).mockClear(); });

  it('up이면 지금 돌린다', async () => {
    const o = new RedisOutage(fakeClient() as never, () => 0);
    const run = jest.fn().mockResolvedValue(undefined);

    await mirrorAfterCommit(o, silentLogger, '미러', run);

    expect(run).toHaveBeenCalledTimes(1);
  });

  /**
   * **던지면 안 된다.** 커밋은 이미 끝났다 — 부르는 쪽이 503을 돌려주면
   * 「돈은 빠졌는데 실패」가 되고, 다시 눌러도 409라 미러가 영영 안 써진다.
   */
  it('up인데 실패하면 로그만 남기고 던지지 않는다', async () => {
    const o = new RedisOutage(fakeClient() as never, () => 0);
    const run = jest.fn().mockRejectedValue(new Error('펑'));

    await expect(mirrorAfterCommit(o, silentLogger, '미러', run)).resolves.toBeUndefined();

    expect(`호출 ${run.mock.calls.length} 로그 ${(silentLogger.error as jest.Mock).mock.calls.length}`)
      .toBe('호출 1 로그 1');
  });

  /**
   * **up의 실패는 다시 걸지 않는다.** 장애가 아니면 `whenUp`이 곧바로 풀려
   * 영영 도는 고리가 된다.
   */
  it('up의 실패는 재시도를 걸지 않는다 (반대 입력)', async () => {
    const o = new RedisOutage(fakeClient() as never, () => 0);
    const run = jest.fn().mockRejectedValue(new Error('펑'));

    await mirrorAfterCommit(o, silentLogger, '미러', run);
    // 대기자가 있었다면 여기서 한 번 더 불린다.
    o.phase = 'recovering';
    o.markRecovered();
    await Promise.resolve();

    expect(run).toHaveBeenCalledTimes(1);
  });

  /**
   * **장애 중에는 시도조차 하지 않는다.** 운영 클라이언트는 재시도 예산을 다
   * 쓸 때까지(실측 7~10초) 요청을 붙잡는다 — 그동안 사용자는 응답이 없다.
   */
  it('down이면 부르지 않고 곧바로 끝난다', async () => {
    const client = fakeClient();
    const o = new RedisOutage(client as never, () => 0);
    const run = jest.fn().mockResolvedValue(undefined);
    client.emit('reconnecting');

    await mirrorAfterCommit(o, silentLogger, '미러', run);

    expect(`단계 ${o.phase} 호출 ${run.mock.calls.length}`).toBe('단계 down 호출 0');
  });

  /**
   * **반대 입력 — `booting`과 `recovering`은 미루지 않는다.**
   *
   * `isUp()`으로 가르면 둘도 걸러 낸다. 둘은 Redis가 곧 응답하는 구간이고,
   * 특히 `booting`은 클라이언트가 붙는 중일 뿐이다(오프라인 큐가 들고 있다가
   * `ready`에 흘린다). 미루면 착석 직후 좌석 비트맵이 비어 있는 창이 생긴다 —
   * 실제로 `isUp()`으로 갈랐을 때 「좌석 비트맵에 반영된다」가 빨개졌다.
   */
  it.each([
    ['booting', (c: EventEmitter & { status: string }) => { void c; }],
    ['recovering', (c: EventEmitter & { status: string }) => { c.emit('reconnecting'); c.emit('ready'); }],
  ])('%s에서는 미루지 않고 지금 돌린다 (반대 입력)', async (phase, drive) => {
    const client = fakeClient('connecting');
    const o = new RedisOutage(client as never, () => 0);
    drive(client);
    const run = jest.fn().mockResolvedValue(undefined);

    await mirrorAfterCommit(o, silentLogger, '미러', run);

    expect(`단계 ${o.phase} 호출 ${run.mock.calls.length}`).toBe(`단계 ${phase} 호출 1`);
  });

  it('복구되면 미룬 것이 한 번 돈다', async () => {
    const client = fakeClient();
    const o = new RedisOutage(client as never, () => 0);
    let done!: () => void;
    const ran = new Promise<void>((resolve) => { done = resolve; });
    const run = jest.fn().mockImplementation(async () => { done(); });
    client.emit('reconnecting');

    await mirrorAfterCommit(o, silentLogger, '미러', run);
    client.emit('ready');
    o.markRecovered();
    await ran;

    expect(run).toHaveBeenCalledTimes(1);
  });

  /**
   * 복구 직후 또 끊겨 실패하면 다음 복구에 다시 건다.
   *
   * **재등록을 로그로 붙잡는다.** `run` 안에서 붙잡으면 던지기 **전**이라,
   * 다시 걸리기도 전에 다음 `markRecovered`가 지나가 검사가 멎는다(실제로
   * 그렇게 멎었다). `logger.error`는 catch 안이고 `whenUp()` 등록과 **같은
   * 동기 구간**이라, 그 알림을 받고 깨어난 시점에는 등록이 이미 끝나 있다.
   */
  it('미룬 것이 또 실패하고 그때도 down이면 다시 건다', async () => {
    const client = fakeClient();
    const o = new RedisOutage(client as never, () => 0);
    let logged!: () => void;
    const failed = new Promise<void>((resolve) => { logged = resolve; });
    const logger = { error: () => { logged(); } } as unknown as Logger;

    let secondDone!: () => void;
    const second = new Promise<void>((resolve) => { secondDone = resolve; });

    const run = jest.fn()
      .mockImplementationOnce(async () => {
        o.phase = 'down';          // 복구 직후 또 끊겼다
        throw new Error('또 끊김');
      })
      .mockImplementationOnce(async () => { secondDone(); });

    client.emit('reconnecting');
    await mirrorAfterCommit(o, logger, '미러', run);

    o.phase = 'recovering';
    o.markRecovered();
    await failed;

    o.phase = 'recovering';
    o.markRecovered();
    await second;

    expect(run).toHaveBeenCalledTimes(2);
  });
});
