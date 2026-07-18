import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PlaysyncService } from './playsync.service';
import { ActionType } from 'src/game-engine/types';
import { RedisService } from 'src/redis/redis.service';

@Processor('player-timeout')
export class TimeoutProcessor extends WorkerHost {
  constructor(private readonly playsyncService: PlaysyncService,
    private readonly redis: RedisService,
  ) {
    super();
  }

  async process(job: Job<{ tableId: string; userId: string; timerEpoch?: number }>) {
    const { tableId, userId, timerEpoch } = job.data;

    // 여기서도 한 번 걸러 두면 불필요한 락 획득을 줄일 수 있다. 다만 이 검사는
    // 락 밖이라 신뢰할 수 없다 — 진짜 판정은 handleAction이 락을 잡은 뒤에 한다.
    const state = await this.redis.getSnapShot(tableId);
    if (!state) return;
    if (state.players[state.currentTurnSeatIndex]?.id !== userId) return;

    await this.playsyncService.handleAction(
      userId,
      tableId,
      { action: ActionType.TIME_OUT },
      timerEpoch,
    );
  }
}