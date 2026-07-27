import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';

export const MAX_ATTEMPTS = 5;
export const LOCK_SECONDS = 300;

/**
 * 잠금을 대회 단위로 거는 이유.
 *
 * IP 단위로 걸면 공격자가 주소를 바꿔가며 빠져나간다. 계정 단위로는 걸 수
 * 없다 — 딜러는 계정이 아니라 역할이고, OTP를 넣기 전에는 신원이 없다.
 *
 * **대가는 이것이 DoS 원시함수라는 것이다.** `POST /dealer/auth`에는 인증이
 * 없으므로, 같은 망의 누구나 5분에 틀린 OTP 다섯 개 — 분당 한 요청 — 으로 모든
 * 대회의 신규 딜러 로그인을 무기한 막을 수 있다. 재발급이 카운터를 지우지만
 * 공격자가 다섯 번 더 보내 다시 잠근다. 영향은 한정적이다: 이미 인증된 딜러는
 * 계속 플레이하고, 막히는 것은 *새* 단말의 로그인뿐이다. 닫으려면 IP 차원을
 * 더하거나 전역 Throttler가 필요하고, 그건 `backlog.md`의 이월 항목이다.
 * (정상 딜러가 남의 오타로 5분 막히는 사고 쪽은 상점 콘솔의 재발급이 탈출구다.)
 */
@Injectable()
export class OtpAttempts {
  // RedisService는 ioredis 인스턴스를 `private readonly redis`로 감추고 있어
  // 밖에서 명령을 직접 부를 수 없다. 카운터는 RedisService의 도메인 메서드와
  // 성격이 다르므로 그쪽에 메서드를 늘리지 않고 같은 토큰을 직접 주입한다.
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  private key(tournamentId: string) {
    return `dealer:otp:fail:${tournamentId}`;
  }

  /**
   * 시도 슬롯을 하나 예약한다. 한도를 넘으면 던진다.
   *
   * 읽고-검사하고-나중에-증가하는 형태가 아니라 **증가 자체가 게이트**다.
   * 예전에는 `assertNotLocked`가 GET으로 읽고, 호출자가 bcrypt에서 ~80ms를 쓰고,
   * 그다음에야 INCR을 했다. 그 창에 동시에 들어온 요청은 전부 같은 값을 읽으므로
   * 아무도 걸리지 않는다 — 50개를 한꺼번에 던지면 50개가 전부 통과했다(회귀
   * 테스트가 이 숫자를 못 박는다). 실제 한도는 "순차 5회 + 무제한 동시 버스트
   * 1회"였다.
   *
   * INCR이 원자적이므로, 동시성이 어떻든 창당 `MAX_ATTEMPTS`개만 반환된다.
   * 나머지는 bcrypt에 닿기 전에 걸러져 스레드풀도 함께 지켜진다.
   *
   * **의미 변화**: 성공한 로그인도 `clear`가 돌기 전까지 슬롯을 하나 쓴다.
   * 성공 경로가 `clear`를 부르므로 정상 딜러에게는 보이지 않는다.
   */
  async reserveAttempt(tournamentId: string): Promise<void> {
    const key = this.key(tournamentId);
    // INCR과 EXPIRE를 한 왕복으로 묶는다. 사이에 끼어들면 TTL 없는 키가 남아
    // 영영 잠긴다.
    const results = await this.redis
      .multi()
      .incr(key)
      .expire(key, LOCK_SECONDS)
      .exec();

    // `exec()`는 트랜잭션이 버려지면 null을, 명령이 실패하면 첫 자리에 에러를
    // 준다. 셀 수 없으면 통과시키는 대신 막는다 — 카운터가 죽은 순간이 곧
    // 무제한 추측이 되면 안 된다.
    const count = results?.[0]?.[1];

    if (typeof count !== 'number' || count > MAX_ATTEMPTS) {
      throw new ForbiddenException(
        '인증 시도가 너무 많습니다. 잠시 후 다시 시도하거나 상점에 문의해주세요.',
      );
    }
  }

  async clear(tournamentId: string): Promise<void> {
    await this.redis.del(this.key(tournamentId));
  }
}
