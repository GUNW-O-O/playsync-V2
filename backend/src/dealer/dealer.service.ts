import { InjectQueue } from '@nestjs/bullmq';
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { Queue } from 'bullmq';
import { DealerDto } from 'shared/dto/dealer.dto';
import { TableEngine } from 'src/game-engine/table-engine';
import { ActionType, GamePhase, TablePlayer } from 'src/game-engine/types';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';

@Injectable()
export class DealerService {
  constructor(
    @InjectQueue('player-timeout') private timeoutQueue: Queue,
    private prisma: PrismaService,
    private redis: RedisService,
    private playsync: PlaysyncService,
    private jwtService: JwtService,
  ) { }

  async loginDealer(dto: DealerDto) {
    return await this.prisma.$transaction(async (tx) => {
      // 1. 세션 및 OTP 검증 (기존 로직)
      const tournament = await tx.tournament.findUnique({
        where: { id: dto.tournamentId },
        include: {
          dealerSession: true,
        }
      });
      if (!tournament || tournament.dealerOtp !== dto.otp) {
        throw new UnauthorizedException('인증 정보가 올바르지 않습니다.');
      }
      if (!tournament.dealerSession) {
        throw new ConflictException('예기치 못한 오류가 발생했습니다.')
      }


      if (tournament.status === 'ONGOING') {
        const table = await tx.table.findUnique({
          where: { tournamentId_id: { tournamentId: dto.tournamentId, id: dto.tableId } },
          include: { tablePlayers: true }
        });

        if (table) {
          // 참가자 상태 변경
          const userIds = table.tablePlayers.map(p => p.userId);
          await tx.tournamentParticipation.updateMany({
            where: {
              userId: { in: userIds },
              tournamentId: dto.tournamentId,
              status: 'WAITING'
            },
            data: { status: 'PLAYING' }
          });
        }
      }
      const accessToken = {
        sub: tournament.dealerSession.id,
        tournamentId: dto.tournamentId,
        tableId: dto.tableId,
        role: Role.DEALER,
      }
      return {
        accessToken: this.jwtService.sign(accessToken)
      }
    });
  }

  async startPreFlop(tournamentId: string, tableId: string) {
    try {
      const oldJob = await this.timeoutQueue.getJob(tableId);
      if (oldJob) await oldJob.remove();
    } catch (e) {
      console.log('타임아웃 제거 실패');
    }
    console.log('tournamentId !!!!!!!!!!!!!! : ', tournamentId)
    console.log('tableId !!!!!!!!!!!!!! : ', tableId)
    const blind = await this.redis.checkAndSyncBlindLevel(tournamentId);
    const state = await this.redis.getSnapShot(tableId);
    if (!blind) throw new Error('블라인드 정보가 없습니다.');
    if (blind.isBreak) {
      throw new Error('휴식 상태입니다.');
    }
    if (!state || state.phase !== GamePhase.WAITING) {
      return;
    }
    const ante = blind.blindStructure[blind.currentBlindLv].ante;
    const smallBlind = blind.blindStructure[blind.currentBlindLv].sb;
    state.actionDeadline = Date.now() + 31000;
    state.smallBlind = smallBlind;
    state.ante = ante;
    const engine = new TableEngine(state);
    engine.startPreFlop();
    const firstPlayer = state.players[state.currentTurnSeatIndex];
    if (firstPlayer) {
      await this.timeoutQueue.add('player-timeout',
        { tableId, userId: firstPlayer.id },
        {
          delay: 31000,
          jobId: tableId,
          removeOnComplete: true,
          removeOnFail: true
        }
      );
      state.actionDeadline = Date.now() + 30000;
    }
    await this.redis.saveSnapShot(tableId, state);
    return engine.state;
  }

  async handleDealerAction(tournamentId: string, tableId: string, targetUserId: string, type: 'FOLD' | 'KICK') {
    try {
      const oldJob = await this.timeoutQueue.getJob(tableId);
      if (oldJob) await oldJob.remove();
    } catch (e) {
      console.log('타임아웃 제거 실패');
    }
    const state = await this.redis.getSnapShot(tableId);
    if (!state) throw new Error('예기치 못한 오류가 발생했습니다.')
    const engine = new TableEngine(state);
    const targetIdx = state.players.findIndex(p => p?.id === targetUserId);

    if (targetIdx === -1) throw new Error("대상 플레이어를 찾을 수 없습니다.");

    if (type === 'FOLD') {
      await engine.act(targetIdx, ActionType.DEALER_FOLD);
    } else if (type === 'KICK') {
      await engine.act(targetIdx, ActionType.DEALER_KICK);
      await this.redis.setUserContext(tournamentId, targetUserId, tableId, targetIdx, 'KICKED');
      await this.prisma.tournamentParticipation.update({
        where: { tournamentId_userId: { tournamentId: tournamentId, userId: targetUserId } },
        data: { status: 'ELIMINATED' }
      });
      await this.prisma.tournament.update({
        where: { id: tournamentId },
        data: { activePlayers: { decrement: 1 } }
      });
    }

    if (state.phase !== GamePhase.SHOWDOWN && state.currentTurnSeatIndex !== -1) {
      const nextPlayer = state.players[state.currentTurnSeatIndex];
      if (nextPlayer) {
        await this.timeoutQueue.add('player-timeout',
          { tableId, userId: nextPlayer.id },
          {
            delay: 30000,
            jobId: tableId,
            removeOnComplete: true,
            removeOnFail: true
          }
        );
        state.actionDeadline = Date.now() + 30000;
      }
    }

    await this.redis.saveSnapShot(tableId, state); // Redis 저장 및 다음 턴/타이머 세팅
    return state;
  }

  async resolveWinners(tableId: string, tournamentId: string, winnerUserIds: string[]) {
    const state = await this.redis.getSnapShot(tableId);
    const tournamentInfo = await this.redis.getTournamentDashboard(tournamentId);
    if (!state || !tournamentInfo) throw new Error('예기치 못한 오류가 발생했습니다.')
    // TODO : 보드하이 무승부로직
    if (winnerUserIds.length === 0) throw new Error("유효한 승자가 없습니다.");
    const rebuyCallback = tournamentInfo.isRegistrationOpen
      ? async (playerId: string) => {
        return await this.playsync.processRebuy(
          tournamentId,
          tableId,
          playerId,
          tournamentInfo.entryFee,
          tournamentInfo.startStack,
          tournamentInfo.tournamentName,
          state
        );
      }
      : undefined;

    const engine = new TableEngine(state, rebuyCallback);
    await engine.resolveWinner(winnerUserIds);

    const eliminatedPlayers = engine.state.players
      .filter((p): p is TablePlayer => p != null && p.stack <= 0).slice();

    await this.playsync.eliminatePlayer(tournamentId, tableId, eliminatedPlayers, tournamentInfo);

    const isTxSuccess = await this.playsync.syncTableInventoryToDb(state);
    if (isTxSuccess) {
      await engine.initTable();
      await this.redis.saveSnapShot(tableId, state);
      return state;
    } else {
      throw new Error('DB 동기화 실패');
    }
  }

}
