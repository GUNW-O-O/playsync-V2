import { InjectQueue } from '@nestjs/bullmq';
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PlayerStatus, Prisma, Role, TransactionType } from '@prisma/client';
import { Queue } from 'bullmq';
import { PlayerActionDto } from 'shared/dto/playsync.dto';
import { Dashboard } from 'shared/types/tournamentMeta';
import { TableEngine } from 'src/game-engine/table-engine';
import { ActionType, GamePhase, TablePlayer, TableState } from 'src/game-engine/types';
import { PrismaService } from 'src/prisma/prisma.service';
import { LIVE_PLAYER_STATUSES } from 'src/store/session/player-status';
import {
  NOT_CLOSED_TOURNAMENT_FILTER,
  asClosedTournamentWrite,
} from 'src/store/session/tournament-status';
import { RedisService } from 'src/redis/redis.service';
import { retryAsync } from 'src/common/retry';
import { awardPrize, prizeFor, splitBustedRanks } from './prize';
import { SEAT_ROLE } from 'src/auth/seat-role';

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

  /**
   * 이 호출자가 이 테이블을 볼 자격이 있는지 확인한다.
   *
   * REST(`joinTable`)와 WS(`ws.gateway.ts`의 `handleConnection`)가 **같은
   * 판정 함수**를 부른다. 한 자원에 문이 둘이었는데(REST `GET /playsync/:id`,
   * WS 접속) WS 쪽만 이 규칙을 걸고 있었다 — `JwtAuthGuard`만 걸린
   * `joinTable`은 인증만 되면 소유권·좌석·대회 소속을 아무것도 대조하지
   * 않고 전체 스냅샷을 그대로 돌려줬다(T66). 게이트웨이의
   * `assertTournamentAccess` 주석이 이미 같은 논법을 남겼다 — 한쪽만
   * 뚫려 있던 비대칭 자체가 빠뜨렸다는 증거다.
   *
   * 판정을 두 벌로 두지 않는다. 두 벌이면 한쪽만 고쳐지는 날이 온다
   * (`SessionService.assertBlindBelongsToStore`와 같은 이유, T64).
   *
   * 어느 쪽도 클라이언트가 보낸 값을 근거로 삼지 않는다. 딜러는 로그인 시
   * 서명된 토큰의 tableId를, 플레이어는 서버가 들고 있는 스냅샷의 좌석을
   * 본다.
   */
  async assertTableAccess(
    // `role`이 `Role`만이 아닌 이유는 `WsIdentity`와 같다(T71) — 좌석 토큰은
    // enum 밖의 `SEAT_ROLE`을 싣는다. 딜러가 아닌 값은 전부 아래 좌석 대조로
    // 내려가므로 판정은 그대로다.
    identity: { sub: string; role: Role | typeof SEAT_ROLE; tableId?: string },
    tableId: string,
  ): Promise<void> {
    if (identity.role === Role.DEALER) {
      // 토큰의 tableId는 loginDealer가 서명해 넣은 값이고, 요청의 tableId는
      // 클라이언트가 고른 값이다. 대조하지 않으면 A테이블 딜러가 B테이블의
      // 스냅샷을 그대로 받는다.
      if (identity.tableId !== tableId) {
        throw new ForbiddenException('토큰에 없는 테이블입니다.');
      }
      return;
    }

    const state = await this.redis.getSnapShot(tableId);
    if (!state) throw new NotFoundException('테이블을 찾을 수 없습니다.');

    const isSeated = state.players.some((p) => p?.id === identity.sub);
    if (!isSeated) throw new ForbiddenException('이 테이블의 좌석이 없습니다.');
  }

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
    // 쓰지 않고 나가는 경로가 둘이다(낡은 TIME_OUT, 턴이 아닌 사람의 액션).
    // 그 경로를 전파에서 가르려면 "실제로 고쳤는가"가 필요하다 —
    // `mutateSnapshot`의 반환값만으로는 갈리지 않는다(쓰지 않고 나가도 읽은
    // 상태가 돌아온다).
    let acted = false;

    const state = await this.redis.mutateSnapshot(tableId, async (state) => {
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

        // 상태를 건드리지 않고 나간다. `null`이 곧 "저장하지 마"이고,
        // `mutateSnapshot`은 그 경우 **읽은 상태**를 호출자에게 돌려준다 —
        // 게이트웨이가 브로드캐스트할 것이 그것이다.
        if (isStaleTurn || isStaleEpoch) return null;
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
      const applied = await engine.act(playerIdx, effectiveAction, effectiveAmount);

      // 엔진이 no-op이었으면(턴이 아닌 사람의 액션) 낡은 TIME_OUT과 **같은
      // 길**로 나간다. `null` 하나로 넷이 한 번에 멎는다 — 스냅샷 쓰기,
      // 타임아웃 잡 삭제·재등록, `renderGame` 브로드캐스트, `acted` emit.
      //
      // 예전에는 여기가 조건 없이 통과해서, 옆자리가 30초마다 아무 액션이나
      // 던지면 현재 턴 플레이어의 제한시간이 무한히 늘어났고 마감을 넘긴
      // 턴도 되살아났다(T65).
      //
      // 에러를 돌려주지는 않는다. 지금도 조용히 무시하는 동작이고, 에러로
      // 바꾸면 그것이 엔진 밖의 두 번째 턴 검사가 된다.
      if (!applied) return null;

      // 타이머 교체는 반드시 검증을 모두 통과한 뒤에 한다. 조기 반환 경로는
      // 이 함수를 부르지 않으므로 큐를 건드리지 않는다.
      await this.scheduleTurnTimeout(tableId, state);

      acted = true;
      return state;
    });

    // **전파는 쓰기 뒤다.** `mutateSnapshot`은 fn이 돌아온 **뒤에** 저장하므로,
    // emit을 fn 안에 두면 아직 Redis에 없는 상태가 먼저 나간다. 락은 아직
    // 쥔 채라 다른 쓰기가 끼어들지는 못하지만, 락을 안 잡는 조회(게이트웨이의
    // renderGame)가 그 틈에 낡은 값을 읽는다.
    //
    // 호출자가 타임아웃 프로세서인 경우에만 emit한다. WS 경로는 게이트웨이가
    // 반환값을 받아 직접 브로드캐스트하므로(ws.gateway.ts) 여기서 또 쏘면
    // 같은 상태가 두 번 나간다. 프로세서에는 응답할 소켓이 없어서 emit이 필요하다.
    // `acted`가 필요한 이유는 낡은 TIME_OUT이 쓰지 않고 나가기 때문이다 —
    // 그 경로는 예전에도 emit하지 않았다.
    if (dto.action === ActionType.TIME_OUT && acted) {
      this.eventEmitter.emit('game.state.updated', { tableId, state });
    }

    // 아무것도 바뀌지 않았으면 `null`이다. 호출자가 전파를 걸러야 하기
    // 때문이다 — 상태 객체만 돌려주면 "바뀐 것이 없다"를 표현할 자리가 없고,
    // 게이트웨이는 매번 같은 스냅샷을 테이블 전원에게 다시 배달하게 된다.
    //
    // `mutateSnapshot`의 반환값으로는 갈리지 않는다. fn이 `null`을 돌려줘도
    // 그쪽은 **읽은 상태**를 돌려주기 때문이다.
    return acted ? state! : null;
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
   *
   * `updateMany`가 아니라 `update`인 이유: `updateMany`는 대상이 0행이어도
   * 조용히 성공한다. 스냅샷에는 있는데 장부에 없는 사람이 있으면 칩 불일치가
   * 아무 에러 없이 지나갔다(T28 최종 리뷰). `update`는 P2025로 즉시 터지고,
   * 아래 `catch`가 유한 재시도 경로로 보낸다.
   */
  public async syncTableInventoryToDb(tableId: string, state: TableState): Promise<boolean> {
    // 버튼도 같은 트랜잭션이다. 스택과 버튼이 갈라지면 복구가 "칩은 이 핸드,
    // 버튼은 저 핸드"인 상태를 만든다. 체크포인트가 원자적이어야 DB가 항상
    // **어떤 한 핸드의 끝**을 가리킨다.
    //
    // `updateMany`가 아니라 `update`인 이유는 위 스택과 같다 — 대상이 0행이면
    // 조용히 성공한다.
    const updates = [
      ...state.players
        .filter(p => p !== null)
        .map(p => this.prisma.tournamentParticipation.update({
          where: {
            tournamentId_userId: { tournamentId: state.tournamentId, userId: p.id },
          },
          data: { currentStack: p.stack },
        })),
      this.prisma.table.update({
        where: { id: tableId },
        data: { buttonUser: state.buttonUser },
      }),
    ];
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
        const ok = await this.syncTableInventoryToDb(tableId, state);
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
      // 표시를 남기지 못해도 실패는 실패다. `markDbSyncStatus`는
      // `mutateSnapshot` → `withTableLock`이라 Redis가 힘들면 던지는데, 그것을
      // 그대로 올리면 호출자는 `false` 대신 예외를 받는다. 그러면 테이블이
      // HAND_END에 남고 표시도 없어 나올 길이 닫힌다.
      //
      // **표시가 없어도 갇히지 않는다** — `retryCheckpoint`의 문지기는 페이즈만
      // 본다. 여기서 삼키는 것은 화면의 빨간 표시뿐이다.
      try {
        await this.markDbSyncStatus(tableId, 'FAILED');
      } catch (error) {
        this.logger.error(`[체크포인트] 테이블 ${tableId} 실패 표시를 남기지 못했다`, error);
      }
      return false;
    }
    return true;
  }

  /** 스냅샷의 체크포인트 상태만 바꾸고 테이블 전원에게 쏜다. */
  public async markDbSyncStatus(tableId: string, status: 'RETRYING' | 'FAILED' | null) {
    const state = await this.redis.mutateSnapshot(tableId, async (snapshot) => {
      if (!snapshot) return null;
      if (status === null) {
        delete snapshot.dbSyncStatus;
      } else {
        snapshot.dbSyncStatus = status;
      }
      return snapshot;
    });
    if (state) {
      this.eventEmitter.emit('game.state.updated', { tableId, state });
    }
  }


  /**
   * 탈락을 확정하고 등수와 상금을 매긴다.
   *
   * **여러 명이 한 배열로 온다.** `DealerService.resolveWinners` 3단계가
   * `stack <= 0`인 사람을 모아 넘기고, 사이드팟이 갈리는 표준 핸드(숏스택 둘이
   * 올인)면 흔한 배치다. 그래서 등수는 스칼라가 아니라 **구간**이다(T59).
   */
  public async eliminatePlayer(tournamentId: string, tableId: string, players: TablePlayer[], tournamentInfo: Dashboard) {
    if (players.length === 0) return;
    const playerIds = players.map(p => p.id);
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. **이번 배치가 실제로 탈락시키는 인원을 먼저 확정한다.**
      //
      //    지급은 멱등이라(`awardPrize`가 이미 처리된 행을 건너뛴다) 예전에는
      //    지급이 끝나야 그 수를 알 수 있었다. 이제는 그 수가 등수를 정하므로
      //    지급보다 앞에 와야 한다 — 순서가 뒤집혔다.
      //
      //    세는 것으로 끝내지 않고 `FOR UPDATE`로 잠그는 이유: 같은 탈락이
      //    **동시에** 두 번 도착하면 둘 다 "한 명"을 세고 둘 다 카운터를 깎는다.
      //    예전에는 `updateMany` 하나가 잠금과 판정을 함께 해서 그 창이 없었다.
      //    잠금을 앞으로 옮긴 것이지 새로 만든 것이 아니다.
      const pending = await tx.$queryRaw<{ userId: string }[]>`
        SELECT "userId" FROM "TournamentParticipation"
        WHERE "tournamentId" = ${tournamentId}
          AND "userId" IN (${Prisma.join(playerIds)})
          AND "status" NOT IN ('ELIMINATED', 'AWARDED')
        FOR UPDATE
      `;
      const pendingIds = new Set(pending.map(row => row.userId));

      // 핸드 시작 스택이 곧 `stack + totalContributed`다. 3단계 시점의 스냅샷은
      // 아직 HAND_END라 `resetStatus`가 플래그 셋만 되돌렸고,
      // `refundUncalledBets`는 둘을 함께 움직여 합을 보존한다. 그래서
      // `resolveWinners`가 이 값을 따로 들고 나올 필요가 없다.
      const busted = players
        .filter(player => pendingIds.has(player.id))
        .map(player => ({
          userId: player.id,
          seatIndex: player.seatIndex,
          handStartStack: player.stack + player.totalContributed,
        }));

      // 삭제는 원래 멱등이라 조건을 더할 필요가 없다.
      await tx.tablePlayer.deleteMany({
        where: {
          tableId,
          userId: { in: playerIds }
        }
      });

      // 중복 도착이다. 카운터는 건드리지 않고 현재 값만 들고 나간다.
      if (busted.length === 0) {
        const { activePlayers } = await tx.tournament.findUniqueOrThrow({
          where: { id: tournamentId },
          select: { activePlayers: true },
        });
        return { eliCount: 0, remaining: activePlayers };
      }

      // 2. **등수 구간을 원자적으로 받는다.** 먼저 깎고 그 반환값으로
      //    `after+1 … after+n`을 잡는다.
      //
      //    교차 테이블은 스택 비교로 안 풀린다 — 다른 테이블의 파산자는 이
      //    배열에 없다. 예전에는 읽기에 행 잠금이 없어서 두 테이블이 동시에
      //    정산하면 둘 다 감소 전 값을 읽고 같은 등수를 매겼다. `UPDATE`가
      //    행 잠금을 잡으므로 두 번째 트랜잭션은 첫 번째의 커밋을 기다렸다가
      //    겹치지 않는 구간을 받는다.
      //
      //    풀과 분배율을 같은 문장에서 읽는다. Redis 대시보드에도
      //    `totalBuyinAmount`가 있지만 그건 화면용 파생값이고 **돈의 진실은
      //    DB다.** 인원수도 같은 규칙을 따른다(T60) — 등수가 상금을 정하므로
      //    (`prizeFor`) 화면용 파생값에서 오는 것 자체가 위험했다.
      //    **닫힌 대회면 여기서 멈춘다.** 상금이 이 뒤에 나가고
      //    (`tournamentFinished` → `awardPrize`), 그 판단의 재료가 방금 깎은
      //    인원수다. 회계가 끝난 대회에서 한 번 더 나가면 되돌릴 수 없다.
      //    위의 좌석 삭제도 같은 트랜잭션이라 함께 되돌아간다.
      const { activePlayers, totalBuyinAmount, prizePayouts } = await tx.tournament.update({
        where: { id: tournamentId, status: NOT_CLOSED_TOURNAMENT_FILTER },
        data: { activePlayers: { decrement: busted.length } },
        select: { activePlayers: true, totalBuyinAmount: true, prizePayouts: true },
      }).catch(asClosedTournamentWrite);

      // 3. 핸드 시작 스택으로 등수를 가르고 공동 등수의 몫을 나눈다.
      const awards = splitBustedRanks(
        busted,
        activePlayers + busted.length,
        totalBuyinAmount,
        prizePayouts,
      );

      // 상태 전환·포인트·거래 내역이 한 곳에서 함께 일어난다. 기록만 되고
      // 돈이 안 나가는 창을 만들지 않기 위해서다.
      //
      // 등수마다 따로 부르는 것은 내역의 설명이 그 사람의 등수여야 하기
      // 때문이다. `awardPrize`는 원래 배열을 순회하므로 쿼리 수는 같다.
      for (const award of awards) {
        await awardPrize(tx, tournamentId, [award], `${award.place}위 상금`);
      }

      return { eliCount: busted.length, remaining: activePlayers }
    });

    // 카운터는 **조기 반환보다 앞에서** 맞춘다(T60). 중복 도착은 정상 경로이고,
    // 대입이라 그때가 오히려 어긋난 값을 지우는 기회다.
    await this.redis.syncActivePlayer(
      tournamentId,
      result.remaining,
      tournamentInfo.startStack,
      tournamentInfo.entryFee,
    );

    // 중복 도착이면 여기서 끝난다. 좌석 비트맵과 userContext는 첫 번째가 이미 지웠다.
    if (result.eliCount === 0) return;

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

    // 최후 1인 판정도 DB가 돌려준 값으로 한다(T60). Redis는 전광판 전용이다.
    if (result.remaining <= 1) {
      await this.tournamentFinished(tournamentId)
    }
  }

  // 최후 1인
  async tournamentFinished(tournamentId: string) {
    // 살아 있는 사람 중에서 고른다. `PLAYING`만 보면 **쉬는 시간에 좌석이
    // 해제된 채로 마지막 탈락이 나는 경우** 우승자를 못 찾아 던진다 —
    // 해제된 사람(`RELEASED`)은 칩을 들고 있고 다시 앉을 수 있는 사람이다.
    // `WAITING`을 넣지 않는 것도 같은 이유다: 한 번도 안 앉은 사람이 우승자가
    // 되면 안 된다(`store/session/player-status.ts`).
    const user = await this.prisma.tournamentParticipation.findFirst({
      where: {
        tournamentId: tournamentId,
        status: { in: [...LIVE_PLAYER_STATUSES] },
      }
    });
    if (!user) throw new Error('유저 없음.');
    await this.prisma.$transaction(async (tx) => {
      const { totalBuyinAmount, prizePayouts } = await tx.tournament.findUniqueOrThrow({
        where: { id: tournamentId },
        select: { totalBuyinAmount: true, prizePayouts: true },
      });

      await awardPrize(
        tx,
        tournamentId,
        [{
          userId: user.userId,
          place: 1,
          amount: prizeFor(totalBuyinAmount, prizePayouts, 1),
        }],
        '우승 상금',
      );
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
    const state = await this.redis.mutateSnapshot(tableId, async (state) => {
      if (!state) return null;
      new TableEngine(state).applyRebuy(userId, resultStack);
      return state;
    });
    // 전파는 쓰기 뒤다(위 handleAction과 같은 이유). 스냅샷이 없어 아무것도
    // 하지 않았으면 보낼 것도 없다.
    if (state) {
      this.eventEmitter.emit('game.state.updated', { tableId, state });
    }

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

      // **닫힌 대회에는 쓰지 않는다.** 이 자리의 창이 제일 넓다 — 리바인은
      // 사람에게 15초를 묻고 오는 길이라(`waitForRebuyResponse`) 묻는 동안
      // 대회가 닫히는 것이 드문 일이 아니다.
      //
      // 막지 않으면 **돈만 사라진다.** 참가비는 위에서 이미 빠졌는데 칩을 넣는
      // `mutateSnapshot`은 지워진 스냅샷을 못 찾아 아무 일도 안 한다. 장부
      // 검산(`걷은 참가비 == 나간 상금`)은 그보다 앞에서 통과한 뒤다.
      //
      // 조건을 여기 거는 이유는 **판정과 쓰기가 같은 문장이어야** 하기
      // 때문이다. 트랜잭션 앞에서 상태를 읽어 보면 그 읽기와 이 UPDATE 사이가
      // 다시 창이 된다. UPDATE가 행 잠금을 잡으므로, 닫는 쪽과 이쪽 중 하나는
      // 반드시 상대의 커밋을 보고 결정한다.
      await tx.tournament.update({
        where: { id: tournamentId, status: NOT_CLOSED_TOURNAMENT_FILTER },
        data: { totalBuyinAmount: { increment: entryFee } },
      }).catch(asClosedTournamentWrite);

      // 리바인은 장부 하나만 건드린다. 예전에는 buyInCount(참가 행)와
      // currentStack(좌석 행)이 갈라져 있어 update가 둘이었다.
      await tx.tournamentParticipation.update({
        where: { tournamentId_userId: { tournamentId, userId } },
        data: {
          buyInCount: { increment: 1 },
          currentStack: { increment: startStack },
        },
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
