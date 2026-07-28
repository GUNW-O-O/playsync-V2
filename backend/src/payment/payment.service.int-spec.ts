import { ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient, TournamentStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { PayMentDto } from 'shared/dto/payment.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { SessionService } from 'src/store/session/session.service';
import { TableState } from 'src/game-engine/types';
import { UserService } from 'src/user/user.service';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { PaymentService } from './payment.service';
import * as playerOtp from './player-otp';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';

/**
 * 착석이 DB와 Redis 두 곳에 어떻게 반영되는가.
 *
 * DB는 진짜가 아니라 스텁이다. 검증 대상이 "DB 작업이 실패했을 때 Redis에
 * 무엇이 남는가"이므로 필요한 것은 **실패를 마음대로 일으킬 수 있는 DB**와
 * **진짜 Redis**다. Prisma를 진짜로 띄우면 원하는 지점에서 롤백을 만들기 위해
 * 오히려 더 많은 장치가 필요해진다.
 */
describe('PaymentService.joinSessionWithSeat', () => {
  let redis: Redis;
  let redisService: RedisService;
  let emitter: EventEmitter2;

  const TOURNAMENT = 'tournament-1';
  const TABLE = 'table-1';
  const stateKey = `table:state:${TABLE}`;
  const seatKey = `tournament:${TOURNAMENT}:seat`;

  const sessionRow: {
    id: string;
    name: string;
    status: TournamentStatus;
    isRegistrationOpen: boolean;
    entryFee: number;
    startStack: number;
  } = {
    id: TOURNAMENT,
    name: 'T',
    status: TournamentStatus.PENDING,
    isRegistrationOpen: true,
    entryFee: 1000,
    startStack: 10000,
  };

  function dto(seatIndex: number): PayMentDto {
    return { tournamentId: TOURNAMENT, tableId: TABLE, seatIndex };
  }

  /**
   * @param failAt 어디서 터뜨릴지. undefined면 전부 성공.
   *
   *   - `'write'`: 트랜잭션 중간의 DB 쓰기가 실패한다.
   *   - `'commit'`: 콜백은 끝까지 돌고 **커밋이** 실패한다. P2-1이 노출되는
   *     지점이 여기다. 예전 코드는 `saveSnapShot`을 콜백의 마지막 문장으로
   *     두었으므로 중간 실패로는 Redis에 아무것도 남지 않는다. 반면 커밋
   *     실패는 콜백이 이미 전부 실행된 뒤라, 그때 쓴 스냅샷만 롤백되지 않고
   *     살아남는다 — DB에 없는 사람이 자리를 차지한다.
   */
  function makeService(failAt?: 'write' | 'commit' | 'seatTaken') {
    const tx = {
      tablePlayer: {
        // 'seatTaken': 좌석 락은 통과했는데 DB에는 이미 사람이 있는 경우.
        // 락과 DB가 어긋난 상태라 정상 경로로는 만들 수 없고, 그래서 여기의
        // 백스톱이 실제로 무엇을 던지는지는 스텁으로만 확인할 수 있다.
        findUnique: async () => (failAt === 'seatTaken' ? { id: 'someone' } : null),
        create: async () => ({}),
      },
      tournamentParticipation: { create: async () => ({}) },
      tournament: {
        update: async () => {
          if (failAt === 'write') throw new Error('DB 실패');
          return {};
        },
      },
    };

    const prisma = {
      tournament: { findUnique: async () => sessionRow },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
        const result = await fn(tx);
        if (failAt === 'commit') throw new Error('커밋 실패');
        return result;
      },
    } as unknown as PrismaService;

    const user = {
      findByUUID: async (id: string) => ({ id, nickname: id, points: 100000 }),
      paymentPoint: async () => ({}),
    } as unknown as UserService;

    // 이 스위트가 부르는 경로는 SessionService를 쓰지 않는다. 예전에는
    // 착석이 createTable을 불러서 스텁이 필요했다.
    const session = {} as unknown as SessionService;

    return new PaymentService(user, session, prisma, redisService, emitter);
  }

  beforeAll(() => {
    redis = createTestRedis();
    redisService = new RedisService(redis);
    emitter = new EventEmitter2();
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
    await redisService.setSeatBitmap(TOURNAMENT, TABLE);
  });

  describe('DB 실패', () => {
    it('커밋이 실패하면 스냅샷에 유령 착석이 남지 않는다', async () => {
      // Redis는 Prisma 트랜잭션에 참여하지 않는다. 콜백 안에서 saveSnapShot을
      // 부르면, 커밋이 실패해 DB가 전부 되돌아가도 스냅샷에는 유저가 그대로
      // 앉아 있다 — DB에 없는 사람이 자리를 차지한다.
      const service = makeService('commit');

      await expect(service.joinSessionWithSeat(dto(3), 'alice')).rejects.toThrow('커밋 실패');

      expect(await redis.get(stateKey)).toBeNull();
    });

    it('중간 쓰기가 실패해도 스냅샷은 비어 있다', async () => {
      const service = makeService('write');

      await expect(service.joinSessionWithSeat(dto(3), 'alice')).rejects.toThrow('DB 실패');

      expect(await redis.get(stateKey)).toBeNull();
    });

    it('롤백되면 좌석 비트맵도 그대로다', async () => {
      const service = makeService('commit');

      await expect(service.joinSessionWithSeat(dto(3), 'alice')).rejects.toThrow();

      expect(await redis.hget(seatKey, `table:${TABLE}`)).toBe('000000000');
    });

    it('실패해도 좌석 락은 풀린다', async () => {
      const service = makeService('commit');

      await expect(service.joinSessionWithSeat(dto(3), 'alice')).rejects.toThrow();

      expect(await redis.exists(`lock:seat:${TABLE}:3`)).toBe(0);
    });
  });

  describe('성공', () => {
    it('스냅샷과 비트맵에 함께 반영된다', async () => {
      const service = makeService();

      await service.joinSessionWithSeat(dto(3), 'alice');

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.players[3]!.id).toBe('alice');
      expect(state.players[3]!.stack).toBe(10000);
      expect(await redis.hget(seatKey, `table:${TABLE}`)).toBe('000100000');
    });

    it('진행 중인 토너먼트에 앉으면 이번 핸드는 폴드 상태로 들어간다', async () => {
      // 카드는 이미 딜링됐다. 중간에 앉은 사람은 다음 핸드부터 참여한다.
      const service = makeService();
      sessionRow.status = TournamentStatus.ONGOING;

      await service.joinSessionWithSeat(dto(2), 'bob');
      sessionRow.status = TournamentStatus.PENDING;

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.players[2]!.hasFolded).toBe(true);
    });
  });

  describe('동시 착석', () => {
    it('같은 테이블 다른 좌석에 동시에 앉아도 서로를 지우지 않는다', async () => {
      // 좌석 락은 좌석**별**이라 이 둘은 서로를 막지 않는다. 스냅샷은 JSON을
      // 통째로 덮어쓰므로, 테이블 락이 없으면 나중에 쓴 쪽이 앞선 착석을
      // 통째로 지운다. 결제는 됐는데 자리에 없는 유저가 생긴다.
      const service = makeService();

      await Promise.all([
        service.joinSessionWithSeat(dto(0), 'alice'),
        service.joinSessionWithSeat(dto(5), 'bob'),
      ]);

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.players[0]?.id).toBe('alice');
      expect(state.players[5]?.id).toBe('bob');
    });

    it('아홉 명이 동시에 앉아도 전원이 남는다', async () => {
      const service = makeService();
      const seats = [0, 1, 2, 3, 4, 5, 6, 7, 8];

      await Promise.all(seats.map(s => service.joinSessionWithSeat(dto(s), `p${s}`)));

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.players.map(p => p?.id ?? null)).toEqual(seats.map(s => `p${s}`));
      expect(await redis.hget(seatKey, `table:${TABLE}`)).toBe('111111111');
    });

    it('같은 좌석을 동시에 노리면 한 명만 앉는다', async () => {
      const service = makeService();

      const results = await Promise.allSettled([
        service.joinSessionWithSeat(dto(4), 'alice'),
        service.joinSessionWithSeat(dto(4), 'bob'),
      ]);

      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.players.filter(p => p !== null)).toHaveLength(1);
    });

    it('경합에서 진 쪽은 409로 거절된다', async () => {
      // 이 경로는 이미 좌석 락이 ConflictException으로 막고 있다(T6). 아래
      // 백스톱 테스트와 짝을 이뤄, 같은 상황이 어느 층에서 걸리든 참가자가
      // 받는 안내가 같다는 것을 고정한다.
      const service = makeService();

      const results = await Promise.allSettled([
        service.joinSessionWithSeat(dto(5), 'alice'),
        service.joinSessionWithSeat(dto(5), 'bob'),
      ]);

      const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(ConflictException);
    });

    it('락을 통과해도 DB에 이미 사람이 있으면 409로 거절된다', async () => {
      // T11. 좌석 중복은 참가자가 결제 화면에서 실제로 마주치는 상황이다.
      // 500이면 프론트가 "다른 자리를 고르세요"와 "서버가 죽었다"를 구분할 수
      // 없어 재시도를 권하게 되고, 참가자는 계속 같은 자리를 누른다.
      const service = makeService('seatTaken');

      await expect(service.joinSessionWithSeat(dto(6), 'alice'))
        .rejects.toThrow(ConflictException);
    });
  });
});

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

  function dto(seatIndex: number): PayMentDto {
    return { tournamentId: TOURNAMENT, tableId: TABLE, seatIndex };
  }

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
      new EventEmitter2(),
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
    await service.joinSessionWithSeat(dto(0), 'u1');

    const [row] = await prisma.$queryRaw<{ playerOtp: string }[]>`
      SELECT "playerOtp" FROM "TournamentParticipation" WHERE "userId" = 'u1'
    `;
    expect(row.playerOtp).toMatch(/^\d{8}$/);
  });

  it('참가자마다 다른 값이다', async () => {
    await service.joinSessionWithSeat(dto(0), 'u1');
    await service.joinSessionWithSeat(dto(1), 'u2');

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

    await service.joinSessionWithSeat(dto(0), 'u1');

    // u1의 참가로 이미 늘어난 값 위에서 u2 몫만 재는 게 목적이라, 기준점을
    // u1 참가 "이후"에 잡는다. 재시도가 부수효과를 두 번 적용했다면 아래
    // before/after 차이가 entryFee나 카운터 증분의 배수로 어긋난다.
    const beforeUser = await prisma.user.findUniqueOrThrow({ where: { id: 'u2' } });
    const beforeTournament = await prisma.tournament.findUniqueOrThrow({ where: { id: TOURNAMENT } });
    otp.mockClear();

    await expect(
      service.joinSessionWithSeat(dto(1), 'u2'),
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

    // 참가/착석 행도 재시도로 실패한 첫 시도의 잔해 없이 정확히 하나씩이다.
    const participationCount = await prisma.tournamentParticipation.count({
      where: { tournamentId: TOURNAMENT, userId: 'u2' },
    });
    expect(participationCount).toBe(1);

    const tablePlayerCount = await prisma.tablePlayer.count({
      where: { tableId: TABLE, userId: 'u2' },
    });
    expect(tablePlayerCount).toBe(1);

    // 포인트 원장(user.service.ts의 paymentPoint가 쓰는 PointTransaction)도
    // 한 건만 남아야 한다. 실패한 첫 시도의 차감이 롤백되지 않고 남았다면
    // 여기서 2가 나온다.
    const pointTxCount = await prisma.pointTransaction.count({
      where: { userId: 'u2', tournamentId: TOURNAMENT, type: 'BUY_IN' },
    });
    expect(pointTxCount).toBe(1);
  });

  it('같은 사람이 두 번 참가하면 재시도하지 않고 그대로 실패한다', async () => {
    await service.joinSessionWithSeat(dto(0), 'u1');
    // 좌석을 바꿔도 (tournamentId, userId) 유니크에 걸린다.
    // 이건 OTP 충돌이 아니므로 재시도 대상이 아니다.
    await expect(
      service.joinSessionWithSeat(dto(2), 'u1'),
    ).rejects.toThrow();
  });

  it('리바인은 OTP를 다시 발급하지 않는다', async () => {
    await service.joinSessionWithSeat(dto(0), 'u1');
    const before = await prisma.$queryRaw<{ playerOtp: string }[]>`
      SELECT "playerOtp" FROM "TournamentParticipation" WHERE "userId" = 'u1'
    `;

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
      tournament: { findUnique: async () => row },
    } as unknown as PrismaService;
    const session = { getGameSession: async () => row } as unknown as SessionService;

    return new PaymentService(
      {} as unknown as UserService, session, prisma, redisService, new EventEmitter2(),
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
