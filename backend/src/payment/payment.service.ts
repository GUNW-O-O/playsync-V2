import { ConflictException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TournamentStatus } from '@prisma/client';
import { PayMentDto } from 'shared/dto/payment.dto';
import { GamePhase, TablePlayer } from 'src/game-engine/types';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { SessionService } from 'src/store/session/session.service';
import { UserService } from 'src/user/user.service';

@Injectable()
export class PaymentService {
  constructor(private user: UserService,
    private session: SessionService,
    private prismaService: PrismaService,
    private redisService: RedisService,
    private readonly eventEmitter: EventEmitter2,
  ) { };

  // 가맹점 이름으로 검색
  async searchStore(name: string) {
    return await this.prismaService.store.findMany({
      where: { name: { contains: name } }
    });
  }

  // 해당 매장의 참가가능 토너먼트 정보
  async getStoreAvailableSessions(storeId: string) {
    return await this.prismaService.tournament.findMany({
      where: {
        storeId: storeId,
        status: {
          in: [TournamentStatus.ONGOING, TournamentStatus.PENDING],
        }
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async getTournamentInfo(tournamentId: string) {
    const data = await this.session.getGameSession(tournamentId);
    if (!data) throw new ConflictException('잘못된 세션 ID 입니다.');
    const { dealerOtp, ...tournament } = data;
    let seatStatus = await this.redisService.getTournamentTables(tournamentId);
    if (!seatStatus || seatStatus.length === 0) {
      const session = await this.prismaService.tournament.findUnique({
        where: { id: tournamentId },
        include: {
          tables: true
        }
      });
      if (!session || !session.tables) throw new ConflictException('잘못된 세션 ID 입니다.');
      if (session.totalPlayers === 0) {
        await this.redisService.setSeatBitmap(tournamentId, session.tables[0].id);
      }
      // TODO : 다중 테이블 기능 개발시 유저자리 매핑하는로직
    }
    return { tournament, seatStatus };
  }

  // 세션 참여
  async joinSessionWithSeat(dto: PayMentDto, userId: string) {
    const isLocked = await this.redisService.acquireSeatLock(dto, userId);
    if (!isLocked) {
      throw new ConflictException('이미 다른 유저가 선택 중인 좌석입니다.');
    }
    try {
      const user = await this.user.findByUUID(userId);
      if (!user) {
        throw new ConflictException('잘못된 유저 ID 입니다.')
      }
      const session = await this.prismaService.tournament.findUnique({
        where: { id: dto.tournamentId },
      });
      if (!session) throw new ConflictException('잘못된 세션 ID 입니다.');
      if (session.status === TournamentStatus.FINISHED || !session.isRegistrationOpen) {
        throw new ConflictException('이미 종료된 세션입니다.');
      }
      if (user.points < session.entryFee) {
        throw new ConflictException('포인트가 부족합니다.');
      }
      const result = await this.prismaService.$transaction(async (tx) => {
        // DB 최종 중복 체크
        const exsitingPlayer = await tx.tablePlayer.findUnique({
          where: {
            tableId_seatPosition: {
              tableId: dto.tableId,
              seatPosition: dto.seatIndex
            }
          }
        });
        const isOngoing = session.status === TournamentStatus.ONGOING;
        if (exsitingPlayer) throw new Error('이미 플레이어가 존재하는 좌석입니다');
        await this.user.paymentPoint(tx, userId, dto.tournamentId, session.name, session.entryFee);
        await tx.tournamentParticipation.create({
          data: {
            userId: userId,
            tournamentId: dto.tournamentId,
            status: isOngoing ? 'PLAYING' : 'WAITING',
          }
        });
        await tx.tablePlayer.create({
          data: {
            tournamentId: session.id,
            nickname: user.nickname,
            tableId: dto.tableId,
            userId: userId,
            seatPosition: dto.seatIndex,
            currentStack: session.startStack,
          }
        })
        await tx.tournament.update({
          where: { id: dto.tournamentId },
          data: {
            totalPlayers: { increment: 1 },
            activePlayers: { increment: 1 },
            totalBuyinAmount: { increment: session.entryFee },
          }
        });
        let updatedState = await this.redisService.getSnapShot(dto.tableId);

        const newPlayer: TablePlayer = {
          id: userId,
          tableId: dto.tableId,
          nickname: user.nickname!,
          seatIndex: dto.seatIndex,
          stack: session.startStack,
          bet: 0,
          hasFolded: isOngoing, // 게임 중이면 true, 대기 중이면 false
          isAllIn: false,
          hasChecked: false,
          totalContributed: 0,
        };

        if (!updatedState) {
          updatedState = {
            phase: GamePhase.WAITING,
            players: Array(9).fill(null),
            pot: 0,
            currentBet: 0,
            buttonUser: 0,
            currentTurnSeatIndex: -1,
            sidePots: [],
            ante: false,
            tournamentId: session.id,
            smallBlind: 100,
          };
        }
        updatedState.players[dto.seatIndex] = newPlayer;
        await this.redisService.saveSnapShot(dto.tableId, updatedState);
        return { success: true, updatedState };
      });
      if (result.success) {
        await this.redisService.setUserContext(dto.tournamentId, userId, dto.tableId, dto.seatIndex, 'ACTIVE');
        await this.redisService.joinPlayer(dto.tournamentId, session.entryFee);
        const table = await this.redisService.updateSeatBitmap(dto.tournamentId, dto.tableId, dto.seatIndex, true);
        let cnt = 0;
        table.split('').forEach(idx => {
          if (idx === '1') cnt++;
        })
        if (cnt === 7) {
          await this.session.createTable(dto.tournamentId);
        }
        const tableStatus = await this.redisService.getTournamentTables(dto.tournamentId);
        this.eventEmitter.emit('SEAT_LIST_UPDATED', {
          tournamentId: dto.tournamentId, 
          state : tableStatus
        })
      }
      return result.updatedState;
    } finally {
      await this.redisService.releaseSeatLock(dto);
    }
  }
}
