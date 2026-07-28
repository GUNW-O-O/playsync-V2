import { ConflictException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TournamentStatus } from '@prisma/client';
import { PayMentDto } from 'shared/dto/payment.dto';
import { GamePhase, TablePlayer, TableState } from 'src/game-engine/types';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { SessionService } from 'src/store/session/session.service';
import { UserService } from 'src/user/user.service';
import * as playerOtp from './player-otp';

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
      // 참가자용 조회다. 해시라도 응답에 실으면 안 된다.
      omit: { dealerOtpHash: true },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async getTournamentInfo(tournamentId: string) {
    const tournament = await this.session.getGameSession(tournamentId);
    if (!tournament) throw new ConflictException('잘못된 세션 ID 입니다.');
    let seatStatus = await this.redisService.getTournamentTables(tournamentId);
    if (!seatStatus || seatStatus.length === 0) {
      const session = await this.prismaService.tournament.findUnique({
        where: { id: tournamentId },
        include: {
          tables: true
        }
      });
      if (!session) throw new ConflictException('잘못된 세션 ID 입니다.');
      // `!session.tables`로는 빈 배열을 걸러내지 못한다 — `[]`는 truthy라
      // 그대로 통과한 뒤 `tables[0].id`에서 TypeError로 죽었다. 대회를 보고
      // 있는 참가자 전원이 500을 본다. 테이블이 하나도 없는 상태는 실제로
      // 생긴다: `completeSession`이 대회를 닫으며 전부 지운 경우다.
      // 되살릴 대상이 없을 뿐이므로 거부가 아니라 그냥 건너뛴다.
      if (session.totalPlayers === 0 && session.tables.length > 0) {
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
      const isOngoing = session.status === TournamentStatus.ONGOING;

      // 트랜잭션은 DB만 만진다. Redis는 트랜잭션에 참여하지 않으므로, 안에서
      // 스냅샷을 쓰면 뒷부분이 실패해 DB가 롤백돼도 Redis에는 유저가 앉아 있다.
      //
      // OTP가 대회 안에서 겹치면 다시 뽑는다. 8자리라 드물지만 드문 것은
      // 안 나는 것이 아니다. 트랜잭션 전체를 다시 도는 이유는 참가비 차감과
      // 좌석 생성이 같은 트랜잭션 안이라 OTP만 따로 바꿀 수 없기 때문이다.
      let result: { success: boolean } | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          result = await this.prismaService.$transaction(async (tx) => {
            // DB 최종 중복 체크
            const exsitingPlayer = await tx.tablePlayer.findUnique({
              where: {
                tableId_seatPosition: {
                  tableId: dto.tableId,
                  seatPosition: dto.seatIndex
                }
              }
            });
            if (exsitingPlayer) throw new ConflictException('이미 다른 참가자가 앉은 좌석입니다.');
            await this.user.paymentPoint(tx, userId, dto.tournamentId, session.name, session.entryFee);
            await tx.tournamentParticipation.create({
              data: {
                userId: userId,
                tournamentId: dto.tournamentId,
                status: isOngoing ? 'PLAYING' : 'WAITING',
                playerOtp: playerOtp.generatePlayerOtp(),
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
            return { success: true };
          });
          break;
        } catch (e) {
          // 같은 사람이 두 번 참가한 경우(tournamentId, userId)는 재시도해도
          // 같은 결과다. OTP 충돌만 다시 뽑는다.
          //
          // `meta.target`이 아니라 `meta.driverAdapterError...constraint.fields`를
          // 보는 이유: 드라이버 어댑터(@prisma/adapter-pg) 구성에서는 P2002 메타에
          // `target`이 없다. 대신 postgres가 준 제약 조건 정보를 그대로 담아
          // 필드 이름에 큰따옴표가 붙은 채로(`"playerOtp"`) 내려온다.
          const err = e as {
            code?: string;
            meta?: {
              target?: string[];
              driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } };
            };
          };
          const violatedFields =
            err.meta?.target ?? err.meta?.driverAdapterError?.cause?.constraint?.fields ?? [];
          const isOtpCollision =
            err.code === 'P2002' && violatedFields.some((field) => field.includes('playerOtp'));
          if (!isOtpCollision) throw e;
        }
      }
      if (!result) {
        throw new ConflictException('참가 OTP를 만들지 못했습니다. 다시 시도해 주세요.');
      }

      let updatedState: TableState | undefined;
      if (result.success) {
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

        // 좌석 락은 좌석별이라 다른 좌석에 앉는 사람을 막지 않는다. 스냅샷은
        // JSON 통째로 덮어쓰므로, 락 없이 겹치면 나중에 쓴 쪽이 앞선 착석을
        // 통째로 지운다 — 앉았는데 자리에 없는 유저가 생긴다.
        updatedState = await this.redisService.withTableLock(dto.tableId, async () => {
          const state = await this.redisService.getSnapShot(dto.tableId) ?? {
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
          state.players[dto.seatIndex] = newPlayer;
          await this.redisService.saveSnapShot(dto.tableId, state);
          return state;
        });

        await this.redisService.setUserContext(dto.tournamentId, userId, dto.tableId, dto.seatIndex, 'ACTIVE');
        await this.redisService.joinPlayer(dto.tournamentId, session.entryFee);
        // 좌석 비트맵 갱신은 남는다 — 좌석 목록과 전광판이 이 값을 읽는다.
        // 예전에는 여기서 점유 수가 7이면 테이블을 자동 생성했다. 카운트
        // 비교라 탈락으로 비었다가 다시 차면 7을 다시 넘어 빈 테이블이
        // 계속 생겼다. 테이블은 이제 상점이 만든다.
        await this.redisService.updateSeatBitmap(dto.tournamentId, dto.tableId, dto.seatIndex, true);
        const tableStatus = await this.redisService.getTournamentTables(dto.tournamentId);
        this.eventEmitter.emit('SEAT_LIST_UPDATED', {
          tournamentId: dto.tournamentId, 
          state : tableStatus
        })
      }
      return updatedState;
    } finally {
      await this.redisService.releaseSeatLock(dto);
    }
  }
}
