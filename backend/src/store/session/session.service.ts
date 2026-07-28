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
   * `tableOrder`를 트랜잭션 **안에서** 센다. 밖에서 세면 동시 호출이 같은
   * 번호를 읽는다. 최종 방어는 `@@unique([tournamentId, tableOrder])`다.
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
   * `tableOrder`는 재정렬하지 않는다. 2번을 지우면 1, 3이 남는다. 번호는
   * 물리 테이블을 가리키므로, 재정렬하면 전광판과 딜러 화면이 부르는 번호가
   * 통째로 바뀌어 방 안의 테이블과 어긋난다.
   */
  async deleteTable(tournamentId: string, tableId: string, ownerId: string) {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    const table = await this.prismaService.table.findFirst({
      where: { id: tableId, tournamentId },
      include: { _count: { select: { tablePlayers: true } } },
    });
    if (!table) throw new NotFoundException('테이블을 찾을 수 없습니다.');
    if (table._count.tablePlayers > 0) {
      throw new ConflictException('좌석에 참가자가 있는 테이블은 삭제할 수 없습니다.');
    }

    await this.prismaService.table.delete({ where: { id: tableId } });
    await this.redis.removeSeatBitmap(tournamentId, tableId);
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
   * 번호를 세고 행을 넣는다.
   *
   * Read Committed에서는 동시 트랜잭션이 같은 count를 볼 수 있으므로,
   * `@@unique([tournamentId, tableOrder])`가 뒤늦은 쪽을 P2002로 거부한다.
   * 그대로 두면 500이 나가므로 409로 바꾼다 — 다시 누르면 되는 상황이고,
   * 서버 오류가 아니다.
   */
  private async insertTable(tournamentId: string, dealerId: string) {
    try {
      return await this.prismaService.$transaction(async (tx) => {
        const tableCount = await tx.table.count({ where: { tournamentId } });
        return await tx.table.create({
          data: { tableOrder: tableCount + 1, tournamentId, dealerId },
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

  // 플레이어 자리 옮기기
  async manualMovingPlayer() {
    // 플레이어끼리 위치변경

    // 빈자리에 채우기
  }


}
