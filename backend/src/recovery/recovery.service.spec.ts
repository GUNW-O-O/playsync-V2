import { EventEmitter } from 'events';
import { RecoveryService } from './recovery.service';

/**
 * 부팅 복구와 Redis 장애 이벤트의 순서(T97).
 *
 * Redis가 죽은 채 프로세스가 뜨면 `down`이 부팅 1단계보다 먼저 올 수 있다. 그때
 * `pausedAt`을 "지금"으로 찍으면 부팅이 읽는 마지막 하트비트로 덮을 길이 없다.
 * DB·Redis 왕복 타이밍에 맡기지 않고 부팅을 붙잡아 순서를 강제한다.
 */
function setup() {
  const outage = Object.assign(new EventEmitter(), {
    generation: 1,
    downSince: 500 as number | null,
    markRecovered: jest.fn(),
  });
  const updateMany = jest.fn().mockResolvedValue({ count: 0 });
  const findMany = jest.fn().mockResolvedValue([]);
  const recovery = new RecoveryService(
    { tournament: { updateMany, findMany } } as never,
    { outage } as never,
  );
  let finishBoot!: () => void;
  jest.spyOn(recovery, 'recoverAll').mockImplementationOnce(
    () => new Promise<void>((r) => { finishBoot = r; }),
  );
  return { outage, updateMany, recovery, finishBoot: () => finishBoot() };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('RecoveryService — 부팅 중 Redis 장애', () => {
  it('부팅이 도는 동안 온 down은 대회를 건드리지 않고, 부팅 뒤의 down은 켠다', async () => {
    const { outage, updateMany, recovery, finishBoot } = setup();
    const boot = recovery.onApplicationBootstrap();

    outage.emit('down', 1000, 'up');
    await flush();
    expect(`부팅 중 update ${updateMany.mock.calls.length}`).toBe('부팅 중 update 0');

    finishBoot();
    await boot;
    outage.emit('down', 2000, 'up');
    await flush();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ pausedAt: new Date(2000) }) }),
    );
  });

  it('부팅이 도는 동안 온 up은 부팅이 끝난 뒤에 스윕한다', async () => {
    const { outage, updateMany, recovery, finishBoot } = setup();
    const boot = recovery.onApplicationBootstrap();

    outage.emit('up');
    await flush();
    expect(`부팅 중 스윕 ${updateMany.mock.calls.length} 복구 ${outage.markRecovered.mock.calls.length}`)
      .toBe('부팅 중 스윕 0 복구 0');

    finishBoot();
    await boot;
    await flush();
    expect(`부팅 뒤 스윕 ${updateMany.mock.calls.length} 복구 ${outage.markRecovered.mock.calls.length}`)
      .toBe('부팅 뒤 스윕 1 복구 1');
  });

  it('부팅을 부르지 않았어도 up에서 끊긴 down은 대회를 켠다 (반대 입력)', async () => {
    // 시나리오 하네스는 `new`로 세우고 `onApplicationBootstrap`을 부르지 않는다.
    const { outage, updateMany } = setup();
    outage.emit('down', 3000, 'up');
    await flush();
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('한 번도 붙기 전(booting)에 끊긴 down은 부팅이 불리기 전이어도 대회를 건드리지 않는다', async () => {
    // Redis가 죽은 채 프로세스가 뜨면 `reconnecting`은 DI 도중, 부팅 복구보다 먼저 온다.
    const { outage, updateMany } = setup();
    outage.emit('down', 4000, 'booting');
    await flush();
    expect(`down update ${updateMany.mock.calls.length}`).toBe('down update 0');

    // DI 도중에 돌아와도 스윕이 대회를 켜지 않는다 — 켜는 것은 뒤이을 부팅이다.
    outage.emit('up');
    await flush();
    expect(`up update ${updateMany.mock.calls.length} 복구 ${outage.markRecovered.mock.calls.length}`)
      .toBe('up update 0 복구 1');

    // 그 장애가 끝난 뒤의 런타임 장애는 다시 켠다.
    outage.emit('down', 5000, 'up');
    await flush();
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
