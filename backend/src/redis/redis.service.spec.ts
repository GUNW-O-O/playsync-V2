import { RedisService } from './redis.service';
import { TableState } from 'src/game-engine/types';

/**
 * 파이프라인의 부분 실패.
 *
 * `pipeline.exec()`은 명령이 실패해도 **던지지 않는다.** 실패는 결과 배열의
 * 각 원소 `[err, response]`에 담겨 돌아온다. 그래서 결과를 안 보면 어떤 실패도
 * 성공처럼 보인다 — T9의 `$transaction` 삼항과 같은 유형이다.
 *
 * 진짜 Redis로는 SET 하나만 골라 실패시킬 방법이 없다. 검증 대상이 "실패가
 * 돌아왔을 때 무엇을 하는가"이므로 필요한 것은 마음대로 실패를 만들 수 있는
 * 파이프라인이다.
 */
describe('RedisService.saveInitialTableSnapshots', () => {
  const state = { phase: 0, players: [] } as unknown as TableState;

  const setup = (execResult: [Error | null, unknown][]) => {
    const set = jest.fn();
    const redis = {
      pipeline: () => ({ set, exec: async () => execResult }),
    };
    return { service: new RedisService(redis as any), set };
  };

  it('전부 성공하면 조용히 끝난다', async () => {
    const { service, set } = setup([
      [null, 'OK'],
      [null, 'OK'],
    ]);

    await service.saveInitialTableSnapshots([
      { tableId: 't1', state },
      { tableId: 't2', state },
    ]);

    expect(set).toHaveBeenCalledTimes(2);
  });

  it('하나라도 실패하면 어느 테이블인지 담아 던진다', async () => {
    // 토너먼트 시작 경로다. 조용히 넘어가면 그 테이블은 스냅샷 없이 시작하고,
    // 딜러는 첫 액션에서 '테이블 상태를 찾을 수 없습니다'를 이유도 모른 채 본다.
    // 시작이 실패한 것을 시작한 사람이 그 자리에서 알아야 한다.
    const { service } = setup([
      [null, 'OK'],
      [new Error('OOM'), null],
    ]);

    await expect(
      service.saveInitialTableSnapshots([
        { tableId: 't1', state },
        { tableId: 'broken-table', state },
      ]),
    ).rejects.toThrow(/broken-table/);
  });
});
