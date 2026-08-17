import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * 창 하나에 자격 검사까지 갈 수 있는 요청 수.
 *
 * **동시에 붙는 딜러 태블릿 수보다 커야 한다**(T53). 게이트가 대조 앞에 있어
 * 정답도 슬롯을 하나 쓰므로, 한도가 태블릿 수보다 작으면 **OTP가 맞는데도
 * 거절되는 태블릿**이 생긴다. 대회 하나의 태블릿 수는 테이블 수만큼이고
 * 보통 5~10이다. 5에서 10으로 올린 이유가 그것뿐이다.
 *
 * 추측 방어는 이 변경으로 달라지지 않는다. OTP는 6자리 숫자(후보 10^6)이고
 * 10회 / 5분이면 시간당 120회 — 전부 훑는 데 여전히 1년 가까이 걸린다.
 * 대회는 몇 시간이고 끝나면 OTP도 죽는다. **잠금의 방어력은 창의 크기가
 * 아니라 시도율에서 나온다.**
 *
 * bcrypt 부담도 그대로다. 창당 최대 10회 × 약 80ms를 워커 넷이 나눠 지고,
 * 그 앞에는 요청율 상한(분당 120)이 따로 서 있다.
 *
 * **한도 초과를 대기로 완화하지 않는다.** "6~7번째는 잠깐 재우고 카운터가
 * 내려가면 통과"를 검토하고 버렸다. (1) 거절이 공짜가 아니게 된다 — 버릴
 * 요청마다 서버가 100ms씩 핸들을 문다. (2) "창당 정확히 MAX개만 자격 검사에
 * 닿는다"가 조건부로 바뀐다. (3) 대기 뒤 재검사는 T23이 지운 읽고-검사
 * 패턴이다. 한도 상수를 올리는 쪽이 같은 문제를 더 싸게 푼다.
 */
export const MAX_ATTEMPTS = 10;
export const LOCK_SECONDS = 300;

/**
 * 슬롯 하나 반납. 키가 없으면 아무것도 하지 않고, 1 이하면 지운다.
 *
 * TTL은 `DECR`가 그대로 유지한다 — 잠금 창의 길이는 첫 실패가 정하고 반납이
 * 그것을 늘리거나 줄이지 않는다.
 */
const REFUND_SLOT = `
local v = tonumber(redis.call('GET', KEYS[1]))
if v == nil then return 0 end
if v <= 1 then
  redis.call('DEL', KEYS[1])
  return 0
end
return redis.call('DECR', KEYS[1])
`;

/**
 * 잠금을 대회 단위로 거는 이유.
 *
 * IP 단위로 걸면 공격자가 주소를 바꿔가며 빠져나간다. 계정 단위로는 걸 수
 * 없다 — 딜러는 계정이 아니라 역할이고, OTP를 넣기 전에는 신원이 없다.
 *
 * **대가는 이것이 DoS 원시함수라는 것이다.** `POST /dealer/auth`에는 인증이
 * 없으므로, 같은 망의 누구나 창 하나에 틀린 OTP를 한도만큼 보내 모든 대회의
 * 신규 딜러 로그인을 무기한 막을 수 있다. 재발급이 카운터를 지우지만
 * 공격자가 그만큼 더 보내 다시 잠근다. 영향은 한정적이다: 이미 인증된 딜러는
 * 계속 플레이하고, 막히는 것은 *새* 단말의 로그인뿐이다.
 * (정상 딜러가 남의 오타로 5분 막히는 사고 쪽은 상점 콘솔의 재발급이 탈출구다.)
 *
 * **T53이 그 대가에 값을 매겼다** — 요청율 상한(`auth/throttle.ts`)이 라우트
 * 앞에 서서, 잠금을 거는 쪽도 공짜가 아니게 됐다. 잠금 단위는 그대로 대회다.
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
   * 테스트가 이 숫자를 못 박는다). 실제 한도는 "순차 한도 + 무제한 동시 버스트
   * 1회"였다.
   *
   * INCR이 원자적이므로, 동시성이 어떻든 창당 `MAX_ATTEMPTS`개만 반환된다.
   * 나머지는 bcrypt에 닿기 전에 걸러져 스레드풀도 함께 지켜진다.
   *
   * **의미 변화**: 성공한 로그인도 `clear`가 돌기 전까지 슬롯을 하나 쓴다.
   * 순차로는 보이지 않는다 — 성공 경로가 `clear`를 부른다. 동시에는 보인다.
   *
   * - 한도보다 많은 태블릿이 같은 대회에 한꺼번에 인증하면 넘친 쪽은 OTP가
   *   맞는데도 403을 받는다. 게이트가 bcrypt 앞이라 생기는 값이고, 앞이 아니면
   *   스레드풀을 못 지킨다.
   * - OTP는 맞았는데 대회가 `FINISHED`거나 딜러 세션이 없어 던지는 경로는
   *   슬롯을 쓰고 `clear`를 부르지 않는다. 한도를 넘긴 재시도부터 안내 문구가
   *   "시도가 너무 많습니다"로 바뀌어, 준비가 덜 됐다는 진짜 원인을 가린다.
   *
   * **둘 다 T53이 다뤘다.** 둘째는 `refund`가 닫았다 — 대조를 통과한 요청이
   * 슬롯을 되돌리므로 준비 미완료 경로는 카운터에 흔적을 남기지 않는다.
   * 첫째는 **한도를 태블릿 수보다 크게 잡아**(`MAX_ATTEMPTS` 참고) 상황 자체를
   * 없앴다. 완전히 사라진 것은 아니다 — 한도보다 많은 요청이 정말 동시에
   * 들어오면 반납이 돌기 전에 INCR이 한도에 닿는다. 게이트가 대조 앞에 있는
   * 한 구조적이고, 한 번 다시 누르면 통과한다.
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

  /**
   * 쓴 슬롯을 하나 되돌린다. **OTP 대조를 통과한 요청만 부른다.**
   *
   * 게이트가 대조 앞에 있어서 정답도 슬롯을 하나 쓴다. 그대로 두면 OTP는
   * 맞았는데 다른 이유로 막히는 경로(닫힌 대회 · 딜러 세션 없음 · 남의
   * 테이블)가 카운터를 채워, 여섯 번째 재시도부터 안내가 "시도가 너무
   * 많습니다"로 바뀐다 — **진짜 원인을 가리는 거짓 안내다.**
   *
   * 반납이 잠금을 무르지 않는 이유는 **조건이 "OTP를 맞혔다"**이기 때문이다.
   * 추측하는 쪽은 대조를 통과하지 못하므로 반납에 닿지 않는다. 카운터가
   * 막으려는 것은 모르는 사람의 반복 추측이지 아는 사람의 재시도가 아니다.
   *
   * 원자적이어야 한다. 읽고-빼면 두 반납이 같은 값을 읽어 하나만 반영되거나
   * 음수로 내려간다. 음수는 그 자체로 위험하다 — 잠금이 열리는 방향이라
   * 다음 추측 다섯 개가 공짜가 된다. 그래서 Lua 한 덩이로 묶고, 1 이하면
   * 빼는 대신 키를 지운다(0으로 남기면 TTL만 있고 뜻이 없는 키가 된다).
   */
  async refund(tournamentId: string): Promise<void> {
    await this.redis.eval(REFUND_SLOT, 1, this.key(tournamentId));
  }

  async clear(tournamentId: string): Promise<void> {
    await this.redis.del(this.key(tournamentId));
  }
}
