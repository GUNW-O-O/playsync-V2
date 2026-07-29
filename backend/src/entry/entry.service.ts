import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { PlayerStatus, TournamentStatus } from '@prisma/client';
import { EnterTournamentDto } from 'shared/dto/entry.dto';
import { SEAT_ROLE } from 'src/auth/seat-role';
import { GamePhase, TableState } from 'src/game-engine/types';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';

/** 좌석을 확정할 때 필요한 것만 추린 값. 조회 결과를 그대로 끌고 다니지 않는다. */
type Claimant = {
  userId: string;
  participationId: string;
  nickname: string;
  stack: number;
  /** 이미 이 좌석의 `TablePlayer`가 있는가(재입장). */
  alreadySeated: boolean;
};

/**
 * 참가 OTP로 좌석을 확정하고 좌석 토큰을 발급한다.
 *
 * 결제 서비스가 아니라 별도 모듈인 이유: 결제는 돈이고 입장은 인증과 좌석이다.
 * 한 파일에 두면 참가비 차감과 JWT 서명이 같은 클래스에 앉는다.
 */
@Injectable()
export class EntryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async enterSeat(tournamentId: string, dto: EnterTournamentDto) {
    // OTP로 **찾을** 뿐 돌려받지 않으므로 `omit: { playerOtp: false }`가 필요
    // 없다. 클라이언트 수준 omit은 출력만 가린다 — 참가 OTP를 읽는 유일한
    // 곳은 여전히 마이페이지다(T27).
    const participation = await this.prisma.tournamentParticipation.findUnique({
      where: { tournamentId_playerOtp: { tournamentId, playerOtp: dto.otp } },
      include: {
        user: { select: { nickname: true } },
        tournament: { select: { status: true, startStack: true } },
      },
    });

    // 대회가 없을 때와 OTP가 틀렸을 때를 가르지 않는다. 가르면 존재하는 대회
    // id를 훑을 수 있다 — 딜러 로그인과 같은 이유(`dealer.service.ts:53`).
    if (!participation) {
      throw new UnauthorizedException('인증 정보가 올바르지 않습니다.');
    }
    if (participation.tournament.status === TournamentStatus.FINISHED) {
      throw new ForbiddenException('종료된 대회입니다.');
    }
    if (
      participation.status === PlayerStatus.ELIMINATED ||
      participation.status === PlayerStatus.AWARDED
    ) {
      throw new ConflictException('이미 끝난 참가입니다.');
    }

    // 좌석은 대회 안에서 하나다. 이건 빠른 경로일 뿐 경합의 최종 판정이
    // 아니다 — check-then-act라 같은 OTP가 두 테이블에서 몇 ms 안에
    // 동시에 들어오면 둘 다 이 줄을 `null`로 통과할 수 있다(테이블마다
    // 락이 따로라 서로를 막지 않는다). 진짜 판정은
    // `@@unique([tournamentId, userId])`가 `claimSeat`의 트랜잭션에서
    // `P2002`로 내린다.
    const seated = await this.prisma.tablePlayer.findFirst({
      where: { tournamentId, userId: participation.userId },
    });
    const sameSeat =
      seated !== null &&
      seated.tableId === dto.tableId &&
      seated.seatPosition === dto.seatIndex;
    if (seated && !sameSeat) {
      throw new ConflictException('이미 다른 좌석에 앉아 있습니다. 상점에 문의해주세요.');
    }

    await this.claimSeat(tournamentId, dto, {
      userId: participation.userId,
      participationId: participation.id,
      nickname: participation.user.nickname ?? '',
      // 재입장이면 스냅샷이 없을 수 있고, 그때는 DB의 스택이 유일한 출처다.
      stack: seated?.currentStack ?? participation.tournament.startStack,
      alreadySeated: seated !== null,
    });

    return {
      accessToken: this.jwt.sign({
        sub: participation.userId,
        tournamentId,
        tableId: dto.tableId,
        seatIndex: dto.seatIndex,
        role: SEAT_ROLE,
      }),
    };
  }

  /**
   * 좌석을 DB와 스냅샷에 반영한다.
   *
   * DB 트랜잭션은 락 **밖**에서 돈다. 두 사람이 같은 의자를 노리는 경합의
   * 최종 판정은 `@@unique([tableId, seatPosition])`다 — 트랜잭션이 위반을
   * `P2002`로 돌려주면 늦게 온 쪽이 거기서 끝난다. 트랜잭션을 락 안에 두면,
   * 대회 시작처럼 여러 명이 한꺼번에 들어와 커넥션 풀이 찰 때 트랜잭션이
   * 락의 TTL(5초)보다 오래 걸릴 수 있다. 그러면 락이 말없이 만료되고 두
   * 요청이 임계 구역에 같이 들어가 스냅샷을 서로 지운다 — `payment.service.ts`가
   * 이미 트랜잭션을 락 밖에 두는 이유와 같다.
   *
   * 락이 감싸는 것은 스냅샷 읽기 → 점유자 확인 → 스냅샷 쓰기뿐이다. JSON을
   * 통째로 덮어쓰므로 그 세 단계가 원자적이어야 다른 좌석에 앉는 두 사람이
   * 서로의 착석을 지우지 않는다.
   */
  private async claimSeat(
    tournamentId: string,
    dto: EnterTournamentDto,
    who: Claimant,
  ) {
    // 어떤 쓰기보다도 먼저 확인한다. 트랜잭션이 락 밖에 있으므로, 락 안에서
    // 확인하면 이미 DB에 좌석을 만든 뒤에야 403을 던지는 순서가 된다.
    const table = await this.prisma.table.findUnique({
      where: { tournamentId_id: { tournamentId, id: dto.tableId } },
      select: { id: true },
    });
    if (!table) {
      throw new ForbiddenException('이 대회에 속하지 않은 테이블입니다.');
    }

    if (!who.alreadySeated) {
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.tablePlayer.create({
            data: {
              tournamentId,
              tableId: dto.tableId,
              userId: who.userId,
              nickname: who.nickname,
              seatPosition: dto.seatIndex,
              currentStack: who.stack,
            },
          });
          await tx.tournamentParticipation.update({
            where: { id: who.participationId },
            data: { status: PlayerStatus.PLAYING },
          });
        });
      } catch (e) {
        // 어떤 제약이 걸렸는지로 메시지를 가른다. 드라이버 어댑터
        // (@prisma/adapter-pg) 구성에서는 P2002 메타에 `target`이 없다.
        // 대신 postgres가 준 제약 조건 정보를 필드 이름에 큰따옴표가 붙은
        // 채로 담아 온다(`payment.service.ts:143-163`와 같은 모양).
        const err = e as {
          code?: string;
          meta?: {
            target?: string[];
            driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } };
          };
        };
        if (err.code !== 'P2002') throw e;
        const violatedFields =
          err.meta?.target ?? err.meta?.driverAdapterError?.cause?.constraint?.fields ?? [];
        // seatPosition이 걸리면 자리 싸움(`tableId+seatPosition`)이다.
        // userId만 걸리면(`tableId+userId` 또는 `tournamentId+userId`)
        // 이 사람이 이미 다른 자리에 있다는 뜻이다 — 테이블 안이든
        // 대회 안 다른 테이블이든 메시지는 같다.
        if (violatedFields.some((field) => field.includes('seatPosition'))) {
          throw new ConflictException('이미 다른 참가자가 앉은 좌석입니다.');
        }
        throw new ConflictException('이미 다른 좌석에 앉아 있습니다. 상점에 문의해주세요.');
      }
    }

    await this.redis.withTableLock(dto.tableId, async () => {
      const state =
        (await this.redis.getSnapShot(dto.tableId)) ?? this.emptyTableState(tournamentId);
      const occupant = state.players[dto.seatIndex];
      // 정상 경로라면 여기 도달했을 때 이 좌석은 이미 우리 것으로 DB에
      // 확정돼 있다(방금 트랜잭션이 성공했거나, 재입장이라 원래 우리
      // 것이었다). 그런데도 다른 사용자가 점유자로 남아 있다면 스냅샷이
      // DB와 어긋난 것이다 — 방어용이다.
      if (occupant && occupant.id !== who.userId) {
        throw new ConflictException('이미 다른 참가자가 앉은 좌석입니다.');
      }

      // 이 사람이 이미 스냅샷에 있으면 손대지 않는다. 덮어쓰면 진행 중인
      // 핸드의 bet·hasFolded·totalContributed가 날아간다. 비어 있는 경우만
      // 채우는 것이 곧 "DB는 썼는데 스냅샷을 못 쓰고 죽은" 상태의 복구다.
      if (!occupant) {
        state.players[dto.seatIndex] = {
          id: who.userId,
          tableId: dto.tableId,
          nickname: who.nickname,
          seatIndex: dto.seatIndex,
          stack: who.stack,
          bet: 0,
          // 핸드 도중 착석은 허용이다(늦은 참가). 폴드로 넣으면 팟·차례·
          // 사이드팟 어디에도 끼어들지 않고, 핸드가 끝날 때 resetStatus()가
          // 풀어 준다(`table-engine.ts:281`).
          hasFolded: state.phase !== GamePhase.WAITING,
          isAllIn: false,
          hasChecked: false,
          totalContributed: 0,
        };
        await this.redis.saveSnapShot(dto.tableId, state);
      }
    });

    await this.redis.setUserContext(
      tournamentId, who.userId, dto.tableId, dto.seatIndex, 'ACTIVE',
    );
    await this.redis.updateSeatBitmap(tournamentId, dto.tableId, dto.seatIndex, true);
    const tableStatus = await this.redis.getTournamentTables(tournamentId);
    this.eventEmitter.emit('SEAT_LIST_UPDATED', { tournamentId, state: tableStatus });
  }

  /**
   * 스냅샷이 아직 없는 테이블의 초기 상태.
   *
   * 스냅샷을 만드는 유일한 지점이다(예전에는 결제가 했다). `smallBlind`는
   * `startPreFlop`이 블라인드 구조에서 덮어쓰므로 여기 값은 자리 채움이다.
   */
  private emptyTableState(tournamentId: string): TableState {
    return {
      phase: GamePhase.WAITING,
      players: Array(9).fill(null),
      pot: 0,
      currentBet: 0,
      buttonUser: 0,
      currentTurnSeatIndex: -1,
      sidePots: [],
      ante: false,
      tournamentId,
      smallBlind: 100,
    };
  }
}
