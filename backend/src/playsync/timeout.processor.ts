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

  async process(job: Job<{ tableId: string; userId: string }>) {
    const {tableId, userId } = job.data;

    // 타임아웃 시점에 해당 유저가 여전히 그 테이블의 그 턴인지 다시 확인
    const state = await this.redis.getSnapShot(tableId);
    if (!state) return;

    const currentPlayer = state.players[state.currentTurnSeatIndex];

    // 만약 이미 액션을 해서 턴이 넘어갔거나 유저가 바뀌었다면 무시
    if (currentPlayer?.id !== userId) return;

    // 자동 TIME_OUT 액션 실행
    await this.playsyncService.handleAction(
      userId,
      tableId,
      {
        action: ActionType.TIME_OUT,
      }
    );

  }
}