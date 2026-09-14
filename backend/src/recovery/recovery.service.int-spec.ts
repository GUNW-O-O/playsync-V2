import Redis from 'ioredis';
import { Queue } from 'bullmq';
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
  let queue: Queue;
  let queueConnection: Redis;
  let seq = 0;

  beforeAll(() => {
    prisma = createTestPrisma();
    redis = createTestRedis();
    // 복구가 턴 타이머를 다시 건다(T94). 진짜 큐라야 "걸렸는가"를 볼 수 있다 —
    // `maxRetriesPerRequest: null`은 BullMQ가 요구하는 연결 설정이다.
    queueConnection = createTestRedis({ maxRetriesPerRequest: null });
    queue = new Queue('player-timeout', { connection: queueConnection });
    // 테스트마다 새로 세우지 않는다. `RecoveryService`는 생성자에서 클라이언트의
    // 장애 상태(`RedisService.outage`)를 구독하므로(T97), 매번 세우면 한 클라이언트에
    // 구독이 쌓인다. 둘 다 상태가 없어 다시 세울 이유도 없다.
    redisService = new RedisService(redis);
    recovery = new RecoveryService(prisma as unknown as PrismaService, redisService);
  });

  afterAll(async () => {
    await queue.close();
    await queueConnection.quit();
    await redis.quit();
    await closeTestPrisma(prisma);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await flushTestRedis(redis);
    await queue.obliterate({ force: true });
    seq = 0;
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
        payoutTable: [{ minEntries: 0, payouts: [{ place: 1, percent: 100 }] }],
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

  /** 차례가 살아 있는 테이블 하나. `deadline`을 과거로 두면 정지를 겪은 모양이다. */
  async function seedLiveTurn(opts: { epoch?: number; turnSeat?: number } = {}) {
    const { tournamentId, tableIds } = await seedOngoingTournament();
    const [tableId] = tableIds;
    const userId = await seatPlayer({ tournamentId, tableId, seatPosition: 0, stack: 8000 });
    const live: TableState = {
      phase: GamePhase.FLOP,
      players: Array(9).fill(null),
      buttonUser: 0,
      currentTurnSeatIndex: opts.turnSeat ?? 0,
      pot: 500,
      sidePots: [],
      currentBet: 200,
      smallBlind: 100,
      ante: 0,
      tournamentId,
      timerEpoch: opts.epoch ?? 3,
      // 정지 전에 찍힌 마감이다. 지금은 이미 지났다.
      actionDeadline: Date.now() - 120_000,
    };
    live.players[0] = {
      id: userId, tableId, nickname: 'p', seatIndex: 0, stack: 7800,
      bet: 200, hasFolded: false, hasChecked: false, isAllIn: false, totalContributed: 200,
    };
    await redisService.saveSnapshotUnlocked(tableId, live, 'table-created');
    return { tournamentId, tableId, userId };
  }

  it('하트비트 행이 없으면 pausedAt이 지금이다 — pausedMs는 그대로', async () => {
    const { tournamentId, tableIds } = await seedOngoingTournament();
    // 앉은 사람을 하나 둔다 — 없으면 recoverAll이 그 자리에서
    // completeSync까지 끝내 버려 pausedMs가 Δ만큼 늘어나 버린다.
    await seatPlayer({ tournamentId, tableId: tableIds[0], seatPosition: 0, stack: 5000 });
    await prisma.table.update({ where: { id: tableIds[0] }, data: { buttonUser: 0 } });
    // 0은 컬럼 기본값과 같아서, "건드리지 않았다"와 "0으로 잘못 되돌렸다"를
    // 구별하지 못한다(`increment: 0`으로 바꿔도 초록이다 — 최종 리뷰
    // "판별력이 약한 것"). 0이 아닌 값을 미리 심어 실제로 손대지 않았음을
    // 증명한다.
    await prisma.tournament.update({ where: { id: tournamentId }, data: { pausedMs: 4242 } });

    await recovery.recoverAll();

    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    expect(t.pausedMs).toBe(4242);
    expect(`상태 ${t.status}`).toBe('상태 SYNCING');
    expect(`pausedAt 오차 ${Math.abs(t.pausedAt!.getTime() - Date.now()) < 1000}`)
      .toBe('pausedAt 오차 true');
  });

  it('두 번 복구해도 pausedAt은 첫 값 — 누적은 completeSync가 한다', async () => {
    const { tournamentId, tableIds } = await seedOngoingTournament();
    await seatPlayer({ tournamentId, tableId: tableIds[0], seatPosition: 0, stack: 5000 });
    await prisma.table.update({ where: { id: tableIds[0] }, data: { buttonUser: 0 } });

    await setHeartbeatAgo(60_000);
    await recovery.recoverAll();
    const first = (
      await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } })
    ).pausedAt;

    await setHeartbeatAgo(30_000);
    await recovery.recoverAll();
    const second = (
      await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } })
    ).pausedAt;

    // 대입으로 덮으면 second가 30초 전쯔으로 바뀌어 빨개진다 — 이미
    // SYNCING이면 pausedAt을 덮지 않아야 한다.
    expect(second!.getTime()).toBe(first!.getTime());

    const before = (
      await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } })
    ).pausedMs;
    await recovery.completeSync(tournamentId);
    const after = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    // 누적은 끄는 자리(completeSync)의 몫이다. `>before`만 보면 아주 작은
    // 증가(예: 1ms)로도 통과한다 — 이 테스트 이름이 약속하는 「첫 정지부터의
    // Δ」(1단계에서 60초 전으로 찍은 하트비트)를 실제로 증명하려면 그 크기를
    // 본다.
    expect(after.pausedMs - before).toBeGreaterThan(55_000);
  });

  /**
   * 최종 리뷰 Critical 1이 살던 자리. `recoverAll`이 소비한 다운타임을
   * 하트비트로 다시 찍지 않으면, 하트비트 주기(30초) 안에 프로세스가 다시 뜰
   * 때(컨테이너 재시작 루프, dev watch, 운영자의 연속 재시작) 그 구간을 또
   * 다운타임으로 잰다 — 지금은 `pausedAt`이 이미 SYNCING이라 덮이지 않는
   * 것으로, 그리고 그 구간 자체가 턴 시계 보정(`resumePending.downMs`)에
   * 작게 반영되는 것으로 나타난다.
   */
  it('복구가 하트비트를 소비한다 — 곧바로 다시 복구해도 pausedAt이 안 바뀌고 downMs가 작다', async () => {
    const { tableId, tournamentId } = await seedLiveTurn();
    await setHeartbeatAgo(60_000);

    await recovery.recoverAll();
    const pausedAtFirst = (
      await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } })
    ).pausedAt;
    const firstDownMs = (await redisService.getSnapShot(tableId))!.resumePending!.downMs;

    // 하트비트를 다시 찍지 않는다 — 30초 안에 프로세스가 다시 뜬 상황이다.
    await recovery.recoverAll();
    const pausedAtSecond = (
      await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } })
    ).pausedAt;
    const secondDownMs = (await redisService.getSnapShot(tableId))!.resumePending!.downMs;

    expect(pausedAtSecond!.getTime()).toBe(pausedAtFirst!.getTime());
    // 지금 코드는 second ≈ first(60000+)가 되어 빨개진다.
    expect(secondDownMs).toBeLessThan(2_000);
  });

  it('블라인드 기준점을 대회당 한 번만 민다 — completeSync가 테이블이 셋이어도', async () => {
    const { tournamentId, tableIds } = await seedOngoingTournament({ tableCount: 3 });
    // 앉은 사람을 하나 둔다 — 아무도 없으면 recoverAll이 그 자리에서
    // completeSync까지 곧바로 끝내 버려 SYNCING 중간 상태를 볼 수 없다.
    await seatPlayer({ tournamentId, tableId: tableIds[0], seatPosition: 0, stack: 5000 });
    await prisma.table.update({ where: { id: tableIds[0] }, data: { buttonUser: 0 } });

    // 블라인드 메타가 없어 첫 호출이 새로 세우면서 SYNCING을 켠다. 대입이라
    // 이 진입 자체는 기준점을 밀지 않는다.
    await recovery.recoverAll();
    const before = (await redisService.getTournamentBlind(tournamentId))!.startedAt;

    // 정지가 60초 전에 시작한 것으로 되돌린다(`setHeartbeatAgo`와 같은
    // 이유로 실제 시간을 기다리지 않고 흉내 낸다) — 이미 SYNCING이라
    // `recoverAll`을 다시 불러도 pausedAt은 안 덮이므로, completeSync가 볼
    // Δ를 직접 심는다.
    await prisma.tournament.update({
      where: { id: tournamentId },
      data: { pausedAt: new Date(Date.now() - 60_000) },
    });

    await recovery.completeSync(tournamentId);
    const after = (await redisService.getTournamentBlind(tournamentId))!.startedAt;

    expect(after - before).toBeGreaterThan(55_000);
    expect(after - before).toBeLessThan(75_000);
  });

  /**
   * 인원 카운터의 최후의 그물(T60).
   *
   * 복구는 `getTournamentBlind`가 `null`일 때 — 즉 info 키를 **통째로 잃었을
   * 때만** — `buildTournamentMeta`로 메타를 다시 세운다. Redis가 살아 있고
   * 카운터만 어긋난 경우는 그 분기에 들어가지 않아 영영 안 나았다.
   *
   * 카운터가 대입이 된 지금(`RedisService.syncActivePlayer`), 복구가 분기와
   * 무관하게 한 번 대입하면 짝을 빠뜨린 새 경로가 생겨도 그 대회의 다음
   * 재기동에서 사라진다.
   */
  describe('인원 카운터를 항상 맞춘다', () => {
    /** 메타를 세워 두고(info 키가 살아 있는 상태) DB 인원을 3으로 만든다. */
    async function seedWithMeta() {
      const { tournamentId } = await seedOngoingTournament();
      await prisma.tournament.update({
        where: { id: tournamentId },
        data: { activePlayers: 3 },
      });
      // 첫 복구는 blindField가 없어 `buildTournamentMeta`로 메타를 세운다.
      await recovery.recoverAll();
      return { tournamentId, infoKey: `tournament:${tournamentId}:info` };
    }

    it('info 키가 살아 있어도 어긋난 인원을 DB로 맞춘다', async () => {
      const { infoKey } = await seedWithMeta();
      await redis.hset(infoKey, 'activePlayer', 9);
      await setHeartbeatAgo(60_000);

      await recovery.recoverAll();

      expect(Number(await redis.hget(infoKey, 'activePlayer'))).toBe(3);
    });

    it('다운타임이 0이어도 맞춘다', async () => {
      // 위 첫 복구가 하트비트를 찍었으므로 이번 호출의 다운타임은 사실상 0이다.
      const { infoKey } = await seedWithMeta();
      await redis.hset(infoKey, 'activePlayer', 9);

      await recovery.recoverAll();

      expect(Number(await redis.hget(infoKey, 'activePlayer'))).toBe(3);
    });
  });

  it('blindField가 없으면 startedAt + pausedMs로 새로 세운다 — blindField.pausedAt도 같다', async () => {
    const { tournamentId, tableIds } = await seedOngoingTournament({ startedAtMsAgo: 100_000 });
    // 앉은 사람을 하나 둔다 — 없으면 recoverAll이 그 자리에서 completeSync까지
    // 끝내 SYNCING 중간 상태(이 테스트가 보려는 것)를 볼 수 없다.
    await seatPlayer({ tournamentId, tableId: tableIds[0], seatPosition: 0, stack: 5000 });
    await prisma.table.update({ where: { id: tableIds[0] }, data: { buttonUser: 0 } });
    await setHeartbeatAgo(40_000);

    await recovery.recoverAll();

    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    expect(`상태 ${t.status}`).toBe('상태 SYNCING');
    const blind = await redisService.getTournamentBlind(tournamentId);
    expect(blind).not.toBeNull();
    const expectedBaseAt = t.startedAt!.getTime() + t.pausedMs;
    expect(Math.abs(blind!.startedAt - expectedBaseAt)).toBeLessThan(1000);
    expect(`blindField.pausedAt ${blind!.pausedAt}`)
      .toBe(`blindField.pausedAt ${t.pausedAt!.getTime()}`);
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

  it('한 대회의 복구가 실패해도 다른 대회는 복구된다 — 둘 다 SYNCING이 된다', async () => {
    const { tournamentId: brokenId } = await seedOngoingTournament();
    // startedAt을 인위적으로 지운다 — ONGOING인데 startedAt이 없는 것은
    // 정상 흐름에서는 일어날 수 없는 상태고, 이 서비스가 "이 대회 복구
    // 실패로 본다"고 선언한 케이스다. 1단계(SYNCING 진입) 바로 뒤의
    // `!t.startedAt` 검사가 blindField나 테이블 재구성에 닿기도 전에 던진다.
    await prisma.tournament.update({ where: { id: brokenId }, data: { startedAt: null } });
    const { tournamentId: okId, tableIds: okTableIds } = await seedOngoingTournament();
    // 앉은 사람을 하나 둔다 — 없으면 okId도 그 자리에서 completeSync까지
    // 끝나 ONGOING으로 돌아가, "SYNCING이 됐는가"를 볼 수 없다.
    await seatPlayer({ tournamentId: okId, tableId: okTableIds[0], seatPosition: 0, stack: 5000 });

    await setHeartbeatAgo(50_000);
    await expect(recovery.recoverAll()).resolves.toBeUndefined();

    const broken = await prisma.tournament.findUniqueOrThrow({ where: { id: brokenId } });
    const ok = await prisma.tournament.findUniqueOrThrow({ where: { id: okId } });
    // 실패한 대회도 1단계(SYNCING 진입)까지는 통과한다 — 실패는 그 다음
    // (startedAt을 읽는 자리)에서 난다. 그래도 다른 대회는 온전히 복구된다.
    expect(`broken 상태 ${broken.status}`).toBe('broken 상태 SYNCING');
    expect(`ok 상태 ${ok.status}`).toBe('ok 상태 SYNCING');
  });

  /**
   * 부팅(recoverTournament)이 아니라 **completeSync 뒤에** 본다(T96) —
   * 부팅은 `pausedAt`에서 얼린 레벨을 보여줄 뿐이고, 실제로 "정지 시간만큼
   * 미는" 보정은 SYNCING을 끄는 자리에서 일어난다. `pausedAt`을 DB에
   * 직접 박아 두는 것은 하트비트 기반 `setHeartbeatAgo`와 같은 이유다 — 실제
   * 시간을 기다리지 않고 "정지가 X초 전에 시작했다"를 흉내 낸다.
   */
  it('completeSync 뒤에 보면 레벨이 정지 시각의 값으로 있다', async () => {
    const { tournamentId, structure } = await seedOngoingTournament({ startedAtMsAgo: 90_000 });
    // 90초 전에 시작한 것으로 블라인드를 세운다: 레벨 duration이 1분이라
    // 90초 경과는 레벨 인덱스 1(두 번째 레벨) 한가운데다. `currentBlindLv`를
    // 일부러 그 값(1)으로 심어 둔다 — completeSync의 force 재계산이 실제로
    // 다시 계산하는지(캐시를 그대로 믇지 않는지)를 이 값이 증명한다.
    const blindField: BlindField = {
      isBreak: false,
      startedAt: Date.now() - 90_000,
      currentBlindLv: 1,
      nextLevelAt: Date.now() - 1_000,
      serverTime: Date.now(),
      blindStructure: structure,
    };
    await redisService.setTournamentBlind(tournamentId, blindField);
    // 정지가 40초 전에 시작했다 — 정지 시각의 경과는 90-40=50초, 60초(레벨 0
    // duration) 미만이므로 정지 시각의 레벨은 0이다. completeSync가 그
    // 경과를 그대로 보존해야 한다(정지 시간만큼 기준점도 같이 밀어서).
    await prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: TournamentStatus.SYNCING, pausedAt: new Date(Date.now() - 40_000) },
    });

    await recovery.completeSync(tournamentId);

    const synced = await redisService.checkAndSyncBlindLevel(tournamentId);
    expect(`레벨 ${synced!.currentBlindLv}`).toBe('레벨 0');
  });

  /**
   * 최종 리뷰 Important 1이 살던 자리. `nextLevelAt`은 `startedAt`에서
   * 파생된 캐시다. `completeSync`가 기준점만 밀고 파생값을 그대로 두면,
   * `checkAndSyncBlindLevel`의 캐시 조기 반환(`now < nextLevelAt`)이 낡은
   * 경계를 그대로 내보내 전광판 카운트다운이 0에 닿은 뒤 정지 시간만큼 멈춘
   * 채로 남는다. `completeSync`가 내부에서 `force: true`로 부르는 것이
   * 이것을 막는다 — 여기서는 그 결과를 **외부에서** 다시 확인한다.
   */
  it('completeSync 뒤에 보면 nextLevelAt도 같이 밀려 있다', async () => {
    const { tournamentId, structure } = await seedOngoingTournament({ startedAtMsAgo: 20_000 });
    const nextLevelAt = Date.now() + 40_000; // 미래 — 캐시 분기에 걸리는 입력
    await redisService.setTournamentBlind(tournamentId, {
      isBreak: false, startedAt: Date.now() - 20_000, currentBlindLv: 0,
      nextLevelAt, serverTime: Date.now(), blindStructure: structure,
    });
    await prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: TournamentStatus.SYNCING, pausedAt: new Date(Date.now() - 30_000) },
    });

    await recovery.completeSync(tournamentId);

    const synced = await redisService.checkAndSyncBlindLevel(tournamentId);
    // completeSync가 force 없이 재계산하면 nextLevelAt이 그대로라 delta ≈ 0이
    // 되어 빨개진다.
    expect(synced!.nextLevelAt - nextLevelAt).toBeGreaterThan(25_000);
  });

  /**
   * **입력이 자기모순이 아닌 것이 이 테스트의 핵심이다.** 위 두 테스트처럼
   * `startedAt`과 `nextLevelAt`을 따로 조작하지 않는다 — 여기 입력은
   * `getCurrentBlindLevel`이 실제로 만들 수 있는 값이다: 레벨 duration이
   * 1분, 경과 70초 → 인덱스 1, `nextLevelAt = startedAt + 120초`(미래).
   *
   * 정지가 35초 전에 시작했다 — 정지 시각의 경과는 70-35=35초로 인덱스 0
   * 이다. `completeSync`가 기준점을 밀 때 이 "한 칸 내려가는" 레벨을 캐시가
   * 아니라 다시 계산해서 반영해야 한다.
   */
  it('completeSync가 밀 때 레벨이 한 칸 내려가면 캐시도 따라 내려간다', async () => {
    const { tournamentId, structure } = await seedOngoingTournament({ startedAtMsAgo: 70_000 });
    const startedAt = Date.now() - 70_000;
    await redisService.setTournamentBlind(tournamentId, {
      isBreak: false,
      startedAt,
      currentBlindLv: 1,
      nextLevelAt: startedAt + 120_000, // 기준점에서 파생된 값 그대로 — 미래다
      serverTime: Date.now(),
      blindStructure: structure,
    });
    await prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: TournamentStatus.SYNCING, pausedAt: new Date(Date.now() - 35_000) },
    });

    await recovery.completeSync(tournamentId);

    // 캐시 분기가 켜져 있으므로, 강제 갱신이 없으면 여기서 낡은 레벨 1이 나온다.
    const synced = await redisService.checkAndSyncBlindLevel(tournamentId);
    expect(`레벨 ${synced!.currentBlindLv}`).toBe('레벨 0');
  });

  /**
   * 테이블 단위 재구성(3단계). 스냅샷 유실 판정과 정지 시간 보정은 별개의
   * 축이라 위 테스트들과 겹치지 않는다.
   */
  /**
   * 정지에서 돌아온 뒤의 **턴 시계**(T94·T95).
   *
   * 정지 동안 블라인드 시계는 위에서 밀어 주는데 액션 시계는 아무도 밀지
   * 않았다. 그 비대칭이 차례였던 사람을 자동 폴드시켰다. 폴드되는 경로가
   * 둘이라 둘 다 본다 — 살아남은 잡과, 지나간 마감 시각이다.
   *
   * **정지의 끝은 부팅이 아니다.** 복구는 멈춰 세우기만 하고, 다시 여는 것은
   * 딜러다(`DealerService.resumeTable`). 그래서 여기서는 "새 잡을 걸지
   * 않았는가"까지 본다.
   */
  describe('턴 시계 정지', () => {
    // `seedLiveTurn`은 describe 위(파일 상단)에서 공유한다 — '복구가
    // 하트비트를 소비한다' 테스트도 같은 헬퍼가 필요해서 그쪽으로 옮겼다.

    /**
     * **이것이 결함의 두 번째 경로다.** 마감이 절대 시각이라, 안 지우면
     * 돌아온 사람이 누른 버튼이 `handleAction`에서 `TIME_OUT`으로 바뀐다.
     *
     * 마감을 지우기만 하면 "차례가 없다"(쇼다운·대기)와 구별이 안 되므로
     * 정지 표시를 함께 세운다.
     */
    it('지나간 마감을 지우고 정지 표시를 세운다', async () => {
      const { tableId } = await seedLiveTurn();
      await setHeartbeatAgo(300_000);

      await recovery.recoverAll();

      const after = await redisService.getSnapShot(tableId);
      // 정지 길이는 하트비트에서 나온다 — 주기(5초)만큼 실제보다 길게 잡힌다.
      expect(`마감 ${after!.actionDeadline} 정지 ${after!.resumePending!.downMs > 290_000}`)
        .toBe('마감 undefined 정지 true');
    });

    /**
     * **첫 번째 경로.** 큐에 남은 잡은 지연이 이미 지나 부팅 직후 발화하는데,
     * 세대가 그대로면 `handleAction`의 세대 검사를 통과해 폴드시킨다.
     */
    it('세대를 올려 살아남은 잡을 무효로 만든다', async () => {
      const { tableId } = await seedLiveTurn({ epoch: 3 });
      await setHeartbeatAgo(300_000);

      await recovery.recoverAll();

      expect((await redisService.getSnapShot(tableId))!.timerEpoch).toBe(4);
    });

    /**
     * **정지의 끝은 시계가 아니라 딜러다.** 부팅에서 새 타이머를 걸면 그
     * 시각을 감으로 잡는 것이 되고, 짧으면 아직 깜깜한 사람이 폴드당하고
     * 길면 다 모인 테이블이 기다린다. 카드가 물리라 딜러 없이는 판이 어차피
     * 안 나가므로, 타이머 없는 테이블이 남는 것을 받아들인다.
     */
    it('새 타이머 잡을 걸지 않는다', async () => {
      const { tableId } = await seedLiveTurn({ epoch: 3 });
      await setHeartbeatAgo(300_000);

      await recovery.recoverAll();

      expect(await queue.getJob(`${tableId}-4`)).toBeUndefined();
    });

    /**
     * **차례가 없는 테이블에 정지 표시를 달면 딜러가 아무 일도 없던 테이블에서
     * 재개 버튼을 눌러야 한다.** 이 검사가 없으면 "전부 멈춘다"는 구현도 위
     * 셋을 전부 통과한다.
     */
    it('차례가 없으면 손대지 않는다', async () => {
      const { tableId } = await seedLiveTurn({ turnSeat: -1, epoch: 3 });
      await setHeartbeatAgo(300_000);

      await recovery.recoverAll();

      const after = await redisService.getSnapShot(tableId);
      expect(`세대 ${after!.timerEpoch} 정지 ${after!.resumePending === undefined}`)
        .toBe('세대 3 정지 true');
    });
  });

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
        ante: 0,
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
      await redisService.saveSnapshotUnlocked(tableA, liveA, 'table-created');
      const aBefore = JSON.stringify(await redisService.getSnapShot(tableA));

      // 테이블 B는 스냅샷을 만든 적이 없다(세션 시작 흐름을 거치지 않았다).

      await recovery.recoverAll();

      // **턴 시계는 예외다**(T94·T95). 정지에서 돌아오면 복구가 마감을 지우고
      // 세대를 올리고 정지 표시를 세우므로 스냅샷이 한 바이트도 안 바뀌지는 않는다. 이 검사가 보려는
      // 것은 "재구성하지 않았다"이지 "불변"이 아니라서, 게임 내용만 견준다 —
      // 재구성했다면 phase가 WAITING이고 스택이 DB 값(8000)이 된다.
      const aAfter = await redisService.getSnapShot(tableA);
      const gameContent = (s: unknown) => {
        const { actionDeadline, timerEpoch, resumePending, ...rest } = s as TableState;
        return JSON.stringify(rest);
      };
      expect(gameContent(aAfter)).toBe(gameContent(JSON.parse(aBefore)));
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
        ante: 80,
        tournamentId,
      };
      await redisService.saveSnapshotUnlocked(tableId, live, 'table-created');

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

    /**
     * T46. **재구성 판정 기준이 스냅샷 유무뿐이었다.** 좌석 비트맵은
     * `tournament:{id}:seat` 키 하나에 대회의 모든 테이블이 필드로 들어 있어서,
     * 그 키만 잃는 유실(필드 만료, maxmemory 축출, 부분 AOF 손상)이 스냅샷과
     * 독립적으로 가능하다.
     *
     * 그 경우 `getTournamentTables`가 hgetall이라 테이블이 좌석 목록에서 통째로
     * 사라지고, `entry`의 가드도 스냅샷 기준이라 막지 못하며, `UPDATE_SEAT_BIT`는
     * 필드가 없으면 아무것도 하지 않으므로(설계상 옳다) **착석으로도 낫지
     * 않는다.** 지배적인 케이스(Redis 통째 유실)는 스냅샷도 같이 없어져 기존
     * 판정에 덮이지만, 이 부분 유실만 사각지대였다.
     */
    it('스냅샷은 살아 있고 비트맵만 잃으면 비트맵을 다시 세운다', async () => {
      const { tournamentId, tableIds } = await seedOngoingTournament();
      const [tableId] = tableIds;
      await prisma.table.update({ where: { id: tableId }, data: { buttonUser: 1 } });
      const userA = await seatPlayer({ tournamentId, tableId, seatPosition: 1, stack: 5000 });
      const userB = await seatPlayer({ tournamentId, tableId, seatPosition: 6, stack: 5000 });

      // 스냅샷은 멀쩡하다 — 진행 중인 핸드다. 비트맵 필드만 없다.
      const live: TableState = {
        phase: GamePhase.FLOP,
        players: Array(9).fill(null),
        buttonUser: 1,
        currentTurnSeatIndex: 1,
        pot: 300,
        sidePots: [],
        currentBet: 100,
        smallBlind: 100,
        ante: 0,
        tournamentId,
      };
      live.players[1] = { id: userA, tableId, nickname: 'a', seatIndex: 1, stack: 4900,
        bet: 100, hasFolded: false, hasChecked: false, isAllIn: false, totalContributed: 100 };
      live.players[6] = { id: userB, tableId, nickname: 'b', seatIndex: 6, stack: 5000,
        bet: 0, hasFolded: false, hasChecked: false, isAllIn: false, totalContributed: 0 };
      await redisService.saveSnapshotUnlocked(tableId, live, 'table-created');

      await recovery.recoverAll();

      const bitmap = await redis.hget(`tournament:${tournamentId}:seat`, `table:${tableId}`);
      expect(bitmap).toBe('010000100');
    });

    /**
     * 위 테스트와 **어긋나는 입력**이다. 위만으로는 비트맵을 무엇에서
     * 파생시키는지가 갈리지 않는다 — 스냅샷과 DB 좌석 행이 같은 좌석을
     * 가리키기 때문이다.
     *
     * 살아 있는 스냅샷이 권위다. DB 좌석 행에는 참가가 끝난 잔재가 남을 수
     * 있고(T29 이후 ELIMINATED·AWARDED의 좌석 행은 남는다), 시나리오 하네스가
     * 단계마다 검사하는 불변식도 "좌석 비트맵 == 스냅샷"이다. DB에서 파생시키면
     * 복구가 그 불변식을 스스로 깬 상태로 서비스를 연다.
     */
    it('되세운 비트맵은 DB 좌석 행이 아니라 스냅샷을 따른다', async () => {
      const { tournamentId, tableIds } = await seedOngoingTournament();
      const [tableId] = tableIds;
      await prisma.table.update({ where: { id: tableId }, data: { buttonUser: 2 } });
      const seated = await seatPlayer({ tournamentId, tableId, seatPosition: 2, stack: 5000 });
      // 좌석 5: 참가가 끝났는데 좌석 행이 남아 있다. 스냅샷에는 없다.
      await seatPlayer({
        tournamentId, tableId, seatPosition: 5, stack: 0,
        status: PlayerStatus.ELIMINATED,
      });

      const live: TableState = {
        phase: GamePhase.WAITING,
        players: Array(9).fill(null),
        buttonUser: 2,
        currentTurnSeatIndex: -1,
        pot: 0,
        sidePots: [],
        currentBet: 0,
        smallBlind: 100,
        ante: 0,
        tournamentId,
      };
      live.players[2] = { id: seated, tableId, nickname: 'a', seatIndex: 2, stack: 5000,
        bet: 0, hasFolded: false, hasChecked: false, isAllIn: false, totalContributed: 0 };
      await redisService.saveSnapshotUnlocked(tableId, live, 'table-created');

      await recovery.recoverAll();

      const bitmap = await redis.hget(`tournament:${tournamentId}:seat`, `table:${tableId}`);
      // DB 좌석 행에서 파생시키면 좌석 5도 켜져 '001001000'이 된다.
      expect(bitmap).toBe('001000000');
    });

    it('스냅샷이 살아 있고 비트맵도 있으면 비트맵에 손대지 않는다', async () => {
      const { tournamentId, tableIds } = await seedOngoingTournament();
      const [tableId] = tableIds;
      await prisma.table.update({ where: { id: tableId }, data: { buttonUser: 0 } });
      const userId = await seatPlayer({ tournamentId, tableId, seatPosition: 0, stack: 5000 });

      const live: TableState = {
        phase: GamePhase.WAITING,
        players: Array(9).fill(null),
        buttonUser: 0,
        currentTurnSeatIndex: -1,
        pot: 0,
        sidePots: [],
        currentBet: 0,
        smallBlind: 100,
        ante: 0,
        tournamentId,
      };
      live.players[0] = { id: userId, tableId, nickname: 'a', seatIndex: 0, stack: 5000,
        bet: 0, hasFolded: false, hasChecked: false, isAllIn: false, totalContributed: 0 };
      await redisService.saveSnapshotUnlocked(tableId, live, 'table-created');
      // 스냅샷과 어긋나는 패턴을 일부러 심는다. 복구는 **없는 것만** 세운다 —
      // 있는 값을 스냅샷에 맞춰 고치는 것은 정합성 조정이지 유실 복구가 아니고,
      // 이 서비스의 판단 기준("지금 무엇이 없는지만 본다")과 다른 일이다.
      await redis.hset(`tournament:${tournamentId}:seat`, `table:${tableId}`, '111000000');

      await recovery.recoverAll();

      const bitmap = await redis.hget(`tournament:${tournamentId}:seat`, `table:${tableId}`);
      expect(bitmap).toBe('111000000');
    });
  });
});
