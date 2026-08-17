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
import { tokenTtl } from 'src/auth/token-ttl';
import { GamePhase, TableState, createEmptyTableState } from 'src/game-engine/types';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { isClosedTournament } from 'src/store/session/tournament-status';

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
    // id를 훑을 수 있다 — 딜러 로그인과 같은 이유(`DealerService.loginDealer`).
    if (!participation) {
      throw new UnauthorizedException('인증 정보가 올바르지 않습니다.');
    }
    if (isClosedTournament(participation.tournament.status)) {
      throw new ForbiddenException('닫힌 대회입니다.');
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
      // **좌석 태블릿은 대회 내내 켜져 있다.** 전역 기본값(1시간)으로 두면
      // 한 시간 뒤부터 `POST /ws/ticket`이 401이라 태블릿이 스스로 재접속하지
      // 못한다 — 네 시간짜리 대회면 전원이 겪고, T31의 복구 시나리오와 정면으로
      // 겹친다. 수명만 늘리고 폐기 수단을 붙이지 않는 근거는 `token-ttl.ts`에.
      accessToken: this.jwt.sign(
        {
          sub: participation.userId,
          tournamentId,
          tableId: dto.tableId,
          seatIndex: dto.seatIndex,
          role: SEAT_ROLE,
        },
        { expiresIn: tokenTtl(SEAT_ROLE) },
      ),
    };
  }

  /**
   * 좌석 점유 현황.
   *
   * 가드가 없다 — 좌석 대기 화면은 **앉기 전**에 이걸 읽어야 하는데, 그
   * 시점의 태블릿은 자격 증명이 하나도 없다. 같은 화면이 부르는
   * `POST /tournaments/:id/enter`가 이미 공개인 것과 같은 이유다(OTP 자체가
   * 자격 증명이라 그 앞에 가드를 세울 수 없다).
   *
   * WS(`renderSeatList`)로 하지 않은 이유: 대회 스코프 구독도 티켓을 요구하고
   * (`ws.gateway.ts` handleConnection), 티켓은 JWT를 보고 발급된다. 게이트웨이의
   * "신뢰의 출처가 티켓 소비다"에 예외를 내는 값이 "좌석 도식이 1초 빠르다"뿐이라
   * 폴링을 택했다. 동시 지정의 최종 판정은 그대로 `enter`의 409다.
   */
  async getSeatMap(tournamentId: string) {
    return await this.redis.getTournamentTables(tournamentId);
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
    // 대회 상태와 좌석 수(`_count.tablePlayers`)를 여기서 함께 읽는다 —
    // `shouldBlockEmptySnapshot`(아래)의 입력이다. 락 안에서 다시 읽으면
    // 넣을 이유가 없는 읽기가 TTL 예산만 먹는다. 이 카운트는 아래 트랜잭션이
    // 좌석을 만들기 **전**에 읽으므로 지금 들어오는 사람 자신은 세지 않는다.
    //
    // 락 밖에서 읽으므로 아주 좁은 창이 남는다: 새 테이블에 두 사람이 거의
    // 동시에 들어와 둘 다 `_count === 0`을 읽은 **뒤** 그 사이에 Redis가
    // 유실되면, 늦게 락을 잡은 쪽이 `createEmptyTableState`로 앞선 사람을 지운다.
    // 창은 최대 락 대기(5초)이고 그 안에 Redis가 죽어야 한다 — 가드를 넣기
    // 전보다 좁아졌고, 락 안에 조회를 더하는 비용이 이 확률에 비해 크므로
    // 감수한다(최종 리뷰).
    const table = await this.prisma.table.findUnique({
      where: { tournamentId_id: { tournamentId, id: dto.tableId } },
      select: {
        id: true,
        // `startStack`·`entryFee`는 착석 뒤 평균 스택을 다시 계산할 때 쓴다
        // (`RedisService.seatPlayer`). 여기서 함께 읽어 왕복을 늘리지 않는다.
        tournament: { select: { status: true, startStack: true, entryFee: true } },
        _count: { select: { tablePlayers: true } },
      },
    });
    if (!table) {
      throw new ForbiddenException('이 대회에 속하지 않은 테이블입니다.');
    }

    // 빠른 경로 — 아래 트랜잭션이 좌석을 커밋하기 **전에** 같은 조건을 본다.
    // 이게 없으면: u1이 0번으로 들어와 tablePlayer.create + status=PLAYING이
    // 커밋된 **뒤에야** 락 안에서 409를 받는다. 안내대로 다른 좌석으로
    // 재시도하면 `enterSeat` 맨 앞의 `seated` 검사가 방금 커밋된 0번 행을
    // 찾아 "이미 다른 좌석에 앉아 있습니다"를 던진다 — 부팅 복구 없이는
    // 빠져나올 수 없는 좌석 없는 PLAYING 상태에 묶인다.
    //
    // 락 안의 검사(아래)는 그대로 남긴다 — 스냅샷은 이 지점과 락 사이에도
    // 사라질 수 있으므로 권위 있는 마지막 판정이 필요하다. 이건 그 앞에
    // 세우는 방어선이다.
    const preSnapshot = await this.redis.getSnapShot(dto.tableId);
    if (this.shouldBlockEmptySnapshot(table, preSnapshot)) {
      throw new ConflictException('테이블 상태를 복구하는 중입니다. 잠시 후 다시 시도해 주세요.');
    }

    /** 이번 착석으로 `WAITING`에서 올라간 사람 수. 재입장이면 0이다. */
    let promoted = 0;

    if (!who.alreadySeated) {
      try {
        promoted = await this.prisma.$transaction(async (tx) => {
          await tx.tablePlayer.create({
            data: {
              tournamentId,
              tableId: dto.tableId,
              userId: who.userId,
              nickname: who.nickname,
              seatPosition: dto.seatIndex,
            },
          });

          // **인원수가 오르는 유일한 자리다**(T55). 결제가 아니라 첫 착석이
          // 올린다 — 끝내 안 온 사람은 세지 않아야 최후 1인 판정이 걸린다.
          //
          // `update`가 아니라 `WAITING` 조건을 건 `updateMany`인 이유는
          // **몇 명이 실제로 올라갔는지**가 카운터의 입력이기 때문이다.
          // 좌석을 뗐다가 다시 앉는 사람은 `RELEASED`라 여기서 0을 받는다 —
          // 그 사람은 이미 세고 있었으므로 두 번 세면 안 된다. 탈락 처리가
          // `changed.count`로 줄이는 것과 같은 모양이고, 같은 이유(멱등)다.
          const changed = await tx.tournamentParticipation.updateMany({
            where: { id: who.participationId, status: PlayerStatus.WAITING },
            data: { status: PlayerStatus.PLAYING },
          });
          if (changed.count > 0) {
            await tx.tournament.update({
              where: { id: tournamentId },
              data: { activePlayers: { increment: changed.count } },
            });
          } else {
            // 재입장이다. 상태만 되돌린다(`RELEASED` → `PLAYING`).
            await tx.tournamentParticipation.updateMany({
              where: { id: who.participationId, status: PlayerStatus.RELEASED },
              data: { status: PlayerStatus.PLAYING },
            });
          }
          return changed.count;
        });
      } catch (e) {
        // 어떤 제약이 걸렸는지로 메시지를 가른다. 드라이버 어댑터
        // (@prisma/adapter-pg) 구성에서는 P2002 메타에 `target`이 없다.
        // 대신 postgres가 준 제약 조건 정보를 필드 이름에 큰따옴표가 붙은
        // 채로 담아 온다(`payment.service.ts`의 `joinSession`과 같은 모양).
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

    // 락 안에서 만든 최종 스냅샷을 밖으로 들고 나온다. 브로드캐스트는 락을
    // 놓은 뒤에 한다.
    let seated: TableState | null = null;

    await this.redis.mutateSnapshot(dto.tableId, async (snapshot) => {
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

      if (this.shouldBlockEmptySnapshot(table, snapshot)) {
        throw new ConflictException('테이블 상태를 복구하는 중입니다. 잠시 후 다시 시도해 주세요.');
      }
      const state = snapshot ?? createEmptyTableState(tournamentId);
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
          // 풀어 준다(`TableEngine.resetStatus`).
          hasFolded: state.phase !== GamePhase.WAITING,
          isAllIn: false,
          hasChecked: false,
          totalContributed: 0,
        };
        seated = state;
        return state;
      }

      // 점유자가 이미 우리 자신이다. 손댈 것이 없으므로 쓰지 않고 나간다.
      return null;
    });

    // 전광판이 읽는 카운터를 DB와 맞춘다(T55).
    //
    // **스냅샷을 쓴 뒤여야 한다.** DB 커밋과 스냅샷 쓰기 사이에 이 왕복을
    // 끼우면 "좌석 행은 있는데 스냅샷이 없다"는 창이 그만큼 넓어지고, 그
    // 창을 보는 것이 `shouldBlockEmptySnapshot`이다 — 동시에 들어온 다음
    // 사람이 복구 중이라는 409를 받는다. 실제로 그렇게 만들었다가 동시 착석
    // 스펙이 빨개졌다.
    //
    // 이쪽이 실패하면 DB와 Redis가 어긋나지만, 재기동 복구가 DB의
    // `activePlayers`로 메타를 다시 세우므로(`buildTournamentMeta`) 낫는다.
    await this.redis.seatPlayer(
      tournamentId, promoted, table.tournament.startStack, table.tournament.entryFee,
    );

    await this.redis.setUserContext(
      tournamentId, who.userId, dto.tableId, dto.seatIndex, 'ACTIVE',
    );
    await this.redis.updateSeatBitmap(tournamentId, dto.tableId, dto.seatIndex, true);
    const tableStatus = await this.redis.getTournamentTables(tournamentId);
    this.eventEmitter.emit('SEAT_LIST_UPDATED', { tournamentId, state: tableStatus });

    /*
      **이미 앉아 있는 사람의 화면도 바뀌어야 한다.**

      위 `SEAT_LIST_UPDATED`는 아직 안 앉은 사람의 대기 화면이 듣는 신호다.
      게임 화면을 보고 있는 사람에게는 옆자리가 찬 사실이 가지 않아, 다음
      핸드가 시작될 때까지 빈 자리로 남아 있다 — 테이블을 합쳐 사람이 걸어와
      앉는 장면(T29)이 그대로 이 경로다.

      `game.state.updated`는 게이트웨이가 그 테이블 방에 `renderGame`으로
      흘려보내는 이벤트다. 상태는 락 안에서 저장한 것과 같은 값이다.
    */
    if (seated) this.eventEmitter.emit('game.state.updated', { tableId: dto.tableId, state: seated });
  }

  /**
   * `createEmptyTableState` fallback 대신 던져야 하는가.
   *
   * 조건은 "이 테이블에 이미 좌석 행이 있는데 스냅샷이 없다"다. 좌석 행이
   * 있다는 것은 지킬 상태가 있다는 뜻이고, 스냅샷이 없다는 것은 Redis를
   * 잃었고 아직 재구성(`RecoveryService`)되지 않았다는 뜻이다. 여기서
   * `createEmptyTableState`로 새 상태를 만들면 이 테이블의 나머지 전원이
   * 스냅샷에서 사라지고 buttonUser는 0, smallBlind는 100으로 굳는다 — DB에는
   * 다 남아 있는데 스냅샷만 한 명이 되고, 나중에 도는 재구성이 이미 오염된
   * 위에서 돈다.
   *
   * `_count.tablePlayers === 0`은 다른 뜻이다 — 상점이 `createTable`로 막 연
   * 새 테이블처럼 애초에 아무도 앉은 적 없는 테이블이다. 그런 테이블은
   * 스냅샷이 없는 것이 정상이고(재구성 대상도 아니다 — `RecoveryService`도
   * 좌석 행이 없는 테이블은 건너뛴다), 여기서까지 막으면 새 테이블의 첫
   * 착석이 항상 409를 받는다.
   *
   * **대회 상태는 `ONGOING`만 보지 않는다.** `!== FINISHED`로 넓힌다 — 좌석
   * 행이 있는 테이블에 스냅샷이 없는 것은 PENDING이든 SYNCING이든 ONGOING
   * 이든 똑같이 "Redis를 잃었다"는 뜻이기 때문이다. 좁게 두면 이 구멍이
   * 남는다: PENDING 대회에서 u1·u2가 착석해 스냅샷이 살아 있다가 Redis가
   * 죽거나(FLUSHDB) 24시간 TTL로 스냅샷만 사라지면, u3의 착석이
   * `_count.tablePlayers > 0`인데도 status가 PENDING이라 가드를 피해
   * `createEmptyTableState`로 u3 혼자만 있는 스냅샷을 만든다. 그 위에서 대회가
   * 시작되면(`initializeGame`은 "스냅샷 없으면 거부"만 보고, 이 테이블은
   * 스냅샷이 **있으므로** 통과한다) u1·u2는 영원히 빠진 채 대회가 돈다 —
   * `RecoveryService`는 ONGOING만 훑으므로 스스로 못 고친다.
   *
   * **감수하는 것**: 넓히면 시작 전 대회도 좌석 행이 있는 테이블의 스냅샷
   * 유실에 막힌다 — 상점이 손을 써야 한다(재구성 코드가 PENDING까지
   * 커버하지 않는다. 범위 밖 — PENDING에는 아직 `blindField`가 없어서
   * 재구성이 다른 경로가 된다). 이 리포는 "에러는 시끄럽게 나오는 게 맞다"가
   * 규칙이고, 시작 전에는 칩이 움직인 적도 핸드가 돈 적도 없어 잃는 것이
   * 적다. 조용히 오염된 채 시작하는 것보다 시끄럽게 막는 쪽을 택한다.
   */
  private shouldBlockEmptySnapshot(
    table: { tournament: { status: TournamentStatus }; _count: { tablePlayers: number } },
    snapshot: TableState | null,
  ): boolean {
    return (
      !snapshot &&
      !isClosedTournament(table.tournament.status) &&
      table._count.tablePlayers > 0
    );
  }

}
