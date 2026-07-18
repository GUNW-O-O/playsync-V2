import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PlayerStatus, TransactionType } from '@prisma/client';
import { Queue } from 'bullmq';
import { PlayerActionDto } from 'shared/dto/playsync.dto';
import { Dashboard } from 'shared/types/tournamentMeta';
import { TableEngine } from 'src/game-engine/table-engine';
import { ActionType, GamePhase, TablePlayer, TableState } from 'src/game-engine/types';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';

/** 한 턴에 주어지는 시간. 잡의 delay와 state.actionDeadline이 같은 값을 써야 한다. */
const TURN_TIMEOUT_MS = 30000;

@Injectable()
export class PlaysyncService {
  constructor(
    @InjectQueue('player-timeout') private timeoutQueue: Queue,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) { }

  async joinTable(tableId: string, userId?: string) {
    const tableState = await this.redis.getSnapShot(tableId);
    if (!tableState) throw new Error(`TableState ${tableId} not found`);
    if (userId !== null && userId !== undefined) {
      const seatIndex = tableState.players.findIndex(p => p?.id === userId);
      console.log(seatIndex)
      return { tableState, seatIndex };
    } else {
      return { tableState, seatIndex: -1 }
    }
  }

  async findMyTables(userId: string) {
    const players = await this.prisma.tablePlayer.findMany({
      where: { userId: userId },
      include: {
        tournament: {
          select: {
            name: true,
          }
        },
        table: {
          select: {
            tableOrder: true,
          }
        }
      }
    });
    if (!players) return null;
    return players;
  }
  async findDealerTable(tableId: string) {
    const table = await this.prisma.table.findMany({
      where: { id: tableId }
    });
    if (!table) return null;
    return table;
  }

  /**
   * @param expectedTimerEpoch 타임아웃 프로세서가 넘기는 타이머 세대.
   *   자기가 예약된 세대가 아니면 낡은 잡이므로 아무것도 하지 않는다.
   *   플레이어의 WS 액션에는 없다.
   */
  async handleAction(
    userId: string,
    tableId: string,
    dto: PlayerActionDto,
    expectedTimerEpoch?: number,
  ) {
    return this.redis.withTableLock(tableId, async () => {
      const state = await this.redis.getSnapShot(tableId);
      if (!state) throw new Error(`Table ${tableId} not found`);

      const playerIdx = state.players.findIndex(p => p?.id === userId);
      if (playerIdx === -1) throw new Error('테이블에 없는 유저입니다.');

      // 낡은 TIME_OUT은 큐도 상태도 건드리지 않고 돌아간다.
      //
      // 이 검사는 반드시 타임아웃 잡 제거보다 앞에 있어야 한다. 낡은 TIME_OUT이
      // 도착한 시점에 큐에 있는 잡은 이미 "다음 플레이어"의 타이머다. 먼저 지우면
      // 그 유저의 타이머가 사라지거나(제거만 하고 조기 반환) 30초가 처음부터 다시
      // 시작된다(지우고 다시 등록). 앞은 라운드 데드락이고 뒤는 제한시간 연장이다.
      if (dto.action === ActionType.TIME_OUT) {
        const isStaleTurn = state.currentTurnSeatIndex !== playerIdx;
        // 세대까지 봐야 하는 이유: 스트리트가 넘어가면 턴은 같은 유저에게
        // 다시 돌아온다. 좌석만 보면 방금 30초를 받은 유저를 낡은 잡이
        // 즉시 시간 초과시킨다.
        const isStaleEpoch =
          expectedTimerEpoch !== undefined &&
          expectedTimerEpoch !== (state.timerEpoch ?? 0);

        if (isStaleTurn || isStaleEpoch) return state;
      }

      // 판정 기준은 요청 도착 순서가 아니라 마감 시각이다.
      // 태블릿에서 30초를 넘겨 누른 버튼은, 타임아웃 잡보다 먼저 도착하더라도
      // 시간 초과다. actionDeadline은 그동안 프론트가 카운트다운을 그리는 데만
      // 쓰였고 서버는 아무도 읽지 않았다.
      const isExpired =
        state.actionDeadline !== undefined && Date.now() > state.actionDeadline;

      const userState = await this.redis.getUserContext(state.tournamentId, userId);
      const isKicked = userState?.status === 'KICKED';

      // 엔진 호출은 한 번뿐이다. 폴드와 원래 액션을 연달아 호출하면 두 번째가
      // 턴이 넘어간 덕에 흡수될 뿐, 흡수를 보장하는 것은 아무것도 없다.
      const effectiveAction = isKicked
        ? ActionType.FOLD
        : isExpired
          ? ActionType.TIME_OUT
          : dto.action;
      const effectiveAmount =
        effectiveAction === dto.action ? dto.amount : undefined;

      const engine = new TableEngine(state);
      await engine.act(playerIdx, effectiveAction, effectiveAmount);

      // 타이머 교체는 반드시 검증을 모두 통과한 뒤에 한다. 조기 반환 경로는
      // 이 함수를 부르지 않으므로 큐를 건드리지 않는다.
      await this.scheduleTurnTimeout(tableId, state);

      await this.redis.saveSnapShot(tableId, state);

      // 호출자가 타임아웃 프로세서인 경우에만 emit한다. WS 경로는 게이트웨이가
      // 반환값을 받아 직접 브로드캐스트하므로(ws.gateway.ts) 여기서 또 쏘면
      // 같은 상태가 두 번 나간다. 프로세서에는 응답할 소켓이 없어서 emit이 필요하다.
      if (dto.action === ActionType.TIME_OUT) {
        this.eventEmitter.emit('game.state.updated', { tableId, state: state })
      }
      return state;
    });
  }

  /**
   * 현재 턴 유저의 타임아웃을 예약하고, 직전 세대의 잡을 폐기한다.
   * 반드시 테이블 락 안에서, 모든 검증을 통과한 뒤에 부를 것 — state를 수정한다.
   *
   * 잡 id에 세대를 넣는 이유: 예전에는 `jobId`가 tableId로 고정이라, 제거에
   * 실패한 상태에서 add를 하면 BullMQ가 같은 id의 잡이 이미 있다고 보고 조용히
   * 무시했다. 그 잡이 끝나며 removeOnComplete로 사라지면 아무도 타이머가 없는
   * 테이블이 남는다. 세대를 붙이면 add가 충돌하지 않고, 낡은 잡은 제거 성공
   * 여부와 무관하게 세대 불일치로 스스로 폐기된다.
   */
  public async scheduleTurnTimeout(tableId: string, state: TableState) {
    const prevEpoch = state.timerEpoch ?? 0;
    await this.removeTimeoutJob(tableId, prevEpoch);
    // 새 타이머를 걸지 않는 경우에도 세대는 올린다. 그래야 제거에 실패한
    // 낡은 잡이 나중에 깨어나도 스스로 폐기된다.
    state.timerEpoch = prevEpoch + 1;

    const nextPlayer =
      state.phase === GamePhase.SHOWDOWN || state.currentTurnSeatIndex === -1
        ? null
        : state.players[state.currentTurnSeatIndex];

    if (!nextPlayer) {
      state.actionDeadline = undefined;
      return;
    }

    await this.timeoutQueue.add(
      'player-timeout',
      { tableId, userId: nextPlayer.id, timerEpoch: state.timerEpoch },
      {
        delay: TURN_TIMEOUT_MS,
        jobId: `${tableId}-${state.timerEpoch}`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    state.actionDeadline = Date.now() + TURN_TIMEOUT_MS;
  }

  /** 최선 노력. 이미 실행 중인 잡은 지울 수 없고, 그 경우는 세대 검사가 막는다. */
  private async removeTimeoutJob(tableId: string, epoch: number) {
    try {
      const oldJob = await this.timeoutQueue.getJob(`${tableId}-${epoch}`);
      if (oldJob) await oldJob.remove();
    } catch (e) {
      console.log('타임아웃 제거 실패');
    }
  }

  public async syncTableInventoryToDb(state: TableState) {
    const updates = state.players
      .filter(p => p !== null)
      .map(p => this.prisma.tablePlayer.updateMany({
        where: { userId: p.id, tableId: p.tableId },
        data: { currentStack: p.stack }
      }));
    const success = await this.prisma.$transaction(updates) ? true : false;
    return success;
  }


  // 탈락
  public async eliminatePlayer(tournamentId: string, tableId: string, players: TablePlayer[], tournamentInfo: Dashboard) {
    if (players.length === 0) return;
    const playerIds = players.map(p => p.id);
    const result = await this.prisma.$transaction(async (tx) => {
      const isInTheMoney = tournamentInfo.itmCount >= tournamentInfo.activePlayer;
      const eliminatedRank = tournamentInfo.activePlayer;
      await tx.tournamentParticipation.updateMany({
        where: {
          tournamentId,
          userId: { in: playerIds }
        },
        data: {
          finalPlace: eliminatedRank,
          status: (isInTheMoney ? 'AWARDED' : 'ELIMINATED'),
          prizeAmount: (isInTheMoney ? 1000 : 0),
        }
      });
      await tx.tablePlayer.deleteMany({
        where: {
          tableId,
          userId: { in: playerIds }
        }
      });
      await tx.tournament.update({
        where: { id: tournamentId },
        data: { activePlayers: { decrement: playerIds.length } }
      });
      return { success: true, eliCount: playerIds.length }
    });
    if (result.success) {
      const activePlayerCount = await this.redis.eliminatedPlayer(tournamentId, tournamentInfo.startStack, tournamentInfo.entryFee, result.eliCount);
      await Promise.all(
        players.map(player => {
          this.redis.updateSeatBitmap(tournamentId, tableId, player.seatIndex, false);
          this.redis.deleteUserContext(tournamentId, player.id);
        }
        )
      );
      if (activePlayerCount <= 1) {
        await this.tournamentFinished(tournamentId)
      }
    }
  }

  // 최후 1인
  async tournamentFinished(tournamentId: string) {
    const user = await this.prisma.tournamentParticipation.findFirst({
      where: {
        tournamentId: tournamentId,
        status: PlayerStatus.PLAYING,
      }
    });
    if (!user) throw new Error('유저 없음.');
    await this.prisma.$transaction(async (tx) => {
      await tx.tournamentParticipation.update({
        where: {
          tournamentId_userId:
            { tournamentId: tournamentId, userId: user.userId }
        },
        data: {
          finalPlace: 1,
          status: 'AWARDED',
          prizeAmount: 3000,
        },
      });
    });
  }

  public async processRebuy(tournamentId: string, tableId: string, userId: string, entryFee: number, startStack: number, tournamentName: string, sharedState: TableState): Promise<number> {
    const userPoints = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { points: true }
    });
    if (!userPoints) throw new Error('플레이어 정보 오류');
    if (userPoints.points < entryFee) {
      return 0;
    }
    return new Promise(async (resolve) => {
      let isResolved = false;
      const timeoutMs = 15000;
      // [웹소켓] 유저에게 리바인 확인 팝업 요청 전송
      this.eventEmitter.emit('rebuy.request.sent', {
        userId,
        tableId,
        deadline: Date.now() + timeoutMs,
        userPoints,
        entryFee,
        tournamentName,
      });

      // [타이머] 15초 내 응답 없으면 자동 취소 (0 반환)
      const timer = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          console.log(`[TIMEOUT] 유저 ${userId} 리바인 시간초과`);
          resolve(0);
        }
      }, 15000);

      // [이벤트] WsGateway에서 전달해주는 유저의 버튼 클릭 응답 대기
      this.eventEmitter.once(`rebuy_res_${userId}`, async (accept: boolean) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timer);

          if (accept) {
            try {
              const resultStack = await this.executeRebuyTransaction(tournamentId, tableId, userId, entryFee, startStack, tournamentName);
              if (resultStack > 0) {
                this.eventEmitter.emit('game.state.updated', { tableId, state: sharedState });
              }
              resolve(resultStack);
            } catch (error) {
              console.error('리바인 트랜잭션 실패:', error.message);
              resolve(0);
            }
          } else {
            resolve(0);
          }
        }
      });
    });
  }

  // 리바인 트랜잭션
  public async executeRebuyTransaction(tournamentId: string, tableId: string, userId: string, entryFee: number, startStack: number, tournamentName: string): Promise<number> {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: {
          id: userId,
          points: { gte: entryFee }
        },
        data: { points: { decrement: entryFee } }
      }).catch(() => { throw new Error('포인트 부족 혹은 유저 없음'); });

      await tx.pointTransaction.create({
        data: {
          userId,
          amount: entryFee * -1,
          type: TransactionType.REBUY,
          tournamentId,
          description: `${tournamentName} 리바인 -${entryFee}`
        }
      });

      await tx.tournament.update({
        where: { id: tournamentId },
        data: { totalBuyinAmount: { increment: entryFee } },
      })

      await tx.tournamentParticipation.update({
        where: { tournamentId_userId: { tournamentId, userId } },
        data: { buyInCount: { increment: 1 } },
      });

      await tx.tablePlayer.update({
        where: { tableId_userId: { tableId: tableId, userId } }, // tableId 관리 필요
        data: { currentStack: { increment: startStack } }
      });

      return { success: true, startStack };
    });
    if (result.success) {
      await this.redis.rebuyPlayer(tournamentId, entryFee, startStack);
    }
    return result.success ? startStack : 0;
  }

  async getDashboardInfo(tournamentId: string) {
    const info = await this.redis.getFullTournamentInfo(tournamentId);
    return info ? info : null;
  }

}
