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

    await recovery.recoverAll();

    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    expect(t.pausedMs).toBe(0);
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
      await seatPlayer({
        tournamentId, tableId, seatPosition: 3, stack: 0,
        status: PlayerStatus.ELIMINATED,
      });

      await recovery.recoverAll();

      const state = await redisService.getSnapShot(tableId);
      expect(state!.players[3]).toBeNull();
      expect(state!.players[0]).not.toBeNull();
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
      const occupied = bitmap!.split('').map((b) => b === '1');
      const state = await redisService.getSnapShot(tableId);
      const expectedOccupied = state!.players.map((p) => p !== null);
      expect(occupied).toEqual(expectedOccupied);
    });

    it('유저 컨텍스트를 세운다', async () => {
      const { tournamentId, tableIds } = await seedOngoingTournament();
      const [tableId] = tableIds;
      await prisma.table.update({ where: { id: tableId }, data: { buttonUser: 0 } });
      const userId = await seatPlayer({ tournamentId, tableId, seatPosition: 0, stack: 5000 });

      await recovery.recoverAll();

      const ctx = await redisService.getUserContext(tournamentId, userId);
      expect(ctx).toMatchObject({ tableId, seatIndex: 0, status: 'PLAYING' });
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

    it('buttonUser가 null이면 그 테이블 재구성이 실패한다 — 다른 테이블은 복구된다', async () => {
      const { tournamentId, tableIds } = await seedOngoingTournament({ tableCount: 2 });
      const [okTable, brokenTable] = tableIds;
      await prisma.table.update({ where: { id: okTable }, data: { buttonUser: 0 } });
      await seatPlayer({ tournamentId, tableId: okTable, seatPosition: 0, stack: 5000 });
      // brokenTable은 buttonUser를 세우지 않는다 — 시작 트랜잭션이 반드시
      // 채워야 하는데, 여기 오면 버그다.
      await seatPlayer({ tournamentId, tableId: brokenTable, seatPosition: 0, stack: 5000 });

      await expect(recovery.recoverAll()).resolves.toBeUndefined();

      expect(await redisService.getSnapShot(okTable)).not.toBeNull();
      expect(await redisService.getSnapShot(brokenTable)).toBeNull();
    });
  });
});
