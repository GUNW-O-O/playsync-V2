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
import { Client } from 'pg';
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
/**
 * 테이블 하나가 이미 있는 대회를 세운다.
 *
 * `createTable — tableOrder 경합` 스위트와 `deleteTable` 스위트가 owner →
 * store → blind → tournament → dealerSession → table로 이어지는 같은
 * fixture를 쓴다. 두 스위트가 한 파일에 있으니 배선은 여기서 한 번만
 * 적고, 각 describe는 자기 몫의 검증과 docstring만 남긴다.
 */
async function seedTournamentWithTable(prisma: PrismaClient) {
  const owner = await prisma.user.create({
    data: { nickname: 'owner', password: 'x', role: 'STORE_ADMIN' },
  });
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
  const dealerSession = await prisma.dealerSession.create({
    data: { tournamentId: tournament.id },
  });
  const table = await prisma.table.create({
    data: { tableOrder: 1, tournamentId: tournament.id, dealerId: dealerSession.id },
  });

  return { ownerId: owner.id, tournamentId: tournament.id, tableId: table.id };
}

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

    ({ ownerId, tournamentId } = await seedTournamentWithTable(prisma));
  });

  /**
   * 예전 이 자리에는 `Promise.allSettled`로 `createTable`을 두 번 부르고
   * "번호가 겹치지 않았다"를 보는 테스트가 있었다. **아무 증거도 없는
   * 테스트였다** — 리뷰가 테스트 DB에서 `DROP INDEX
   * "Table_tournamentId_tableOrder_key"`를 하고 돌렸는데 그대로 초록이었다.
   * 두 호출이 각자의 `$transaction`으로 사실상 직렬화돼 애초에 충돌이 일어나지
   * 않았고, 제약은 한 번도 실행되지 않았다.
   *
   * 그래서 충돌을 **결정적으로** 만든다. 커밋하지 않은 원시 커넥션이 2번을
   * 먼저 꽂아두면, `createTable`은 그것이 보이지 않으므로 같은 2번을 고른다.
   * 유니크 인덱스가 뒤늦은 쪽을 상대 커밋까지 대기시켰다가 23505로 거부하고,
   * `insertTable`이 그 P2002를 409로 바꾼다. 인덱스를 지우면 둘 다 성공해
   * 이 테스트는 빨개진다.
   */
  it('같은 번호를 고른 뒤늦은 추가는 제약이 막고 409로 나간다', async () => {
    const rival = new Client({ connectionString: process.env.DATABASE_URL });
    await rival.connect();
    const dealerId = (
      await prisma.dealerSession.findFirstOrThrow({ where: { tournamentId } })
    ).id;

    try {
      await rival.query('BEGIN');
      await rival.query(
        `INSERT INTO "Table"(id,"tableOrder","tournamentId","dealerId")
         VALUES (gen_random_uuid(), 2, $1, $2)`,
        [tournamentId, dealerId],
      );

      let settled = false;
      const attempt = sessionService
        .createTable(tournamentId, ownerId)
        .then(
          (v) => { settled = true; return v; },
          (e) => { settled = true; throw e; },
        );
      // 거부를 아무도 받지 않는 창을 만들지 않는다.
      const caught = attempt.catch((e) => e);

      await new Promise((r) => setTimeout(r, 500));
      // 아직 못 끝냈다는 것 자체가 "제약이 실제로 대기시키고 있다"는 증거다.
      expect(`대기 중 ${settled ? '아님' : '맞음'}`).toBe('대기 중 맞음');

      await rival.query('COMMIT');

      expect(await caught).toBeInstanceOf(ConflictException);
    } finally {
      await rival.query('ROLLBACK').catch(() => undefined);
      await rival.end();
    }

    const orders = (
      await prisma.table.findMany({ where: { tournamentId }, select: { tableOrder: true } })
    ).map((t) => t.tableOrder).sort((a, b) => a - b);

    expect(`번호 ${orders.join(',')}`).toBe('번호 1,2');
  });

  /**
   * 삭제는 번호를 재정렬하지 않는다. 그래서 1·2·3에서 2를 지우면 개수는 2인데
   * 최댓값은 3이다. 예전 `insertTable`은 `count + 1`로 다음 번호를 정해서 이미
   * 쓰이는 3을 골랐고, 유니크 제약이 P2002를 던져 409("다시 시도해 주세요")가
   * 나갔다. 다시 눌러도 같은 계산이라 **그 대회의 테이블 추가가 영구히 죽었다.**
   */
  it('중간 번호를 지운 뒤에도 테이블을 더 열 수 있다', async () => {
    const second = await sessionService.createTable(tournamentId, ownerId);
    await sessionService.createTable(tournamentId, ownerId);

    await sessionService.deleteTable(tournamentId, second.id, ownerId);

    const created = await sessionService.createTable(tournamentId, ownerId);

    const orders = (
      await prisma.table.findMany({ where: { tournamentId }, select: { tableOrder: true } })
    ).map((t) => t.tableOrder).sort((a, b) => a - b);

    expect(`새 번호 ${created.tableOrder} / 남은 번호 ${orders.join(',')}`)
      .toBe('새 번호 4 / 남은 번호 1,3,4');
  });

  it('딜러 세션이 없으면 명시적으로 거부한다', async () => {
    await prisma.table.deleteMany({ where: { tournamentId } });
    await prisma.dealerSession.deleteMany({ where: { tournamentId } });

    await expect(sessionService.createTable(tournamentId, ownerId)).rejects.toThrow(ConflictException);
  });
});

/**
 * 빈 테이블만 지운다.
 *
 * 좌석에 사람이 있는 테이블을 지우면 TablePlayer가 cascade로 함께 사라진다.
 * 참가비를 낸 사람이 장부에서 조용히 없어지는 것이라 거부한다.
 *
 * tableOrder는 재정렬하지 않는다. 2번을 지우면 1, 3이 남는다. 재정렬하면
 * 전광판과 딜러 화면이 보고 있는 번호가 통째로 바뀌어 물리 테이블과
 * 어긋난다 — 번호가 비는 것보다 나쁘다.
 */
describe('SessionService.deleteTable', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let sessionService: SessionService;
  let tournamentId: string;
  let ownerId: string;
  let tableId: string;

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

    ({ ownerId, tournamentId, tableId } = await seedTournamentWithTable(prisma));
    await redisService.setSeatBitmap(tournamentId, tableId);
    // 마지막 하나는 지울 수 없으므로, 삭제를 검증하는 스위트는 2번을 함께
    // 세워두고 그 2번을 지운다.
    ({ id: tableId } = await sessionService.createTable(tournamentId, ownerId));
  });

  it('빈 테이블은 DB 행과 Redis 필드가 함께 사라진다', async () => {
    await sessionService.deleteTable(tournamentId, tableId, ownerId);

    const row = await prisma.table.findUnique({ where: { id: tableId } });
    const seat = await redis.hget(`tournament:${tournamentId}:seat`, `table:${tableId}`);

    expect(`DB ${row === null ? '없음' : '있음'} / Redis ${seat === null ? '없음' : '있음'}`)
      .toBe('DB 없음 / Redis 없음');
  });

  /**
   * 대회는 테이블이 최소 하나 있다는 전제 위에 서 있다. 전부 지우면
   * `getTournamentInfo`가 비트맵이 빈 대회를 복구하려다 `tables[0].id`를
   * 읽어 500을 내고, 그 대회를 보고 있는 참가자 전원이 함께 죽는다.
   */
  it('마지막 남은 테이블은 지울 수 없다', async () => {
    await sessionService.deleteTable(tournamentId, tableId, ownerId);

    const last = await prisma.table.findFirstOrThrow({ where: { tournamentId } });

    await expect(
      sessionService.deleteTable(tournamentId, last.id, ownerId),
    ).rejects.toThrow(ConflictException);

    expect(`남은 테이블 ${await prisma.table.count({ where: { tournamentId } })}개`)
      .toBe('남은 테이블 1개');
  });

  /**
   * C2. 점유 검사와 삭제 사이에 바이인이 끼어드는 진짜 경합.
   *
   * 예전 코드는 `deleteMany({ where: { ..., tablePlayers: { none: {} } } })`
   * 한 문장이 이것을 "구조로" 막는다고 적혀 있었지만 성립하지 않았다.
   * NOT EXISTS 서브쿼리는 DELETE 문장의 스냅샷으로 평가되고, DELETE는 그 뒤
   * 동시 INSERT가 쥔 FOR KEY SHARE에 막혔다가 상대가 커밋하면 **서브쿼리를
   * 다시 보지 않고** 진행한다. 삭제가 성공하고 방금 앉은 참가자가 cascade로
   * 사라졌다 — 포인트는 이미 빠졌고, `TournamentParticipation`과
   * `totalBuyinAmount`는 남는다. 그 사람은 좌석 없이 돈만 낸 채로 탈락도
   * 수상도 못 하고, `completeSession`의 정산 게이트가 영원히 안 맞아
   * **대회를 닫을 수 없게 된다.**
   *
   * 지금은 `SELECT ... FOR UPDATE`가 먼저 나가므로 바이인의 커밋까지 대기하고,
   * 그 뒤의 점유 검사는 새 문장이라 새 스냅샷에서 그 참가자를 본다.
   */
  it('검사 도중 들어온 바이인은 지워지지 않고 삭제가 409로 막힌다', async () => {
    const buyin = new Client({ connectionString: process.env.DATABASE_URL });
    await buyin.connect();
    const player = await prisma.user.create({
      data: { nickname: 'player', password: 'x' },
    });

    let outcome: unknown;
    try {
      await buyin.query('BEGIN');
      await buyin.query(
        `INSERT INTO "TablePlayer"(id,nickname,"tableId","userId","seatPosition","currentStack","tournamentId")
         VALUES (gen_random_uuid(), 'player', $1, $2, 0, 30000, $3)`,
        [tableId, player.id, tournamentId],
      );

      let settled = false;
      const caught = sessionService
        .deleteTable(tournamentId, tableId, ownerId)
        .then(
          (v) => { settled = true; return v; },
          (e) => { settled = true; return e; },
        );

      await new Promise((r) => setTimeout(r, 500));
      // 대기하고 있지 않다면 삭제가 이미 지나갔다는 뜻이다.
      expect(`대기 중 ${settled ? '아님' : '맞음'}`).toBe('대기 중 맞음');

      await buyin.query('COMMIT');
      outcome = await caught;
    } finally {
      await buyin.query('ROLLBACK').catch(() => undefined);
      await buyin.end();
    }

    const table = await prisma.table.count({ where: { id: tableId } });
    const seated = await prisma.tablePlayer.count({ where: { tableId } });

    expect(`${outcome instanceof ConflictException ? '409' : `결과 ${String(outcome)}`} / Table ${table}행 / TablePlayer ${seated}행`)
      .toBe('409 / Table 1행 / TablePlayer 1행');
  });

  /**
   * I3. 탈락 처리는 DB 커밋 **뒤에** 좌석 비트를 내린다. 그 사이에 상점이
   * 그 테이블을 닫으면, 비트 내리기가 방금 지운 필드를 되살릴 수 있었다 —
   * `UPDATE_SEAT_BIT`이 없는 필드를 9칸 빈 비트맵으로 만들어 줬기 때문이다.
   * 좌석 목록에 DB에 없는 테이블이 24시간 떠 있고, 그 자리를 고른 참가자는
   * `tablePlayer.create`의 외래키 실패로 이유 없는 500을 본다.
   */
  it('지워진 테이블은 뒤늦은 좌석 비트 갱신으로 되살아나지 않는다', async () => {
    const redisService = new RedisService(redis);

    await sessionService.deleteTable(tournamentId, tableId, ownerId);
    await redisService.updateSeatBitmap(tournamentId, tableId, 0, false);

    const listed = (await redisService.getTournamentTables(tournamentId)).map((t) => t.tableId);

    expect(`좌석 목록의 지워진 테이블 ${listed.includes(tableId) ? '있음' : '없음'}`)
      .toBe('좌석 목록의 지워진 테이블 없음');
  });

  it('삭제는 테이블 상태 스냅샷도 함께 지운다', async () => {
    await redis.set(`table:state:${tableId}`, '{"phase":"WAITING"}');

    await sessionService.deleteTable(tournamentId, tableId, ownerId);

    expect(`스냅샷 ${(await redis.exists(`table:state:${tableId}`)) === 1 ? '있음' : '없음'}`)
      .toBe('스냅샷 없음');
  });

  it('좌석에 사람이 있으면 409고 아무것도 지워지지 않는다', async () => {
    const player = await prisma.user.create({
      data: { nickname: 'player', password: 'x' },
    });
    await prisma.tablePlayer.create({
      data: {
        tableId, userId: player.id, tournamentId,
        seatPosition: 0, currentStack: 30000, nickname: 'player',
      },
    });

    await expect(
      sessionService.deleteTable(tournamentId, tableId, ownerId),
    ).rejects.toThrow(ConflictException);

    const row = await prisma.table.findUnique({ where: { id: tableId } });
    const seat = await redis.hget(`tournament:${tournamentId}:seat`, `table:${tableId}`);

    expect(`DB ${row === null ? '없음' : '있음'} / Redis ${seat === null ? '없음' : '있음'}`)
      .toBe('DB 있음 / Redis 있음');
  });

  /**
   * 위 409 테스트는 Table 행이 살아 있는지만 본다. 이 테스트는 그 아래
   * 실제로 보호하려는 대상 — TablePlayer 행 — 이 cascade로 함께 사라지지
   * 않았는지를 직접 확인한다. `deleteTable`이 검사(findFirst)와 삭제를
   * 분리한 채로 있었다면 이 자체는 여전히 통과할 수 있었다(레이스가 없는
   * 단일 스레드 호출이라서) — 구조적 가드(`tablePlayers: { none: {} }`를
   * 조건으로 실은 `deleteMany`)가 실제로 그 자리에 있는지를 이 테스트
   * 하나로는 증명하지 못한다. 그래도 회귀 방지 차원에서, "참가비를 낸
   * 사람의 행이 조용히 사라지는 것"이 이 기능의 핵심 위험이므로 명시적으로
   * 남긴다.
   */
  it('좌석에 사람이 있으면 TablePlayer 행도 그대로 남는다', async () => {
    const player = await prisma.user.create({
      data: { nickname: 'player', password: 'x' },
    });
    const tablePlayer = await prisma.tablePlayer.create({
      data: {
        tableId, userId: player.id, tournamentId,
        seatPosition: 0, currentStack: 30000, nickname: 'player',
      },
    });

    await expect(
      sessionService.deleteTable(tournamentId, tableId, ownerId),
    ).rejects.toThrow(ConflictException);

    const row = await prisma.tablePlayer.findUnique({ where: { id: tablePlayer.id } });

    expect(`TablePlayer ${row === null ? '없음' : '있음'}`).toBe('TablePlayer 있음');
  });

  it('다른 대회의 테이블 id를 넘기면 404다', async () => {
    const other = await prisma.tournament.create({
      data: {
        name: '다른 대회',
        type: GameType.TOURNAMENT,
        storeId: (await prisma.store.findFirstOrThrow()).id,
        blindId: (await prisma.blindStructure.findFirstOrThrow()).id,
        dealerOtpHash: 'unused-hash', // 이 스펙은 로그인 경로를 검증하지 않는다.
        startStack: 30000, avgStack: 30000, entryFee: 10000, rebuyUntil: 5,
        isRegistrationOpen: true, itmCount: 1,
        prizePayouts: [{ place: 1, percent: 100 }],
      },
    });
    const otherDealer = await prisma.dealerSession.create({
      data: { tournamentId: other.id },
    });
    const otherTable = await prisma.table.create({
      data: { tableOrder: 1, tournamentId: other.id, dealerId: otherDealer.id },
    });

    await expect(
      sessionService.deleteTable(tournamentId, otherTable.id, ownerId),
    ).rejects.toThrow(NotFoundException);
  });
});
