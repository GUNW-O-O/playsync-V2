import { ConflictException, Injectable } from '@nestjs/common';
import { PlayerStatus, TournamentStatus } from '@prisma/client';
import { PayMentDto } from 'shared/dto/payment.dto';
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

  // `SessionService.getGameSession`을 재사용하지 않는다 — 그건 상점 콘솔의
  // 소유자 조회용이라 tornamentParticipations·tablePlayers까지 include한다.
  // 여기는 가드 없는 공개 라우트(`GET /tournaments/:id`)의 조회라 화면이
  // 실제로 읽는 필드만 select한다 — 참가자 목록·좌석 배정 같은 남의 정보가
  // 실려 나가지 않게.
  async getTournamentInfo(tournamentId: string) {
    const tournament = await this.prismaService.tournament.findUnique({
      where: { id: tournamentId },
      select: {
        id: true,
        name: true,
        status: true,
        type: true,
        isRegistrationOpen: true,
        entryFee: true,
        startStack: true,
        rebuyUntil: true,
        itmCount: true,
        prizePayouts: true,
        totalPlayers: true,
        activePlayers: true,
        avgStack: true,
        totalBuyinAmount: true,
        storeId: true,
        startedAt: true,
        createdAt: true,
        tables: true,
        blindStructure: true,
      },
    });
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

  // 참가비 결제. **좌석은 여기서 정하지 않는다**(T28) — 오프라인에서 돈은
  // 미리 내고 의자는 현장에서 정해진다. 좌석 확정은 EntryService가 참가
  // OTP를 받는 순간에 한다.
  async joinSession(dto: PayMentDto, userId: string) {
    const user = await this.user.findByUUID(userId);
    if (!user) {
      throw new ConflictException('잘못된 유저 ID 입니다.');
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

    // OTP가 대회 안에서 겹치면 다시 뽑는다. 8자리라 드물지만 드문 것은 안 나는
    // 것이 아니다. 트랜잭션 전체를 다시 도는 이유는 참가비 차감과 참가 생성이
    // 같은 트랜잭션 안이라 OTP만 따로 바꿀 수 없기 때문이다.
    let participation: { id: string; status: PlayerStatus } | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        participation = await this.prismaService.$transaction(async (tx) => {
          await this.user.paymentPoint(
            tx, userId, dto.tournamentId, session.name, session.entryFee,
          );
          // 착석 여부와 무관하게 WAITING이다. PLAYING으로 올리는 것은
          // 입장(EntryService)의 몫이다 — PlayerStatus의 주석이 원래
          // 그렇게 적혀 있다("바이인 완료 후 대기" / "테이블 착석 중").
          //
          // 칩은 여기서 정해진다. 좌석이 아니라 **돈을 낸 것**이므로 T28이 그은
          // 경계(결제는 좌석을 정하지 않는다)를 넘지 않는다.
          const created = await tx.tournamentParticipation.create({
            data: {
              userId,
              tournamentId: dto.tournamentId,
              status: PlayerStatus.WAITING,
              currentStack: session.startStack,
              playerOtp: playerOtp.generatePlayerOtp(),
            },
          });
          await tx.tournament.update({
            where: { id: dto.tournamentId },
            data: {
              totalPlayers: { increment: 1 },
              activePlayers: { increment: 1 },
              totalBuyinAmount: { increment: session.entryFee },
            },
          });
          return { id: created.id, status: created.status };
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
    if (!participation) {
      throw new ConflictException('참가 OTP를 만들지 못했습니다. 다시 시도해 주세요.');
    }

    // 대회 카운터의 Redis 미러다. 방금 DB에 올린 세 필드와 같은 값이라
    // 좌석과 무관하고, 그래서 여기 남는다.
    await this.redisService.joinPlayer(dto.tournamentId, session.entryFee);

    return participation;
  }
}
