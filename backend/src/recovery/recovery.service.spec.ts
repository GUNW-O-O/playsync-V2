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

    outage.emit('down', 1000);
    await flush();
    expect(`부팅 중 update ${updateMany.mock.calls.length}`).toBe('부팅 중 update 0');

    finishBoot();
    await boot;
    outage.emit('down', 2000);
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

  it('부팅을 거치지 않고 new로 세우면 부팅은 끝난 것이다 (반대 입력)', async () => {
    const { outage, updateMany } = setup();
    outage.emit('down', 3000);
    await flush();
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
