import Redis from 'ioredis';
import { PlayerStatus, PrismaClient, TournamentStatus } from '@prisma/client';
import { BlindField } from 'shared/types/tournamentMeta';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { GamePhase, TableState } from 'src/game-engine/types';
import { RecoveryService } from './recovery.service';

/**
 * `RecoveryService`의 정지 시간 보정.
 *
 * 세 가지를 검증한다.
 * - 하트비트가 없으면 건너뛴다 (최초 부팅)
 * - `pausedMs`는 **누적**된다 — 대입이면 두 번째 복구가 첫 번째를 지운다
 * - 블라인드 기준점은 **대회 단위**로 한 번만 밀린다 — 테이블 수와 무관하다
 *
 * 테이블 단위 재구성(스냅샷 없는 테이블 되살리기)은 Task 3의 몫이라 여기서는
 * 다루지 않는다.
 */
describe('RecoveryService', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let redisService: RedisService;
  let recovery: RecoveryService;
  let seq = 0;

  beforeAll(() => {
    prisma = createTestPrisma();
    redis = createTestRedis();
  });

  afterAll(async () => {
    await redis.quit();
    await closeTestPrisma(prisma);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await flushTestRedis(redis);
    seq = 0;
    redisService = new RedisService(redis);
    recovery = new RecoveryService(prisma as unknown as PrismaService, redisService);
  });

  async function setHeartbeatAgo(ms: number) {
    const beatAt = new Date(Date.now() - ms);
    await prisma.serverHeartbeat.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', beatAt },
      update: { beatAt },
    });
  }

  /**
   * ONGOING 대회 하나를 테이블 `tableCount`개와 함께 세운다.
   * 블라인드 구조는 1분짜리 레벨 둘 — 실제 시간 몇 분을 통짜로 기다리지
   * 않고도 레벨 경계를 넘나들 수 있게 짧게 잡는다(운영 DTO의 `Min(10)`은
   * 생성 API의 검증이지 여기서 직접 만드는 Json에는 걸리지 않는다).
   */
  async function seedOngoingTournament(opts: { tableCount?: number; startedAtMsAgo?: number } = {}) {
    seq += 1;
    const n = seq;
    const owner = await prisma.user.create({
      data: { nickname: `owner-${n}`, password: 'x', role: 'STORE_ADMIN' },
    });
    const store = await prisma.store.create({
      data: { name: `store-${n}`, ownerId: owner.id },
    });
    const structure = [
      { lv: 1, sb: 100, ante: false, duration: 1 },
      { lv: 2, sb: 200, ante: false, duration: 1 },
    ];
    const blind = await prisma.blindStructure.create({
      data: { name: `blind-${n}`, storeId: store.id, structure },
    });
    const tournament = await prisma.tournament.create({
      data: {
        name: `대회-${n}`,
        storeId: store.id,
        blindId: blind.id,
        dealerOtpHash: 'unused-hash',
        startStack: 10000,
        avgStack: 10000,
        entryFee: 1000,
        rebuyUntil: 5,
        isRegistrationOpen: true,
        itmCount: 1,
        prizePayouts: [{ place: 1, percent: 100 }],
        status: TournamentStatus.ONGOING,
        startedAt: new Date(Date.now() - (opts.startedAtMsAgo ?? 0)),
      },
    });
    const dealerSession = await prisma.dealerSession.create({
      data: { tournamentId: tournament.id },
    });
    const tableIds: string[] = [];
    for (let i = 0; i < (opts.tableCount ?? 1); i++) {
      const table = await prisma.table.create({
        data: { tableOrder: i + 1, tournamentId: tournament.id, dealerId: dealerSession.id },
      });
      tableIds.push(table.id);
    }
    return { tournamentId: tournament.id, tableIds, structure };
  }

  /**
   * 좌석 하나를 만든다 — 유저, 참가 행(장부), 좌석 행(배치표)을 함께 세운다.
   * `status`를 바꿔 PLAYING이 아닌 참가자(ELIMINATED 등)의 좌석 행이 남아
   * 있는 상태를 흉내 낼 수 있다.
   */
  async function seatPlayer(opts: {
    tournamentId: string;
    tableId: string;
    seatPosition: number;
    stack: number;
    status?: PlayerStatus;
  }) {
    seq += 1;
    const userId = `p-${seq}`;
    await prisma.user.create({ data: { id: userId, nickname: userId, password: 'x' } });
    await prisma.tournamentParticipation.create({
      data: {
        userId,
        tournamentId: opts.tournamentId,
        playerOtp: `otp-${seq}`,
        status: opts.status ?? PlayerStatus.PLAYING,
        currentStack: opts.stack,
      },
    });
    await prisma.tablePlayer.create({
      data: {
        tournamentId: opts.tournamentId,
        tableId: opts.tableId,
        userId,
        nickname: userId,
        seatPosition: opts.seatPosition,
      },
    });
    return userId;
  }

  it('하트비트 행이 없으면 정지 시간 보정을 건너뛴다', async () => {
    const { tournamentId } = await seedOngoingTournament();
    // 0은 컬럼 기본값과 같아서, "건드리지 않았다"와 "0으로 잘못 되돌렸다"를
    // 구별하지 못한다(`increment: 0`으로 바꿔도 초록이다 — 최종 리뷰
    // "판별력이 약한 것"). 0이 아닌 값을 미리 심어 실제로 손대지 않았음을
    // 증명한다.
    await prisma.tournament.update({ where: { id: tournamentId }, data: { pausedMs: 4242 } });

    await recovery.recoverAll();

    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    expect(t.pausedMs).toBe(4242);
  });

  it('정지 시간을 누적한다 — 두 번 복구하면 합이 더해진다', async () => {
    const { tournamentId } = await seedOngoingTournament();

    await setHeartbeatAgo(60_000);
    await recovery.recoverAll();
    const first = (
      await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } })
    ).pausedMs;

    await setHeartbeatAgo(30_000);
    await recovery.recoverAll();
    const second = (
      await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } })
    ).pausedMs;

    // 대입(`=`)이면 second가 30초쯤이 되어 빨개진다.
    expect(second).toBeGreaterThan(first + 25_000);
  });

  /**
   * 최종 리뷰 Critical 1: `recoverAll`이 소비한 다운타임을 하트비트로 다시
   * 찍지 않으면, 하트비트 주기(30초) 안에 프로세스가 다시 뜰 때(컨테이너
   * 재시작 루프, dev watch, 운영자의 연속 재시작) 같은 구간을 또 더한다.
   * 위 '정지 시간을 누적한다' 테스트는 두 번째 호출 전에
   * `setHeartbeatAgo`로 하트비트를 **테스트가 직접 다시 찍어서** 이 결함에
   * 닿지 않는다 — 여기서는 그 사이에 아무것도 다시 찍지 않는다.
   */
  it('복구가 하트비트를 소비한다 — 곧바로 다시 복구해도 두 번 더하지 않는다', async () => {
    const { tournamentId } = await seedOngoingTournament();
    await setHeartbeatAgo(60_000);

    await recovery.recoverAll();
    const first = (
      await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } })
    ).pausedMs;

    // 하트비트를 다시 찍지 않는다 — 30초 안에 프로세스가 다시 뜬 상황이다.
    await recovery.recoverAll();
    const second = (
      await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } })
    ).pausedMs;

    // 지금 코드는 second ≈ first + 60000이 되어 빨개진다.
    expect(second - first).toBeLessThan(2_000);
  });

  it('블라인드 기준점을 대회당 한 번만 민다 — 테이블이 셋이어도', async () => {
    const { tournamentId } = await seedOngoingTournament({ tableCount: 3 });
    // 블라인드 메타를 미리 세워 둔다 — "이미 살아 있는 스냅샷"의 대회 단위
    // blindField 시나리오다.
    await recovery.recoverAll(); // 하트비트가 없어 이번 호출은 blindField를 새로 세우기만 한다.
    const before = (await redisService.getTournamentBlind(tournamentId))!.startedAt;

    await setHeartbeatAgo(60_000);
    await recovery.recoverAll();
    const after = (await redisService.getTournamentBlind(tournamentId))!.startedAt;

    expect(after - before).toBeGreaterThan(55_000);
    expect(after - before).toBeLessThan(75_000);
  });

  it('blindField가 없으면 startedAt + pausedMs로 새로 세운다', async () => {
    const { tournamentId } = await seedOngoingTournament({ startedAtMsAgo: 100_000 });
    await setHeartbeatAgo(40_000);

    await recovery.recoverAll();

    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    const blind = await redisService.getTournamentBlind(tournamentId);
    expect(blind).not.toBeNull();
    const expectedBaseAt = t.startedAt!.getTime() + t.pausedMs;
    expect(Math.abs(blind!.startedAt - expectedBaseAt)).toBeLessThan(1000);
  });

  /**
   * 리뷰 finding(Important 2): 등록 마감을 **닫는** 유일한 코드는
   * `checkAndSyncBlindLevel`(Redis)뿐이고, DB의 `Tournament.isRegistrationOpen`은
   * 생성 시에만 쓰인다. `blindField`를 통째로 잃어 `buildTournamentMeta`로
   * 다시 세울 때 DB 컬럼을 그대로 실으면, 이미 레벨로 마감됐던 등록이
   * `true`로 되돌아간다 — 그 위에서 리바인이 다시 열리고 포인트가 실제로
   * 빠진다.
   */
  it('메타를 다시 세울 때 등록 마감을 되돌리지 않는다', async () => {
    // rebuyUntil을 지난 레벨에 있는 대회. blindField 없음 → 재구성 분기(2단계).
    const { tournamentId } = await seedOngoingTournament({ startedAtMsAgo: 70_000 });
    await prisma.tournament.update({ where: { id: tournamentId }, data: { rebuyUntil: 2 } });

    await recovery.recoverAll();

    const info = await redis.hget(`tournament:${tournamentId}:info`, 'isRegistrationOpen');
    // 지금 코드는 DB 컬럼(true)을 그대로 실어 '1'이 나온다.
    expect(`등록 ${info}`).toBe('등록 0');
  });

  it('한 대회의 복구가 실패해도 다른 대회는 복구된다', async () => {
    const { tournamentId: brokenId } = await seedOngoingTournament();
    // startedAt을 인위적으로 지운다 — ONGOING인데 startedAt이 없는 것은
    // 정상 흐름에서는 일어날 수 없는 상태고, 이 서비스가 "그 테이블 재구성
    // 실패로 본다"고 선언한 케이스다. blindField가 없어야(=redis에 아무것도
    // 안 세워야) 재구성 분기로 들어가 이 값을 읽으려다 던진다.
    await prisma.tournament.update({ where: { id: brokenId }, data: { startedAt: null } });
    const { tournamentId: okId } = await seedOngoingTournament();

    await setHeartbeatAgo(50_000);
    await expect(recovery.recoverAll()).resolves.toBeUndefined();

    const broken = await prisma.tournament.findUniqueOrThrow({ where: { id: brokenId } });
    const ok = await prisma.tournament.findUniqueOrThrow({ where: { id: okId } });
    // 실패한 대회도 1단계(pausedMs 누적)까지는 통과한다 — 실패는 2단계
    // (blindField 재구성)에서 난다. 그래도 다른 대회는 온전히 복구된다.
    expect(broken.pausedMs).toBeGreaterThan(0);
    expect(ok.pausedMs).toBeGreaterThan(0);
  });

  it('블라인드 기준점을 밀면 레벨이 되돌아온다', async () => {
    const { tournamentId, structure } = await seedOngoingTournament();
    // 90초 전에 시작한 것으로 블라인드를 세운다: 레벨 duration이 1분이라
    // 90초 경과는 레벨 인덱스 1(두 번째 레벨) 한가운데다.
    //
    // `nextLevelAt`은 일부러 과거로 둔다. `checkAndSyncBlindLevel`은
    // `now < nextLevelAt`이면 재계산 없이 캐시된 값을 그대로 돌려주는
    // 최적화가 있다(redis.service.ts:361) — 실제 장애에서는 서버가 죽어
    // 있는 동안에도 실제 시계는 흘러서 이 경계를 이미 지나 있다. 그 조건을
    // 재현하지 않으면(가짜로 미래 시각을 넣으면) 이 테스트가 재계산 경로에
    // 닿지도 못한 채 통과해 버린다.
    const blindField: BlindField = {
      isBreak: false,
      startedAt: Date.now() - 90_000,
      currentBlindLv: 1,
      nextLevelAt: Date.now() - 1_000,
      serverTime: Date.now(),
      blindStructure: structure,
    };
    await redisService.setTournamentBlind(tournamentId, blindField);

    // 40초 다운타임 → 기준점이 40초 뒤로 밀려 경과 시간이 50초가 된다.
    // 50초 < 60초(레벨 0 duration)이므로 레벨이 0으로 되돌아가야 한다.
    await setHeartbeatAgo(40_000);
    await recovery.recoverAll();

    const synced = await redisService.checkAndSyncBlindLevel(tournamentId);
    expect(`레벨 ${synced!.currentBlindLv}`).toBe('레벨 0');
  });

  /**
   * 최종 리뷰 Important 1: `nextLevelAt`은 `startedAt`에서 파생된 캐시다.
   * 기준점만 밀고 파생값을 그대로 두면, `checkAndSyncBlindLevel`의 캐시
   * 조기 반환(`now < nextLevelAt`)이 낡은 경계를 그대로 내보내 전광판
   * 카운트다운이 0에 닿은 뒤 다운타임만큼 멈춘 채로 남는다.
   *
   * `nextLevelAt`을 **미래**로 두는 것이 핵심이다 — 위 '레벨이 되돌아온다'
   * 테스트처럼 과거로 두면 캐시 분기를 건너뛰어 이 결함이 있는 입력을
   * 스위트가 아예 비워 둔다. 반대로 그 테스트는 파생값을 **다시 계산하지
   * 않고 더하기만** 하는 고침을 잡는다(캐시 분기가 켜지면서 낡은
   * `currentBlindLv`가 나온다). 둘이 서로 어긋나는 입력이라 각각이 증명된다.
   */
  it('기준점을 밀 때 nextLevelAt도 같이 민다 — 캐시 분기가 낡은 경계를 내보내지 않는다', async () => {
    const { tournamentId, structure } = await seedOngoingTournament();
    const nextLevelAt = Date.now() + 40_000; // 미래 — 캐시 분기에 걸리는 입력
    await redisService.setTournamentBlind(tournamentId, {
      isBreak: false, startedAt: Date.now() - 20_000, currentBlindLv: 0,
      nextLevelAt, serverTime: Date.now(), blindStructure: structure,
    });

    await setHeartbeatAgo(30_000);
    await recovery.recoverAll();

    const synced = await redisService.checkAndSyncBlindLevel(tournamentId);
    // 지금 코드는 nextLevelAt이 그대로라 delta ≈ 0이 되어 빨개진다.
    expect(synced!.nextLevelAt - nextLevelAt).toBeGreaterThan(25_000);
  });

  /**
   * **입력이 자기모순이 아닌 것이 이 테스트의 핵심이다.**
   *
   * 위 '레벨이 되돌아온다'는 `startedAt`이 90초 전인데 `nextLevelAt`을 과거로
   * 둔다 — 그 조합은 제품 코드가 만들 수 없다(`getCurrentBlindLevel`은 둘을
   * 항상 같이 계산한다). 일관된 입력만 놓고 보면 사실 **레벨은 밀기만으로도
   * 옳다**: 기준점을 D만큼 밀고 실제 시계도 D만큼 흘러 경과가 상쇄되므로,
   * 캐시에 든 레벨이 곧 죽은 시점의 레벨이고 그게 재개할 레벨이다.
   *
   * 갈리는 곳은 하나다. 하트비트 주기(30초)라 측정된 D는 실제 정지보다 최대
   * 그만큼 **크다**. 과잉 보정으로 민 기준점의 레벨이 한 칸 내려가는데, 캐시는
   * 낡은 레벨을 들고 있다 — 캐시 분기가 켜져 있으면 전광판과 다음 핸드가 서로
   * 다른 레벨을 본다.
   *
   * 여기 입력은 제품 코드가 실제로 쓸 수 있는 값이다: 레벨 duration이 1분,
   * 경과 70초 → 인덱스 1, `nextLevelAt = startedAt + 120초`(미래). 35초를
   * 밀면 경과가 35초가 되어 인덱스 0으로 내려간다.
   */
  it('과잉 보정으로 레벨이 한 칸 내려가면 캐시도 따라 내려간다', async () => {
    const { tournamentId, structure } = await seedOngoingTournament();
    const startedAt = Date.now() - 70_000;
    await redisService.setTournamentBlind(tournamentId, {
      isBreak: false,
      startedAt,
      currentBlindLv: 1,
      nextLevelAt: startedAt + 120_000, // 기준점에서 파생된 값 그대로 — 미래다
      serverTime: Date.now(),
      blindStructure: structure,
    });

    await setHeartbeatAgo(35_000);
    await recovery.recoverAll();

    // 캐시 분기가 켜져 있으므로, 강제 갱신이 없으면 여기서 낡은 레벨 1이 나온다.
    const synced = await redisService.checkAndSyncBlindLevel(tournamentId);
    expect(`레벨 ${synced!.currentBlindLv}`).toBe('레벨 0');
  });

  /**
   * 테이블 단위 재구성(3단계). 스냅샷 유실 판정과 정지 시간 보정은 별개의
   * 축이라 위 테스트들과 겹치지 않는다.
   */
  describe('테이블 단위 재구성', () => {
    it('스냅샷 없는 테이블만 재구성한다 — 한 대회에 둘이 섞여 있어도', async () => {
      const { tournamentId, tableIds } = await seedOngoingTournament({ tableCount: 2 });
      const [tableA, tableB] = tableIds;

      const userA = await seatPlayer({ tournamentId, tableId: tableA, seatPosition: 0, stack: 8000 });
      await prisma.table.update({ where: { id: tableA }, data: { buttonUser: 0 } });

      await seatPlayer({ tournamentId, tableId: tableB, seatPosition: 3, stack: 4000 });
      await prisma.table.update({ where: { id: tableB }, data: { buttonUser: 3 } });

      // 테이블 A는 이미 핸드가 진행 중인 모양을 흉내 낸다 — 재구성이 절대
      // 만들어 낼 수 없는 값(phase FLOP, 진행 중인 베팅, DB 스택과 다른 스택)
      // 으로 일부러 채운다. "손대지 않았다"와 "새로 세웠다"가 같은 결과로
      // 나오면 구별이 안 되므로, 재구성이 만들 결과와 확실히 다르게 만든다.
      const liveA: TableState = {
        phase: GamePhase.FLOP,
        players: Array(9).fill(null),
        buttonUser: 0,
        currentTurnSeatIndex: 0,
        pot: 500,
        sidePots: [],
        currentBet: 200,
        smallBlind: 100,
        ante: false,
        tournamentId,
      };
      liveA.players[0] = {
        id: userA,
        tableId: tableA,
        nickname: 'p',
        seatIndex: 0,
        stack: 7800, // DB currentStack(8000)과 다르다 — 핸드 진행 중의 값
        bet: 200,
        hasFolded: false,
        hasChecked: false,
        isAllIn: false,
        totalContributed: 200,
      };
      await redisService.saveSnapShot(tableA, liveA);
      const aBefore = JSON.stringify(await redisService.getSnapShot(tableA));

      // 테이블 B는 스냅샷을 만든 적이 없다(세션 시작 흐름을 거치지 않았다).

      await recovery.recoverAll();

      expect(JSON.stringify(await redisService.getSnapShot(tableA))).toBe(aBefore);
      const bAfter = await redisService.getSnapShot(tableB);
      expect(bAfter).not.toBeNull();
      expect(bAfter!.players[3]).toMatchObject({ stack: 4000 });
    });

    it('PLAYING만 앉힌다 — ELIMINATED의 좌석 행이 남아 있어도', async () => {
      const { tournamentId, tableIds } = await seedOngoingTournament();
      const [tableId] = tableIds;
      await prisma.table.update({ where: { id: tableId }, data: { buttonUser: 0 } });
      await seatPlayer({ tournamentId, tableId, seatPosition: 0, stack: 9000 });
      const eliminatedUserId = await seatPlayer({
        tournamentId, tableId, seatPosition: 3, stack: 0,
        status: PlayerStatus.ELIMINATED,
      });

      await recovery.recoverAll();

      const state = await redisService.getSnapShot(tableId);
      expect(state!.players[3]).toBeNull();
      expect(state!.players[0]).not.toBeNull();

      // 좌석 행까지 지워야 그 자리가 실제로 다시 팔린다. 남기면 비트맵은
      // 0인데 `@@unique([tableId, seatPosition])`의 P2002로 막히는 죽은
      // 좌석이 된다(리뷰 finding Important 3).
      expect(await prisma.tablePlayer.count({ where: { tableId, seatPosition: 3 } })).toBe(0);
      expect(await prisma.tablePlayer.count({ where: { tableId, seatPosition: 0 } })).toBe(1);

      // 반대 방향: 장부(참가 행)는 건드리지 않는다. `ELIMINATED`가 그대로
      // 남아야 상금·탈락 처리의 멱등 키가 유지된다.
      const participation = await prisma.tournamentParticipation.findUniqueOrThrow({
        where: { tournamentId_userId: { tournamentId, userId: eliminatedUserId } },
      });
      expect(participation.status).toBe(PlayerStatus.ELIMINATED);
    });

    it('스택을 currentStack에서 읽는다', async () => {
      const { tournamentId, tableIds } = await seedOngoingTournament();
      const [tableId] = tableIds;
      await prisma.table.update({ where: { id: tableId }, data: { buttonUser: 0 } });
      await seatPlayer({ tournamentId, tableId, seatPosition: 2, stack: 13579 });

      await recovery.recoverAll();

      const state = await redisService.getSnapShot(tableId);
      expect(state!.players[2]!.stack).toBe(13579);
    });

    it('버튼을 Table.buttonUser에서 읽는다', async () => {
      const { tournamentId, tableIds } = await seedOngoingTournament();
      const [tableId] = tableIds;
      await seatPlayer({ tournamentId, tableId, seatPosition: 4, stack: 5000 });
      await prisma.table.update({ where: { id: tableId }, data: { buttonUser: 4 } });

      await recovery.recoverAll();

      const state = await redisService.getSnapShot(tableId);
      expect(state!.buttonUser).toBe(4);
    });

    it('좌석 비트맵이 스냅샷 점유 좌석과 일치한다', async () => {
      const { tournamentId, tableIds } = await seedOngoingTournament();
      const [tableId] = tableIds;
      await prisma.table.update({ where: { id: tableId }, data: { buttonUser: 1 } });
      await seatPlayer({ tournamentId, tableId, seatPosition: 1, stack: 5000 });
      await seatPlayer({ tournamentId, tableId, seatPosition: 6, stack: 5000 });

      await recovery.recoverAll();

      const bitmap = await redis.hget(`tournament:${tournamentId}:seat`, `table:${tableId}`);
      // 좌석 1과 6만 채워졌다. 스냅샷에서 파생시키지 않고 리터럴로 고정한다 —
      // 비트맵과 스냅샷이 둘 다 같은 `p.seatPosition`에서 나오므로, 둘 다
      // 같은 off-by-one을 공유하면 서로를 가려서 초록이 될 수 있다
      // (CLAUDE.md 네 번째 가짜 초록의 정확한 형태).
      expect(bitmap).toBe('010000100');
    });

    it('유저 컨텍스트를 세운다', async () => {
      const { tournamentId, tableIds } = await seedOngoingTournament();
      const [tableId] = tableIds;
      await prisma.table.update({ where: { id: tableId }, data: { buttonUser: 0 } });
      const userId = await seatPlayer({ tournamentId, tableId, seatPosition: 0, stack: 5000 });

      await recovery.recoverAll();

      const ctx = await redisService.getUserContext(tournamentId, userId);
      // entry.service.ts가 착석 때 쓰는 값과 같은 'ACTIVE'다. 'PLAYING'을
      // 쓰면 착석과 재구성의 어휘가 갈린다.
      expect(ctx).toMatchObject({ tableId, seatIndex: 0, status: 'ACTIVE' });
    });

    it('블라인드를 현재 레벨로 맞춘다', async () => {
      // 레벨 duration이 1분씩 둘 — 70초 전에 시작했다고 하면 레벨 인덱스 1
      // (두 번째 레벨, sb 200) 한가운데다.
      const { tournamentId, tableIds, structure } = await seedOngoingTournament({
        startedAtMsAgo: 70_000,
      });
      const [tableId] = tableIds;
      await prisma.table.update({ where: { id: tableId }, data: { buttonUser: 0 } });
      await seatPlayer({ tournamentId, tableId, seatPosition: 0, stack: 5000 });

      await recovery.recoverAll();

      const state = await redisService.getSnapShot(tableId);
      expect(state!.smallBlind).toBe(structure[1].sb);
    });

    /**
     * 리뷰에서 뒤집힌 것: `buttonUser === null`은 버그가 아니라 정상 경로다.
     * 채우는 자리가 핸드 종료 체크포인트뿐이라, 대회 시작 시점에 비어 있던
     * 테이블이나 대회 도중 `createTable`로 새로 연 테이블은 핸드를 한 번도
     * 끝낸 적이 없어 null인 채로 재구성을 맞는다. 이런 테이블에서는 앉은
     * 누구나 정당한 첫 버튼이므로 무작위로 뽑는다(`initializeGame`이 시작
     * 시점에 하는 것과 같은 방식).
     */
    it('buttonUser가 null이면 앉은 사람 중에서 첫 버튼을 뽑는다', async () => {
      const { tournamentId, tableIds } = await seedOngoingTournament();
      const [tableId] = tableIds;
      // buttonUser를 세우지 않는다 — 핸드를 한 번도 끝낸 적 없는 테이블이다.
      await seatPlayer({ tournamentId, tableId, seatPosition: 2, stack: 5000 });
      await seatPlayer({ tournamentId, tableId, seatPosition: 5, stack: 5000 });

      await recovery.recoverAll();

      const state = await redisService.getSnapShot(tableId);
      expect([2, 5]).toContain(state!.buttonUser);
    });

    /**
     * 테이블 단위 격리를 증명하는 입력. `buttonUser === null`은 이제 정상
     * 경로라 실패 사유로 쓸 수 없다 — 대신 "앉힐 PLAYING이 아무도 없어
     * 버튼을 뽑을 근거가 없다"로 brokenTable을 실패시킨다. 좌석 행은 있지만
     * (그래서 재구성 대상에는 들어온다) 그 참가가 이미 ELIMINATED라 아무도
     * 앉힐 수 없는 상태다.
     *
     * **brokenTable을 okTable보다 먼저 만든다.** `tableOrder` asc로 순회하므로
     * 실패하는 테이블이 먼저 처리된다 — 테이블 단위 try/catch가 없으면 예외가
     * 루프를 통째로 끊어 okTable은 순회조차 되지 않는다. okTable을 먼저
     * 만들면(우연히 이미 처리된 뒤 실패가 나서) catch가 없어도 초록으로
     * 보일 수 있어 격리를 증명하지 못한다.
     */
    it('한 테이블의 재구성이 실패해도 다른 테이블은 복구된다', async () => {
      const { tournamentId, tableIds } = await seedOngoingTournament({ tableCount: 2 });
      const [brokenTable, okTable] = tableIds;
      // brokenTable: 좌석 행은 있지만 유일한 참가자가 ELIMINATED다 — 앉힐
      // 사람이 없어 첫 버튼을 뽑을 근거가 없다.
      await seatPlayer({
        tournamentId, tableId: brokenTable, seatPosition: 0, stack: 0,
        status: PlayerStatus.ELIMINATED,
      });
      await prisma.table.update({ where: { id: okTable }, data: { buttonUser: 0 } });
      await seatPlayer({ tournamentId, tableId: okTable, seatPosition: 0, stack: 5000 });

      await expect(recovery.recoverAll()).resolves.toBeUndefined();

      expect(await redisService.getSnapShot(brokenTable)).toBeNull();
      expect(await redisService.getSnapShot(okTable)).not.toBeNull();
    });

    /**
     * Important 5: 좌석 0인 테이블도 좌석 비트맵 **필드**는 되살아나야 한다.
     * 필드가 없으면 `getTournamentTables`(hgetall)가 그 테이블을 아예 목록에서
     * 빼먹어, 상점 좌석 화면과 참가자용 대회 정보 양쪽에서 사라진다.
     */
    it('좌석 0인 테이블도 비트맵 필드를 되살린다 — 목록에서 사라지지 않는다', async () => {
      const { tournamentId, tableIds } = await seedOngoingTournament({ tableCount: 2 });
      const [seatedTable, emptyTable] = tableIds;
      await prisma.table.update({ where: { id: seatedTable }, data: { buttonUser: 0 } });
      await seatPlayer({ tournamentId, tableId: seatedTable, seatPosition: 0, stack: 5000 });
      // emptyTable: 좌석 행도 비트맵 필드도 없다 — Redis를 통째로 잃은
      // 상태를 흉내 낸다(실제로는 `createTable`이 `setSeatBitmap`으로 필드를
      // 만들어 두지만, 그 필드까지 함께 사라진 경우다).

      await recovery.recoverAll();

      const tables = await redisService.getTournamentTables(tournamentId);
      const emptyEntry = tables.find((t) => t.tableId === emptyTable);
      expect(emptyEntry).toBeDefined();
      expect(emptyEntry!.seatStatus.every((s) => s === false)).toBe(true);
    });

    /**
     * T44. 생성 경로(`createSession` / `createTable`)는 T38 이후 빈 테이블에도
     * 빈 스냅샷을 세운다. 복구 경로만 안 세워서, Redis를 잃고 재기동하면
     * 아무도 안 앉은 테이블에 스냅샷이 없다 — 그 테이블에 딜러가 붙으면
     * `PlaysyncService.joinTable`이 맨 `Error`를 던져 500이 난다. T38이 좁힌
     * "스냅샷이 없다 = 유실"이 재기동으로 다시 넓어지는 것이다.
     */
    it('좌석 0인 테이블에도 빈 스냅샷을 세운다 — 딜러가 붙어도 500이 아니다', async () => {
      const { tournamentId, tableIds } = await seedOngoingTournament();
      const [emptyTable] = tableIds;
      // 좌석 행도 스냅샷도 없다 — Redis를 통째로 잃은 뒤의 빈 테이블.

      await recovery.recoverAll();

      const state = await redisService.getSnapShot(emptyTable);
      expect(state).not.toBeNull();
      expect(state!.tournamentId).toBe(tournamentId);
      expect(state!.players.every((p) => p === null)).toBe(true);
      expect(state!.phase).toBe(GamePhase.WAITING);
    });

    /**
     * 위 테스트와 **어긋나는 입력**이다. 조건 없이 세우는 고침은 위를
     * 통과시키면서 여기를 깨뜨린다 — 정상적으로 살아 있는 빈 테이블의
     * 스냅샷(직전 핸드가 남긴 버튼·블라인드)을 초기값으로 되돌려, 다음 핸드가
     * 버튼 0에서 시작하고 블라인드가 100으로 내려간다. 스냅샷 있는 테이블에
     * 손대지 않는 것은 이 서비스 전체의 규칙이고(`:189`), 빈 테이블만 예외일
     * 이유가 없다.
     */
    it('좌석 0인 테이블에 스냅샷이 이미 있으면 덮어쓰지 않는다', async () => {
      const { tournamentId, tableIds } = await seedOngoingTournament();
      const [tableId] = tableIds;
      // 재구성이 만들어 낼 수 없는 값으로 채운다 — `createEmptyTableState`는
      // buttonUser 0 · smallBlind 100이다.
      const live: TableState = {
        phase: GamePhase.WAITING,
        players: Array(9).fill(null),
        buttonUser: 7,
        currentTurnSeatIndex: -1,
        pot: 0,
        sidePots: [],
        currentBet: 0,
        smallBlind: 400,
        ante: true,
        tournamentId,
      };
      await redisService.saveSnapShot(tableId, live);

      await recovery.recoverAll();

      const after = await redisService.getSnapShot(tableId);
      expect(`버튼 ${after!.buttonUser} sb ${after!.smallBlind}`).toBe('버튼 7 sb 400');
    });

    it('좌석 0인 테이블에 비트맵이 이미 있으면 덮어쓰지 않는다', async () => {
      const { tournamentId, tableIds } = await seedOngoingTournament();
      const [tableId] = tableIds;
      // 좌석 행 없이도 비트맵은 이미 있을 수 있다(정상 상태 — `createTable`이
      // 세워 둔 것). 특이한 패턴을 심어 두고 재구성 후에도 그대로인지 본다.
      await redis.hset(`tournament:${tournamentId}:seat`, `table:${tableId}`, '111000000');

      await recovery.recoverAll();

      const bitmap = await redis.hget(`tournament:${tournamentId}:seat`, `table:${tableId}`);
      expect(bitmap).toBe('111000000');
    });
  });
});
