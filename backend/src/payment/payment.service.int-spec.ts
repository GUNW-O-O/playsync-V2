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
    await prisma.table.create({ data: { id: TABLE, tournamentId: TOURNAMENT, dealerId: session.id } });

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
    expect(afterTournament.activePlayers).toBe(beforeTournament.activePlayers + 1);
    expect(afterTournament.totalBuyinAmount).toBe(beforeTournament.totalBuyinAmount + 1000);

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

  it('같은 사람이 두 번 참가하면 재시도하지 않고 그대로 실패한다', async () => {
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

    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const err = caught as Prisma.PrismaClientKnownRequestError;
    expect(err.code).toBe('P2002');
    // ConflictException으로 포장되지 않고 Prisma 원본 에러 그대로 올라왔다는
    // 뜻이다 — 재시도 루프를 다 돌고 나서 뜨는 '참가 OTP를 만들지 못했습니다'
    // 메시지가 아니다.
    expect(err.message).not.toContain('참가 OTP를 만들지 못했습니다');

    // 충돌 필드가 playerOtp가 아니라 (tournamentId, userId)라는 것도 확인한다
    // — payment.service.ts의 판별 로직과 같은 자리를 본다.
    const meta = err.meta as
      | { target?: string[]; driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } } }
      | undefined;
    const violatedFields = meta?.target ?? meta?.driverAdapterError?.cause?.constraint?.fields ?? [];
    expect(violatedFields.some((f) => f.includes('playerOtp'))).toBe(false);

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
 */
describe('PaymentService.getTournamentInfo — 테이블이 없는 대회', () => {
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

  it('테이블이 있으면 예전처럼 비트맵을 되살린다', async () => {
    const service = makeService([{ id: 'table-a' }], 0);

    await service.getTournamentInfo(TOURNAMENT);

    expect(await redis.hget(`tournament:${TOURNAMENT}:seat`, 'table:table-a'))
      .toBe('000000000');
  });
});
