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
    return this.redis.withTableLock(tableId, async () => {
      const blind = await this.redis.checkAndSyncBlindLevel(tournamentId);
      const state = await this.redis.getSnapShot(tableId);
      if (!blind) throw new Error('블라인드 정보가 없습니다.');
      if (blind.isBreak) {
        throw new Error('휴식 상태입니다.');
      }
      // 시작할 수 없는 상태면 아무것도 건드리지 않고 거절한다.
      //
      // 이 검사가 잡 제거보다 뒤로 가면, 이미 진행 중인 핸드에서 액션을
      // 기다리던 플레이어의 타이머를 지우고 나가게 된다 — 아무도 타이머가
      // 없는 상태가 되어 그 유저가 자리를 비우면 라운드가 끝나지 않는다.
      //
      // 조용한 `return`이 아니라 `throw`인 이유: 실패를 undefined로 표현하면
      // 게이트웨이가 그걸 renderGame으로 브로드캐스트해 테이블 전원의 상태를
      // undefined로 덮는다. 딜러의 오조작 한 번에 전 화면이 날아가는 셈이다.
      // 실패는 예외로 올리고 경계에서 잡는다.
      if (!state) throw new Error('테이블을 찾을 수 없습니다.');
      if (state.phase !== GamePhase.WAITING) {
        throw new Error('대기 상태가 아닙니다.');
      }

      const ante = blind.blindStructure[blind.currentBlindLv].ante;
      const smallBlind = blind.blindStructure[blind.currentBlindLv].sb;
      state.smallBlind = smallBlind;
      state.ante = ante;
      const engine = new TableEngine(state);
      engine.startPreFlop();

      await this.playsync.scheduleTurnTimeout(tableId, state);
      await this.redis.saveSnapShot(tableId, state);
      return engine.state;
    });
  }

  async handleDealerAction(tournamentId: string, tableId: string, targetUserId: string, type: 'FOLD' | 'KICK') {
    return this.redis.withTableLock(tableId, async () => {
      const state = await this.redis.getSnapShot(tableId);
      if (!state) throw new Error('예기치 못한 오류가 발생했습니다.')
      const engine = new TableEngine(state);
      const targetIdx = state.players.findIndex(p => p?.id === targetUserId);

      // 대상이 없으면 큐를 건드리기 전에 나간다.
      if (targetIdx === -1) throw new Error("대상 플레이어를 찾을 수 없습니다.");

      if (type === 'FOLD') {
        await engine.act(targetIdx, ActionType.DEALER_FOLD);
      } else if (type === 'KICK') {
        await engine.act(targetIdx, ActionType.DEALER_KICK);
        await this.redis.setUserContext(tournamentId, targetUserId, tableId, targetIdx, 'KICKED');

        // 상태 변경과 카운터 감소가 한 트랜잭션이어야 한다. 따로 두면 두 번째가
        // 실패했을 때 탈락했는데 인원수는 그대로인 상태가 남는다.
        //
        // 그리고 `decrement: 1`은 멱등이 아니다. 딜러가 킥을 두 번 누르면 두 번
        // 준다. 이미 탈락한 사람은 `where`에서 걸러 **실제로 바뀐 행 수만큼만**
        // 줄인다.
        await this.prisma.$transaction(async (tx) => {
          const changed = await tx.tournamentParticipation.updateMany({
            where: {
              tournamentId,
              userId: targetUserId,
              status: { notIn: ['ELIMINATED', 'AWARDED'] },
            },
            data: { status: 'ELIMINATED' }
          });
          if (changed.count > 0) {
            await tx.tournament.update({
              where: { id: tournamentId },
              data: { activePlayers: { decrement: changed.count } }
            });
          }
        });
      }

      await this.playsync.scheduleTurnTimeout(tableId, state);
      await this.redis.saveSnapShot(tableId, state);
      return state;
    });
  }

  /**
   * 정산은 세 구간으로 나뉘고, 가운데만 락 밖이다.
   *
   * 1. 팟 분배 — 락 안. 짧고 순수한 계산이다.
   * 2. 리바인 응답 대기 — **락 밖.** 최대 15초짜리 사람 입력이다. 이걸 락 안에
   *    두면 그동안 테이블 전체가 멎는다(그래서 예전엔 TTL을 30초로 늘려야 했다).
   *    대신 1단계가 남긴 `HAND_END`가 문지기가 된다 — `startPreFlop`은 `WAITING`만
   *    받으므로 이 구간에 다음 핸드가 시작되지 않는다.
   * 3. 탈락 확정과 초기화 — 락 안. 스냅샷을 **다시 읽는다.** 2단계 동안 각 리바인이
   *    자기 락을 잡고 스택을 반영했으므로, 1단계의 객체는 이미 낡았다.
   */
  async resolveWinners(tableId: string, tournamentId: string, winnerUserIds: string[]) {
    const tournamentInfo = await this.redis.getTournamentDashboard(tournamentId);
    if (!tournamentInfo) throw new Error('예기치 못한 오류가 발생했습니다.');
    // TODO : 보드하이 무승부로직
    if (winnerUserIds.length === 0) throw new Error("유효한 승자가 없습니다.");

    // 1. 팟 분배
    const brokePlayerIds = await this.redis.withTableLock(tableId, async () => {
      const state = await this.redis.getSnapShot(tableId);
      if (!state) throw new Error('예기치 못한 오류가 발생했습니다.');

      const engine = new TableEngine(state);
      await engine.resolveWinner(winnerUserIds);
      await this.redis.saveSnapShot(tableId, state);

      return state.players
        .filter((p): p is TablePlayer => p != null && p.stack <= 0)
        .map(p => p.id);
    });

    // 2. 리바인 — 락 밖. 전원에게 동시에 묻고 같은 마감을 준다.
    //    수락한 사람은 남을 기다리지 않고 그 즉시 반영·전파된다.
    if (tournamentInfo.isRegistrationOpen && brokePlayerIds.length > 0) {
      await Promise.all(
        brokePlayerIds.map(playerId =>
          this.playsync.processRebuy(
            tournamentId,
            tableId,
            playerId,
            tournamentInfo.entryFee,
            tournamentInfo.startStack,
            tournamentInfo.tournamentName,
          ),
        ),
      );
    }

    // 3. 탈락 확정 + 다음 핸드 준비
    return this.redis.withTableLock(tableId, async () => {
      const state = await this.redis.getSnapShot(tableId);
      if (!state) throw new Error('예기치 못한 오류가 발생했습니다.');

      // 리바인으로 살아난 사람은 여기서 이미 스택이 있다.
      const eliminatedPlayers = state.players
        .filter((p): p is TablePlayer => p != null && p.stack <= 0);

      await this.playsync.eliminatePlayer(tournamentId, tableId, eliminatedPlayers, tournamentInfo);

      const isTxSuccess = await this.playsync.syncTableInventoryToDb(state);
      if (!isTxSuccess) throw new Error('DB 동기화 실패');

      await new TableEngine(state).initTable();
      await this.redis.saveSnapShot(tableId, state);
      return state;
    });
  }

}
