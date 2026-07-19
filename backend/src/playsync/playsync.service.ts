import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PlayerStatus, TransactionType } from '@prisma/client';
import { Queue } from 'bullmq';
import { PlayerActionDto } from 'shared/dto/playsync.dto';
import { Dashboard } from 'shared/types/tournamentMeta';
import { TableEngine } from 'src/game-engine/table-engine';
import { ActionType, GamePhase, TablePlayer, TableState } from 'src/game-engine/types';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { retryAsync } from 'src/common/retry';
import { prizeFor } from './prize';

/** 한 턴에 주어지는 시간. 잡의 delay와 state.actionDeadline이 같은 값을 써야 한다. */
const TURN_TIMEOUT_MS = 30000;

/**
 * 리바인 팝업 응답을 기다리는 시간.
 *
 * 호출 시점에 읽는다 — 모듈 로드 시점에 고정하면 통합 테스트가 값을 줄일 수
 * 없어서 실제 15초를 기다려야 한다.
 */
function rebuyTimeoutMs(): number {
  return Number(process.env.REBUY_TIMEOUT_MS ?? 15000);
}

@Injectable()
export class PlaysyncService {
  private readonly logger = new Logger(PlaysyncService.name);

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
      // 제거 실패는 치명적이지 않다 — 세대(timerEpoch)가 다르면 잡이 스스로
      // 폐기되므로 잘못된 타임아웃이 발화하지는 않는다. 다만 큐에 쓰레기가
      // 쌓이는 신호이므로 남긴다.
      this.logger.warn(`타임아웃 잡 제거 실패 (table=${tableId}, epoch=${epoch}): ${e.message}`);
    }
  }

  /**
   * 핸드 종료 시점의 스택을 DB에 남긴다. 이 트랜잭션이 체크포인트다.
   *
   * 예전에는 `await this.prisma.$transaction(updates) ? true : false`였다.
   * `$transaction`은 성공하면 결과 **배열**을 주고 실패하면 던지므로, 이 식은
   * 배열의 truthy 여부를 물은 것이고 항상 `true`였다. 호출자의
   * `if (!isTxSuccess) throw`는 도달할 수 없는 죽은 분기였다 — DB가 실패해도
   * 정산은 성공으로 끝나고 다음 핸드로 넘어갔다.
   */
  public async syncTableInventoryToDb(state: TableState): Promise<boolean> {
    const updates = state.players
      .filter(p => p !== null)
      .map(p => this.prisma.tablePlayer.updateMany({
        where: { userId: p.id, tableId: p.tableId },
        data: { currentStack: p.stack }
      }));
    try {
      await this.prisma.$transaction(updates);
      return true;
    } catch (error) {
      this.logger.error(`[체크포인트] 테이블 스택 동기화 실패`, error);
      return false;
    }
  }

  /**
   * 체크포인트를 찍고, 실패하면 유한 재시도한다.
   *
   * **락을 잡지 않는다.** 백오프까지 포함하면 수 초가 될 수 있는데 테이블 락의
   * TTL은 5초다. 락 안에 두면 TTL이 먼저 만료돼 남이 잡은 락을 해제하게 된다.
   * 대신 페이즈가 문지기다 — 이 구간의 스냅샷은 `HAND_END`이고, `startPreFlop`은
   * `WAITING`만 받으며 `act()`는 베팅 라운드가 아닌 페이즈를 거부한다(T8).
   * 테이블은 진짜로 정지해 있다.
   *
   * 첫 시도가 성공하면 아무 표시도 남기지 않는다. 정상 경로에서 "재시도 중"이
   * 한 번 깜빡이는 것을 피하려는 것이다.
   */
  public async checkpointTableToDb(tableId: string): Promise<boolean> {
    const attempts = Number(process.env.DB_SYNC_RETRY_ATTEMPTS ?? 4);
    const baseMs = Number(process.env.DB_SYNC_RETRY_BASE_MS ?? 200);

    const result = await retryAsync(
      async () => {
        const state = await this.redis.getSnapShot(tableId);
        if (!state) throw new Error('테이블을 찾을 수 없습니다.');
        const ok = await this.syncTableInventoryToDb(state);
        if (!ok) throw new Error('DB 동기화 실패');
        return true;
      },
      {
        attempts,
        baseMs,
        maxMs: 3000,
        // 첫 실패를 확인한 뒤에만 표시가 나간다.
        onRetry: async (attempt, delayMs) => {
          this.logger.warn(
            `[체크포인트] 테이블 ${tableId} 재시도 ${attempt}/${attempts - 1}, ${Math.round(delayMs)}ms 후`,
          );
          await this.markDbSyncStatus(tableId, 'RETRYING');
        },
      },
    );

    if (!result.ok) {
      await this.markDbSyncStatus(tableId, 'FAILED');
      return false;
    }
    return true;
  }

  /** 스냅샷의 체크포인트 상태만 바꾸고 테이블 전원에게 쏜다. */
  public async markDbSyncStatus(tableId: string, status: 'RETRYING' | 'FAILED' | null) {
    const state = await this.redis.withTableLock(tableId, async () => {
      const snapshot = await this.redis.getSnapShot(tableId);
      if (!snapshot) return null;
      if (status === null) {
        delete snapshot.dbSyncStatus;
      } else {
        snapshot.dbSyncStatus = status;
      }
      await this.redis.saveSnapShot(tableId, snapshot);
      return snapshot;
    });
    if (state) {
      this.eventEmitter.emit('game.state.updated', { tableId, state });
    }
  }


  // 탈락
  public async eliminatePlayer(tournamentId: string, tableId: string, players: TablePlayer[], tournamentInfo: Dashboard) {
    if (players.length === 0) return;
    const playerIds = players.map(p => p.id);
    const result = await this.prisma.$transaction(async (tx) => {
      const eliminatedRank = tournamentInfo.activePlayer;

      // 풀과 분배율은 DB에서 읽는다. Redis 대시보드에도 totalBuyinAmount가
      // 있지만 그건 화면용 파생값이고, **돈의 진실은 DB다.** 리바인으로
      // 풀이 커지는 것도 여기에 반영돼 있다.
      const { totalBuyinAmount, prizePayouts } = await tx.tournament.findUniqueOrThrow({
        where: { id: tournamentId },
        select: { totalBuyinAmount: true, prizePayouts: true },
      });
      const prize = prizeFor(totalBuyinAmount, prizePayouts, eliminatedRank);
      const isInTheMoney = prize > 0;

      // 이미 탈락한 사람은 제외하고 센다. 카운터를 `playerIds.length`가 아니라
      // **실제로 상태가 바뀐 행 수**로 줄이는 것이 멱등성의 전부다.
      //
      // 같은 탈락이 두 번 도착하는 것은 예외가 아니라 정상 경로다 — 재시도를
      // 붙이는 순간 중복은 보장된다(at-least-once). 지금까지 안 터진 이유는
      // 재시도가 없었기 때문이지 중복이 불가능해서가 아니다.
      const changed = await tx.tournamentParticipation.updateMany({
        where: {
          tournamentId,
          userId: { in: playerIds },
          status: { notIn: ['ELIMINATED', 'AWARDED'] },
        },
        data: {
          finalPlace: eliminatedRank,
          status: (isInTheMoney ? 'AWARDED' : 'ELIMINATED'),
          prizeAmount: prize,
        }
      });
      // 삭제는 원래 멱등이라 조건을 더할 필요가 없다.
      await tx.tablePlayer.deleteMany({
        where: {
          tableId,
          userId: { in: playerIds }
        }
      });
      if (changed.count > 0) {
        await tx.tournament.update({
          where: { id: tournamentId },
          data: { activePlayers: { decrement: changed.count } }
        });
      }
      return { eliCount: changed.count }
    });

    // 중복 도착이면 여기서 끝난다. Redis 카운터도 건드리지 않는다.
    if (result.eliCount === 0) return;

    const activePlayerCount = await this.redis.eliminatedPlayer(tournamentId, tournamentInfo.startStack, tournamentInfo.entryFee, result.eliCount);

    // 화살표 본문이 블록인데 `return`이 없어 `map`이 `undefined[]`를 만들었다.
    // `Promise.all([undefined, undefined])`는 즉시 resolve되므로, `await`가
    // 붙어 있어도 실제로는 fire-and-forget이었다 — 정리가 실패해도 성공으로
    // 끝나고 rejection은 아무도 안 받는다. 좌석 비트가 켜진 채, userContext가
    // 남은 채 조용히 넘어간다.
    //
    // 여기는 DB 커밋 **이후**라 체크포인트를 위협하지 않는다. DB가 진실이고
    // 이 둘은 파생 표시다. 그래서 차단이 아니라 실패를 올려 보이게만 한다.
    await Promise.all(
      players.flatMap(player => [
        this.redis.updateSeatBitmap(tournamentId, tableId, player.seatIndex, false),
        this.redis.deleteUserContext(tournamentId, player.id),
      ])
    );

    if (activePlayerCount <= 1) {
      await this.tournamentFinished(tournamentId)
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
      const { totalBuyinAmount, prizePayouts } = await tx.tournament.findUniqueOrThrow({
        where: { id: tournamentId },
        select: { totalBuyinAmount: true, prizePayouts: true },
      });

      await tx.tournamentParticipation.update({
        where: {
          tournamentId_userId:
            { tournamentId: tournamentId, userId: user.userId }
        },
        data: {
          finalPlace: 1,
          status: 'AWARDED',
          prizeAmount: prizeFor(totalBuyinAmount, prizePayouts, 1),
        },
      });
    });
  }

  /**
   * 탈락 위기 플레이어에게 리바인을 묻고, 수락하면 반영까지 한다.
   *
   * **테이블 락을 쥐지 않은 채로 불러야 한다.** 응답 대기는 사람을 기다리는
   * I/O고, 그 구간을 락 안에 두면 최대 15초 동안 테이블 전체가 멎는다.
   * 락은 응답이 온 뒤 스택을 반영하는 순간에만 짧게 잡는다.
   *
   * @returns 반영된 리바인 금액. 거절·시간초과·실패는 모두 0.
   */
  public async processRebuy(
    tournamentId: string,
    tableId: string,
    userId: string,
    entryFee: number,
    startStack: number,
    tournamentName: string,
  ): Promise<number> {
    const userPoints = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { points: true }
    });
    if (!userPoints) throw new Error('플레이어 정보 오류');
    if (userPoints.points < entryFee) {
      return 0;
    }

    const accepted = await this.waitForRebuyResponse(
      userId, tableId, userPoints, entryFee, tournamentName,
    );
    if (!accepted) return 0;

    let resultStack: number;
    try {
      resultStack = await this.executeRebuyTransaction(
        tournamentId, tableId, userId, entryFee, startStack, tournamentName,
      );
    } catch (error) {
      // 참가자는 리바인 팝업에서 수락했는데 돈이 빠지지 않았다. 스택도 안 늘어
      // 정합성은 맞지만, 왜 안 됐는지는 여기 말고 남는 곳이 없다.
      this.logger.error(`리바인 트랜잭션 실패 (table=${tableId}, user=${userId}): ${error.message}`);
      return 0;
    }
    if (resultStack <= 0) return 0;

    // 반영이 먼저, 전파가 나중이다. 예전에는 트랜잭션 직후 전파하고 스택 반영은
    // 엔진이 콜백 반환 뒤에 했다 — 나가는 상태의 스택이 아직 0이었다.
    await this.redis.withTableLock(tableId, async () => {
      const state = await this.redis.getSnapShot(tableId);
      if (!state) return;
      new TableEngine(state).applyRebuy(userId, resultStack);
      await this.redis.saveSnapShot(tableId, state);
      this.eventEmitter.emit('game.state.updated', { tableId, state });
    });

    return resultStack;
  }

  /**
   * 리바인 팝업을 띄우고 응답 하나를 기다린다. 시간이 지나면 거절로 본다.
   *
   * executor에 `async`를 붙이지 않는다. 붙이면 안에서 던진 예외가 아무도 받지
   * 않는 rejected promise로 사라지고, 이 Promise는 영영 pending으로 남는다.
   * 예전 코드는 리스너·타이머 등록보다 `emit`이 먼저라 그 위험이 실재했다 —
   * 게이트웨이 리스너가 던지면 팝업도 못 띄운 채 정산이 통째로 멈춘다.
   */
  private waitForRebuyResponse(
    userId: string,
    tableId: string,
    userPoints: { points: number },
    entryFee: number,
    tournamentName: string,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const eventName = `rebuy_res_${userId}`;
      const timeoutMs = rebuyTimeoutMs();
      let settled = false;

      const settle = (accept: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // 핵심. `once`는 "실행되면 제거"라, 시간 초과로 끝난 경우 리스너가
        // 그대로 남는다. 리바인이 일어날 때마다 하나씩 영구 누적됐다.
        this.eventEmitter.removeListener(eventName, handler);
        resolve(accept);
      };

      const handler = (accept: boolean) => settle(accept);

      const timer = setTimeout(() => {
        this.logger.log(`리바인 응답 시간초과 (user=${userId})`);
        settle(false);
      }, timeoutMs);

      // 리스너를 먼저 등록한 뒤 팝업을 띄운다. 순서가 반대면 응답이 아주 빨리
      // 돌아온 경우 받을 사람이 없다.
      this.eventEmitter.once(eventName, handler);

      try {
        this.eventEmitter.emit('rebuy.request.sent', {
          userId,
          tableId,
          deadline: Date.now() + timeoutMs,
          userPoints,
          entryFee,
          tournamentName,
        });
      } catch (error) {
        this.logger.warn(`리바인 팝업 전송 실패 (user=${userId}): ${error.message}`);
        settle(false);
      }
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
