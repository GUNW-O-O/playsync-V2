import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PlayerStatus, Prisma, TournamentStatus } from '@prisma/client';
import { CreateBlindStructureDto } from 'shared/dto/blind-structure.dto';
import { CreateTournamentDto, UpdateTournamentDto } from 'shared/dto/tournament.dto';
import { BlindField, Dashboard } from 'shared/types/tournamentMeta';
import { getCurrentBlindLevel, parseBlindStructure } from 'shared/util/util';
import { generateDealerOtp, hashDealerOtp } from 'src/dealer/dealer-otp';
import { OtpAttempts } from 'src/dealer/otp-attempts';
import { GamePhase, TableState } from 'src/game-engine/types';
import { parsePayouts, PrizePayout } from 'src/playsync/prize';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';

/**
 * 대회를 시작할 수 있는 최소 인원.
 *
 * 코드에는 2가 박혀 있었는데 제품 규칙이 아니라 **수동 테스트 편의**였다.
 * 크롬 창을 6개 띄우고 각각 로그인하는 데 드는 시간 때문에 낮춰둔 값이다.
 *
 * 그래서 2를 6으로 바꾸는 것은 답이 아니다 — 로컬에서 다시 못 돌리게 된다.
 * 환경으로 빼되 **기본값은 운영 규칙**이어야 한다. 기본값을 테스트 편의값으로
 * 두면 설정을 빠뜨린 배포가 조용히 2로 뜬다. T10의 `JWT_SECRET='super-secret'`과
 * 같은 실수다.
 *
 * 호출 시점에 읽는 것은 `rebuyTimeoutMs`와 같은 이유다 — 모듈 로드 시점에
 * 고정하면 테스트가 값을 바꿀 수 없다.
 */
function minPlayersToStart(): number {
  return Number(process.env.MIN_PLAYERS_TO_START ?? 6);
}

/**
 * 대회를 시작하려면 상금 분배율이 있어야 한다.
 *
 * 생성 경로는 이미 막고 있지만, 컬럼 기본값이 `[]`라 그 이전에 만들어진 행은
 * 비어 있을 수 있다. 시작한 뒤에 발견하면 이미 사람이 다 앉은 뒤고, 더 나쁘게는
 * 상금을 지급하는 순간까지 아무도 모른다.
 */
function startablePayouts(raw: unknown): PrizePayout[] {
  try {
    return parsePayouts((raw ?? []) as PrizePayout[]);
  } catch (e) {
    throw new BadRequestException(`상금 분배율이 올바르지 않습니다: ${(e as Error).message}`);
  }
}

@Injectable()
export class SessionService {
  constructor(
    private prismaService: PrismaService,
    private redis: RedisService,
    private otpAttempts: OtpAttempts,
    private readonly eventEmitter: EventEmitter2,
  ) { };

  // dealerOtpHash는 어느 조회 경로에도 담아 보내지 않는다 — 해시라도 값이
  // 새어 나가면 오프라인 무차별 대입을 시도할 수 있다.
  async getGameSession(id: string) {
    return await this.prismaService.tournament.findUnique({
      where: { id },
      omit: { dealerOtpHash: true },
      include: {
        tables: true,
        tornamentParticipations: true,
        tablePlayers: true,
        blindStructure: true,
      }
    });
  }


  // 딜러인증시 테이블도 포함
  async getGameSessionWithTables(tournamentId: string) {
    return await this.prismaService.tournament.findUnique({
      where: {
        id: tournamentId,
        status: {
          in: [TournamentStatus.ONGOING, TournamentStatus.PENDING],
        }
      },
      omit: { dealerOtpHash: true },
      include: {
        tables: true,
      },
    });
  }

  // 해당 매장의 전체 토너먼트 정보
  async getStoreAllSessions(storeId: string) {
    return await this.prismaService.tournament.findMany({
      where: {
        storeId: storeId,
      },
      omit: { dealerOtpHash: true },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async createBlind(blindStructure: CreateBlindStructureDto) {
    const blind = await this.prismaService.blindStructure.create({
      data: {
        name: blindStructure.name,
        structure: blindStructure.structure as any,
        storeId: blindStructure.storeId
      }
    })
    return blind;
  }

  async createSession(dto: CreateTournamentDto, blindStructure?: CreateBlindStructureDto) {
    // blindId와 blindStructure 둘 다 선택 인자라 "아무것도 안 넘긴" 호출이
    // 타입상 합법이다. 예전에는 그때 자리 채우기용 문자열이 FK로 들어갔고,
    // 운이 좋으면 외래키 에러로 즉시 죽고 운이 나쁘면 생성만 성공한 뒤
    // startSession의 blindStructure.structure 접근에서 죽었다 — 참가자가
    // 다 앉은 다음에. 기본값을 고치는 대신 입구에서 거부한다.
    if (!dto.blindId && !blindStructure) {
      throw new BadRequestException('블라인드 구조 정보가 필요합니다.');
    }

    // dto.blindId(기존 구조 재사용)가 우선이고, 없을 때만 새로 만든다.
    // 이 시점 이후 blindId는 반드시 실재하는 BlindStructure를 가리킨다.
    let blindId = dto.blindId;
    if (!blindId) {
      const newBlind = await this.prismaService.blindStructure.create({
        data: {
          name: blindStructure!.name,
          structure: blindStructure!.structure as any,
          storeId: blindStructure!.storeId
        }
      })
      blindId = newBlind.id;
    }
    // 분배율은 트랜잭션 밖에서 검증한다. 합이 100이 아닌 대회는 지급하는
    // 순간에야 어긋남이 드러나는데, 그때는 이미 돈이 나간 뒤다.
    let payouts: PrizePayout[];
    try {
      payouts = parsePayouts((dto.prizePayouts ?? []) as PrizePayout[]);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    // 트랜잭션 진입 전에 뽑아 둔다. bcrypt 해싱은 CPU 작업이라 트랜잭션 안에서
    // 돌리면 그동안 DB 커넥션을 잡은 채 기다린다.
    const dealerOtp = generateDealerOtp();
    const dealerOtpHash = await hashDealerOtp(dealerOtp);

    const sessionInfo = await this.prismaService.$transaction(async (tx) => {
      // 1. 기본 게임 세션 생성 (블라인드 구조 연결 및 OTP 생성 포함)
      const session = await tx.tournament.create({
        data: {
          name: dto.name,
          type: dto.type,
          storeId: dto.storeId,
          itmCount: payouts.length,
          prizePayouts: payouts as unknown as Prisma.InputJsonValue,
          blindId: blindId,
          dealerOtpHash,
          startStack: dto.startStack,
          avgStack: dto.startStack,
          entryFee: dto.entryFee,
          rebuyUntil: dto.rebuyUntil,
          isRegistrationOpen: dto.isRegistrationOpen,
        },
      });

      const dealerSession = await tx.dealerSession.create({
        data: { tournamentId: session.id },
      });

      await tx.table.create({
        data: {
          tableOrder: 1,
          tournamentId: session.id,
          dealerId: dealerSession.id,
        }
      });
      const updatedSession = await tx.tournament.findUnique({
        where: { id: session.id },
        omit: { dealerOtpHash: true },
        include: {
          tables: true,
        }
      });
      return updatedSession;
    });
    if (!sessionInfo) throw new InternalServerErrorException('세션을 만들지 못했습니다.');
    await this.redis.setSeatBitmap(sessionInfo.id, sessionInfo.tables[0].id);

    // 평문은 여기 한 번만 실린다. 저장은 해시로만 했으므로 이후로는 어디에도
    // 남지 않는다 — 상점 콘솔이 이 응답을 보여주는 것이 유일한 열람 경로다.
    return { ...sessionInfo, dealerOtp };
  }

  /**
   * 테이블을 하나 더 연다. 상점 콘솔의 버튼이 여기로 온다.
   *
   * 예전에는 착석이 좌석 점유 수를 세어 자동으로 불렀다. 소리 없이 늘어난
   * 테이블에 앉은 손님은 아무도 응대하지 못한다 — 테이블을 여는 것은 딜러를
   * 배치하고 칩을 세팅하는 물리적 행위다.
   *
   * `tableOrder`는 트랜잭션 **안에서** 최댓값을 뽑아 다음 번호를 정한다. 밖에서
   * 뽑으면 동시 호출이 같은 번호를 읽는다. 최종 방어는
   * `@@unique([tournamentId, tableOrder])`다.
   */
  async createTable(tournamentId: string, ownerId: string) {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    const tournament = await this.prismaService.tournament.findUnique({
      where: { id: tournamentId },
      include: { dealerSession: true },
    });
    if (!tournament) throw new NotFoundException('세션을 찾을 수 없습니다.');
    // completeSession이 대회를 닫으며 테이블과 딜러 세션을 함께 지운다.
    // 여기서 만들면 죽은 대회에 테이블이 되살아난다.
    if (tournament.status === TournamentStatus.FINISHED) {
      throw new ConflictException('이미 종료된 대회입니다.');
    }
    if (!tournament.dealerSession) {
      throw new ConflictException('딜러 세션이 없는 대회에는 테이블을 추가할 수 없습니다.');
    }
    const dealerId = tournament.dealerSession.id;

    // Task 2가 만든 private 헬퍼. P2002를 409로 바꾼다.
    const newTable = await this.insertTable(tournamentId, dealerId);

    await this.redis.setSeatBitmap(tournamentId, newTable.id);
    await this.emitSeatList(tournamentId);

    return newTable;
  }

  /**
   * 잘못 연 테이블을 닫는다.
   *
   * **빈 테이블만** 지운다. `TablePlayer`는 `onDelete: Cascade`라 사람이 앉은
   * 테이블을 지우면 참가자 행이 조용히 함께 사라진다 — 참가비를 낸 사람이
   * 장부에서 없어지는 것이라 거부한다.
   *
   * **마지막 하나는 지우지 않는다.** 대회에 테이블이 0개인 상태는 어느 경로도
   * 상정하지 않는다.
   *
   * `tableOrder`는 재정렬하지 않는다. 2번을 지우면 1, 3이 남는다. 번호는
   * 물리 테이블을 가리키므로, 재정렬하면 전광판과 딜러 화면이 부르는 번호가
   * 통째로 바뀌어 방 안의 테이블과 어긋난다.
   */
  async deleteTable(tournamentId: string, tableId: string, ownerId: string) {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    await this.prismaService.$transaction(async (tx) => {
      // 대상 행을 **먼저 잠근다.** 이 한 줄이 아래 점유 검사의 근거 전부다.
      //
      // TablePlayer의 INSERT는 외래키 때문에 부모 Table 행에 FOR KEY SHARE를
      // 자동으로 건다. FOR UPDATE는 그것과 충돌하므로 두 방향 모두 직렬화된다.
      //
      //  - 좌석 확정이 먼저 꽂았고 아직 커밋 전이면, 이 SELECT가 그 커밋까지
      //    막힌다. 풀린 뒤의 점유 검사는 **새 문장**이고 Read Committed는
      //    문장마다 스냅샷을 다시 뜨므로, 방금 커밋된 TablePlayer가 보인다 →
      //    409로 거부한다.
      //  - 이쪽이 먼저 잠갔으면 좌석 확정의 INSERT가 막힌다. 삭제를 커밋하고
      //    나면 그 INSERT는 외래키 위반으로 실패하고, `EntryService.claimSeat`의
      //    트랜잭션이 통째로 롤백된다(T28부터 이 INSERT는 결제가 아니라 입장이
      //    한다). 그쪽을 고칠 필요가 없는 이유가 이것이다 — 충돌하는 락을
      //    이미 걸고 있다.
      //
      // 예전에는 `deleteMany({ where: { ..., tablePlayers: { none: {} } } })`
      // 한 문장이 "구조로 막는다"고 적혀 있었지만 **그 보장은 성립하지 않았다.**
      // NOT EXISTS 서브쿼리는 DELETE 문장의 스냅샷으로 평가된다. DELETE는 그
      // 뒤 동시 INSERT가 쥔 FOR KEY SHARE에 막히는데, 상대가 커밋하면
      // 서브쿼리를 **다시 보지 않고** 그대로 진행한다(EvalPlanQual은 대상 행이
      // UPDATE된 경우만 재평가하고, 여기서는 key-share로 잠겼을 뿐이다).
      // 결과는 삭제 1건 + cascade로 방금 앉은 참가자 소멸이었다. 두 커넥션으로
      // 재현했다.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Table"
        WHERE id = ${tableId} AND "tournamentId" = ${tournamentId}
        FOR UPDATE
      `;
      // 404("테이블을 찾을 수 없습니다")와 아래 409를 구분되는 메시지로 남긴다.
      if (locked.length === 0) throw new NotFoundException('테이블을 찾을 수 없습니다.');

      const occupied = await tx.tablePlayer.count({ where: { tableId } });
      if (occupied > 0) {
        throw new ConflictException('좌석에 참가자가 있는 테이블은 삭제할 수 없습니다.');
      }

      // 마지막 하나는 남긴다. 대회는 테이블이 최소 하나 있다는 전제 위에 서
      // 있다 — `createSession`이 1번을 함께 만들고, `payment.service.ts`의
      // `getTournamentInfo`는 비트맵이 비었을 때 `tables[0]`으로 복구한다.
      // 전부 지우면 그 경로가 빈 배열의 0번을 읽어 참가자 화면이 500이 된다.
      const remaining = await tx.table.count({ where: { tournamentId } });
      if (remaining <= 1) {
        throw new ConflictException('대회의 마지막 테이블은 삭제할 수 없습니다.');
      }

      await tx.table.delete({ where: { id: tableId } });
    });

    await this.redis.removeSeatBitmap(tournamentId, tableId);
    // 스냅샷도 함께 지운다. 남겨두면 24시간 동안 사라진 테이블의 게임 상태가
    // 떠 있고, 같은 id가 다시 쓰이지 않더라도 `completeSession`이 지우는 대상
    // 목록에서는 이미 빠져 있어 영영 남는다.
    await this.redis.deleteTableState(tableId);
    await this.emitSeatList(tournamentId);
  }

  /**
   * 좌석 목록 브로드캐스트.
   *
   * 예전에는 `createTable`이 착석 경로 안에서만 불려서, 바로 뒤의 `buyIn`이
   * 대신 이벤트를 냈다. 상점이 단독으로 부르면 아무도 내지 않아 전광판과
   * 좌석 목록이 새 테이블을 모른다.
   */
  private async emitSeatList(tournamentId: string) {
    const state = await this.redis.getTournamentTables(tournamentId);
    this.eventEmitter.emit('SEAT_LIST_UPDATED', { tournamentId, state });
  }

  /**
   * 다음 번호를 정하고 행을 넣는다.
   *
   * 번호는 **개수가 아니라 최댓값**에서 뽑는다. `deleteTable`이 번호를
   * 재정렬하지 않기 때문이다(그 이유는 `deleteTable`의 주석에 있다). 1·2·3을
   * 만들고 2를 지우면 남는 것은 1과 3인데, 개수는 2라 `count + 1`은 이미
   * 쓰이고 있는 3을 고른다. 유니크 제약이 P2002로 거부하고 아래 409("다시
   * 시도해 주세요")가 나가지만, 다시 눌러도 같은 계산이라 영원히 같은 결과다 —
   * 그 대회의 테이블 추가가 통째로 죽는다. 번호가 비는 것을 감수한 결정이
   * 번호를 세는 쪽과 어긋나 있었다.
   *
   * Read Committed에서는 동시 트랜잭션이 같은 최댓값을 볼 수 있으므로,
   * `@@unique([tournamentId, tableOrder])`가 뒤늦은 쪽을 P2002로 거부한다.
   * 그대로 두면 500이 나가므로 409로 바꾼다 — 이쪽은 다시 누르면 실제로
   * 풀리는 상황이고, 서버 오류가 아니다.
   */
  private async insertTable(tournamentId: string, dealerId: string) {
    try {
      return await this.prismaService.$transaction(async (tx) => {
        const { _max } = await tx.table.aggregate({
          _max: { tableOrder: true },
          where: { tournamentId },
        });
        // 테이블이 하나도 없는 대회면 _max는 null이다. 그때의 첫 번호는 1.
        const nextOrder = (_max.tableOrder ?? 0) + 1;
        return await tx.table.create({
          data: { tableOrder: nextOrder, tournamentId, dealerId },
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('테이블 추가가 동시에 요청되었습니다. 다시 시도해 주세요.');
      }
      throw e;
    }
  }

  /**
   * 대회를 실제로 시작한다.
   *
   * 두 단계의 성격이 다르다. `initializeGame`은 **준비** — 게임 상태를 Redis에
   * 올리는 일이고, 이 시점에는 아직 아무도 그것을 보지 않는다. 그래서 실패해도
   * 되돌릴 것이 없다. 여기 커밋이 **시작** — 웹이 읽는 것은 DB이므로, 참가자
   * 눈에 "시작했다"가 보이는 순간이 바로 이 한 줄이다.
   *
   * 순서가 이 방향이어야 하는 이유: 반대면 Redis가 실패했을 때 DB만 진행 중으로
   * 남고 되돌릴 수 없다 — 이미 커밋된 뒤다. 참가자에게는 시작한 것으로 보이는데
   * 실제 게임 상태는 어디에도 없다.
   *
   * 예전에는 `initializeGame`이 `startedAt`과 참가자 `PLAYING`을 먼저 커밋하고
   * Redis를 나중에 썼다. 준비 단계가 시작 사실을 써버린 셈이다.
   *
   * 실패하면 `PENDING`으로 남으므로 **시작 버튼을 다시 누르는 것이 곧 재시도**다.
   * T9처럼 별도의 재시도 명령이 필요 없는 것은, 준비 단계가 전부 덮어쓰기라
   * 몇 번을 돌려도 같은 결과이기 때문이다.
   */
  async startSession(id: string) {
    const { startedAt } = await this.initializeGame(id);

    return await this.prismaService.$transaction(async (tx) => {
      await tx.tournamentParticipation.updateMany({
        where: { tournamentId: id },
        data: { status: PlayerStatus.PLAYING },
      });
      // startedAt은 준비 단계가 정한 값을 그대로 쓴다. 여기서 다시 찍으면
      // Redis의 블라인드 기준 시각과 어긋난다 — 블라인드 레벨은 startedAt으로
      // 부터의 경과 시간으로 계산되므로, DB를 읽는 쪽은 다른 레벨을 얻는다.
      return await tx.tournament.update({
        where: { id },
        data: { status: TournamentStatus.ONGOING, startedAt },
        omit: { dealerOtpHash: true },
      });
    });
  }

  /** 게임 상태를 Redis에 올린다. 아직 시작이 아니다 — 커밋은 호출자가 한다. */
  private async initializeGame(id: string) {
    // 1. DB에서 세션과 모든 테이블/플레이어 정보를 한 번에 가져옴
    const game = await this.prismaService.tournament.findUnique({
      where: { id },
      include: {
        tables: {
          include: {
            tablePlayers: true,
          }
        },
        blindStructure: true,
      }
    });

    const startedAt = new Date();
    if (!game) throw new NotFoundException('세션을 찾을 수 없습니다.');
    const blindStructure = parseBlindStructure(game.blindStructure.structure);
    const blindInfo = getCurrentBlindLevel(blindStructure, startedAt.getTime());

    const dashboard: Dashboard = {
      isRegistrationOpen: game.isRegistrationOpen,
      totalPlayer: game.totalPlayers,
      activePlayer: game.activePlayers,
      // DB가 누적한 값을 그대로 쓴다. `entryFee * totalPlayers`로 다시 계산하면
      // 같은 금액을 두 방식으로 구하는 셈이라, 참가 경로가 하나라도 달라지면
      // 전광판과 지급이 어긋난다.
      totalBuyinAmount: game.totalBuyinAmount,
      rebuyUntil: game.rebuyUntil,
      avgStack: game.avgStack,
      entryFee: game.entryFee,
      tournamentName: game.name,
      startStack: game.startStack,
      itmCount: game.itmCount,
      prizePool: game.totalBuyinAmount,
      // 금액은 여기서 굳히지 않는다. Redis에서 읽을 때 그때의 풀로 파생된다 —
      // 리바인으로 풀이 커지면 전광판이 따라 올라야 하기 때문이다.
      prizes: startablePayouts(game.prizePayouts).map(p => ({ ...p, amount: 0 })),
    }
    const blindField: BlindField = {
      isBreak: false,
      startedAt: startedAt.getTime(),
      currentBlindLv: blindInfo.currentIndex,
      nextLevelAt: blindInfo.nextLevelAt,
      serverTime: startedAt.getTime(),
      blindStructure: blindStructure,
    }

    const minPlayers = minPlayersToStart();
    if (game.totalPlayers < minPlayers) {
      throw new ConflictException(
        `시작하기에 충분한 인원이 아닙니다. (${game.totalPlayers}/${minPlayers}명)`,
      )
    }

    const seatedTables = game.tables.filter(t => t.tablePlayers.length > 0);

    // 사람이 앉은 테이블에 스냅샷이 없으면 **거부한다.** 예전에는 `return null`로
    // 조용히 빼고 진행했다 — 그 테이블만 상태 없이 시작되고, DB에는 사람이
    // 앉아 있는데 딜러는 첫 액션에서 '테이블 상태를 찾을 수 없습니다'를 이유도
    // 모른 채 본다. 게다가 전부 빠져도 대회는 시작됐다.
    const tableStates = await Promise.all(
      seatedTables.map(async t => {
        const randomCnt = Math.floor(Math.random() * t.tablePlayers.length);
        const btnIdx = t.tablePlayers[randomCnt].seatPosition;

        const initialState = await this.redis.getSnapShot(t.id);
        if (!initialState) return { tableId: t.id, state: null };
        initialState.buttonUser = btnIdx;
        return { tableId: t.id, state: initialState };
      }),
    );

    const missing = tableStates.filter(t => t.state === null).map(t => t.tableId);
    if (missing.length > 0) {
      throw new ConflictException(
        `테이블 상태가 준비되지 않아 시작할 수 없습니다: ${missing.join(', ')}`,
      );
    }

    await this.redis.setTournamentMeta(id, dashboard, blindField);
    await this.redis.saveInitialTableSnapshots(
      tableStates as { tableId: string; state: TableState }[],
    );

    return { startedAt };
  }

  // 세션 완료
  /**
   * 대회를 닫는다. **되돌릴 수 없다** — 테이블과 딜러 세션을 지우고 Redis를
   * 비우므로, 그 뒤에는 누가 몇 등이었고 얼마를 받아야 했는지 재구성할 근거가
   * 남지 않는다.
   *
   * 그래서 정산이 끝난 뒤에만 닫힌다. 걷은 참가비와 나간 상금의 합이 같아야
   * 한다 — 대회 하나의 회계가 맞아떨어졌다는 뜻이다.
   *
   * 마무리가 수동인 것은 설계다. ICM 찹으로 끝나는 대회가 있어 최후 1인이
   * 나오기 전에 관리자가 정산할 수 있어야 한다. 이 게이트는 그 자유를 막지
   * 않는다 — 어떻게 나눴든 합만 맞으면 통과한다.
   */
  async completeSession(id: string) {
    const tournament = await this.prismaService.tournament.findUnique({
      where: { id },
    });
    if (!tournament) throw new NotFoundException('세션을 찾을 수 없습니다.');
    if (tournament.status === TournamentStatus.FINISHED) {
      throw new ConflictException('이미 종료된 세션입니다.');
    }

    const participations = await this.prismaService.tournamentParticipation.findMany({
      where: { tournamentId: id },
      select: { prizeAmount: true },
    });
    const paid = participations.reduce((sum, p) => sum + p.prizeAmount, 0);
    const remaining = tournament.totalBuyinAmount - paid;

    if (remaining !== 0) {
      throw new ConflictException(
        remaining > 0
          ? `상금 정산이 끝나지 않았습니다. ${remaining} 남았습니다.`
          : `지급된 상금이 참가비 총액보다 ${-remaining} 많습니다.`,
      );
    }

    const tables = await this.prismaService.table.findMany({
      where : { tournamentId : id }
    });
    let tableIds: string[] = [];
    tables.forEach(t => {
      tableIds.push(t.id);
    })
    await this.prismaService.$transaction(async (tx) => {
      await tx.tournament.update({
        where: {
          id: id,
        },
        data: {
          status: TournamentStatus.FINISHED,
          finishedAt: new Date(),
        },
      });
      await tx.table.deleteMany({
        where: {
          tournamentId: id,
        },
      });
      await tx.dealerSession.delete({
        where: {
          tournamentId: id,
        },
      });
    });
    await this.redis.deleteTournament(id, tableIds);
  }

  /**
   * 상점 소유권 확인.
   *
   * 재발급은 평문 OTP를 응답에 실어 돌려주고, 내보내기는 딜러 세션을 끊는다.
   * 둘 다 강한 동작이라 역할만 확인하고 지나가면 다른 상점 관리자가 남의
   * 대회의 딜러 접근권을 만들거나 끊을 수 있다.
   *
   * 컨트롤러가 아니라 `reissueDealerOtp`/`revokeDealerSession` 각각의 첫
   * 문장으로 둔다 — 컨트롤러에만 있으면 그 한 줄이 지워져도 서비스 메서드를
   * 직접 부르는 어떤 테스트도, 어떤 다른 호출부도 잡아내지 못한다. 이 검사가
   * 우회 불가능해야 값을 만든다. `store.service.ts`의 `updateStore`/
   * `removeStore`가 `getStoreDetail`을 내부에서 부르는 것과 같은 자리다.
   *
   * `PATCH /store/sessions/:id` 등 기존 경로에는 이 검사가 없다. 그건 이
   * 태스크 이전부터 있던 별도 항목이라 여기서 같이 고치지 않는다.
   */
  async assertTournamentOwnership(tournamentId: string, ownerId: string): Promise<void> {
    const tournament = await this.prismaService.tournament.findUnique({
      where: { id: tournamentId },
      select: { store: { select: { ownerId: true } } },
    });
    if (!tournament) throw new NotFoundException('세션을 찾을 수 없습니다.');
    if (tournament.store.ownerId !== ownerId) {
      throw new ForbiddenException('본인의 매장이 아닙니다.');
    }
  }

  /**
   * 태블릿이 토큰을 잃었을 때 쓰는 탈출구다. 해시로 저장하므로 원본을 다시
   * 보여줄 방법이 없고, 대신 새로 발급한다.
   *
   * 이미 붙어 있는 딜러는 끊지 않는다 — 그들은 갱신으로 살아 있고, 갱신은
   * OTP가 아니라 tokenVersion을 본다.
   */
  async reissueDealerOtp(tournamentId: string, ownerId: string): Promise<{ dealerOtp: string }> {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    const dealerOtp = generateDealerOtp();
    const dealerOtpHash = await hashDealerOtp(dealerOtp);

    await this.prismaService.tournament.update({
      where: { id: tournamentId },
      data: { dealerOtpHash },
    });

    // 재발급은 잠금을 푼다. 잠긴 원인이 남의 오타였다면 상점이 여기서 풀 수
    // 있어야 하고, 공격자였다면 값이 이미 바뀌어 카운터가 의미 없다.
    await this.otpAttempts.clear(tournamentId);

    return { dealerOtp };
  }

  /**
   * 붙어 있는 딜러를 끊는다. 남은 토큰은 만료(최대 1시간)까지 살아 있다.
   *
   * 소유권 확인이 먼저라, 없는 tournamentId를 넘기면 여기서 404로 걸린다
   * (예전에는 검사가 없어 `dealerSession.update`가 P2025를 던지고 그걸
   * 조용히 삼켜 존재하지도 않는 대회에 대해 성공을 돌려줬다).
   *
   * 실재하는 대회인데 딜러 세션 행이 없는 경우는 남아 있다 —
   * `completeSession`이 대회를 닫으며 테이블과 함께 이미 지운 경우다. 그때는
   * 끊을 대상이 없다는 것 자체가 목표 상태(붙어 있는 딜러 없음)가 이미
   * 달성돼 있다는 뜻이라, 상점 콘솔에서 "내보내기"를 누른 사람이 500을 볼
   * 이유가 없다 — 조용히 성공으로 둔다.
   */
  async revokeDealerSession(tournamentId: string, ownerId: string): Promise<void> {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    try {
      await this.prismaService.dealerSession.update({
        where: { tournamentId },
        data: { tokenVersion: { increment: 1 } },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        return;
      }
      throw e;
    }
  }

  // 세션 수정
  async updateSession(id: string, dto: UpdateTournamentDto) {
    const session = await this.getGameSession(id);
    if (session?.status === TournamentStatus.FINISHED) {
      throw new ConflictException('종료된 세션은 수정할 수 없습니다.');
    }
    const updateData: any = {
      name: dto.name,
      blindId: dto.blindId,
      startStack: dto.startStack,
      rebuyUntil: dto.rebuyUntil,
      entryFee: dto.entryFee,
    };

    // 수정 경로에도 같은 검증이 걸려야 한다. 생성만 막으면 만든 뒤에 고쳐서
    // 합이 100이 아닌 대회를 만들 수 있다.
    if (dto.prizePayouts) {
      try {
        const payouts = parsePayouts(dto.prizePayouts as PrizePayout[]);
        updateData.prizePayouts = payouts as unknown as Prisma.InputJsonValue;
        updateData.itmCount = payouts.length;
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
    }
    return await this.prismaService.tournament.update({
      where: {
        id: id,
      },
      data: updateData,
      omit: { dealerOtpHash: true },
    });
  }

  /**
   * 상점이 좌석에서 사람을 뗀다.
   *
   * 시스템은 누구를 어디로 보낼지 정하지 않는다. 상점이 체크한 사람을 뗄
   * 뿐이고, 그 사람은 걸어가서 빈 자리에 앉아 자기 참가 OTP를 넣는다(T28).
   * 자동 밸런싱은 하지 않기로 한 것이다 — 언제 누구를 어디로 보낼지는 규칙이
   * 아니라 현장 판단이다.
   *
   * **트랜잭션이 락 안에 있다.** T28의 입장은 반대로 락 밖에 두는데, 그
   * 근거는 대회 시작에 수십 명이 한꺼번에 들어와 커넥션 풀이 차는 상황이었다.
   * 해제는 상점 운영자 한 명의 조작이고 행이 최대 9개다. 이 리포의 실제 규칙은
   * "트랜잭션 금지"가 아니라 **기다림이 무한정인 일 금지**다 —
   * `resolveWinners`가 3단계(탈락 확정)는 락 안에서 돌리고 2단계(사람이 리바인
   * 수락을 기다림)와 4단계(백오프 재시도)만 락 밖으로 뺀 것이 그 증거다.
   *
   * **그런데 레디스 락은 좌석의 DB 쓰기를 직렬화하지 않는다.** T28이 입장의
   * 트랜잭션을 락 밖으로 뺐기 때문에 입장은 테이블 락을 건드리지 않고
   * `TablePlayer`를 INSERT한다. 그래서 `deleteTable`과 같은
   * `SELECT ... FOR UPDATE`가 필요하다 — INSERT가 부모 `Table` 행에 거는
   * `FOR KEY SHARE`와 충돌해 두 방향 모두 직렬화된다.
   */
  async releaseSeats(
    tournamentId: string,
    tableId: string,
    seats: { seatIndex: number; userId: string }[],
    ownerId: string,
  ) {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    await this.redis.withTableLock(tableId, async () => {
      const state = await this.redis.getSnapShot(tableId);
      if (!state) throw new NotFoundException('테이블 상태를 찾을 수 없습니다.');

      // 핸드 중에는 자리가 움직이지 않는다. 이 가드 하나가 팟·차례·폴드
      // 상태·사이드팟을 전부 비껴간다. T28은 이 가드를 쓰지 않았다 — 신규
      // 착석은 핸드 도중이어도 폴드 상태로 들어가 아무것에도 끼지 않는다.
      // 이미 앉은 사람을 빼는 것은 다르다.
      if (state.phase !== GamePhase.WAITING) {
        throw new ConflictException('핸드 진행 중에는 좌석을 해제할 수 없습니다.');
      }

      // 검사 1 — 스냅샷(게임의 진실). 상점 화면이 낡았으면 여기서 걸린다.
      for (const s of seats) {
        if (state.players[s.seatIndex]?.id !== s.userId) {
          throw new ConflictException('좌석 정보가 바뀌었습니다. 화면을 새로 고쳐 주세요.');
        }
      }

      const seatIndexes = seats.map(s => s.seatIndex);
      const userIds = seats.map(s => s.userId);

      await this.prismaService.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Table"
          WHERE id = ${tableId} AND "tournamentId" = ${tournamentId}
          FOR UPDATE
        `;
        if (locked.length === 0) throw new NotFoundException('테이블을 찾을 수 없습니다.');

        // 검사 2 — DB(좌석의 진실). 위 SELECT가 풀린 뒤의 **새 문장**이라
        // Read Committed가 스냅샷을 다시 뜬다. 방금 커밋된 입장이 보인다.
        const rows = await tx.tablePlayer.findMany({
          where: { tableId, seatPosition: { in: seatIndexes } },
          select: { seatPosition: true, userId: true },
        });
        const matched = rows.length === seats.length
          && seats.every(s => rows.some(r => r.seatPosition === s.seatIndex && r.userId === s.userId));
        if (!matched) {
          throw new ConflictException('좌석 정보가 바뀌었습니다. 화면을 새로 고쳐 주세요.');
        }

        await tx.tablePlayer.deleteMany({ where: { tableId, seatPosition: { in: seatIndexes } } });
        // 칩은 건드리지 않는다. 좌석만 사라지고 장부는 남는다(T29의 이사).
        await tx.tournamentParticipation.updateMany({
          where: { tournamentId, userId: { in: userIds } },
          data: { status: PlayerStatus.WAITING },
        });
      });

      for (const s of seats) state.players[s.seatIndex] = null;
      await this.redis.saveSnapShot(tableId, state);
    });

    // 락 밖. 비트맵은 필드 단위 원자 연산이라 락이 필요 없다.
    for (const s of seats) {
      await this.redis.updateSeatBitmap(tournamentId, tableId, s.seatIndex, false);
      await this.redis.deleteUserContext(tournamentId, s.userId);
    }
    await this.emitSeatList(tournamentId);
  }
}
