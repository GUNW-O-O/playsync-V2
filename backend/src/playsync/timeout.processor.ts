import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DelayedError, Job } from 'bullmq';
import { PlaysyncService } from './playsync.service';
import { ActionType } from 'src/game-engine/types';
import { RedisService } from 'src/redis/redis.service';
import { RecoveryService } from 'src/recovery/recovery.service';

/**
 * 딜러가 답하지 않을 때 다시 묻기까지(T130). 딜러가 돌아오면 이 안에 접힌다.
 */
export const TIMEOUT_HOLD_MS = 2_000;

/**
 * **부팅 복구가 끝나야 돈다**(T122, `autorun: false`). 잡은 Redis에 살아남으므로 서버가
 * 죽어 있던 동안 마감이 지난 잡이 부팅하자마자 집힌다. 워커는 `onModuleInit`에서 서는데
 * 부팅 복구는 그 뒤에 테이블을 하나씩 멈춰 세워, 아직 안 멈춘 테이블의 사람이 접혔다 —
 * 667테이블 kill에서 118건. 복구가 끝난 뒤에 집으면 그 잡은 세대가 낡아 스스로 버려진다.
 */
@Processor('player-timeout', { autorun: false })
export class TimeoutProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(private readonly playsyncService: PlaysyncService,
    private readonly redis: RedisService,
    private readonly recovery: RecoveryService,
  ) {
    super();
  }

  async onApplicationBootstrap() {
    await this.recovery.bootOnce();
    // `run()`은 워커가 닫힐 때까지 안 돌아온다. 기다리면 부팅이 선다.
    this.worker.run().catch((e) => new Logger(TimeoutProcessor.name).error('타임아웃 워커가 멎었다', e));
  }

  async process(job: Job<{ tableId: string; userId: string; timerEpoch?: number }>, token?: string) {
    const { tableId, userId, timerEpoch } = job.data;

    // 여기서도 한 번 걸러 두면 불필요한 락 획득을 줄일 수 있다. 다만 이 검사는
    // 락 밖이라 신뢰할 수 없다 — 진짜 판정은 handleAction이 락을 잡은 뒤에 한다.
    const state = await this.redis.getSnapShot(tableId);
    if (!state) return;
    if (state.players[state.currentTurnSeatIndex]?.id !== userId) return;
    // 세대가 낡은 잡은 딜러에게 묻지 않는다(T130) — 미뤄 둔 사이 차례가 넘어갔으면
    // 이 잡은 끝났다. 안 거르면 딜러가 안 돌아오는 동안 영영 미뤄지며 돈다.
    if (timerEpoch !== undefined && timerEpoch !== (state.timerEpoch ?? 0)) return;

    // **접기 직전에 그 테이블의 딜러에게 묻는다**(T130). 답이 없으면 회선이 끊겼는지
    // 딜러 태블릿만 꺼졌는지 아직 모른다 — 모르는 동안에는 접지 않는다. 같은 id로
    // 미뤄 두므로 플레이어가 누르면 `removeTimeoutJob`이 그대로 지운다.
    if (!(await this.redis.dealerLiveness.confirm(tableId))) {
      await job.moveToDelayed(Date.now() + TIMEOUT_HOLD_MS, token);
      throw new DelayedError();
    }

    await this.playsyncService.handleAction(
      userId,
      tableId,
      { action: ActionType.TIME_OUT },
      timerEpoch,
    );
  }
}