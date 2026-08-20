import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PlayerStatus, TournamentStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { buildTournamentMeta } from 'src/store/session/tournament-meta';
import { deriveAnteAmount } from 'shared/util/util';
// 엔진의 좌석 타입과 Prisma 모델 이름이 둘 다 `TablePlayer`다. 이 파일은
// 양쪽을 다 쓰므로 import에서 가른다.
import {
  TablePlayer as SeatPlayer,
  TableState,
  GamePhase,
  createEmptyTableState,
} from 'src/game-engine/types';

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
    try {
      const downtime = await this.downtimeMs();
      if (downtime === null) {
        this.logger.log('하트비트가 없다 — 최초 부팅으로 보고 정지 시간 보정을 건너뛴다');
      }

      // 읽은 다운타임을 **소비 표시**한다. `HeartbeatService.beatOnce()`를
      // 그대로 재사용하지 않는 이유는 그쪽이 Redis ping 성공을 조건으로 걸기
      // 때문이다 — Redis가 아직 안 올라왔으면 찍지 않는데, Redis가 죽어
      // 있다는 사실은 "이 구간은 이미 다운타임에 계상됐다"는 사실을 바꾸지
      // 않는다. 그래서 여기서는 조건 없이 찍는다.
      //
      // 이 줄이 없으면: 하트비트 주기(30초) 안에 프로세스가 다시 뜰 때마다
      // (컨테이너 재시작 루프, dev watch 재시작, 장애 중 운영자의 연속
      // 재시작) 같은 구간을 몇 번이고 또 더한다 — `pausedMs`가 재시작
      // 횟수에 비례해 불어나고, 되돌릴 API도 화면도 없다.
      //
      // **감수 지점.** 루프 **앞**에서 찍으므로, 아래 루프 중간에 프로세스가
      // 죽으면 아직 처리하지 못한 대회는 이번 다운타임 보정을 잃는다. 그
      // 손실은 유한하고 한 방향이다(과소계상 = 블라인드가 조금 앞선다) —
      // 위에서 설명한 무한하고 누적되는 손실보다 낫다는 판단이다. 대회별로
      // 소비 표시를 따로 남기려면 `Tournament`에 `recoveredBeatAt` 같은
      // 컬럼이 필요한데, 이 티켓 범위에서는 과하다.
      const now = new Date();
      await this.prisma.serverHeartbeat.upsert({
        where: { id: 'singleton' },
        create: { id: 'singleton', beatAt: now },
        update: { beatAt: now },
      });

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
    } catch (e) {
      // `downtimeMs()`·위 하트비트 갱신·`tournament.findMany`는 대회
      // 하나에 걸린 일이 아니라 이 함수 자체의 전제라, 위 대회 단위 catch가
      // 감싸지 못한다. 여기서 안 잡으면 `onApplicationBootstrap`이 실패해
      // 프로세스가 `listen()` 앞에서 멈춘다 — 헬스체크가 있는 배치에서는
      // 그 자체가 재시작 루프의 방아쇠가 되고, 그 루프가 위 하트비트 소비
      // 표시가 막으려는 문제를 다시 증폭시킨다. "복구 실패가 서비스 부재보다
      // 낫다"는 판단은 이 파일 전체의 전제다 — 대회 단위 실패만 그 전제를
      // 지키고 있었으므로 여기서도 같은 전제를 지킨다.
      this.logger.error('부팅 복구 자체가 실패했다 — 서비스는 계속 띄운다', e as Error);
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
        // 기준점만 민다. blindField의 나머지 셋(`currentBlindLv`,
        // `nextLevelAt`, `isBreak`)은 기준점에서 파생된 캐시다.
        await this.redis.setTournamentBlind(tournamentId, {
          ...blind,
          startedAt: blind.startedAt + downtime,
        });

        // 그리고 그 캐시를 다시 세운다.
        //
        // **레벨 자체는 밀기만으로 이미 옳다.** 기준점을 D만큼 밀었는데 실제
        // 시계도 D만큼 흘렀으므로 경과 시간이 상쇄돼, 부팅 시점의 레벨이 죽은
        // 시점의 레벨과 같다 — 그게 재개할 레벨이다. 캐시가 들고 있는 값이
        // 바로 그 값이고, 다음 핸드는 어느 경로로든 그 값을 쓴다.
        //
        // 다시 세우는 이유는 둘이다.
        // 1. 레벨이 안 바뀌면 평소 경로의 쓰기 게이트가 안 열려 `nextLevelAt`이
        //    낡은 채로 남는다 — 전광판 카운트다운이 0에 닿은 뒤 다운타임만큼
        //    멈춘다.
        // 2. 하트비트 주기(30초) 때문에 D는 실제 정지보다 최대 그만큼 크다.
        //    과잉 보정으로 민 기준점의 레벨이 한 칸 내려가는 경우, 캐시가 낡은
        //    레벨을 들고 있으면 전광판과 다음 핸드가 서로 다른 레벨을 본다.
        //
        // 파생식을 여기에 복제하지 않는 이유는 재계산이 등록 마감
        // 내리기(`curLv >= rebuyUntil`)를 함께 하기 때문이다 — 복제하면 그
        // 규칙이 복구 경로에서만 빠진다. `force`가 필요한 것은 평소 경로의 두
        // 게이트가 "기준점은 그대로"를 전제하기 때문이다.
        await this.redis.checkAndSyncBlindLevel(tournamentId, { force: true });
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
        // 스냅샷도 같은 이유로 세운다. 생성 경로는 T38 이후 빈 테이블에도 빈
        // 스냅샷을 세우고(`session.service.ts`의 createSession·createTable),
        // 그래서 "스냅샷이 없다"의 뜻이 유실 하나로 좁혀져 있다. 복구가 이
        // 테이블만 비워 두면 재기동이 그 뜻을 다시 넓힌다 — 아무도 안 앉은
        // 테이블에 딜러가 붙는 순간 `PlaysyncService.joinTable`이 맨 `Error`를
        // 던져 500이 난다(`PlaysyncService.joinTable`). T38이 고친 결함이
        // 재기동으로 되살아나는 것이다.
        //
        // 위 비트맵과 같은 모양으로 **없을 때만** 세운다. 정상적으로 살아 있는
        // 빈 테이블의 스냅샷에는 직전 핸드가 남긴 버튼과 블라인드가 들어 있어,
        // 덮어쓰면 다음 핸드가 버튼 0 · sb 100에서 시작한다. "스냅샷이 있으면
        // 손대지 않는다"는 아래 좌석 있는 경로의 `rebuildSeatBitmap`과도 같은 규칙이다.
        if (!(await this.redis.getSnapShot(table.id))) {
          await this.redis.saveSnapshotUnlocked(
            table.id,
            createEmptyTableState(tournamentId),
            'boot-recovery',
          );
        }
        continue;
      }

      const existing = await this.redis.getSnapShot(table.id);
      if (existing) {
        // 살아 있다. 스냅샷에는 시간이 없으므로 스냅샷 자체는 손댈 것이 없다.
        //
        // **그래도 좌석 비트맵은 따로 본다.** 유실 판정을 스냅샷 유무 하나로
        // 하면 이 부분 유실이 사각지대로 남는다 — 비트맵은
        // `tournament:{id}:seat` 키 하나에 대회의 모든 테이블이 필드로 들어
        // 있어서, 그 키만 잃는 일(필드 만료, maxmemory 축출, 부분 AOF 손상)이
        // 스냅샷과 독립적으로 가능하다. 그러면 `getTournamentTables`가
        // hgetall이라 이 테이블이 좌석 목록에서 통째로 사라지고, `entry`의
        // 가드도 스냅샷 기준이라 막지 못하며, `UPDATE_SEAT_BIT`는 필드가 없으면
        // 아무것도 하지 않으므로(설계상 옳다 — `RedisService`의 `UPDATE_SEAT_BIT`) **착석으로도
        // 낫지 않는다.**
        //
        // **스냅샷에서 파생시킨다.** DB 좌석 행에는 참가가 끝난 잔재가 남을 수
        // 있고(T29 이후 ELIMINATED·AWARDED의 좌석 행은 남는다), 시나리오
        // 하네스가 단계마다 검사하는 불변식도 "좌석 비트맵 == 스냅샷"이다.
        // 스냅샷이 살아 있는 이 분기에서는 그쪽이 권위다.
        //
        // 위 빈 테이블 분기와 같이 **없을 때만** 세운다. 있는 값을 스냅샷에
        // 맞춰 고치는 것은 정합성 조정이지 유실 복구가 아니다 — 이 서비스는
        // 무슨 장애였는지 추측하지 않고 지금 무엇이 없는지만 본다.
        const bitmap = await this.redis.getTableSeatStatus(tournamentId, table.id);
        if (bitmap.length === 0) {
          const seated = existing.players
            .map((p, seat) => (p ? seat : -1))
            .filter((seat) => seat >= 0);
          await this.redis.rebuildSeatBitmap(tournamentId, table.id, seated);
          this.logger.warn(
            `좌석 비트맵만 잃은 테이블을 스냅샷으로 되세웠다 (table=${table.id}, 좌석 ${seated.length}개)`,
          );
        }
        continue;
      }

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

    // 버튼을 뽑은 뒤(= 이 재구성이 성공한다고 확정된 뒤)에 한다. `PLAYING`이
    // 아닌 좌석 행(킥된 참가자, 우승자)을 남기면 좌석 하나가 죽는다 — 비트맵과
    // 스냅샷은 그 자리를 비어 있다고 말하는데, `@@unique([tableId, seatPosition])`이
    // 새 착석을 P2002로 막고 `releaseSeats`는 검사 1(스냅샷 점유자 대조)이
    // 통과하지 않아 상점도 치울 수 없다 — 대회가 끝날 때까지 그 좌석과 그
    // 테이블(occupied > 0)이 함께 묶인다. 장부(참가 행)는 건드리지 않는다 —
    // `ELIMINATED`/`AWARDED`는 그대로 남아야 멱등 키가 유지된다.
    const orphans = table.tablePlayers.filter(p => !stackOf.has(p.userId));
    if (orphans.length > 0) {
      await this.prisma.tablePlayer.deleteMany({
        where: { tableId: table.id, seatPosition: { in: orphans.map(p => p.seatPosition) } },
      });
      this.logger.warn(
        `참가가 끝난 좌석 행 ${orphans.length}개를 재구성과 함께 정리했다 (table=${table.id})`,
      );
    }

    const state: TableState = {
      phase: GamePhase.WAITING,
      players,
      buttonUser,
      currentTurnSeatIndex: -1,
      pot: 0,
      sidePots: [],
      currentBet: 0,
      smallBlind: level.sb,
      // T58: deriveAnteAmount 하나로 DealerService.startPreFlop과 같은
      // 계산을 쓴다. 값 자체는 다음 핸드 시작 시 startPreFlop이 다시
      // 덮어쓰므로(위 주석) 정확도가 결정적이지 않지만, 계산식이 두 곳에
      // 따로 있으면 그 자체가 T64가 걷어낸 문제를 재현하는 것이다.
      ante: deriveAnteAmount(level.sb, level.ante),
      tournamentId,
    };

    await this.redis.saveSnapshotUnlocked(table.id, state, 'boot-recovery');

    // 스냅샷만 세우면 나머지가 어긋난다. 좌석 비트맵이 없으면 `entry`가 좌석을
    // 비어 있는 것으로 보고 다른 사람에게 판다.
    await this.redis.rebuildSeatBitmap(tournamentId, table.id, seated);

    // 유저 컨텍스트는 지금 읽는 곳이 한 군데뿐이고(`PlaysyncService.handleAction`의
    // isKicked), 재구성이 PLAYING만 앉히므로 킥된 사람은 스냅샷에 없다 — 즉
    // 안 세워도 지금은 틀리지 않는다. 그래도 세운다: 착석과 컨텍스트가 짝이라는
    // 불변식(`EntryService.claimSeat`)을 재구성만 예외로 두면, 이 키를 읽는 코드가
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
