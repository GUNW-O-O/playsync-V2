import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from 'src/prisma/prisma.service';

const HEARTBEAT_ID = 'singleton';
const DEFAULT_INTERVAL_MS = 30_000;

/**
 * 서버가 살아 있다는 사실을 DB에 남긴다. 복구가 다운타임을 계산하는 유일한
 * 근거다.
 *
 * **Redis ping이 성공할 때만 찍는다.** 시각만 찍으면 "서버는 살아 있고 Redis만
 * 죽은" 구간을 못 잡는다 — 그 구간에는 모든 게임 경로가 스냅샷을 못 읽어
 * 던지므로 대회는 실제로 멈춰 있는데, 하트비트가 계속 찍히면 정지 시간이 0이
 * 된다. 조건 하나가 케이스 하나를 닫는다.
 *
 * BullMQ 반복 잡을 쓰지 않는 이유: 잡이 Redis에 살고 at-least-once라 중복
 * 배달이 하트비트에는 노이즈다. `@nestjs/schedule`을 넣지 않는 이유: 의존성
 * 하나를 위해 얻는 것이 `setInterval` 대비 없다. `prisma.service.ts:53`이 이미
 * 같은 라이프사이클 패턴을 쓴다.
 */
@Injectable()
export class HeartbeatService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(HeartbeatService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  onApplicationBootstrap() {
    const ms = Number(process.env.HEARTBEAT_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
    this.timer = setInterval(() => {
      void this.beatOnce().catch(e =>
        // 실패를 삼키지 않는다. 다음 주기가 재시도이므로 프로세스는 유지한다.
        this.logger.warn(`하트비트 실패: ${(e as Error).message}`),
      );
    }, ms);
    // 하트비트가 이벤트 루프를 붙잡아 프로세스 종료를 막지 않게 한다.
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** 찍었으면 true. Redis ping이 실패하면 찍지 않고 false. */
  async beatOnce(): Promise<boolean> {
    try {
      await this.redis.ping();
    } catch (e) {
      this.logger.warn(`Redis ping 실패 — 하트비트를 찍지 않는다: ${(e as Error).message}`);
      return false;
    }

    const now = new Date();
    await this.prisma.serverHeartbeat.upsert({
      where: { id: HEARTBEAT_ID },
      create: { id: HEARTBEAT_ID, beatAt: now },
      update: { beatAt: now },
    });
    return true;
  }
}
