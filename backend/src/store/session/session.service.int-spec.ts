import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { GameType, PrismaClient, TournamentStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { CreateTournamentDto } from 'shared/dto/tournament.dto';
import { DealerService } from 'src/dealer/dealer.service';
import { OtpAttempts } from 'src/dealer/otp-attempts';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import Redis from 'ioredis';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../../test/helpers/prisma';
import { createTestRedis, flushTestRedis } from '../../../test/helpers/redis';
import { SessionService } from './session.service';

/**
 * OTP 해시 전환의 통합 검증.
 *
 * 단위 스펙(`session.service.spec.ts`)은 prisma를 목으로 두고 트랜잭션 안의
 * `data`만 본다. 여기서는 실제로 저장된 컬럼을 읽어, 응답에는 평문이 한 번만
 * 실리고 DB에는 해시만 남는지를 확인한다.
 */
describe('SessionService.createSession — OTP 해시 통합', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let sessionService: SessionService;
  let storeId: string;
  let blindId: string;

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

    const redisService = new RedisService(redis);
    sessionService = new SessionService(
      prisma as unknown as PrismaService,
      redisService,
      new OtpAttempts(redis),
      new EventEmitter2(),
    );

    const owner = await prisma.user.create({
      data: { nickname: 'owner', password: 'x', role: 'STORE_ADMIN' },
    });
    const store = await prisma.store.create({
      data: { name: '테스트 상점', ownerId: owner.id },
    });
    storeId = store.id;
    const blind = await prisma.blindStructure.create({
      data: {
        name: '기본 구조',
        storeId,
        structure: [{ lv: 1, sb: 100, ante: false, duration: 20 }],
      },
    });
    blindId = blind.id;
  });

  const makeCreateDto = (): CreateTournamentDto => ({
    name: '테스트 대회',
    type: GameType.TOURNAMENT,
    storeId,
    blindId,
    startStack: 10000,
    entryFee: 1000,
    rebuyUntil: 5,
    isRegistrationOpen: true,
    prizePayouts: [{ place: 1, percent: 100 }],
  });

  it('대회를 만들면 평문 OTP는 반환에만 있고 DB에는 해시만 남는다', async () => {
    const created = await sessionService.createSession(makeCreateDto());

    expect(created.dealerOtp).toMatch(/^[0-9]{6}$/);

    const row = await prisma.tournament.findUniqueOrThrow({
      where: { id: created.id },
      select: { dealerOtpHash: true },
    });

    // 해시가 원본을 담고 있으면 저장한 의미가 없다.
    expect(row.dealerOtpHash).not.toContain(created.dealerOtp);
    expect(row.dealerOtpHash.startsWith('$2')).toBe(true);
  });

  it('대회 조회 응답에는 OTP도 해시도 실리지 않는다', async () => {
    const created = await sessionService.createSession(makeCreateDto());

    const fetched = await sessionService.getGameSession(created.id);

    expect(fetched).not.toHaveProperty('dealerOtp');
    expect(fetched).not.toHaveProperty('dealerOtpHash');
  });

  /**
   * 조회(getGameSession 등)만 막으면 충분하지 않다. `PATCH /store/sessions/:id`와
   * `PATCH /store/sessions/:id/start`는 각각 updateSession·startSession의
   * 반환값을 컨트롤러가 그대로 응답으로 내보낸다(session.controller.ts:28,33).
   * 이 두 쓰기 경로가 각자 `tournament.update()`를 부르므로, getGameSession의
   * omit과는 별개로 여기도 omit이 있어야 한다.
   */
  describe('쓰기 경로도 해시를 담아 보내지 않는다', () => {
    it('대회 시작 응답에 해시가 없다', async () => {
      const created = await sessionService.createSession(makeCreateDto());

      // 시작 최소 인원 게이트를 우회한다 — 여기서 보는 것은 게임 시작
      // 로직이 아니라 응답에 해시가 실리는지 여부다.
      process.env.MIN_PLAYERS_TO_START = '0';
      try {
        const started = await sessionService.startSession(created.id);
        expect(started).not.toHaveProperty('dealerOtp');
        expect(started).not.toHaveProperty('dealerOtpHash');
      } finally {
        delete process.env.MIN_PLAYERS_TO_START;
      }
    });

    it('대회 수정 응답에 해시가 없다', async () => {
      const created = await sessionService.createSession(makeCreateDto());

      const updated = await sessionService.updateSession(created.id, {
        name: '이름 변경',
      });

      expect(updated).not.toHaveProperty('dealerOtp');
      expect(updated).not.toHaveProperty('dealerOtpHash');
    });
  });
});

/**
 * 상점 콘솔의 두 탈출구 — 재발급과 내보내기.
 *
 * 재발급은 태블릿이 토큰을 잃었을 때 다시 들어오라는 뜻이고, 이미 붙어 있는
 * 딜러는 끊지 않는다(갱신이 계속 통과한다). 내보내기는 반대로 붙어 있는
 * 쪽을 끊는다. 한 버튼으로 묶으면 태블릿 하나가 재부팅됐다고 나머지 테이블
 * 딜러가 전부 튕긴다 — 그래서 둘을 분리해 각각 검증한다.
 *
 * `dealer.int-spec.ts`의 배선을 그대로 옮겨 왔다(그 파일은 건드리지 않는다).
 * DealerService까지 진짜로 띄우는 이유: 재발급/내보내기가 실제로 로그인·갱신
 * 경로에 어떤 영향을 주는지가 검증 대상이라서다.
 */
describe('SessionService — 딜러 OTP 재발급과 내보내기', () => {
  const SECRET = 'test-only-not-a-real-secret';

  let prisma: PrismaClient;
  let redis: Redis;
  let queueConnection: Redis;
  let queue: Queue;
  let sessionService: SessionService;
  let dealerService: DealerService;
  let jwtService: JwtService;
  let seq = 0;

  beforeAll(() => {
    prisma = createTestPrisma();
    redis = createTestRedis();
    queueConnection = createTestRedis({ maxRetriesPerRequest: null });
    queue = new Queue('player-timeout', { connection: queueConnection });
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
    seq = 0;

    const prismaService = prisma as unknown as PrismaService;
    const redisService = new RedisService(redis);
    const emitter = new EventEmitter2();
    const playsync = new PlaysyncService(queue, redisService, prismaService, emitter);
    // 재발급이 잠금을 풀고, 로그인이 잠금을 걸고, 내보내기가 tokenVersion을
    // 올린다 — 셋 다 같은 Redis 백엔드를 보므로 인스턴스를 굳이 공유할
    // 필요는 없지만(REDIS_CLIENT가 진짜 상태를 들고 있다), session.module.ts와
    // 같은 배선을 재현하기 위해 하나만 만들어 둘 다에 넘긴다.
    const otpAttempts = new OtpAttempts(redis);
    sessionService = new SessionService(prismaService, redisService, otpAttempts, emitter);
    jwtService = new JwtService({ secret: SECRET });
    dealerService = new DealerService(
      queue,
      prismaService,
      redisService,
      playsync,
      jwtService,
      otpAttempts,
    );
  });

  /** 대회 하나를 세우고 평문 OTP와 매장주 id를 함께 돌려준다. */
  async function seedTournament({ status }: { status?: TournamentStatus } = {}) {
    seq += 1;
    const n = seq;

    const owner = await prisma.user.create({
      data: { nickname: `owner-${n}`, password: 'x', role: 'STORE_ADMIN' },
    });
    const store = await prisma.store.create({
      data: { name: `상점-${n}`, ownerId: owner.id },
    });
    const blind = await prisma.blindStructure.create({
      data: {
        name: `블라인드-${n}`,
        storeId: store.id,
        structure: [{ lv: 1, sb: 100, ante: false, duration: 20 }],
      },
    });

    const created = await sessionService.createSession({
      name: `대회-${n}`,
      type: GameType.TOURNAMENT,
      storeId: store.id,
      blindId: blind.id,
      startStack: 10000,
      entryFee: 1000,
      rebuyUntil: 5,
      isRegistrationOpen: true,
      prizePayouts: [{ place: 1, percent: 100 }],
    } as CreateTournamentDto);

    const table = await prisma.table.findFirstOrThrow({
      where: { tournamentId: created.id },
    });

    if (status) {
      await prisma.tournament.update({
        where: { id: created.id },
        data: { status },
      });
    }

    return {
      tournamentId: created.id,
      tableId: table.id,
      otp: created.dealerOtp,
      ownerId: owner.id,
    };
  }

  it('OTP를 재발급하면 옛 OTP는 막히고 새 OTP가 통과한다', async () => {
    const { tournamentId, tableId, otp: oldOtp, ownerId } = await seedTournament({
      status: TournamentStatus.ONGOING,
    });

    const { dealerOtp: newOtp } = await sessionService.reissueDealerOtp(tournamentId, ownerId);

    expect(newOtp).not.toBe(oldOtp);
    await expect(
      dealerService.loginDealer({ tournamentId, tableId, otp: oldOtp }),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      dealerService.loginDealer({ tournamentId, tableId, otp: newOtp }),
    ).resolves.toBeDefined();
  });

  it('재발급은 잠금을 푼다', async () => {
    const { tournamentId, tableId, ownerId } = await seedTournament({ status: TournamentStatus.ONGOING });

    for (let i = 0; i < 5; i++) {
      await expect(
        dealerService.loginDealer({ tournamentId, tableId, otp: '000000' }),
      ).rejects.toThrow(UnauthorizedException);
    }

    const { dealerOtp } = await sessionService.reissueDealerOtp(tournamentId, ownerId);

    await expect(
      dealerService.loginDealer({ tournamentId, tableId, otp: dealerOtp }),
    ).resolves.toBeDefined();
  });

  it('재발급은 이미 붙어 있는 딜러를 끊지 않는다', async () => {
    const { tournamentId, tableId, otp, ownerId } = await seedTournament({ status: TournamentStatus.ONGOING });
    const { accessToken } = await dealerService.loginDealer({ tournamentId, tableId, otp });
    const payload = jwtService.verify(accessToken);

    await sessionService.reissueDealerOtp(tournamentId, ownerId);

    await expect(dealerService.refreshToken(payload)).resolves.toBeDefined();
  });

  it('내보내기는 붙어 있는 딜러의 갱신을 막는다', async () => {
    const { tournamentId, tableId, otp, ownerId } = await seedTournament({ status: TournamentStatus.ONGOING });
    const { accessToken } = await dealerService.loginDealer({ tournamentId, tableId, otp });
    const payload = jwtService.verify(accessToken);

    await sessionService.revokeDealerSession(tournamentId, ownerId);

    await expect(dealerService.refreshToken(payload)).rejects.toThrow(ForbiddenException);
  });

  /**
   * 재발급은 평문 OTP를 응답에 실어 돌려준다. 역할만 확인하고 지나가면 다른
   * 상점 관리자가 남의 대회의 딜러 접근권을 만들어낼 수 있다.
   *
   * 소유권 검사는 `reissueDealerOtp`/`revokeDealerSession` 각각의 첫
   * 문장이다(컨트롤러가 아니라). 그래서 아래 테스트들은 헬퍼
   * `assertTournamentOwnership`이 아니라 **실제 진입점**을 직접 호출해
   * 우회가 불가능함을 검증한다 — 이 검사를 서비스 메서드에서 지우면
   * 아래 두 테스트가 곧바로 빨간불이 된다(리뷰 대응, 아래 리포트의
   * deliberate-revert 참고).
   */
  describe('상점 소유권 — 우회 불가능', () => {
    it('다른 상점 소유자가 재발급을 호출하면 거부한다', async () => {
      const { tournamentId } = await seedTournament();
      const intruder = await prisma.user.create({
        data: { nickname: '다른-상점주-1', password: 'x', role: 'STORE_ADMIN' },
      });

      await expect(
        sessionService.reissueDealerOtp(tournamentId, intruder.id),
      ).rejects.toThrow(ForbiddenException);
    });

    it('다른 상점 소유자가 내보내기를 호출하면 거부한다', async () => {
      const { tournamentId } = await seedTournament();
      const intruder = await prisma.user.create({
        data: { nickname: '다른-상점주-2', password: 'x', role: 'STORE_ADMIN' },
      });

      await expect(
        sessionService.revokeDealerSession(tournamentId, intruder.id),
      ).rejects.toThrow(ForbiddenException);
    });

    it('본인 소유면 재발급이 통과한다', async () => {
      const { tournamentId, ownerId } = await seedTournament();

      const result = await sessionService.reissueDealerOtp(tournamentId, ownerId);

      expect(result.dealerOtp).toMatch(/^[0-9]{6}$/);
    });

    it('없는 대회에 재발급을 호출하면 404다', async () => {
      await expect(
        sessionService.reissueDealerOtp('없는-대회', '아무개'),
      ).rejects.toThrow(NotFoundException);
    });

    /**
     * 이월 minor: 소유권 검사가 없던 시절에는 없는 tournamentId로
     * 내보내기를 불러도 `dealerSession.update`가 P2025를 던지고 그걸
     * 조용히 삼켜 "성공"을 돌려줬다 — 존재하지도 않는 대회에 대해서다.
     * 소유권 검사를 먼저 걸면서 이 경우는 이제 404로 막힌다(실재하는
     * 대회인데 딜러 세션 행만 없는 경우와는 다른 경로 — 그건 아래
     * describe에서 별도로 검증한다).
     */
    it('없는 대회에 내보내기를 호출하면 404다 — 예전에는 조용히 성공했다', async () => {
      await expect(
        sessionService.revokeDealerSession('없는-대회', '아무개'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  /**
   * 소유권 검사가 통과한 **뒤에도** `assertTournamentOwnership` 자체가
   * 정확히 무엇을 판정하는지는 직접 확인할 가치가 있다 — 헬퍼 하나가 두
   * 진입점의 첫 문장이라, 여기서 확인하면 둘 다에 대해 확인한 셈이다.
   */
  describe('assertTournamentOwnership', () => {
    it('본인 소유면 통과한다', async () => {
      const { tournamentId, ownerId } = await seedTournament();

      await expect(
        sessionService.assertTournamentOwnership(tournamentId, ownerId),
      ).resolves.toBeUndefined();
    });

    it('없는 대회면 404다', async () => {
      await expect(
        sessionService.assertTournamentOwnership('없는-대회', '아무개'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  /**
   * `completeSession`이 대회를 닫으며 `DealerSession` 행을 지운다. 그 뒤에
   * 상점(진짜 소유자)이 내보내기를 눌러도(오조작이든 뒤늦은 클릭이든) 500을
   * 보면 안 된다 — 끊을 대상이 이미 없다는 것은 목표 상태(붙어 있는 딜러
   * 없음)가 이미 달성돼 있다는 뜻이다. 대회 자체는 여전히 존재하므로
   * 소유권 검사는 통과하고, 그 다음 단계에서만 no-op이 된다.
   */
  describe('내보내기 — 딜러 세션이 없는 경우', () => {
    it('딜러 세션 행이 없어도 500이 아니다', async () => {
      const { tournamentId, ownerId } = await seedTournament();
      // Table.dealerId가 DealerSession을 RESTRICT로 참조해서, 딜러 세션을
      // 먼저 지우려면 테이블부터 없어야 한다 — completeSession이 실제로
      // 하는 순서(테이블 삭제 → 딜러 세션 삭제) 그대로다.
      await prisma.table.deleteMany({ where: { tournamentId } });
      await prisma.dealerSession.delete({ where: { tournamentId } });

      await expect(
        sessionService.revokeDealerSession(tournamentId, ownerId),
      ).resolves.toBeUndefined();
    });
  });
});

/**
 * 테이블 추가의 동시성.
 *
 * tableOrder를 `tables.length + 1`로 정하는데, 그 length를 트랜잭션 밖에서
 * 읽고 안에서 썼다. 상점 콘솔에서 두 번 눌리거나 두 관리자가 동시에 누르면
 * 같은 번호가 두 개 생긴다. 번호는 물리 테이블을 가리키므로, 겹치면 딜러와
 * 전광판이 서로 다른 테이블을 같은 번호로 부른다.
 *
 * 재시도 코드가 아니라 제약으로 막는다 — `@@unique([tournamentId, tableOrder])`.
 */
describe('SessionService.createTable — tableOrder 경합', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let sessionService: SessionService;
  let tournamentId: string;
  let ownerId: string;

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

    const prismaService = prisma as unknown as PrismaService;
    const redisService = new RedisService(redis);
    sessionService = new SessionService(
      prismaService, redisService, new OtpAttempts(redis), new EventEmitter2(),
    );

    const owner = await prisma.user.create({
      data: { nickname: 'owner', password: 'x', role: 'STORE_ADMIN' },
    });
    ownerId = owner.id;
    const store = await prisma.store.create({
      data: { name: '테스트 상점', ownerId: owner.id },
    });
    const blind = await prisma.blindStructure.create({
      data: {
        name: '기본 구조',
        storeId: store.id,
        structure: [{ lv: 1, sb: 100, ante: false, duration: 20 }],
      },
    });
    const tournament = await prisma.tournament.create({
      data: {
        name: '테스트 대회',
        type: GameType.TOURNAMENT,
        storeId: store.id,
        blindId: blind.id,
        dealerOtpHash: 'unused-hash', // 이 스펙은 로그인 경로를 검증하지 않는다.
        startStack: 30000,
        avgStack: 30000,
        entryFee: 10000,
        rebuyUntil: 5,
        isRegistrationOpen: true,
        itmCount: 1,
        prizePayouts: [{ place: 1, percent: 100 }],
      },
    });
    tournamentId = tournament.id;
    const dealerSession = await prisma.dealerSession.create({ data: { tournamentId } });
    await prisma.table.create({
      data: { tableOrder: 1, tournamentId, dealerId: dealerSession.id },
    });
  });

  it('동시에 두 번 불려도 tableOrder가 겹치지 않는다', async () => {
    await Promise.allSettled([
      sessionService.createTable(tournamentId, ownerId),
      sessionService.createTable(tournamentId, ownerId),
    ]);

    const tables = await prisma.table.findMany({
      where: { tournamentId },
      select: { tableOrder: true },
    });
    const orders = tables.map((t) => t.tableOrder);

    expect(`중복 없는 번호 ${new Set(orders).size}개 / 전체 ${orders.length}개`)
      .toBe(`중복 없는 번호 ${orders.length}개 / 전체 ${orders.length}개`);

    // 위 검사는 "겹치지 않았다"만 본다. 두 호출이 전부 실패해도(진짜 데드락,
    // 무관한 회귀, insertTable이 삽입 전에 던지는 경우 등) orders는 사전에
    // 만들어둔 1개뿐이라 size === length가 그대로 성립해 초록불이 뜬다.
    // `Promise.allSettled`가 두 거부를 다 삼키므로 그 실패는 겉으로도 안 보인다.
    // 그래서 "적어도 하나는 실제로 추가됐다"를 별도로 확인한다.
    expect(`사전 생성 1개 대비 추가된 개수 ${orders.length - 1}개 (0이면 둘 다 실패)`)
      .not.toBe('사전 생성 1개 대비 추가된 개수 0개 (0이면 둘 다 실패)');
  });

  it('딜러 세션이 없으면 명시적으로 거부한다', async () => {
    await prisma.table.deleteMany({ where: { tournamentId } });
    await prisma.dealerSession.deleteMany({ where: { tournamentId } });

    await expect(sessionService.createTable(tournamentId, ownerId)).rejects.toThrow(ConflictException);
  });
});
