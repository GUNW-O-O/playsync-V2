import type { Logger } from '@nestjs/common';
import type { RedisOutage } from './outage';

/**
 * **DB가 이긴 뒤의 Redis 미러는 요청의 성패를 정하지 않는다**(T105).
 *
 * 세 자리가 같은 모양이었다 — DB 트랜잭션을 커밋하고, 그 결과를 Redis에
 * 비추고, 그 비추기가 장애로 던지면 **요청 전체가 503으로 끝났다.**
 *
 * - `PaymentService.joinSession` — 포인트는 빠졌는데 화면은 실패다. 다시
 *   누르면 `이미 참가한 대회입니다`(409)라 미러는 **영영 안 써지고**
 *   전광판의 프라이즈풀·엔트리가 다음 부팅까지 낮게 남는다
 * - `EntryService.enterSeat` — 좌석 행은 있는데 비트맵이 0이라 **남이 그 자리를
 *   고른다.** 재시도가 다시 돌려 낫긴 하지만, 그 사이가 창이다
 * - `SessionService.finishClose` — T103이 이 규칙을 처음 세운 자리다
 *
 * **`down`일 때만 시도를 건너뛴다.** 운영 클라이언트는 `maxRetriesPerRequest`
 * 기본 20이라 끊긴 동안 부르면 예산을 다 쓸 때까지(실측 7~10초) 요청이
 * 붙잡힌다 — 그동안 사용자는 아무 응답도 못 받는다. 피하려는 것이 그 지연
 * 하나다.
 *
 * **`isUp()`으로 가르면 안 된다.** 그 함수는 `'up'`만 참이라 `booting`과
 * `recovering`도 걸러 낸다. 둘은 **Redis가 곧 응답하는** 구간이다 — 특히
 * `booting`은 클라이언트가 붙는 중일 뿐이라(ioredis 오프라인 큐가 들고 있다가
 * `ready`에 흘린다) 그 왕복이 빠르다. 그걸 미루면 착석 직후 좌석 비트맵이
 * 비어 있는 창이 생기고, 실제로 검사 하나가 그렇게 빨개졌다.
 *
 * Redis가 **죽은 채로** 프로세스가 뜬 경우에만 `booting`의 시도가 그 지연을
 * 문다. 그때는 아직 요청을 받기 전이라 무는 사람이 없다.
 *
 * **미룬 일은 복구 뒤에 한 번 돈다.** `whenUp()`은 복구 스윕이 끝날 때
 * (`markRecovered`) 풀린다. up인데 실패한 것은 장애가 아니므로 로그만 남긴다 —
 * 다시 걸면 영영 도는 고리가 된다.
 *
 * **미룬 쓰기가 닫힌 대회의 키를 되살릴 수 있다.** 그 사이에 대회가 닫히면
 * `hset`·`hincrby`가 지워진 키를 다시 만든다. 기능 영향은 없고(테이블 행이
 * 없어 게이트웨이가 접속을 거절한다) 메모리만 남는다 —
 * `tickets-recovery.md` 잔여 목록의 「닫힌 대회의 고아 키」와 같은 부류다.
 * 존재 조건으로 막지 않는 이유는 `setUserContext`가 **부팅 복구가
 * `tournament:{id}:user`를 되살리는 유일한 자리**이기 때문이다 — 조건을 걸면
 * 데이터 유실 복구가 깨진다.
 *
 * @param what 로그에 남길 이름. 어느 미러가 밀렸는지가 유일한 단서다.
 * @returns 즉시 시도가 끝나면 resolve. 미룬 경우에는 곧바로 resolve한다.
 *   **어떤 경우에도 reject하지 않는다.**
 */
export function mirrorAfterCommit(
  outage: RedisOutage,
  logger: Logger,
  what: string,
  run: () => Promise<unknown>,
): Promise<void> {
  const attempt = async (): Promise<void> => {
    try {
      await run();
    } catch (error) {
      logger.error(
        `${what} — Redis 미러를 못 썼다`,
        error instanceof Error ? error.stack : String(error),
      );
      if (!outage.isUp()) void outage.whenUp().then(attempt);
    }
  };

  if (outage.phase === 'down') {
    void outage.whenUp().then(attempt);
    return Promise.resolve();
  }
  return attempt();
}
