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
 * 대가는 정상 딜러가 남의 오타로 5분 막힐 수 있다는 것이다. 대회당 한 번
 * 입력하는 값이라 그 5분이 반복되지 않고, 상점 콘솔의 재발급이 탈출구다.
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

  async assertNotLocked(tournamentId: string): Promise<void> {
    const raw = await this.redis.get(this.key(tournamentId));
    if (raw !== null && Number(raw) >= MAX_ATTEMPTS) {
      throw new ForbiddenException(
        '인증 시도가 너무 많습니다. 잠시 후 다시 시도하거나 상점에 문의해주세요.',
      );
    }
  }

  async recordFailure(tournamentId: string): Promise<number> {
    const key = this.key(tournamentId);
    // INCR과 EXPIRE를 한 왕복으로 묶는다. 사이에 끼어들면 TTL 없는 키가 남아
    // 영영 잠긴다.
    const [count] = await this.redis
      .multi()
      .incr(key)
      .expire(key, LOCK_SECONDS)
      .exec() as [[Error | null, number], ...unknown[]];
    return count[1];
  }

  async clear(tournamentId: string): Promise<void> {
    await this.redis.del(this.key(tournamentId));
  }
}
