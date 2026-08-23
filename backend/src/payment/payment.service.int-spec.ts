import { ConflictException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { PayMentDto } from 'shared/dto/payment.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { SessionService } from 'src/store/session/session.service';
import { UserService } from 'src/user/user.service';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { PaymentService } from './payment.service';
import * as playerOtp from './player-otp';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';

/**
 * 참가 확정 시 발급되는 참가 OTP.
 *
 * 여기서부터는 DB를 스텁으로 두지 않는다. 검증 대상이 "OTP가 실제로 컬럼에
 * 박히는가", "충돌하면 트랜잭션 전체가 다시 도는가"라서 진짜 유니크 제약과
 * 진짜 P2002가 있어야 의미가 있다.
 */
describe('PaymentService — 참가 OTP 발급', () => {
  let redis: Redis;
  let prisma: PrismaClient;
  let redisService: RedisService;
  let userService: UserService;
  let service: PaymentService;
  let playsync: PlaysyncService;

  const TOURNAMENT = 'otp-tournament-1';
  const TABLE = 'otp-table-1';

  const dto: PayMentDto = { tournamentId: TOURNAMENT };

  /** 토너먼트 한 개, 테이블 한 개, 참가 후보 유저 둘. FK가 요구하는 최소 그래프만 만든다. */
  async function seedDb() {
    const owner = await prisma.user.create({ data: { nickname: 'otp-owner', password: 'x' } });
    const store = await prisma.store.create({ data: { name: 'otp-store-1', ownerId: owner.id } });
    const blind = await prisma.blindStructure.create({
      data: {
        name: 'otp-blind-1',
        storeId: store.id,
        structure: [{ lv: 1, sb: 100, ante: false, duration: 600 }],
      },
    });
    await prisma.tournament.create({
      data: {
        id: TOURNAMENT,
        name: 'OTP 대회',
        blindId: blind.id,
        storeId: store.id,
        dealerOtpHash: 'unused-hash', // 이 스펙은 딜러 로그인 경로를 검증하지 않는다.
        entryFee: 1000,
        startStack: 10000,
        isRegistrationOpen: true,
      },
    });
    const session = await prisma.dealerSession.create({ data: { tournamentId: TOURNAMENT } });
    await prisma.table.create({ data: { id: TABLE, tournamentId: TOURNAMENT, dealerId: session.id, tableOrder: 1 } });

    for (const id of ['u1', 'u2']) {
      await prisma.user.create({ data: { id, nickname: id, password: 'x', points: 100000 } });
    }
  }

  beforeAll(() => {
    redis = createTestRedis();
    prisma = createTestPrisma();
    redisService = new RedisService(redis);
    userService = new UserService(prisma as unknown as PrismaService);
    service = new PaymentService(
      userService,
      {} as unknown as SessionService,
      prisma as unknown as PrismaService,
      redisService,
    );
    // 리바인 트랜잭션만 부른다. processRebuy와 달리 사람의 팝업 응답을
    // 기다리지 않으므로 큐는 건드리지 않는다 — 스텁으로 충분하다.
    playsync = new PlaysyncService(
      {} as unknown as Queue,
      redisService,
      prisma as unknown as PrismaService,
      new EventEmitter2(),
    );
  });

  afterAll(async () => {
    await redis.quit();
    await closeTestPrisma(prisma);
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
    await truncateAll(prisma);
    await seedDb();
    await redisService.setSeatBitmap(TOURNAMENT, TABLE);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('참가하면 8자리 OTP가 발급된다', async () => {
    await service.joinSession(dto, 'u1');

    const [row] = await prisma.$queryRaw<{ playerOtp: string }[]>`
      SELECT "playerOtp" FROM "TournamentParticipation" WHERE "userId" = 'u1'
    `;
    expect(row.playerOtp).toMatch(/^\d{8}$/);
  });

  /**
   * 없는 유저를 거르는 자리는 `UserService.findByUUID` 하나다. 예전에는
   * 여기서도 한 번 더 막았는데, `findByUUID`의 `await`가 빠져 있어 그
   * 검사가 실제로 일하는 유일한 것이었다. `await`를 채우면 이 자리의
   * 검사는 도달 불가가 되므로 지웠고, 그래서 응답이 409가 아니라 404다.
   */
  it('없는 유저로 참가하면 404로 거절한다', async () => {
    await expect(service.joinSession(dto, 'no-such-user')).rejects.toThrow(NotFoundException);
  });

  it('참가자마다 다른 값이다', async () => {
    await service.joinSession(dto, 'u1');
    await service.joinSession(dto, 'u2');

    const rows = await prisma.$queryRaw<{ playerOtp: string }[]>`
      SELECT "playerOtp" FROM "TournamentParticipation" WHERE "tournamentId" = ${TOURNAMENT}
    `;
    expect(new Set(rows.map(r => r.playerOtp)).size).toBe(2);
  });

  it('충돌하면 다시 뽑는다 — 재시도가 부수효과를 정확히 한 번만 적용한다', async () => {
    // 첫 두 번은 같은 값을 주고, 세 번째부터 다른 값을 준다. u1의 발급(1회)과
    // u2의 첫 시도(1회)가 이 둘을 소비해 충돌을 만들고, u2의 재시도(2번째
    // $transaction 시도)는 mock 큐가 빈 뒤라 진짜 난수를 받아 통과한다.
    const otp = jest.spyOn(playerOtp, 'generatePlayerOtp');
    otp.mockReturnValueOnce('00000001').mockReturnValueOnce('00000001');

    await service.joinSession(dto, 'u1');

    // u1의 참가로 이미 늘어난 값 위에서 u2 몫만 재는 게 목적이라, 기준점을
    // u1 참가 "이후"에 잡는다. 재시도가 부수효과를 두 번 적용했다면 아래
    // before/after 차이가 entryFee나 카운터 증분의 배수로 어긋난다.
    const beforeUser = await prisma.user.findUniqueOrThrow({ where: { id: 'u2' } });
    const beforeTournament = await prisma.tournament.findUniqueOrThrow({ where: { id: TOURNAMENT } });
    otp.mockClear();

    await expect(
      service.joinSession(dto, 'u2'),
    ).resolves.toBeDefined();

    // 재시도가 실제로 일어났는지부터 확인한다. 여기서 통과하지 못하면
    // 아래 단정들은 "재시도 경로가 한 번만 적용한다"를 증명하지 못하고
    // "정상 경로가 한 번만 적용한다"만 증명하게 된다.
    expect(otp.mock.calls.length).toBeGreaterThan(1);

    const rows = await prisma.$queryRaw<{ playerOtp: string }[]>`
      SELECT "playerOtp" FROM "TournamentParticipation" WHERE "tournamentId" = ${TOURNAMENT}
    `;
    expect(new Set(rows.map(r => r.playerOtp)).size).toBe(2);

    // 포인트 차감이 재시도 횟수만큼(2번) 아니라 정확히 한 번만 반영됐는가.
    const afterUser = await prisma.user.findUniqueOrThrow({ where: { id: 'u2' } });
    expect(afterUser.points).toBe(beforeUser.points - 1000);

    // 대회 집계도 마찬가지로 시도 횟수가 아니라 성공한 참가 한 건만큼만 는다.
    const afterTournament = await prisma.tournament.findUniqueOrThrow({ where: { id: TOURNAMENT } });
    expect(afterTournament.totalPlayers).toBe(beforeTournament.totalPlayers + 1);
    expect(afterTournament.totalBuyinAmount).toBe(beforeTournament.totalBuyinAmount + 1000);
    // **결제는 `activePlayers`를 건드리지 않는다**(T55). 그 카운터가 세는 것은
    // 지금 살아 있는 사람이고, 올리는 것은 첫 착석이다 — 여기서 오르면 끝내
    // 안 온 사람이 최후 1인 판정을 영영 막는다.
    expect(afterTournament.activePlayers).toBe(beforeTournament.activePlayers);

    // 참가 행도 재시도로 실패한 첫 시도의 잔해 없이 정확히 하나다. 착석은
    // 이제 결제와 무관하다(T28) — 여기서 TablePlayer를 세지 않는다.
    const participationCount = await prisma.tournamentParticipation.count({
      where: { tournamentId: TOURNAMENT, userId: 'u2' },
    });
    expect(participationCount).toBe(1);

    // 포인트 원장(user.service.ts의 paymentPoint가 쓰는 PointTransaction)도
    // 한 건만 남아야 한다. 실패한 첫 시도의 차감이 롤백되지 않고 남았다면
    // 여기서 2가 나온다.
    const pointTxCount = await prisma.pointTransaction.count({
      where: { userId: 'u2', tournamentId: TOURNAMENT, type: 'BUY_IN' },
    });
    expect(pointTxCount).toBe(1);
  });

  it('같은 사람이 두 번 참가하면 409로 거절한다 — 재시도하지 않는다', async () => {
    // 인자 없는 `.rejects.toThrow()`는 아무 에러나 통과시킨다 — 충돌 판별을
    // 거꾸로 뒤집어(OTP 충돌이 아닌 것을 충돌로 오분류) 5번 재시도 끝에
    // `ConflictException('참가 OTP를 만들지 못했습니다...')`를 던지게 고장 내도
    // 그 조건을 만족해 버린다. 그래서 여기서는 두 가지를 정확히 짚는다 —
    // (1) 실제로 올라오는 에러가 (tournamentId, userId) 유니크 위반 그
    // 자체(Prisma P2002, playerOtp가 아닌 필드)라는 것, (2) 재시도를 하지
    // 않았다는 것을 OTP 생성 호출 횟수로 직접 증명하는 것.
    const otp = jest.spyOn(playerOtp, 'generatePlayerOtp');

    await service.joinSession(dto, 'u1');
    otp.mockClear();

    // 다시 결제해도 (tournamentId, userId) 유니크에 걸린다. 좌석이 결제에서
    // 빠진 뒤로는(T28) 이 값이 유일한 방어선이다 — 이건 OTP 충돌이 아니므로
    // 재시도 대상이 아니다.
    let caught: unknown;
    try {
      await service.joinSession(dto, 'u1');
    } catch (e) {
      caught = e;
    }

    // **문구가 있는 409여야 한다.** 예전에는 Prisma 원본 P2002가 그대로
    // 올라가 500이 됐고, 화면은 원인 없는 실패만 보여줬다 — 사실은 사람이
    // 아는 상황("이미 참가했다")이라 안내가 가능하다.
    expect(caught).toBeInstanceOf(ConflictException);
    const err = caught as ConflictException;
    expect(err.getStatus()).toBe(409);
    expect(err.message).toBe('이미 참가한 대회입니다.');

    // 재시도 루프를 다 돌고 나서 뜨는 OTP 문구가 아니다 — 그쪽이면 판별이
    // 거꾸로 뒤집힌 것이다.
    expect(err.message).not.toContain('참가 OTP를 만들지 못했습니다');

    // 재시도하지 않았다 — 두 번째 참가 시도에서 generatePlayerOtp가 정확히
    // 한 번만 불렸다(재시도했다면 2회 이상이었을 것이다).
    expect(otp).toHaveBeenCalledTimes(1);
  });

  it('리바인은 OTP를 다시 발급하지 않는다', async () => {
    await service.joinSession(dto, 'u1');
    const before = await prisma.$queryRaw<{ playerOtp: string }[]>`
      SELECT "playerOtp" FROM "TournamentParticipation" WHERE "userId" = 'u1'
    `;

    // 좌석을 만들 필요가 없다. T29가 칩을 좌석 배치표에서 장부로 옮긴 뒤로
    // executeRebuyTransaction은 TournamentParticipation 하나만 건드린다 —
    // 결제로 생긴 참가 행이 이미 그 대상이다.

    // 기존 리바인 경로. processRebuy는 사람의 팝업 응답을 기다리므로, 그
    // 응답이 들어온 뒤 실제로 DB를 건드리는 부분만 부른다.
    await playsync.executeRebuyTransaction(TOURNAMENT, TABLE, 'u1', 1000, 10000, 'OTP 대회');

    const after = await prisma.$queryRaw<{ playerOtp: string }[]>`
      SELECT "playerOtp" FROM "TournamentParticipation" WHERE "userId" = 'u1'
    `;
    expect(after[0].playerOtp).toBe(before[0].playerOtp);
  });

  /**
   * T66. `getTournamentInfo`는 가드 없는 공개 라우트(`GET /tournaments/:id`)의
   * 조회다 — 예전에는 `tables: true`로 `Table` 행을 통째로 select해
   * `dealerId`(딜러 세션 FK)까지 실었다. 이 스펙의 `seedDb`가 만드는
   * `TABLE` 행은 실제로 `dealerId`를 갖는다(딜러 세션과 연결돼 있다) —
   * 좁히지 않으면 이 테스트가 그 값을 그대로 잡아낸다.
   */
  it('tables에 dealerId 같은 관리용 컬럼을 싣지 않는다', async () => {
    const info = await service.getTournamentInfo(TOURNAMENT);

    expect(info.tournament?.tables).toEqual([{ id: TABLE, tableOrder: 1 }]);
  });
});

/**
 * 테이블이 하나도 없는 대회의 조회.
 *
 * 좌석 비트맵이 비면 DB에서 재구성을 시도하는 분기가 있다. 그 가드가
 * `if (!session || !session.tables)`였는데, `[]`는 truthy라 테이블이 0개인
 * 대회도 그대로 통과했다. 바로 다음 줄의 `session.tables[0].id`가
 * `TypeError: Cannot read properties of undefined`로 죽고, 이 엔드포인트는
 * 그 대회를 보고 있는 참가자 전원에게 500이 된다.
 *
 * 테이블 0개는 실제로 생긴다 — `completeSession`이 대회를 닫으며 전부 지운다.
 *
 * T52. **그 재구성 자체를 걷어냈다.** 되살리는 대상이 `tables[0]` 하나뿐이라
 * 테이블이 셋이면 둘은 비트맵 없이 남았고, 게다가 되살린 값을 응답의
 * `seatStatus`에 반영하지도 않았다(`let`으로 받아 놓고 다시 읽지 않는다) —
 * 부르는 쪽이 얻는 것이 없는 순수한 부수효과였다. 유실을 되세우는 권위는
 * `RecoveryService.recoverTournament`(T46) 하나다. 아래 스펙은 그 경계를
 * 지킨다: **읽기 경로는 읽기만 한다.**
 */
describe('PaymentService.getTournamentInfo — 좌석 비트맵이 빈 대회', () => {
  let redis: Redis;
  let redisService: RedisService;

  const TOURNAMENT = 'tournament-empty';

  beforeAll(() => {
    redis = createTestRedis();
    redisService = new RedisService(redis);
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
  });

  function makeService(tables: { id: string }[], totalPlayers: number) {
    const row = { id: TOURNAMENT, totalPlayers, tables };
    const prisma = {
      // getTournamentInfo가 이제 자기 select로 직접 조회하므로(더 이상
      // SessionService.getGameSession을 거치지 않는다), 두 번의
      // findUnique 호출(첫 조회 + 좌석 비트맵 재구성용 조회) 모두 이
      // 하나로 받는다.
      tournament: { findUnique: async () => row },
    } as unknown as PrismaService;

    return new PaymentService(
      {} as unknown as UserService, {} as unknown as SessionService, prisma, redisService,
    );
  }

  it('테이블이 0개여도 500이 아니라 빈 좌석 목록을 돌려준다', async () => {
    const service = makeService([], 0);

    const info = await service.getTournamentInfo(TOURNAMENT);

    expect(`좌석 목록 ${info.seatStatus.length}개`).toBe('좌석 목록 0개');
  });

  it('비트맵이 비어도 읽기 경로는 Redis에 쓰지 않는다', async () => {
    const service = makeService([{ id: 'table-a' }], 0);

    await service.getTournamentInfo(TOURNAMENT);

    const fields = await redis.hkeys(`tournament:${TOURNAMENT}:seat`);
    expect(`남긴 필드 ${fields.length}개`).toBe('남긴 필드 0개');
  });

  /**
   * 부분 재구성이 왜 위험한지 그대로 드러나는 자리. 예전 코드가 남기던 것은
   * "테이블 셋 중 1번만 있는 좌석 해시"였다 — 유실도 정상도 아닌 세 번째
   * 모양이라, 다음에 읽는 코드가 무엇을 믿어야 할지 정할 수 없다.
   */
  it('테이블이 셋이어도 1번만 되살아나는 반쪽 상태를 만들지 않는다', async () => {
    const service = makeService([{ id: 'table-a' }, { id: 'table-b' }, { id: 'table-c' }], 0);

    const info = await service.getTournamentInfo(TOURNAMENT);

    const fields = await redis.hkeys(`tournament:${TOURNAMENT}:seat`);
    expect(`필드 ${fields.length}개 / 응답 좌석 ${info.seatStatus.length}개`)
      .toBe('필드 0개 / 응답 좌석 0개');
  });
});

/**
 * T66. `GET /tournaments/stores`(`searchStore`)는 가드도 페이징도 없는 공개
 * 라우트다. 참가자용 대회 목록 화면(`(player)/tournaments/page.tsx`의
 * `fetchStores('')`)이 빈 쿼리로 불러 전체 목록을 받는 것이 의도된
 * 동작이라 그 자체는 유지한다 — 그런데 `store.findMany`가 행을 통째로
 * 돌려줘서 상점 관리자의 `ownerId`(uuid)까지 그 목록에 실렸다. 누구나
 * 열람 가능한 라우트에서 관리자 계정 id를 열거할 수 있었다는 뜻이다.
 */
describe('PaymentService.searchStore', () => {
  let prisma: PrismaClient;
  let service: PaymentService;

  beforeAll(() => {
    prisma = createTestPrisma();
    service = new PaymentService(
      {} as unknown as UserService,
      {} as unknown as SessionService,
      prisma as unknown as PrismaService,
      {} as unknown as RedisService,
    );
  });

  afterAll(async () => {
    await closeTestPrisma(prisma);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  it('ownerId를 싣지 않는다', async () => {
    const owner = await prisma.user.create({ data: { nickname: 'store-owner', password: 'x' } });
    await prisma.store.create({ data: { name: '검색 대상 상점', ownerId: owner.id } });

    const [store] = await service.searchStore('검색');

    expect(store).toEqual({ id: expect.any(String), name: '검색 대상 상점' });
    expect(store).not.toHaveProperty('ownerId');
  });

  it('빈 쿼리는 전체 목록을 준다 — 참가자용 대회 목록 화면이 이 동작에 기대고 있다', async () => {
    const owner = await prisma.user.create({ data: { nickname: 'store-owner-2', password: 'x' } });
    await prisma.store.create({ data: { name: '상점 A', ownerId: owner.id } });
    await prisma.store.create({ data: { name: '상점 B', ownerId: owner.id } });

    const stores = await service.searchStore('');

    expect(stores).toHaveLength(2);
  });
});

/**
 * T47. **등록 마감이 반쪽이었다.**
 *
 * 마감 스위치가 둘이다. 전광판이 보는 쪽(Redis 해시)은 블라인드가
 * `rebuyUntil` 레벨을 넘으면 `checkAndSyncBlindLevel`이 자동으로 내린다.
 * 결제 문지기가 보는 쪽(`Tournament.isRegistrationOpen` 컬럼)은 **대회 생성
 * 때 한 번 쓰이고 아무도 안 내린다.** 그래서 화면에는 "등록 마감"인데 그
 * 시각에 결제하면 참가가 됐다 — 블라인드가 이미 커진 대회에 늦은 참가자가
 * 돈을 내고 들어오고, 되돌리려면 환불이 필요한데 환불 경로가 없다.
 *
 * 고치는 방향은 "검사를 추가한다"가 아니다. 검사는 이미 있었다
 * (`payment.service.ts`의 `!session.isRegistrationOpen`). **마감이 무엇인지
 * 한 번만 계산하게** 만든다 — 상점이 연 상태(컬럼)와 현재 레벨을 함께 보는
 * 파생식 하나. 레벨은 `startedAt + pausedMs + 블라인드 구조`로 나오고 셋 다
 * DB에 있으므로 **Redis가 없어도 답이 나온다.** 돈 문지기의 정본을 캐시에
 * 두지 않는 것이 이 결정의 핵심이다.
 */
describe('PaymentService.joinSession — 등록 마감', () => {
  let redis: Redis;
  let prisma: PrismaClient;
  let redisService: RedisService;
  let service: PaymentService;

  const TOURNAMENT = 'close-tournament-1';

  /**
   * 레벨 하나가 1분인 구조 셋. `rebuyUntil`은 레벨 번호(`lv`)와 비교되므로
   * 구조의 `lv` 값을 그대로 쓴다.
   */
  const STRUCTURE = [
    { lv: 1, sb: 100, ante: false, duration: 1 },
    { lv: 2, sb: 200, ante: false, duration: 1 },
    { lv: 3, sb: 300, ante: false, duration: 1 },
  ];

  /**
   * ONGOING 대회 하나. `startedAtMsAgo`로 지금 몇 레벨인지 정한다 —
   * 90초 전 시작이면 레벨 2(인덱스 1) 한가운데다.
   */
  async function seedTournament(opts: {
    startedAtMsAgo: number;
    rebuyUntil: number;
    isRegistrationOpen?: boolean;
    pausedMs?: number;
  }) {
    const owner = await prisma.user.create({ data: { nickname: 'close-owner', password: 'x' } });
    const store = await prisma.store.create({ data: { name: 'close-store', ownerId: owner.id } });
    const blind = await prisma.blindStructure.create({
      data: { name: 'close-blind', storeId: store.id, structure: STRUCTURE },
    });
    await prisma.tournament.create({
      data: {
        id: TOURNAMENT,
        name: '마감 대회',
        blindId: blind.id,
        storeId: store.id,
        dealerOtpHash: 'unused-hash',
        entryFee: 1000,
        startStack: 10000,
        rebuyUntil: opts.rebuyUntil,
        isRegistrationOpen: opts.isRegistrationOpen ?? true,
        status: 'ONGOING',
        startedAt: new Date(Date.now() - opts.startedAtMsAgo),
        pausedMs: opts.pausedMs ?? 0,
      },
    });
    await prisma.user.create({
      data: { id: 'late-comer', nickname: 'late-comer', password: 'x', points: 100000 },
    });
  }

  /**
   * 대회 메타(전광판 + 블라인드 시계)를 Redis에 세운다. `cachedLv`·`cachedOpen`을
   * 실제와 어긋나게 줄 수 있어야 "캐시가 늦었을 때"를 재현할 수 있다.
   */
  async function seedRedisMeta(opts: {
    startedAtMsAgo: number;
    cachedLv: number;
    cachedOpen: boolean;
  }) {
    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: TOURNAMENT } });
    const blindBaseAt = Date.now() - opts.startedAtMsAgo;
    await redisService.setTournamentMeta(
      TOURNAMENT,
      {
        isRegistrationOpen: opts.cachedOpen,
        totalPlayer: 0,
        activePlayer: 0,
        totalBuyinAmount: 0,
        rebuyUntil: t.rebuyUntil,
        avgStack: 0,
        entryFee: t.entryFee,
        tournamentName: t.name,
        startStack: t.startStack,
        itmCount: t.itmCount,
        prizePool: 0,
        prizes: [{ place: 1, percent: 100, amount: 0 }],
      },
      {
        isBreak: false,
        startedAt: blindBaseAt,
        currentBlindLv: opts.cachedLv,
        // 과거로 둔다 — 레벨 경계를 이미 지났다는 뜻이라 동기화가 재계산에
        // 들어간다. 미래로 두면 캐시 조기 반환에 걸려 이 입력이 무의미해진다.
        nextLevelAt: Date.now() - 1_000,
        serverTime: Date.now(),
        blindStructure: STRUCTURE,
      },
    );
  }

  beforeAll(() => {
    redis = createTestRedis();
    prisma = createTestPrisma();
    redisService = new RedisService(redis);
    service = new PaymentService(
      new UserService(prisma as unknown as PrismaService),
      {} as unknown as SessionService,
      prisma as unknown as PrismaService,
      redisService,
    );
  });

  afterAll(async () => {
    await redis.quit();
    await closeTestPrisma(prisma);
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
    await truncateAll(prisma);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * **Redis를 일부러 비워 둔다.** 마감 판정이 캐시에 기대고 있으면 여기서
   * 드러난다 — 그것이 이 티켓이 없애려는 의존이다.
   */
  it('마감 레벨을 지났으면 참가를 거절한다', async () => {
    // 90초 경과 → 레벨 2. rebuyUntil 2면 `curLv >= rebuyUntil`이라 마감이다.
    await seedTournament({ startedAtMsAgo: 90_000, rebuyUntil: 2 });

    await expect(service.joinSession({ tournamentId: TOURNAMENT }, 'late-comer'))
      .rejects.toThrow();

    // 포인트가 실제로 빠지지 않았는지까지 본다. 예외만 보면 "던지긴 했는데
    // 이미 차감한 뒤"를 놓친다.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: 'late-comer' } });
    expect(`포인트 ${user.points}`).toBe('포인트 100000');
    expect(await prisma.tournamentParticipation.count()).toBe(0);
  });

  /**
   * 위와 **어긋나는 입력**이다. 무조건 거절하는 고침은 위를 통과시키면서
   * 여기를 깨뜨린다.
   */
  it('마감 레벨 전이면 참가시킨다', async () => {
    // 30초 경과 → 레벨 1. rebuyUntil 2면 아직 열려 있다.
    await seedTournament({ startedAtMsAgo: 30_000, rebuyUntil: 2 });

    await expect(service.joinSession({ tournamentId: TOURNAMENT }, 'late-comer'))
      .resolves.toBeDefined();

    expect(await prisma.tournamentParticipation.count()).toBe(1);
  });

  /**
   * 상점이 손으로 닫은 것은 레벨과 무관하게 유지된다. 파생식이 컬럼을
   * 무시하고 레벨만 보면 여기가 빨개진다 — 상점의 수동 마감이 무력해진다.
   */
  it('상점이 손으로 닫았으면 레벨과 무관하게 거절한다', async () => {
    await seedTournament({ startedAtMsAgo: 30_000, rebuyUntil: 2, isRegistrationOpen: false });

    await expect(service.joinSession({ tournamentId: TOURNAMENT }, 'late-comer'))
      .rejects.toThrow();
  });

  /**
   * 정지 시간은 진행 시간이 아니다. 서버가 죽어 있던 60초를 빼면 실제 진행은
   * 30초라 아직 레벨 1이다. `pausedMs`를 빼먹으면 장애를 겪은 대회에서만
   * 등록이 일찍 닫힌다 — 블라인드 시계가 이미 같은 보정을 하고 있으므로
   * (T31), 결제만 다른 시각을 보면 전광판과 어긋난다.
   */
  it('정지 시간(pausedMs)만큼은 진행으로 세지 않는다', async () => {
    await seedTournament({ startedAtMsAgo: 90_000, rebuyUntil: 2, pausedMs: 60_000 });

    await expect(service.joinSession({ tournamentId: TOURNAMENT }, 'late-comer'))
      .resolves.toBeDefined();
  });

  /**
   * **Redis 메타가 살아 있으면 그쪽이 평소 경로다.** 마감 판정은 핸드가 시작될
   * 때마다 `checkAndSyncBlindLevel`이 이미 갱신해 두는 값이라, 결제가 DB에서
   * 레벨을 다시 계산할 이유가 없다 — 캐시를 둔 목적이 그것이다.
   *
   * 여기 입력은 **한 박자 늦은 캐시**다. 해시에는 아직 '열림'이 박혀 있고
   * `nextLevelAt`은 이미 지났다(레벨이 넘어갔다는 뜻). `getFullTournamentInfo`가
   * 해시를 읽은 **뒤에** 동기화를 부르면 이 호출만 옛 값을 돌려주고, 마감 순간에
   * 딱 한 명이 통과한다.
   */
  it('마감 순간에도 통과시키지 않는다 — 캐시가 한 박자 늦어도', async () => {
    await seedTournament({ startedAtMsAgo: 90_000, rebuyUntil: 2 });
    await seedRedisMeta({ startedAtMsAgo: 90_000, cachedLv: 0, cachedOpen: true });

    await expect(service.joinSession({ tournamentId: TOURNAMENT }, 'late-comer'))
      .rejects.toThrow();
    expect(await prisma.tournamentParticipation.count()).toBe(0);
  });

  /**
   * 거절한 김에 DB 컬럼도 닫는다. **마감을 단조로 만든다** — 한 번 닫히면 다시
   * 열리지 않는다. 그래야 Redis를 잃은 뒤의 fallback도 이미 닫힌 상태에서
   * 출발하고, 복구가 정지 시간을 과잉 보정해 레벨이 한 칸 내려가는 경우에도
   * (T31이 테스트로 잡아 둔 자리) 등록이 되살아나지 않는다.
   *
   * 쓰기는 **조건부**여야 한다. 마감 뒤 결제 시도마다 UPDATE가 나가면 안 된다.
   */
  it('마감으로 거절하면 DB 컬럼도 닫는다', async () => {
    await seedTournament({ startedAtMsAgo: 90_000, rebuyUntil: 2 });
    await seedRedisMeta({ startedAtMsAgo: 90_000, cachedLv: 1, cachedOpen: false });

    await expect(service.joinSession({ tournamentId: TOURNAMENT }, 'late-comer'))
      .rejects.toThrow();

    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: TOURNAMENT } });
    expect(`컬럼 ${t.isRegistrationOpen}`).toBe('컬럼 false');
  });

  /**
   * 반대 방향. 캐시가 '열림'이고 레벨도 마감 전이면 통과해야 한다 — 무조건
   * 거절하는 고침을 가른다.
   */
  it('Redis가 열려 있으면 참가시킨다', async () => {
    await seedTournament({ startedAtMsAgo: 30_000, rebuyUntil: 3 });
    await seedRedisMeta({ startedAtMsAgo: 30_000, cachedLv: 0, cachedOpen: true });

    await expect(service.joinSession({ tournamentId: TOURNAMENT }, 'late-comer'))
      .resolves.toBeDefined();
  });

  /**
   * 아직 시작하지 않은 대회에는 레벨이 없다. `startedAt`이 null인데 레벨을
   * 계산하려 들면 여기서 터지거나(0을 기준점으로 삼아 마지막 레벨이 나온다)
   * 사전 등록이 통째로 막힌다.
   */
  it('시작 전 대회는 레벨을 보지 않고 열어 둔다', async () => {
    await seedTournament({ startedAtMsAgo: 0, rebuyUntil: 1 });
    await prisma.tournament.update({
      where: { id: TOURNAMENT },
      data: { status: 'PENDING', startedAt: null },
    });

    await expect(service.joinSession({ tournamentId: TOURNAMENT }, 'late-comer'))
      .resolves.toBeDefined();
  });

  /**
   * 그리고 **캐시를 묻지도 않는다.** 시작 전 대회는 Redis 메타 자체가 없어서
   * (`startSession`이 세운다) 조회가 반드시 헛방이고, 그 뒤 DB를 한 번 더 읽는
   * fallback까지 타게 된다. 사전 등록은 대회 직전에 몰리는 구간이라 그 헛수고가
   * 그대로 부하다.
   *
   * 이 단언이 없으면 결제의 조기 반환을 지워도 초록이다 — fallback의 같은
   * 판단이 결과를 가려 준다(CLAUDE.md "두 검사가 서로를 가렸다").
   */
  it('시작 전 대회는 캐시를 묻지 않는다', async () => {
    await seedTournament({ startedAtMsAgo: 0, rebuyUntil: 1 });
    await prisma.tournament.update({
      where: { id: TOURNAMENT },
      data: { status: 'PENDING', startedAt: null },
    });
    const lookup = jest.spyOn(redisService, 'getTournamentDashboard');

    await service.joinSession({ tournamentId: TOURNAMENT }, 'late-comer');

    expect(lookup).not.toHaveBeenCalled();
  });
});

/**
 * 목업 결제 — 충전과 거절(T72).
 *
 * **이 스펙의 값어치는 "가짜 결제"가 아니라 거절이다.** 지금까지 결제 거절
 * 경로에는 통합 테스트가 없었다. 포인트 게이트를 단위로 확인하는 것은 있어도,
 * **거절 뒤에 무엇이 남지 않는지**를 보는 검사가 없었다.
 *
 * 스텁을 쓰지 않는다. 검증 대상이 "트랜잭션이 통째로 되돌아가는가"라서
 * 진짜 트랜잭션이 있어야 의미가 있다.
 */
describe('PaymentService — 목업 충전과 거절 롤백', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let userService: UserService;
  let service: PaymentService;

  const TOURNAMENT = 'charge-tournament-1';
  const USER = 'charge-user-1';
  const ENTRY_FEE = 5000;

  async function seedDb(points: number) {
    const owner = await prisma.user.create({ data: { nickname: 'charge-owner', password: 'x' } });
    const store = await prisma.store.create({ data: { name: 'charge-store-1', ownerId: owner.id } });
    const blind = await prisma.blindStructure.create({
      data: {
        name: 'charge-blind-1',
        storeId: store.id,
        structure: [{ lv: 1, sb: 100, ante: false, duration: 600 }],
      },
    });
    await prisma.tournament.create({
      data: {
        id: TOURNAMENT,
        name: '충전 대회',
        blindId: blind.id,
        storeId: store.id,
        dealerOtpHash: 'unused-hash',
        entryFee: ENTRY_FEE,
        startStack: 10000,
        isRegistrationOpen: true,
      },
    });
    await prisma.user.create({ data: { id: USER, nickname: USER, password: 'x', points } });
  }

  beforeAll(() => {
    redis = createTestRedis();
    prisma = createTestPrisma();
    userService = new UserService(prisma as unknown as PrismaService);
    service = new PaymentService(
      userService,
      {} as unknown as SessionService,
      prisma as unknown as PrismaService,
      new RedisService(redis),
    );
  });

  afterAll(async () => {
    await redis.quit();
    await closeTestPrisma(prisma);
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
    await truncateAll(prisma);
  });

  it('승인되면 포인트가 오른다', async () => {
    await seedDb(0);

    await service.chargePoint(USER, 10_000);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: USER } });
    expect(user.points).toBe(10_000);
  });

  /**
   * `TransactionType.CHARGE`가 `schema.prisma`에 **선언만 있고 사용처가
   * 0건**이었다(T71 9-3이 같은 항목을 적었고 T72로 옮겼다). 여기가 첫
   * 사용처다.
   */
  it('승인되면 CHARGE 거래 내역이 남는다', async () => {
    await seedDb(0);

    await service.chargePoint(USER, 10_000);

    const rows = await prisma.pointTransaction.findMany({ where: { userId: USER } });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('CHARGE');
    expect(rows[0].amount).toBe(10_000);
  });

  /**
   * 402다. **`HttpException`을 직접 쓴다** — NestJS에 `PaymentRequiredException`이
   * 없다. 409(포인트 부족)와 갈라야 화면이 "결제가 거절됐다"와 "돈이 모자란다"를
   * 다르게 안내할 수 있다.
   */
  it('거절되면 402로 막는다', async () => {
    await seedDb(0);

    const err = await service.chargePoint(USER, 9_999).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
  });

  /**
   * 두 단언을 갈라 뒀다. 포인트만 보면 **거래 내역만 남기는 구현**이
   * 통과하고, 내역만 보면 그 반대가 통과한다.
   */
  it('거절되면 포인트가 그대로다', async () => {
    await seedDb(700);

    await expect(service.chargePoint(USER, 9_999)).rejects.toThrow();

    const user = await prisma.user.findUniqueOrThrow({ where: { id: USER } });
    expect(user.points).toBe(700);
  });

  it('거절되면 거래 내역이 안 남는다', async () => {
    await seedDb(700);

    await expect(service.chargePoint(USER, 9_999)).rejects.toThrow();

    expect(await prisma.pointTransaction.count({ where: { userId: USER } })).toBe(0);
  });

  /**
   * **거절의 진짜 값어치가 여기 있다.**
   *
   * 충전이 거절되면 그 사람은 포인트가 모자란 채로 참가를 시도한다. 그
   * 참가가 409로 막힐 때 넷이 하나도 안 남아야 한다 — 참가 행 · 참가 OTP ·
   * 거래 내역 · 프라이즈풀. 아무도 이걸 재지 않았다.
   */
  describe('거절당한 사람이 참가를 시도하면', () => {
    beforeEach(async () => {
      await seedDb(ENTRY_FEE - 1);
      await expect(service.chargePoint(USER, 9_999)).rejects.toThrow();
    });

    it('409로 막는다', async () => {
      await expect(
        service.joinSession({ tournamentId: TOURNAMENT }, USER),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('참가 행이 안 남는다', async () => {
      await expect(service.joinSession({ tournamentId: TOURNAMENT }, USER)).rejects.toThrow();

      expect(
        await prisma.tournamentParticipation.count({ where: { userId: USER } }),
      ).toBe(0);
    });

    it('거래 내역이 안 남는다', async () => {
      await expect(service.joinSession({ tournamentId: TOURNAMENT }, USER)).rejects.toThrow();

      expect(await prisma.pointTransaction.count({ where: { userId: USER } })).toBe(0);
    });

    /**
     * 프라이즈풀은 `totalBuyinAmount`다. 여기가 올라가면 전광판의 상금이
     * 아무도 안 낸 돈을 표시한다.
     */
    it('프라이즈풀이 안 오른다', async () => {
      await expect(service.joinSession({ tournamentId: TOURNAMENT }, USER)).rejects.toThrow();

      const tournament = await prisma.tournament.findUniqueOrThrow({ where: { id: TOURNAMENT } });
      expect(tournament.totalBuyinAmount).toBe(0);
      expect(tournament.totalPlayers).toBe(0);
    });
  });
});

/**
 * **참가하는 사이에 대회가 닫힌다.**
 *
 * `joinSession`은 `isClosedTournament`로 먼저 거절하는데, 그 검사는 **트랜잭션
 * 밖**이다. 검사와 커밋 사이에 상점이 대회를 닫으면(`completeSession` ·
 * `cancelSession`) 참가비와 참가 행이 죽은 대회에 들어간다 — 그 대회는 이미
 * 「걷은 참가비 == 나간 상금」을 맞춰 놓고 닫힌 뒤라, 늘어난 `totalBuyinAmount`는
 * 어느 상금으로도 나가지 않는다.
 *
 * **늦은 도착으로는 재현되지 않는다.** 닫힌 뒤에 부르면 트랜잭션 앞의 검사가
 * 잡는다. 그래서 트랜잭션 **한가운데**서 닫아야 하고, 그 자리를 만드는 것이
 * `paymentPoint` 스파이다 — 콜래버레이터를 흉내 내는 것이 아니라 **진짜를
 * 부르되 그 앞에 시각 하나를 끼워 넣는다.**
 */
describe('PaymentService.joinSession — 참가하는 사이에 대회가 닫히면', () => {
  let redis: Redis;
  let prisma: PrismaClient;
  let redisService: RedisService;
  let userService: UserService;
  let service: PaymentService;

  const TOURNAMENT = 'race-tournament-1';
  const USER = 'race-joiner';
  const ENTRY_FEE = 1000;
  const POINTS = 50_000;

  async function seedDb() {
    const owner = await prisma.user.create({ data: { nickname: 'race-owner', password: 'x' } });
    const store = await prisma.store.create({ data: { name: 'race-store', ownerId: owner.id } });
    const blind = await prisma.blindStructure.create({
      data: {
        name: 'race-blind',
        storeId: store.id,
        structure: [{ lv: 1, sb: 100, ante: false, duration: 600 }],
      },
    });
    await prisma.tournament.create({
      data: {
        id: TOURNAMENT,
        name: '경합 대회',
        blindId: blind.id,
        storeId: store.id,
        dealerOtpHash: 'unused-hash',
        entryFee: ENTRY_FEE,
        startStack: 10000,
        isRegistrationOpen: true,
      },
    });
    await prisma.user.create({
      data: { id: USER, nickname: USER, password: 'x', points: POINTS },
    });
  }

  /**
   * 참가비가 빠진 **직후, 대회 장부를 건드리기 직전**에 대회를 닫는다.
   *
   * 그 순서라야 창이 재현된다 — 트랜잭션은 아직 `Tournament` 행에 손대지
   * 않았으므로 바깥의 UPDATE가 잠금 없이 통과하고, 뒤이은 `tx.tournament.update`가
   * 이미 닫힌 대회를 만난다.
   */
  function closeMidTransaction() {
    const real = userService.paymentPoint.bind(userService);
    jest.spyOn(userService, 'paymentPoint').mockImplementation(async (...args) => {
      await prisma.tournament.update({
        where: { id: TOURNAMENT },
        data: { status: 'CANCELLED' },
      });
      return real(...args);
    });
  }

  beforeAll(() => {
    redis = createTestRedis();
    prisma = createTestPrisma();
    redisService = new RedisService(redis);
    userService = new UserService(prisma as unknown as PrismaService);
    service = new PaymentService(
      userService,
      {} as unknown as SessionService,
      prisma as unknown as PrismaService,
      redisService,
    );
  });

  afterAll(async () => {
    await redis.quit();
    await closeTestPrisma(prisma);
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
    await truncateAll(prisma);
    await seedDb();
    closeMidTransaction();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('409로 막는다 — 닫힌 뒤에 부른 것과 같은 문구다', async () => {
    await expect(
      service.joinSession({ tournamentId: TOURNAMENT }, USER),
    ).rejects.toThrow('이미 닫힌 세션입니다.');
  });

  it('참가비가 빠지지 않는다 — 같은 트랜잭션이라 함께 되돌아간다', async () => {
    await expect(service.joinSession({ tournamentId: TOURNAMENT }, USER)).rejects.toThrow();

    const user = await prisma.user.findUniqueOrThrow({ where: { id: USER } });
    const ledger = await prisma.pointTransaction.count({ where: { userId: USER } });

    expect(`지갑 ${user.points} / 거래 ${ledger}건`).toBe(`지갑 ${POINTS} / 거래 0건`);
  });

  it('참가 행과 대회 장부가 그대로다', async () => {
    await expect(service.joinSession({ tournamentId: TOURNAMENT }, USER)).rejects.toThrow();

    const rows = await prisma.tournamentParticipation.count({ where: { tournamentId: TOURNAMENT } });
    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: TOURNAMENT } });

    expect(`참가 ${rows}행 / 결제 ${t.totalPlayers}명 / 걷은 ${t.totalBuyinAmount}`)
      .toBe('참가 0행 / 결제 0명 / 걷은 0');
  });

  /** 재시도 루프가 이것을 OTP 충돌로 오해하면 다섯 번을 헛돈다. */
  it('재시도하지 않는다 — 마감은 단조라 결과가 같다', async () => {
    await expect(service.joinSession({ tournamentId: TOURNAMENT }, USER)).rejects.toThrow();

    expect(userService.paymentPoint).toHaveBeenCalledTimes(1);
  });
});
