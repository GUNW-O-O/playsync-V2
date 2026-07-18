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

  async handleAction(userId: string, tableId: string, dto: PlayerActionDto) {
    try {
      const oldJob = await this.timeoutQueue.getJob(tableId);
      if (oldJob) await oldJob.remove();
    } catch (e) {
      console.log('타임아웃 제거 실패');
    }
    // Redis에서 상태 로드 및 엔진 초기화
    const state = await this.redis.getSnapShot(tableId);
    if (!state) throw new Error(`Table ${tableId} not found`);

    const userState = await this.redis.getUserContext(state.tournamentId, userId);

    const engine = new TableEngine(state);

    // 엔진 액션 실행
    const playerIdx = state.players.findIndex(p => p?.id === userId);
    if (userState?.status.endsWith('KICKED')) {
      await engine.act(playerIdx, ActionType.FOLD);
    }
    await engine.act(playerIdx, dto.action, dto.amount);

    // 다음 턴 유저가 결정되었다면 그 유저를 위한 타임아웃 생성
    if (state.phase !== GamePhase.SHOWDOWN && state.currentTurnSeatIndex !== -1) {
      const nextPlayer = state.players[state.currentTurnSeatIndex];
      if (nextPlayer) {
        await this.timeoutQueue.add(
          'player-timeout',
          {
            tableId: tableId,
            userId: nextPlayer.id
          },
          {
            delay: 30000,
            jobId: tableId, // 테이블별 고유 ID로 덮어쓰기/관리
            removeOnComplete: true,
            removeOnFail: true,
          }
        );
        state.actionDeadline = Date.now() + 30000;
      }
    }

    // Redis 저장
    await this.redis.saveSnapShot(tableId, state);
    if (dto.action === ActionType.TIME_OUT) {
      this.eventEmitter.emit('game.state.updated', { tableId, state: state })
    }
    return state;
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
