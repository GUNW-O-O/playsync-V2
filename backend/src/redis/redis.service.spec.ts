import type Redis from 'ioredis';
import { RedisService } from './redis.service';

/**
 * `deleteTournament`의 **실패 보고**만 본다.
 *
 * `pipeline.exec()`는 명령별 실패로 reject하지 않고 `[err, result]` 배열로
 * 돌려준다. 그래서 죽은 연결에 대고 불러도 **성공으로 돌아왔고**, 부르는 쪽
 * (`SessionService.finishClose`)이 실패를 보고 걸도록 돼 있는 복구 뒤 재시도가
 * 한 번도 안 탔다 — 닫은 대회의 키가 그대로 고아로 남았다(T103 시나리오에서
 * 드러났다).
 *
 * **진짜 Redis를 끊어서 재지 않는다.** 재는 것이 「끊기면 어떻게 되나」가 아니라
 * 「`exec`가 에러를 배열로 돌려줄 때 이 메서드가 무엇을 하나」라서, 그 배열을
 * 직접 먹이는 쪽이 결정적이다. 끊긴 클라이언트는 사후 정리가 얽혀 검사가 멈춘다.
 */
describe('RedisService.deleteTournament — 실패 보고', () => {
  /**
   * `pipeline()`과 테이블 락 왕복만 흉내 내는 클라이언트. `exec`가 돌려줄
   * 배열을 받아 둔다.
   *
   * `set`·`eval`·`del`은 스냅샷을 **락 안에서** 지우는 경로가 쓴다
   * (`withTableLock`). 대회 키 셋만 pipeline이다.
   */
  function clientWith(results: [Error | null, unknown][]) {
    const pipe = {
      del: () => pipe,
      exec: async () => results,
    };
    return {
      pipeline: () => pipe,
      set: async () => 'OK',      // 락 획득
      eval: async () => 1,        // 락 해제
      del: async () => 1,         // table:state 삭제
      on: () => undefined,
      status: 'ready',
    } as unknown as Redis;
  }

  /** 대회 키 셋의 결과. 하나는 0인데 그것도 성공이다(아래 반대 입력). */
  const ok: [Error | null, unknown][] = [[null, 1], [null, 1], [null, 0]];

  it('다 지워졌으면 조용히 끝난다', async () => {
    const service = new RedisService(clientWith(ok));

    await expect(service.deleteTournament('t1', ['table-1'])).resolves.toBeUndefined();
  });

  it('하나라도 에러가 실려 오면 그 에러를 던진다', async () => {
    const boom = new Error('Stream isn\'t writeable');
    const service = new RedisService(clientWith([[null, 1], [boom, null], [null, 1]]));

    await expect(service.deleteTournament('t1', ['table-1'])).rejects.toBe(boom);
  });

  /**
   * **반대 입력.** 이미 없는 키에 `DEL`은 0을 돌려준다 — 실패가 아니라 이미
   * 정리됐다는 뜻이다. 0을 실패로 읽으면 복구 뒤 재시도가 영영 안 끝난다
   * (재시도는 멱등해야 한다).
   */
  it('지운 개수가 0이어도 실패가 아니다', async () => {
    const service = new RedisService(clientWith([[null, 0], [null, 0], [null, 0]]));

    await expect(service.deleteTournament('t1', ['table-1'])).resolves.toBeUndefined();
  });
});

/**
 * **`joinPlayer`도 같은 pipeline이다**(T105).
 *
 * 이쪽은 고아 키가 아니라 **조용한 유실**이었다 — 죽은 연결에 대고 불러도
 * 성공으로 돌아와서, 전광판의 엔트리·걷은 돈이 에러 한 줄 없이 빠졌다.
 * `mirrorAfterCommit`이 실패를 보고 복구 뒤 재시도를 거는데, 실패가 안 보이니
 * 그 길이 안 탄다.
 *
 * **시나리오(`mirror-outage.int-spec.ts`)는 이것을 증명하지 못한다.** 거기서는
 * 미러가 `down`일 때 아예 안 부르므로 이 결함이 드러날 자리가 없다 — 이 검사가
 * 무는 것은 「장애가 그 판정 뒤에 시작하는」 좁은 창이다.
 */
describe('RedisService.joinPlayer — 실패 보고', () => {
  function clientWith(results: [Error | null, unknown][]) {
    const pipe = {
      hincrby: () => pipe,
      exec: async () => results,
    };
    return { pipeline: () => pipe, on: () => undefined, status: 'ready' } as unknown as Redis;
  }

  it('둘 다 올라갔으면 조용히 끝난다', async () => {
    const service = new RedisService(clientWith([[null, 1], [null, 1000]]));

    await expect(service.joinPlayer('t1', 1000)).resolves.toBeUndefined();
  });

  it('하나라도 에러가 실려 오면 그 에러를 던진다', async () => {
    const boom = new Error('Stream isn\'t writeable');
    const service = new RedisService(clientWith([[null, 1], [boom, null]]));

    await expect(service.joinPlayer('t1', 1000)).rejects.toBe(boom);
  });
});
