import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PlayerStatus, TournamentStatus } from '@prisma/client';
import { CreateBlindStructureDto } from 'shared/dto/blind-structure.dto';
import { CreateTournamentDto, UpdateTournamentDto } from 'shared/dto/tournament.dto';
import { BlindField, Dashboard } from 'shared/types/tournamentMeta';
import { getCurrentBlindLevel, parseBlindStructure } from 'shared/util/util';
import { GamePhase, TableState } from 'src/game-engine/types';
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

@Injectable()
export class SessionService {
  constructor(
    private prismaService: PrismaService,
    private redis: RedisService,
  ) { };

  async getGameSession(id: string) {
    return await this.prismaService.tournament.findUnique({
      where: { id },
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
    const sessionInfo = await this.prismaService.$transaction(async (tx) => {
      // 1. 기본 게임 세션 생성 (블라인드 구조 연결 및 OTP 생성 포함)
      const session = await tx.tournament.create({
        data: {
          name: dto.name,
          type: dto.type,
          storeId: dto.storeId,
          itmCount: dto.itmCount,
          blindId: blindId,
          dealerOtp: Math.floor(1000 + Math.random() * 9000), // 4자리 OTP [cite: 9]
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
        include: {
          tables: true,
        }
      });
      return updatedSession;
    });
    if (!sessionInfo) throw new InternalServerErrorException('세션을 만들지 못했습니다.');
    await this.redis.setSeatBitmap(sessionInfo.id, sessionInfo.tables[0].id);
  }

  async createTable(tournamentId: string) {
    const tournament = await this.prismaService.tournament.findUnique({
      where: { id: tournamentId },
      include: { tables: true, dealerSession: true },
    });
    if (!tournament) throw new NotFoundException('세션을 찾을 수 없습니다.');
    const tableCount = tournament.tables.length;
    const newTable = await this.prismaService.$transaction(async (tx) => {
      const table = await tx.table.create({
        data: {
          tableOrder: tableCount + 1,
          tournamentId: tournament.id,
          dealerId: tournament.dealerSession!.id,
        }
      });
      return table;
    });
    await this.redis.setSeatBitmap(tournamentId, newTable.id);
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
      totalBuyinAmount: game.entryFee * game.totalPlayers,
      rebuyUntil: game.rebuyUntil,
      avgStack: game.avgStack,
      entryFee: game.entryFee,
      tournamentName: game.name,
      startStack: game.startStack,
      itmCount: game.itmCount,
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
  async completeSession(id: string) {
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
      itmCount: dto.itmCount,
      entryFee: dto.entryFee,
    };
    return await this.prismaService.tournament.update({
      where: {
        id: id,
      },
      data: updateData,
    });
  }

  // 플레이어 자리 옮기기
  async manualMovingPlayer() {
    // 플레이어끼리 위치변경

    // 빈자리에 채우기
  }


}
