import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
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
  /** 장부(`TournamentParticipation.currentStack`)의 현재 칩. */
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
  private readonly logger = new Logger(EntryService.name);

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
        tournament: { select: { status: true } },
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
      // 칩은 장부(참가 행)에 있다. 결제가 startStack으로 넣고, 핸드마다
      // 체크포인트가 갱신한다. 좌석 행이 사라져도(T29의 해제) 남는다.
      stack: participation.currentStack,
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
   *
   * 권위는 DB에 있고 스냅샷은 그 파생 뷰다. 그래서 락 안에서 **DB 좌석
   * 주인을 다시 조회해** 우리 것임을 확인한 뒤에야 스냅샷을 쓴다. 확인이
   * 끝나면 점유자가 다른 사용자로 보여도 그건 낡은 값이므로 예외를 던지지
   * 않고 **고쳐 쓴다**(아래 상세 근거는 해당 분기의 주석에 있다).
   */
  private async claimSeat(
    tournamentId: string,
    dto: EnterTournamentDto,
    who: Claimant,
  ) {
    // 어떤 쓰기보다도 먼저 확인한다. 트랜잭션이 락 밖에 있으므로, 락 안에서
    // 확인하면 이미 DB에 좌석을 만든 뒤에야 403을 던지는 순서가 된다.
    //
    // 대회 상태를 여기서 함께 읽는다. 락 안에서 다시 읽으면 넣을 이유가 없는
    // 읽기가 TTL 예산만 먹는다.
    //
    // 좌석 수(`_count.tablePlayers`)도 함께 얹는다 — ONGOING이지만 아직 아무도
    // 앉은 적 없는 새 테이블(상점이 `createTable`로 막 연 테이블)과, 사람이
    // 있었는데 Redis가 죽어 스냅샷만 사라진 테이블을 가르는 기준이다. 이
    // 카운트는 이 트랜잭션이 좌석을 만들기 **전**에 읽으므로 지금 들어오는
    // 사람 자신은 세지 않는다.
    const table = await this.prisma.table.findUnique({
      where: { tournamentId_id: { tournamentId, id: dto.tableId } },
      select: {
        id: true,
        tournament: { select: { status: true } },
        _count: { select: { tablePlayers: true } },
      },
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
      // 권위는 DB 행이다. **추론하지 않고 여기서 확인한다.**
      //
      // 예전에는 "여기 도달했다 = DB가 이 좌석을 우리 것으로 확정했다"고
      // 추론했다. 새 입장(방금 트랜잭션이 커밋된 경로)에서는 참이지만,
      // 재입장(`alreadySeated`) 경로에서는 거짓이다 — 그쪽은 트랜잭션을
      // 건너뛰므로 손에 든 것이 `enterSeat` 맨 앞에서 읽은 낡은 스냅일
      // 뿐이고, 그 읽기와 이 지점 사이는 임의로 벌어질 수 있다
      // (`withTableLock`은 5초까지 재시도하고 `resolveWinners`는 같은
      // 락을 여러 블록에 걸쳐 쥔다). 그 사이에 탈락 처리가 끝나면 우리는
      // 이미 DB에 없는 사람인데도 스냅샷에 자신을 되살리고, 새 참가자가
      // 그 좌석을 정당하게 가져갔다면 그 사람을 덮어쓴다.
      //
      // 인덱스 point SELECT 한 번이다. 트랜잭션이 아니므로 트랜잭션을 락
      // 밖으로 뺀 이유(TTL 초과)를 다시 불러들이지 않는다.
      const owner = await this.prisma.tablePlayer.findUnique({
        where: { tableId_seatPosition: { tableId: dto.tableId, seatPosition: dto.seatIndex } },
        select: { userId: true },
      });
      if (owner?.userId !== who.userId) {
        throw new ConflictException('좌석 정보가 바뀌었습니다. 다시 시도해 주세요.');
      }

      const snapshot = await this.redis.getSnapShot(dto.tableId);
      if (!snapshot && table.tournament.status === TournamentStatus.ONGOING && table._count.tablePlayers > 0) {
        // 진행 중인 대회고, 이 테이블에 이미 좌석 행이 있는데 스냅샷이 없다
        // = Redis를 잃었고 아직 재구성되지 않았다. 여기서 emptyTableState로
        // 새 상태를 만들면 이 테이블의 나머지 전원이 스냅샷에서 사라지고
        // buttonUser는 0, smallBlind는 100으로 굳는다. DB에는 다 남아 있는데
        // 스냅샷만 한 명이 된다. 그리고 나중에 도는 재구성이 이미 오염된
        // 위에서 돈다.
        //
        // `_count.tablePlayers === 0`은 다른 뜻이다 — 상점이 `createTable`로
        // 막 연 새 테이블처럼 애초에 아무도 앉은 적 없는 테이블이다. 그런
        // 테이블은 스냅샷이 없는 것이 정상이고(재구성 대상도 아니다 —
        // `RecoveryService`도 좌석 행이 없는 테이블은 건너뛴다), 여기서까지
        // 막으면 새 테이블의 첫 착석이 항상 409를 받는다.
        //
        // 이 가드는 선택이 아니다. 부팅 복구가 실패를 대회 단위로 격리하는
        // 순간(RecoveryService), 스냅샷 없이 서버가 뜨는 상태가 정상 경로에
        // 들어온다. 그때 이 자리가 격리를 파괴로 바꾼다.
        //
        // fallback 자체는 남긴다 — 대회 시작 전 첫 착석이 스냅샷을 만드는
        // 정상 경로다.
        throw new ConflictException('테이블 상태를 복구하는 중입니다. 잠시 후 다시 시도해 주세요.');
      }
      const state = snapshot ?? this.emptyTableState(tournamentId);
      const occupant = state.players[dto.seatIndex];

      // 위에서 DB 주인이 우리임을 확인했으므로, 점유자가 다른 사람이면 그
      // 값은 낡은 것이다. 실제로 그런 창이 있다: 탈락 처리
      // (`eliminatePlayer`)가 DB 행을 지우는 시점과, 다음 핸드 준비
      // (`finishHand`의 `initTable`)가 그 스냅샷 자리를 비우는 시점 사이다
      // (`dealer.service.ts`의 `resolveWinners` 3~5단계). 그 창은 항상
      // 팟이 이미 분배된 뒤(HAND_END)라 지워지는 쪽은 그 핸드를 더 이상
      // 다투지 않는다 — 덮어써도 살아 있는 핸드 상태를 파괴하지 않는다.
      //
      // 그래서 점유자가 다르면 예외를 던지지 않고 **고쳐 쓴다.** 스냅샷은
      // DB에서 파생된 뷰이고, DB가 이 좌석을 우리 것이라고 확정한 이상
      // 낡은 값을 남겨 두는 것보다 지금 진실로 덮는 것이 맞다. 던지면
      // DB에는 이미 우리 좌석이 커밋된 채로 클라이언트만 409를 보고,
      // 재시도해도 `alreadySeated`가 참이 되어 트랜잭션 없이 같은 예외가
      // 반복된다 — 영구히 좌석 없는 PLAYING으로 묶인다.
      //
      // 위 409는 그 덫에 걸리지 않는다. 거기까지 갔다는 것은 DB 주인이 우리가
      // 아니라는 뜻이라 재시도가 `alreadySeated`로 새지 않는다. 우리 행이
      // 사라졌다면 그것을 지운 `eliminatePlayer`가 같은 트랜잭션에서 상태를
      // ELIMINATED로 바꾸므로 앞단 검사에 걸리고, 남이 가져갔다면 재시도는
      // 트랜잭션을 다시 돌아 `tableId+seatPosition`의 P2002로 끝난다.
      //
      // 점유자가 이미 우리 자신이면 손대지 않는다. 덮어쓰면 진행 중인
      // 핸드의 bet·hasFolded·totalContributed가 날아간다.
      if (!occupant || occupant.id !== who.userId) {
        if (occupant) {
          // 조용한 복구는 남겨야 할 사건이다. 스냅샷이 DB와 갈라졌다는
          // 신호이고, 잦아지면 위 "탈락 창"이 아니라 다른 원인이 있다는 뜻이다.
          this.logger.warn(
            `스냅샷 점유자가 DB 좌석 주인과 달라 고쳐 씁니다. ` +
              `tournamentId=${tournamentId} tableId=${dto.tableId} ` +
              `seatIndex=${dto.seatIndex} 스냅샷=${occupant.id} DB=${who.userId}`,
          );
        }
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
