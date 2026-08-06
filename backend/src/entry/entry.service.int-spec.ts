import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, PlayerStatus, TournamentStatus } from '@prisma/client';
import Redis from 'ioredis';
import { GamePhase, TableState } from 'src/game-engine/types';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';
import { EntryService } from './entry.service';

describe('EntryService.enterSeat', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let redisService: RedisService;
  let service: EntryService;

  const TOURNAMENT = 'entry-tournament-1';
  const TABLE = 'entry-table-1';
  const OTHER_TABLE = 'entry-table-2';

  /**
   * 참가 하나를 만들고 그 OTP를 돌려준다. `currentStack`을 `seedTournament`의
   * `startStack`(10000)에 맞춰 넣는다 — 실제로는 결제가 채우는 값이라, 결제를
   * 거치지 않는 이 헬퍼가 대신 흉내 낸다.
   */
  async function participate(userId: string, otp: string, tournamentId = TOURNAMENT) {
    await prisma.user.create({ data: { id: userId, nickname: userId, password: 'x' } });
    await prisma.tournamentParticipation.create({
      data: {
        userId, tournamentId, playerOtp: otp,
        status: PlayerStatus.WAITING, currentStack: 10000,
      },
    });
    return otp;
  }

  /** `Table.dealerId`가 필수라 대회마다 딜러 세션이 하나 있어야 한다. */
  async function seedTournament(id: string, status: TournamentStatus, tableIds: string[]) {
    await prisma.tournament.create({
      data: {
        id, name: id, blindId: 'entry-blind', storeId: 'entry-store',
        dealerOtpHash: 'unused', entryFee: 1000, startStack: 10000,
        status, isRegistrationOpen: true,
      },
    });
    const dealerSession = await prisma.dealerSession.create({ data: { tournamentId: id } });
    for (const [order, tableId] of tableIds.entries()) {
      await prisma.table.create({
        data: {
          id: tableId, tournamentId: id, tableOrder: order + 1,
          dealerId: dealerSession.id,
        },
      });
    }
  }

  beforeAll(() => {
    prisma = createTestPrisma();
    redis = createTestRedis();
    redisService = new RedisService(redis);
    service = new EntryService(
      prisma as unknown as PrismaService,
      redisService,
      new JwtService({ secret: 'entry-spec-secret' }),
      new EventEmitter2(),
    );
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await flushTestRedis(redis);
    await prisma.user.create({
      data: { id: 'entry-owner', nickname: 'owner', password: 'x', role: 'STORE_ADMIN' },
    });
    await prisma.store.create({ data: { id: 'entry-store', name: '상점', ownerId: 'entry-owner' } });
    await prisma.blindStructure.create({
      data: {
        id: 'entry-blind', name: '기본', storeId: 'entry-store',
        structure: [{ lv: 1, sb: 100, ante: false, duration: 600 }],
      },
    });
    await seedTournament(TOURNAMENT, TournamentStatus.PENDING, [TABLE, OTHER_TABLE]);
  });

  afterAll(async () => {
    await closeTestPrisma(prisma);
    await redis.quit();
  });

  async function snapshot(tableId = TABLE): Promise<TableState | null> {
    return await redisService.getSnapShot(tableId);
  }

  it('OTP가 맞으면 좌석이 확정되고 토큰이 나온다', async () => {
    await participate('u1', '00000001');

    const { accessToken } = await service.enterSeat(TOURNAMENT, {
      otp: '00000001', tableId: TABLE, seatIndex: 3,
    });

    expect(accessToken).toEqual(expect.any(String));

    const row = await prisma.tablePlayer.findFirstOrThrow({ where: { userId: 'u1' } });
    expect(row.seatPosition).toBe(3);

    const state = await snapshot();
    expect(state!.players[3]).toMatchObject({ id: 'u1', seatIndex: 3, stack: 10000 });

    const participation = await prisma.tournamentParticipation.findFirstOrThrow({
      where: { userId: 'u1' },
    });
    expect(participation.status).toBe(PlayerStatus.PLAYING);
  });

  it('좌석 토큰의 sub가 스냅샷의 플레이어 id와 같다 — 게이트웨이 좌석 대조의 근거', async () => {
    await participate('u1', '00000001');

    const { accessToken } = await service.enterSeat(TOURNAMENT, {
      otp: '00000001', tableId: TABLE, seatIndex: 0,
    });

    const payload = new JwtService({ secret: 'entry-spec-secret' }).verify(accessToken);
    const state = await snapshot();
    expect(state!.players.some((p) => p?.id === payload.sub)).toBe(true);
    expect(payload).toMatchObject({
      tournamentId: TOURNAMENT, tableId: TABLE, seatIndex: 0, role: 'PLAYER',
    });
  });

  it('틀린 OTP는 401이다', async () => {
    await participate('u1', '00000001');

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '99999999', tableId: TABLE, seatIndex: 0 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('없는 대회도 같은 401이다 — 존재하는 대회 id를 훑을 수 없어야 한다', async () => {
    await expect(
      service.enterSeat('no-such-tournament', { otp: '00000001', tableId: TABLE, seatIndex: 0 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('다른 대회의 OTP는 통하지 않는다', async () => {
    await seedTournament('entry-tournament-2', TournamentStatus.PENDING, []);
    await participate('u1', '00000001', 'entry-tournament-2');

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 0 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('끝난 대회는 403이다', async () => {
    await participate('u1', '00000001');
    await prisma.tournament.update({
      where: { id: TOURNAMENT }, data: { status: TournamentStatus.FINISHED },
    });

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 0 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  /**
   * T31 결정 5: 대회가 ONGOING이고 이 테이블에 이미 좌석 행(사람)이 있는데
   * 스냅샷이 없으면 `emptyTableState` fallback 대신 던진다. 이 상태는 부팅
   * 복구(`RecoveryService`)가 아직 그 테이블을 세우지 못한 순간이다 — 여기서
   * 빈 스냅샷을 만들면 그 테이블의 나머지 전원이 스냅샷에서 사라지고, 나중에
   * 도는 재구성이 오염된 위에서 돈다.
   *
   * u2를 미리 이 테이블에 앉혀 "지킬 상태가 있다"는 신호(`_count.tablePlayers
   * > 0`)를 만든다 — 이게 없으면 이 테이블은 그냥 아무도 앉은 적 없는 새
   * 테이블과 구별이 안 되고, 아래 "새 테이블" 테스트와 서로를 가린다.
   */
  it('ONGOING이고 이 테이블에 이미 사람이 있는데 스냅샷이 없으면 빈 스냅샷을 만들지 않고 던진다', async () => {
    await participate('u1', '00000001');
    await participate('u2', '00000002');
    await prisma.tournament.update({
      where: { id: TOURNAMENT }, data: { status: TournamentStatus.ONGOING },
    });
    // 세션 시작 흐름 없이 좌석 행만 직접 만든다 — Redis가 통째로 죽어
    // 스냅샷만 사라진 상태를 흉내 낸다.
    await prisma.tablePlayer.create({
      data: { tournamentId: TOURNAMENT, tableId: TABLE, userId: 'u2', nickname: 'u2', seatPosition: 1 },
    });

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 0 }),
    ).rejects.toThrow();

    // 핵심 단언: 빈 스냅샷이 생기지 않았다. 던지기만 하고 상태를 만들면
    // 다음 재구성이 오염된 위에서 돈다.
    expect(await snapshot()).toBeNull();
  });

  /**
   * 리뷰 finding(Important 2): 가드가 트랜잭션 **뒤**(락 안)에만 있으면
   * u1의 `tablePlayer.create` + `status=PLAYING`이 이미 커밋된 뒤에야 409를
   * 받는다. 안내대로 다른 좌석으로 재시도하면 `enterSeat` 맨 앞의 `seated`
   * 검사가 방금 커밋된 0번 행을 찾아 "이미 다른 좌석에 앉아 있습니다"를
   * 던진다 — 부팅 복구 없이는 빠져나올 수 없는 좌석 없는 PLAYING 상태에
   * 묶인다. `claimSeat`이 락 밖 `table` 조회 직후 같은 조건의 빠른 경로를
   * 두어 이걸 막는다.
   */
  it('막힌 착석은 좌석 행도 PLAYING 전환도 남기지 않는다 — 트랜잭션 커밋 전에 막는다', async () => {
    await participate('u1', '00000001');
    await participate('u2', '00000002');
    await prisma.tournament.update({
      where: { id: TOURNAMENT }, data: { status: TournamentStatus.ONGOING },
    });
    await prisma.tablePlayer.create({
      data: { tournamentId: TOURNAMENT, tableId: TABLE, userId: 'u2', nickname: 'u2', seatPosition: 1 },
    });

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 0 }),
    ).rejects.toThrow();

    // 지금 테스트는 스냅샷만 보므로 이 잔여물(u1의 좌석 행)을 못 잡는다 —
    // 좌석 행 개수를 직접 단언해야 트랜잭션이 실제로 안 돌았음을 증명한다.
    expect(await prisma.tablePlayer.count({ where: { tableId: TABLE } })).toBe(1);
    const u1 = await prisma.tournamentParticipation.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId: TOURNAMENT, userId: 'u1' } },
    });
    expect(u1.status).toBe(PlayerStatus.WAITING);
  });

  /**
   * 리뷰 finding(Important 3): 가드를 `status === ONGOING`으로만 좁히면 이
   * 구멍이 남는다 — PENDING 대회에서 u2가 착석해 스냅샷이 살아 있다가
   * Redis가 죽거나(FLUSHDB) 24시간 TTL로 스냅샷만 사라지면, u1의 착석이
   * `_count.tablePlayers > 0`인데도 status가 PENDING이라 가드를 피해
   * `emptyTableState`로 u1 혼자만 있는 스냅샷을 만든다. 그 위에서 대회가
   * 시작되면 u2는 영원히 빠진 채 대회가 돈다. `!== FINISHED`로 넓혀야 막힌다.
   */
  it('PENDING이어도 이미 사람이 있는 테이블에 스냅샷이 없으면 던진다', async () => {
    await participate('u1', '00000001');
    await participate('u2', '00000002');
    // beforeEach가 TOURNAMENT를 PENDING으로 세운다.
    await prisma.tablePlayer.create({
      data: { tournamentId: TOURNAMENT, tableId: TABLE, userId: 'u2', nickname: 'u2', seatPosition: 1 },
    });
    // 스냅샷은 만들지 않는다 — Redis 유실이나 TTL 만료를 흉내 낸다.

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 0 }),
    ).rejects.toThrow();

    expect(await snapshot()).toBeNull();
  });

  /**
   * 리뷰에서 드러난 경계: 상점이 대회 도중 `createTable`로 새 테이블을 열면
   * ONGOING인데도 그 테이블은 스냅샷이 없는 상태로 시작한다(누구도 앉은 적이
   * 없으므로). 이건 Redis 유실이 아니라 정상이다 — 위 가드가 좌석 행
   * 유무(`_count.tablePlayers`)로 이 경우를 가른다. 이 테스트가 없으면 가드를
   * "ONGOING이면 무조건 던지기"로 너무 넓게 걸어도 초록일 수 있다.
   */
  it('ONGOING이어도 아무도 앉은 적 없는 새 테이블은 fallback으로 스냅샷을 만든다', async () => {
    await participate('u1', '00000001');
    await prisma.tournament.update({
      where: { id: TOURNAMENT }, data: { status: TournamentStatus.ONGOING },
    });

    const { accessToken } = await service.enterSeat(TOURNAMENT, {
      otp: '00000001', tableId: TABLE, seatIndex: 0,
    });

    expect(accessToken).toEqual(expect.any(String));
    expect(await snapshot()).not.toBeNull();
  });

  /**
   * 가드가 대회 시작 전 정상 경로도 깨지 않는다는 것을 확인한다.
   */
  it('시작 전 첫 착석은 여전히 fallback으로 스냅샷을 만든다', async () => {
    await participate('u1', '00000001');
    // beforeEach가 TOURNAMENT를 PENDING으로 세운다 — 대회 시작 전이다.

    const { accessToken } = await service.enterSeat(TOURNAMENT, {
      otp: '00000001', tableId: TABLE, seatIndex: 0,
    });

    expect(accessToken).toEqual(expect.any(String));
    const state = await snapshot();
    expect(state).not.toBeNull();
    expect(state!.players[0]).toMatchObject({ id: 'u1' });
  });

  it('탈락한 참가자는 다시 앉지 못한다', async () => {
    await participate('u1', '00000001');
    await prisma.tournamentParticipation.updateMany({
      where: { userId: 'u1' }, data: { status: PlayerStatus.ELIMINATED },
    });

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 0 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('이 대회에 속하지 않은 테이블은 403이다', async () => {
    await seedTournament('entry-tournament-2', TournamentStatus.PENDING, ['foreign-table']);
    await participate('u1', '00000001');

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: 'foreign-table', seatIndex: 0 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('이미 다른 자리에 앉아 있으면 409다 — 이동은 T29다', async () => {
    await participate('u1', '00000001');
    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: OTHER_TABLE, seatIndex: 2 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('같은 좌석에 다시 넣으면 토큰만 새로 나오고 좌석은 하나다', async () => {
    await participate('u1', '00000001');
    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    expect(await prisma.tablePlayer.count({ where: { userId: 'u1' } })).toBe(1);
  });

  it('재입장이 진행 중인 핸드의 상태를 덮지 않는다', async () => {
    await participate('u1', '00000001');
    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    const live = (await snapshot())!;
    live.phase = GamePhase.FLOP;
    live.players[1]!.bet = 500;
    live.players[1]!.totalContributed = 500;
    await redisService.saveSnapShot(TABLE, live);

    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    const after = (await snapshot())!;
    expect(after.players[1]).toMatchObject({ bet: 500, totalContributed: 500 });
  });

  it('DB에는 있는데 스냅샷에서 사라진 좌석을 재입장이 되살린다', async () => {
    await participate('u1', '00000001');
    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    // DB를 쓰고 스냅샷을 쓰기 전에 죽은 상태를 그대로 만든다.
    const broken = (await snapshot())!;
    broken.players[1] = null;
    await redisService.saveSnapShot(TABLE, broken);

    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    expect((await snapshot())!.players[1]).toMatchObject({ id: 'u1' });
  });

  it('핸드 도중에 앉으면 이번 핸드는 폴드 상태로 들어간다 — 늦은 참가', async () => {
    await participate('u1', '00000001');
    await participate('u2', '00000002');
    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 0 });

    const live = (await snapshot())!;
    live.phase = GamePhase.FLOP;
    await redisService.saveSnapShot(TABLE, live);

    await service.enterSeat(TOURNAMENT, { otp: '00000002', tableId: TABLE, seatIndex: 4 });

    expect((await snapshot())!.players[4]).toMatchObject({ id: 'u2', hasFolded: true });
  });

  it('같은 좌석을 동시에 노리면 한 명만 앉고 진 쪽은 409를 받는다', async () => {
    await participate('u1', '00000001');
    await participate('u2', '00000002');

    const results = await Promise.allSettled([
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 2 }),
      service.enterSeat(TOURNAMENT, { otp: '00000002', tableId: TABLE, seatIndex: 2 }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.tablePlayer.count({ where: { tableId: TABLE, seatPosition: 2 } })).toBe(1);

    // T11이 지키던 것: 진 쪽이 500이 아니라 409를 받는다. 프론트가 "다른 자리를
    // 고르세요"와 "서버가 죽었다"를 구분하려면 이 타입이 정확해야 한다. 좌석
    // describe를 지우면서(T28 Task 3) 이 어서션 없이 통과가 남을 뻔했다 —
    // `claimSeat`의 catch가 `ConflictException`을 안 던지고 원본 Prisma
    // 에러를 그대로 흘려도 위 두 줄만으로는 초록이었다(T28 리뷰 finding 1).
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
  });

  it('다른 좌석에 동시에 앉으면 서로를 지우지 않는다', async () => {
    for (const [i, id] of ['u1', 'u2', 'u3'].entries()) {
      await participate(id, String(i + 1).padStart(8, '0'));
    }

    await Promise.all(
      ['u1', 'u2', 'u3'].map((_, i) =>
        service.enterSeat(TOURNAMENT, {
          otp: String(i + 1).padStart(8, '0'), tableId: TABLE, seatIndex: i,
        }),
      ),
    );

    const state = (await snapshot())!;
    expect(state.players.filter(Boolean)).toHaveLength(3);
  });

  /**
   * 리뷰 finding 1: 같은 OTP가 두 테이블에서 몇 ms 안에 동시에 들어오면,
   * 사전 체크(`tablePlayer.findFirst`)는 둘 다 통과시킨다 — 테이블마다 락이
   * 따로라 서로 막지 않는다. `@@unique([tournamentId, userId])`가 없으면
   * 둘 다 커밋되어 참가 하나가 좌석 둘을 갖는다.
   */
  it('같은 유저가 서로 다른 테이블을 동시에 노리면 한 곳에만 앉는다', async () => {
    await participate('u1', '00000001');

    const results = await Promise.allSettled([
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 2 }),
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: OTHER_TABLE, seatIndex: 3 }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.tablePlayer.count({ where: { userId: 'u1' } })).toBe(1);
  });

  /**
   * T28 리뷰 3라운드 finding 2: `payment.service.ts`는 이미 이 보증을
   * 스텁으로 검증한 적이 있었다(트랜잭션 커밋이 실패해도 Redis에 유령 착석이
   * 남지 않는다 — `docs/fixlist.md:376`). Task 3가 그 describe를 지우면서
   * "entry.service.int-spec.ts가 같은 것을 진짜 제약 위에서 본다"고 했지만,
   * 그 주장을 뒷받침하는 테스트가 실제로는 없었다.
   *
   * 스텁 없이 진짜로 커밋을 실패시킨다: 같은 유저가 두 테이블을 동시에
   * 노리면 `@@unique([tournamentId, userId])`가 진 쪽의 `tablePlayer.create`를
   * P2002로 되돌린다 — 위의 "한 곳에만 앉는다" 테스트와 같은 경합이다. 그
   * 테스트가 안 보는 것: 진 쪽이 노렸던 좌석에 스냅샷이나 비트맵 흔적이
   * 조금이라도 남는가. `claimSeat`은 스냅샷·비트맵 쓰기를 트랜잭션 **밖**에
   * 둬서 막고 있는데, 그 배치가 우연이 아니라 지켜야 할 계약이라는 것을
   * 여기서 고정한다. 누군가 "원자적으로 만들자"며 그 쓰기를 트랜잭션 안으로
   * 옮기면(자연스러워 보이는 리팩터다), 트랜잭션이 실패하기 전에 실행된
   * Redis 쓰기는 롤백되지 않고 살아남는다 — 이 테스트가 그걸 잡아야 한다.
   */
  it('두 테이블 경합에서 진 쪽이 노린 좌석에는 스냅샷도 비트맵도 남지 않는다', async () => {
    await participate('u1', '00000001');
    await redisService.setSeatBitmap(TOURNAMENT, TABLE);
    await redisService.setSeatBitmap(TOURNAMENT, OTHER_TABLE);

    const attempts = [
      { tableId: TABLE, seatIndex: 2 },
      { tableId: OTHER_TABLE, seatIndex: 3 },
    ];
    const results = await Promise.allSettled(
      attempts.map((a) =>
        service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: a.tableId, seatIndex: a.seatIndex }),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loserIndex = results.findIndex((r) => r.status === 'rejected');
    expect(loserIndex).toBeGreaterThanOrEqual(0);
    expect((results[loserIndex] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

    const winnerIndex = loserIndex === 0 ? 1 : 0;
    const loser = attempts[loserIndex];
    const winner = attempts[winnerIndex];

    // 이긴 쪽의 좌석은 정상적으로 채워진다.
    const winnerState = await snapshot(winner.tableId);
    expect(winnerState?.players[winner.seatIndex]).toMatchObject({ id: 'u1' });

    // 진 쪽이 노렸던 좌석에는 스냅샷도(테이블 자체가 비어 있거나, 그 자리가
    // null이거나) 비트맵도 흔적이 없어야 한다.
    const loserState = await snapshot(loser.tableId);
    expect(loserState?.players[loser.seatIndex] ?? null).toBeNull();
    const bitmap = await redis.hget(`tournament:${TOURNAMENT}:seat`, `table:${loser.tableId}`);
    expect(bitmap?.[loser.seatIndex]).toBe('0');
  });

  /**
   * 리뷰 2라운드 finding: 탈락 처리가 `TablePlayer` 행을 지운 뒤, 다음 핸드
   * 준비(`initTable`)가 스냅샷 자리를 비우기 전 사이의 창을 흉내 낸다. DB에는
   * 그 좌석의 행이 없지만 스냅샷은 여전히 예전 점유자를 가리키는 상태다.
   * 이 상태에서 새 참가자가 그 좌석을 노리면, DB가 좌석을 내줬으니 스냅샷의
   * 낡은 값을 예외 없이 고쳐 써야 한다 — 예외를 던지면 DB에는 이미 새
   * 참가자의 좌석이 커밋된 채로 클라이언트만 실패를 보고, 재시도해도
   * `alreadySeated`라 트랜잭션 없이 같은 예외가 반복돼 영구히 좌석 없는
   * PLAYING으로 묶인다.
   */
  it('스냅샷에 낡은 다른 참가자가 남아 있어도 DB가 비어 있으면 좌석을 되찾는다', async () => {
    await participate('u1', '00000001');
    await participate('ghost', '00000099');
    // ghost가 먼저 앉아 스냅샷에 자리를 남긴다.
    await service.enterSeat(TOURNAMENT, { otp: '00000099', tableId: TABLE, seatIndex: 7 });

    // 탈락 처리를 흉내 낸다: DB 행만 지우고 스냅샷은 그대로 둔다
    // (eliminatePlayer가 지운 뒤 initTable이 비우기 전의 창).
    await prisma.tablePlayer.deleteMany({ where: { userId: 'ghost' } });

    const before = (await snapshot())!;
    expect(before.players[7]).toMatchObject({ id: 'ghost' });

    const { accessToken } = await service.enterSeat(TOURNAMENT, {
      otp: '00000001', tableId: TABLE, seatIndex: 7,
    });
    expect(accessToken).toEqual(expect.any(String));

    const row = await prisma.tablePlayer.findFirstOrThrow({ where: { userId: 'u1' } });
    expect(row.tableId).toBe(TABLE);
    expect(row.seatPosition).toBe(7);

    const after = (await snapshot())!;
    expect(after.players[7]).toMatchObject({ id: 'u1' });

    // 재시도(같은 요청을 한 번 더)해도 안전하다 — 이제 alreadySeated라
    // 트랜잭션은 건너뛰고, 스냅샷은 이미 우리 것이라 손대지 않는다.
    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 7 });
    expect(await prisma.tablePlayer.count({ where: { userId: 'u1' } })).toBe(1);
    expect((await snapshot())!.players[7]).toMatchObject({ id: 'u1' });
  });

  /**
   * T28 최종 리뷰 finding 1(Critical): `seated`를 읽는 시점과 락 안에서
   * 스냅샷을 쓰는 시점 사이가 임의로 벌어질 수 있다. `withTableLock`은 최대
   * 5초를 재시도하고, `resolveWinners`는 그 같은 락을 여러 블록에 걸쳐 쥔다.
   *
   * 그 창에서 탈락이 끝나면(3단계가 `TablePlayer`를 지우고, 5단계
   * `finishHand` → `initTable`이 스냅샷 자리를 비운다) 대기하던 재입장이
   * 깨어나 `!occupant`를 보고 자기 자신을 낡은 스택으로 되살린다 — DB 행도
   * 없고 참가는 `ELIMINATED`인데 스냅샷에는 앉아 있는 유령이다.
   * `startPreFlop`은 스냅샷만 읽으므로 다음 핸드에 딜링되고,
   * `syncTableInventoryToDb`의 `updateMany`는 0행을 조용히 갱신해 스냅샷과
   * DB의 칩 총량이 아무 에러 없이 어긋난다.
   *
   * 락을 테스트가 직접 쥐고(raw SET) 재입장을 락 대기에 묶은 뒤, 그 안에서
   * 탈락을 흉내 내고 락을 놓는다. 락 진입 시점은 `withTableLock` 스파이로
   * 잡는다 — 그 시점이면 `enterSeat`의 DB 읽기(`seated` 포함)는 이미 끝나
   * 낡은 값을 손에 쥐고 있다.
   */
  describe('락을 기다리는 사이에 좌석의 주인이 바뀌면', () => {
    const LOCK_KEY = `lock:table:state:${TABLE}`;

    /** 재입장을 락 대기에 묶고, 락에 도달한 순간을 돌려준다. */
    async function blockReentryOnLock() {
      let reached!: () => void;
      const atLock = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const original = redisService.withTableLock.bind(redisService);
      const spy = jest
        .spyOn(redisService, 'withTableLock')
        .mockImplementation((tableId, fn, ttlMs, maxWaitMs) => {
          reached();
          return original(tableId, fn, ttlMs, maxWaitMs);
        });

      // 테스트가 락을 먼저 쥔다. 재입장은 여기서 50ms 간격으로 재시도한다.
      await redis.set(LOCK_KEY, 'test-holder', 'PX', 5000, 'NX');
      const settled = service
        .enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 })
        .then(() => 'fulfilled' as const)
        .catch((e: unknown) => e);
      await atLock;

      return {
        async release() {
          await redis.del(LOCK_KEY);
          const outcome = await settled;
          spy.mockRestore();
          return outcome;
        },
      };
    }

    /** 스냅샷 자리를 비운다 — `initTable`이 하는 일. */
    async function clearSeatInSnapshot() {
      const state = (await snapshot())!;
      state.players[1] = null;
      await redisService.saveSnapShot(TABLE, state);
    }

    it('탈락한 자신을 스냅샷에 되살리지 않는다', async () => {
      await participate('u1', '00000001');
      await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });
      await prisma.tournamentParticipation.updateMany({
        where: { userId: 'u1' }, data: { currentStack: 5000 },
      });

      const blocked = await blockReentryOnLock();

      // 창 안에서 딜러가 핸드를 정산하고 u1이 탈락한다.
      await prisma.tablePlayer.deleteMany({ where: { userId: 'u1' } });
      await prisma.tournamentParticipation.updateMany({
        where: { userId: 'u1' }, data: { status: PlayerStatus.ELIMINATED },
      });
      await clearSeatInSnapshot();

      const outcome = await blocked.release();

      // 유령이 남지 않는 것이 본론이다. 되살아나면 다음 핸드에 딜링되고
      // 스냅샷과 DB의 칩 총량이 조용히 어긋난다.
      expect((await snapshot())!.players[1]).toBeNull();
      expect(await prisma.tablePlayer.count({ where: { userId: 'u1' } })).toBe(0);
      expect(outcome).toBeInstanceOf(ConflictException);

      // 409가 좌석을 묶지 않는다: 재시도는 이제 `ELIMINATED` 검사에서 먼저
      // 걸린다 — 좌석 없는 PLAYING으로 남지 않는다.
      await expect(
        service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect((await snapshot())!.players[1]).toBeNull();
    });

    it('그 좌석을 새로 가져간 참가자를 덮어쓰지 않는다', async () => {
      await participate('u1', '00000001');
      await participate('u2', '00000002');
      await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

      const blocked = await blockReentryOnLock();

      // u1이 탈락해 자리가 비고, u2가 그 자리를 정당하게 가져간다.
      await prisma.tablePlayer.deleteMany({ where: { userId: 'u1' } });
      await prisma.tournamentParticipation.updateMany({
        where: { userId: 'u1' }, data: { status: PlayerStatus.ELIMINATED },
      });
      await clearSeatInSnapshot();
      await prisma.tablePlayer.create({
        data: {
          tournamentId: TOURNAMENT, tableId: TABLE, userId: 'u2',
          nickname: 'u2', seatPosition: 1,
        },
      });
      const withU2 = (await snapshot())!;
      withU2.players[1] = {
        id: 'u2', tableId: TABLE, nickname: 'u2', seatIndex: 1, stack: 10000,
        bet: 0, hasFolded: false, isAllIn: false, hasChecked: false, totalContributed: 0,
      };
      await redisService.saveSnapShot(TABLE, withU2);

      const outcome = await blocked.release();

      // u2는 DB 행과 스냅샷 좌석을 모두 지킨다 — 스냅샷에서 지워지면 u2 자신의
      // WS 접속이 `assertTableAccess`에서 거부된다.
      expect((await snapshot())!.players[1]).toMatchObject({ id: 'u2', stack: 10000 });
      expect(outcome).toBeInstanceOf(ConflictException);
    });
  });

  it('좌석 비트맵에 반영된다', async () => {
    await participate('u1', '00000001');
    await redisService.setSeatBitmap(TOURNAMENT, TABLE);

    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 5 });

    const bitmap = await redis.hget(`tournament:${TOURNAMENT}:seat`, `table:${TABLE}`);
    expect(bitmap![5]).toBe('1');
  });
});

// 위 `describe('EntryService.enterSeat', ...)`와는 별개의 최상위 describe다.
// `participate`/`seedTournament`/`snapshot`은 그 안의 지역 함수라 바깥에서
// 이름을 그대로 쓸 수 없고(스코프 밖), 그 describe의 `beforeEach`가 이미
// `TOURNAMENT`를 PENDING으로 시딩해 두므로 안에 중첩하면 이 테스트가 다시
// `seedTournament`를 부를 때 같은 id로 P2002가 난다. 그래서 같은 헬퍼를
// 그대로 복제한 채, 이 describe만의 대회/테이블 id로 독립된 상태에서 돈다.
describe('EntryService.enterSeat — 칩은 좌석보다 오래 산다', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let redisService: RedisService;
  let service: EntryService;

  const TOURNAMENT = 'entry-chip-tournament-1';
  const TABLE = 'entry-chip-table-1';

  /** 참가 하나를 만들고 그 OTP를 돌려준다. */
  async function participate(userId: string, otp: string, tournamentId = TOURNAMENT) {
    await prisma.user.create({ data: { id: userId, nickname: userId, password: 'x' } });
    await prisma.tournamentParticipation.create({
      data: { userId, tournamentId, playerOtp: otp, status: PlayerStatus.WAITING },
    });
    return otp;
  }

  /** `Table.dealerId`가 필수라 대회마다 딜러 세션이 하나 있어야 한다. */
  async function seedTournament(id: string, status: TournamentStatus, tableIds: string[]) {
    await prisma.tournament.create({
      data: {
        id, name: id, blindId: 'entry-chip-blind', storeId: 'entry-chip-store',
        dealerOtpHash: 'unused', entryFee: 1000, startStack: 10000,
        status, isRegistrationOpen: true,
      },
    });
    const dealerSession = await prisma.dealerSession.create({ data: { tournamentId: id } });
    for (const [order, tableId] of tableIds.entries()) {
      await prisma.table.create({
        data: {
          id: tableId, tournamentId: id, tableOrder: order + 1,
          dealerId: dealerSession.id,
        },
      });
    }
  }

  beforeAll(() => {
    prisma = createTestPrisma();
    redis = createTestRedis();
    redisService = new RedisService(redis);
    service = new EntryService(
      prisma as unknown as PrismaService,
      redisService,
      new JwtService({ secret: 'entry-spec-secret' }),
      new EventEmitter2(),
    );
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await flushTestRedis(redis);
    await prisma.user.create({
      data: { id: 'entry-chip-owner', nickname: 'entry-chip-owner', password: 'x', role: 'STORE_ADMIN' },
    });
    await prisma.store.create({
      data: { id: 'entry-chip-store', name: '칩상점', ownerId: 'entry-chip-owner' },
    });
    await prisma.blindStructure.create({
      data: {
        id: 'entry-chip-blind', name: '칩기본', storeId: 'entry-chip-store',
        structure: [{ lv: 1, sb: 100, ante: false, duration: 600 }],
      },
    });
  });

  afterAll(async () => {
    await closeTestPrisma(prisma);
    await redis.quit();
  });

  it('좌석 행이 사라져도 참가 행의 칩으로 다시 앉는다', async () => {
    await seedTournament(TOURNAMENT, TournamentStatus.ONGOING, [TABLE]);
    await participate('u1', '11111111');

    await service.enterSeat(TOURNAMENT, { otp: '11111111', tableId: TABLE, seatIndex: 0 });

    // 핸드가 돌아 스택이 바뀐 상태를 만든다.
    await prisma.tournamentParticipation.update({
      where: { tournamentId_userId: { tournamentId: TOURNAMENT, userId: 'u1' } },
      data: { currentStack: 23400 },
    });
    // 상점이 좌석을 해제한 것과 같은 상태 — 좌석 행만 사라진다. 스냅샷
    // 전체를 지우지 않는다(실제 `releaseSeats`도 그 좌석 하나만 비운다) —
    // 통째로 지우면 "ONGOING인데 스냅샷이 없다"는 T31의 재구성 대상 상태가
    // 되어 버려 이 테스트의 의도(좌석 해제)와 다른 것을 흉내 내게 된다.
    await prisma.tablePlayer.deleteMany({ where: { tournamentId: TOURNAMENT, userId: 'u1' } });
    const released = (await redisService.getSnapShot(TABLE))!;
    released.players[0] = null;
    await redisService.saveSnapShot(TABLE, released);

    await service.enterSeat(TOURNAMENT, { otp: '11111111', tableId: TABLE, seatIndex: 5 });

    const state = (await redisService.getSnapShot(TABLE))!;
    expect(`재착석 스택 ${state.players[5]!.stack}`).toBe('재착석 스택 23400');
  });
});

// 좌석 대기 화면(T34)이 읽는 조회. `getSeatMap`은 Redis 비트맵만 보고 DB를
// 건드리지 않으므로, 위 두 describe처럼 대회를 시딩할 필요가 없다 —
// `PrismaService`는 생성자 타입만 맞추면 되고 실제로 호출되지 않는다.
describe('EntryService.getSeatMap', () => {
  let redis: Redis;
  let redisService: RedisService;
  let service: EntryService;

  beforeAll(() => {
    redis = createTestRedis();
    redisService = new RedisService(redis);
    service = new EntryService(
      {} as unknown as PrismaService,
      redisService,
      new JwtService({ secret: 'entry-spec-secret' }),
      new EventEmitter2(),
    );
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('좌석 비트맵이 없는 대회는 빈 배열이다', async () => {
    const result = await service.getSeatMap('없는-대회-id');
    expect(result).toEqual([]);
  });

  it('앉은 자리만 true로 나온다', async () => {
    const tournamentId = 'entry-seatmap-tournament-1';
    const tableId = 'entry-seatmap-table-1';
    await redisService.setSeatBitmap(tournamentId, tableId);
    await redisService.updateSeatBitmap(tournamentId, tableId, 3, true);

    const result = await service.getSeatMap(tournamentId);

    expect(result).toEqual([
      { tableId, seatStatus: [false, false, false, true, false, false, false, false, false] },
    ]);
  });
});
