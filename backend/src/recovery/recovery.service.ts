import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PlayerStatus, TournamentStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { buildTournamentMeta } from 'src/store/session/tournament-meta';
// 엔진의 좌석 타입과 Prisma 모델 이름이 둘 다 `TablePlayer`다. 이 파일은
// 양쪽을 다 쓰므로 import에서 가른다.
import { TablePlayer as SeatPlayer, TableState, GamePhase } from 'src/game-engine/types';

@Injectable()
export class RecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async onApplicationBootstrap() {
    await this.recoverAll();
  }

  /**
   * 하트비트가 마지막으로 찍힌 뒤 흐른 시간. 행이 없으면 `null`(최초 부팅).
   *
   * 임계값을 두지 않는다. 정상 재시작 5초도 5초 밀리는데 그게 맞다 — 그 5초
   * 동안 대회는 진짜로 돌지 않았다. "얼마 이상이면 장애"를 정하면 그 미만의
   * 정지가 조용히 진행 시간으로 들어간다.
   */
  async downtimeMs(): Promise<number | null> {
    const beat = await this.prisma.serverHeartbeat.findUnique({
      where: { id: 'singleton' },
    });
    if (!beat) return null;
    return Math.max(0, Date.now() - beat.beatAt.getTime());
  }

  /**
   * 부팅 복구. **서버는 무슨 장애였는지 추측하지 않는다** — 지금 무엇이
   * 없는지만 본다.
   *
   * 실패는 대회 단위로 격리한다. 대회 하나 때문에 프로세스가 안 뜨면 다른
   * 대회까지 서비스가 없어진다. 조용해지는 것이 아니다 — 실패한 대회는
   * Redis 키가 계속 없으므로 게임 경로가 전부 던지고 딜러가 첫 액션에서 안다.
   * 그 안전성은 `entry`의 빈 스냅샷 fallback 금지에 의존한다(Task 3).
   */
  async recoverAll(): Promise<void> {
    const downtime = await this.downtimeMs();
    if (downtime === null) {
      this.logger.log('하트비트가 없다 — 최초 부팅으로 보고 정지 시간 보정을 건너뛴다');
    }

    const tournaments = await this.prisma.tournament.findMany({
      where: { status: TournamentStatus.ONGOING },
      select: { id: true },
    });

    for (const t of tournaments) {
      try {
        await this.recoverTournament(t.id, downtime ?? 0);
      } catch (e) {
        this.logger.error(`대회 복구 실패 (tournament=${t.id})`, e as Error);
      }
    }
  }

  private async recoverTournament(tournamentId: string, downtime: number) {
    // 1. 누적 정지 시간을 더한다. increment이지 대입이 아니다 — 대회 하나가
    //    두 번 장애를 겪으면 Redis 기준점은 이미 첫 번째만큼 밀려 있다.
    const t = downtime > 0
      ? await this.prisma.tournament.update({
          where: { id: tournamentId },
          data: { pausedMs: { increment: downtime } },
          include: { blindStructure: true },
        })
      : await this.prisma.tournament.findUniqueOrThrow({
          where: { id: tournamentId },
          include: { blindStructure: true },
        });

    // 2. **대회 단위**로 블라인드 기준점을 다룬다. blindField는 대회 하나에
    //    하나(`tournament:{id}:info`)이므로, 테이블 루프 안에서 밀면 테이블
    //    수만큼 밀린다.
    const blind = await this.redis.getTournamentBlind(tournamentId);
    if (blind) {
      if (downtime > 0) {
        await this.redis.setTournamentBlind(tournamentId, {
          ...blind,
          startedAt: blind.startedAt + downtime,
        });
      }
    } else {
      // 메타를 통째로 잃었다. DB로 다시 세운다. 기준점은 대회가 실제로
      // 시작한 시각에 누적 정지를 더한 값이다.
      if (!t.startedAt) throw new Error('ONGOING인데 startedAt이 없다');
      const { dashboard, blindField } = buildTournamentMeta(
        t,
        t.startedAt.getTime() + t.pausedMs,
      );
      await this.redis.setTournamentMeta(tournamentId, dashboard, blindField);
    }

    // 3. **테이블 단위**로 Redis 키 셋을 본다. 대회 하나 안에서 어떤 테이블은
    //    살아 있고 어떤 테이블만 유실될 수 있다(부분 유실). orderBy는 순서
    //    보장이 필요해서가 아니라(테이블마다 독립적으로 격리되므로 순서는
    //    결과에 영향이 없다) 테스트를 결정적으로 만들기 위함이다.
    const tables = await this.prisma.table.findMany({
      where: { tournamentId },
      orderBy: { tableOrder: 'asc' },
      select: {
        id: true,
        buttonUser: true,
        tablePlayers: { select: { userId: true, nickname: true, seatPosition: true } },
      },
    });

    for (const table of tables) {
      if (table.tablePlayers.length === 0) {
        // 세울 게임 상태가 없다. 그래도 좌석 비트맵 **필드**가 없으면
        // (Redis를 통째로 잃은 경우) 이 테이블이 좌석 목록에서 사라진다 —
        // `getTournamentTables`는 hgetall이라 필드가 없는 테이블은 아예
        // 안 보인다. 필드가 이미 있으면(정상적인 빈 테이블) 손대지 않는다.
        const bitmap = await this.redis.getTableSeatStatus(tournamentId, table.id);
        if (bitmap.length === 0) {
          await this.redis.rebuildSeatBitmap(tournamentId, table.id, []);
        }
        continue;
      }

      const existing = await this.redis.getSnapShot(table.id);
      if (existing) continue; // 살아 있다. 스냅샷에는 시간이 없으므로 손댈 것이 없다.

      // 테이블 단위로 격리한다. 한 테이블의 재구성이 실패해도(예: 앉힐
      // PLAYING이 아무도 없다) 같은 대회의 다른 테이블까지 통째로 접히면
      // 안 된다 — `recoverAll`의 대회 단위 catch만으로는 이 루프 중간에
      // 던지는 순간 이후 테이블이 전부 스킵된다.
      try {
        await this.rebuildTable(tournamentId, table);
      } catch (e) {
        this.logger.error(`테이블 재구성 실패 (table=${table.id})`, e as Error);
      }
    }
  }

  /**
   * 스냅샷을 잃은 테이블 하나를 DB로 세운다.
   *
   * **핸드 경계에서 재개한다.** phase는 WAITING이고 pot·bet·currentTurn은 0이다.
   * 핸드 중간 상태는 체크포인트 사이에만 존재하므로 복구되지 않는다 — 카드가
   * 물리라 그 핸드는 사람이 다시 딜한다. 시스템이 지킬 선은 "다음 핸드가 옳은
   * 사람에게서 시작된다"까지다.
   *
   * 락을 잡지 않는다. 부팅 시점이라 경합할 상대가 없고, 스냅샷이 없으면 모든
   * 게임 경로가 던진다. 유일한 예외인 `entry`는 같은 티켓에서 막았다.
   */
  private async rebuildTable(tournamentId: string, table: {
    id: string;
    buttonUser: number | null;
    tablePlayers: { userId: string; nickname: string | null; seatPosition: number }[];
  }) {
    // 장부는 참가 행이다. **좌석 행만 보면 안 된다** — T29 이후 ELIMINATED와
    // AWARDED는 좌석 행이 남아 있을 수 있어서, 좌석만 보면 탈락자와 우승자를
    // 되살린다.
    const participations = await this.prisma.tournamentParticipation.findMany({
      where: {
        tournamentId,
        userId: { in: table.tablePlayers.map(p => p.userId) },
        status: PlayerStatus.PLAYING,
      },
      select: { userId: true, currentStack: true },
    });
    const stackOf = new Map(participations.map(p => [p.userId, p.currentStack]));

    // 대회 단위(2단계)가 이미 기준점을 밀어 뒀다. 여기서 캐시된 값을 그냥
    // 읽으면(getTournamentBlind) 유실 직전에 마지막으로 폴링된 낡은 레벨이
    // 나올 수 있다 — startPreFlop이 다음 핸드에서 어차피 덮어쓰므로 게임에는
    // 무해하지만, 재구성이 세우는 첫 스냅샷 값 자체는 지금 시점의 진짜 레벨과
    // 다를 수 있다. checkAndSyncBlindLevel로 지금 시각 기준 레벨을 강제
    // 재계산한다.
    const blind = await this.redis.checkAndSyncBlindLevel(tournamentId);
    if (!blind) throw new Error(`블라인드 정보가 없다 (tournament=${tournamentId})`);
    const level = blind.blindStructure[blind.currentBlindLv];

    const players: (SeatPlayer | null)[] = Array(9).fill(null);
    const seated: number[] = [];
    for (const p of table.tablePlayers) {
      const stack = stackOf.get(p.userId);
      if (stack === undefined) continue; // PLAYING이 아니다. 앉히지 않는다.
      players[p.seatPosition] = {
        id: p.userId,
        tableId: table.id,
        nickname: p.nickname ?? '',
        seatIndex: p.seatPosition,
        stack,
        bet: 0,
        hasFolded: false,
        hasChecked: false,
        isAllIn: false,
        totalContributed: 0,
      };
      seated.push(p.seatPosition);
    }

    // `Table.buttonUser`가 null인 것은 버그가 아니다 — 채우는 자리는 핸드
    // 종료 체크포인트뿐이라(시작 트랜잭션은 "그 시점에 사람이 앉아 있던"
    // 테이블만 채운다), null은 "이 테이블이 핸드를 끝낸 적이 없다"와 같은
    // 뜻이다. 대회 시작 시점에 비어 있던 테이블, 대회 도중 `createTable`로
    // 새로 연 테이블이 둘 다 이 상태로 들어온다. 핸드를 끝낸 적 없는
    // 테이블에서는 앉은 누구나 정당한 첫 버튼이므로, `initializeGame`이
    // 시작 시점에 하는 것과 같은 방식(무작위)으로 뽑는다.
    //
    // 앉힐 사람이 아무도 없으면(PLAYING이 하나도 없다) 뽑을 근거가 없다 —
    // 이때만 이 테이블의 재구성을 실패로 본다. `Table.buttonUser`에 다시
    // 쓰지는 않는다. 다음 핸드 종료 체크포인트가 정식으로 채운다.
    const buttonUser = table.buttonUser ?? this.drawFirstButton(table.id, seated);

    const state: TableState = {
      phase: GamePhase.WAITING,
      players,
      buttonUser,
      currentTurnSeatIndex: -1,
      pot: 0,
      sidePots: [],
      currentBet: 0,
      smallBlind: level.sb,
      ante: level.ante,
      tournamentId,
    };

    await this.redis.saveSnapShot(table.id, state);

    // 스냅샷만 세우면 나머지가 어긋난다. 좌석 비트맵이 없으면 `entry`가 좌석을
    // 비어 있는 것으로 보고 다른 사람에게 판다.
    await this.redis.rebuildSeatBitmap(tournamentId, table.id, seated);

    // 유저 컨텍스트는 지금 읽는 곳이 한 군데뿐이고(playsync.service.ts:120의
    // isKicked), 재구성이 PLAYING만 앉히므로 킥된 사람은 스냅샷에 없다 — 즉
    // 안 세워도 지금은 틀리지 않는다. 그래도 세운다: 착석과 컨텍스트가 짝이라는
    // 불변식(entry.service.ts:267)을 재구성만 예외로 두면, 이 키를 읽는 코드가
    // 하나 붙는 순간 조용히 깨진다. 값은 `entry.service.ts`가 착석 때 쓰는
    // 것과 같은 'ACTIVE'다 — 'PLAYING'을 쓰면 어휘가 갈려서, 나중에
    // `=== 'ACTIVE'`를 보는 코드가 하나 붙는 순간 재구성된 행만 조용히
    // 달라진다.
    for (const seat of seated) {
      const p = players[seat]!;
      await this.redis.setUserContext(tournamentId, p.id, table.id, seat, 'ACTIVE');
    }

    this.logger.warn(
      `테이블을 DB로 재구성했다 (table=${table.id}, 좌석 ${seated.length}개, 버튼 ${buttonUser})`,
    );
  }

  /**
   * 핸드를 한 번도 끝낸 적 없는 테이블의 첫 버튼을 뽑는다.
   * `initializeGame`(`session.service.ts`)이 대회 시작 시점에 하는 것과 같은
   * 방식 — 앉은 사람 중 무작위. 앉힐 사람이 없으면 뽑을 근거가 없으므로
   * 이 테이블의 재구성 자체를 실패로 본다(호출자의 테이블 단위 격리가 잡는다).
   */
  private drawFirstButton(tableId: string, seated: number[]): number {
    if (seated.length === 0) {
      throw new Error(`앉힐 사람이 없어 첫 버튼을 뽑을 수 없다 (table=${tableId})`);
    }
    return seated[Math.floor(Math.random() * seated.length)];
  }
}
