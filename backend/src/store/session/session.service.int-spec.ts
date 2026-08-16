import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { GameType, PlayerStatus, PrismaClient, Role, TournamentStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { CreateTournamentDto } from 'shared/dto/tournament.dto';
import { DealerService } from 'src/dealer/dealer.service';
import { EntryService } from 'src/entry/entry.service';
import { OtpAttempts } from 'src/dealer/otp-attempts';
import { GamePhase } from 'src/game-engine/types';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import Redis from 'ioredis';
import { Client } from 'pg';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../../test/helpers/prisma';
import { createTestRedis, flushTestRedis } from '../../../test/helpers/redis';
import { UserService } from 'src/user/user.service';
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
    ownerId = owner.id;
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
   * 대회를 만들면 1번 테이블의 빈 스냅샷도 함께 선다.
   *
   * T38이 "테이블이 있으면 스냅샷이 있다"를 세웠고, 그래야 "스냅샷이 없다"의
   * 뜻이 유실 하나로 좁아진다. `createTable`은 그것을 지키는데 이 경로는
   * 좌석 비트맵만 세우고 있었다 — 불변식이 경로 하나에서만 참이었다.
   *
   * 드러나는 순서는 딜러가 먼저 붙을 때다. 손님이 먼저 앉으면 `enterSeat`이
   * `createEmptyTableState`로 덮어 주므로 보이지 않는다.
   */
  it('대회를 만들면 1번 테이블의 빈 스냅샷도 함께 선다', async () => {
    const created = await sessionService.createSession(makeCreateDto());
    const tableId = created.tables[0].id;

    const raw = await redis.get(`table:state:${tableId}`);
    expect(`스냅샷 ${raw === null ? '없음' : '있음'}`).toBe('스냅샷 있음');

    const state = JSON.parse(raw!);
    expect(`phase ${state.phase}`).toBe(`phase ${GamePhase.WAITING}`);
    expect(`좌석 수 ${state.players.length}`).toBe('좌석 수 9');
    expect(`착석자 ${state.players.filter((p: unknown) => p !== null).length}`)
      .toBe('착석자 0');
    expect(`대회 ${state.tournamentId}`).toBe(`대회 ${created.id}`);
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
        const started = await sessionService.startSession(created.id, ownerId);
        expect(started).not.toHaveProperty('dealerOtp');
        expect(started).not.toHaveProperty('dealerOtpHash');
      } finally {
        delete process.env.MIN_PLAYERS_TO_START;
      }
    });

    it('대회 수정 응답에 해시가 없다', async () => {
      const created = await sessionService.createSession(makeCreateDto());

      const updated = await sessionService.updateSession(
        created.id,
        { name: '이름 변경' },
        ownerId,
      );

      expect(updated).not.toHaveProperty('dealerOtp');
      expect(updated).not.toHaveProperty('dealerOtpHash');
    });
  });

  describe('시작은 참가자 상태를 올리지 않는다', () => {
    it('결제만 한 사람이 WAITING으로 남는다', async () => {
      const created = await sessionService.createSession(makeCreateDto());
      const noshow = await prisma.user.create({
        data: { nickname: 'noshow', password: 'x' },
      });
      await prisma.tournamentParticipation.create({
        data: {
          userId: noshow.id, tournamentId: created.id, playerOtp: '77777777',
          status: 'WAITING', currentStack: 10000,
        },
      });

      process.env.MIN_PLAYERS_TO_START = '0';
      try {
        await sessionService.startSession(created.id, ownerId);
      } finally {
        delete process.env.MIN_PLAYERS_TO_START;
      }

      const p = await prisma.tournamentParticipation.findUniqueOrThrow({
        where: { tournamentId_userId: { tournamentId: created.id, userId: noshow.id } },
      });
      expect(`미착석자 상태 ${p.status}`).toBe('미착석자 상태 WAITING');
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

  /**
   * 테이블을 열면 빈 스냅샷도 함께 선다.
   *
   * 예전에는 스냅샷을 만드는 지점이 착석 하나뿐이었다. 그래서 아무도 앉지
   * 않은 테이블에는 상태가 없었고, 딜러 화면이 뜰 때 부르는
   * `GET /playsync/:tableId`(`PlaysyncService.joinTable`)가 그 없음을 맨
   * `Error`로 던져 **500**이 됐다 — 정상 상태에 서버 오류를 내고 있었다.
   *
   * 스냅샷의 수명을 테이블의 수명에 맞춘다. `deleteTable`은 이미 대칭으로
   * `deleteTableState`를 부른다(`session.service.ts:296`).
   */
  it('테이블을 열면 빈 스냅샷이 함께 선다', async () => {
    const table = await sessionService.createTable(tournamentId, ownerId);

    const raw = await redis.get(`table:state:${table.id}`);
    expect(`스냅샷 ${raw === null ? '없음' : '있음'}`).toBe('스냅샷 있음');

    const state = JSON.parse(raw!);
    expect(`phase ${state.phase}`).toBe(`phase ${GamePhase.WAITING}`);
    expect(`좌석 수 ${state.players.length}`).toBe('좌석 수 9');
    expect(`착석자 ${state.players.filter((p: unknown) => p !== null).length}`)
      .toBe('착석자 0');
    expect(`대회 ${state.tournamentId}`).toBe(`대회 ${tournamentId}`);
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
  let redisService: RedisService;
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
    redisService = new RedisService(redis);
    sessionService = new SessionService(
      prismaService, redisService, new OtpAttempts(redis), new EventEmitter2(),
    );

    ({ ownerId, tournamentId, tableId } = await seedTournamentWithTable(prisma));
    await redisService.setSeatBitmap(tournamentId, tableId);
    // 마지막 하나는 지울 수 없으므로, 삭제를 검증하는 스위트는 2번을 함께
    // 세워두고 그 2번을 지운다.
    ({ id: tableId } = await sessionService.createTable(tournamentId, ownerId));
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
        `INSERT INTO "TablePlayer"(id,nickname,"tableId","userId","seatPosition","tournamentId")
         VALUES (gen_random_uuid(), 'player', $1, $2, 0, $3)`,
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

  /**
   * T48. **Redis를 먼저 치우고 그것이 확인된 뒤에 DB를 지운다.**
   *
   * 예전에는 트랜잭션이 커밋된 **뒤에** Redis를 정리했다. 그 호출이 실패하면
   * DB에 없는 테이블이 좌석 목록에 24시간 남고, 그 자리를 고른 손님은
   * `tablePlayer.create`의 외래키 실패로 이유 없는 500을 본다. 아무도 안
   * 치운다 — DB에 행이 없으니 복구도 그 테이블을 모른다.
   *
   * 뒤집으면 실패 모양이 낫다. Redis 정리가 실패하면 트랜잭션이 통째로
   * 롤백돼 **아무것도 안 지워진다**. 상점은 다시 누르면 된다.
   */
  it('Redis 정리가 실패하면 DB 행도 남는다', async () => {
    jest.spyOn(redisService, 'removeSeatBitmap')
      .mockRejectedValue(new Error('redis down'));

    await expect(
      sessionService.deleteTable(tournamentId, tableId, ownerId),
    ).rejects.toThrow('redis down');

    const row = await prisma.table.findUnique({ where: { id: tableId } });

    expect(`DB ${row === null ? '없음' : '있음'}`).toBe('DB 있음');
  });

  /**
   * 위와 짝. 비트맵은 지워졌는데 스냅샷 지우기가 실패해도, DB 행이 사라져
   * 회수 불가능한 상태로 굳으면 안 된다. Redis만 반쯤 지워진 것은
   * 재기동 시 복구가 되살린다(T44가 빈 스냅샷을, T46이 비트맵을 세운다).
   */
  it('스냅샷 삭제가 실패해도 DB 행은 남는다', async () => {
    jest.spyOn(redisService, 'deleteTableState')
      .mockRejectedValue(new Error('redis down'));

    await expect(
      sessionService.deleteTable(tournamentId, tableId, ownerId),
    ).rejects.toThrow('redis down');

    const row = await prisma.table.findUnique({ where: { id: tableId } });

    expect(`DB ${row === null ? '없음' : '있음'}`).toBe('DB 있음');
  });

  /**
   * 순서를 그냥 앞으로 옮기면 **검사보다 먼저** Redis를 지우게 된다. 그러면
   * 409로 거절되는 살아남은 테이블의 비트맵과 스냅샷을 날린 것이 된다.
   * 그래서 Redis 정리는 트랜잭션 안, 검사 셋을 **통과한 직후**에 있어야 한다.
   */
  it('좌석에 사람이 있으면 409고 아무것도 지워지지 않는다', async () => {
    const player = await prisma.user.create({
      data: { nickname: 'player', password: 'x' },
    });
    await prisma.tablePlayer.create({
      data: {
        tableId, userId: player.id, tournamentId,
        seatPosition: 0, nickname: 'player',
      },
    });

    await expect(
      sessionService.deleteTable(tournamentId, tableId, ownerId),
    ).rejects.toThrow(ConflictException);

    const row = await prisma.table.findUnique({ where: { id: tableId } });
    const seat = await redis.hget(`tournament:${tournamentId}:seat`, `table:${tableId}`);
    const snapshot = await redis.exists(`table:state:${tableId}`);

    expect(`DB ${row === null ? '없음' : '있음'} / Redis ${seat === null ? '없음' : '있음'} / 스냅샷 ${snapshot === 1 ? '있음' : '없음'}`)
      .toBe('DB 있음 / Redis 있음 / 스냅샷 있음');
  });

  /**
   * 마지막 테이블 거절도 마찬가지다. `remaining <= 1`은 검사 셋 중 **마지막**
   * 이라, Redis 정리를 트랜잭션 맨 앞에 두면 이 경로만 조용히 새어 나간다.
   */
  it('마지막 테이블 거절도 비트맵과 스냅샷을 남긴다', async () => {
    await sessionService.deleteTable(tournamentId, tableId, ownerId);
    const last = await prisma.table.findFirstOrThrow({ where: { tournamentId } });
    // 시드가 만든 1번은 `createTable`을 거치지 않아 스냅샷이 없다. 검사하려는
    // 것이 "거절이 스냅샷을 지우지 않는다"이므로 지울 것을 먼저 세운다.
    await redis.set(`table:state:${last.id}`, '{"phase":"WAITING"}');

    await expect(
      sessionService.deleteTable(tournamentId, last.id, ownerId),
    ).rejects.toThrow(ConflictException);

    const seat = await redis.hget(`tournament:${tournamentId}:seat`, `table:${last.id}`);
    const snapshot = await redis.exists(`table:state:${last.id}`);

    expect(`Redis ${seat === null ? '없음' : '있음'} / 스냅샷 ${snapshot === 1 ? '있음' : '없음'}`)
      .toBe('Redis 있음 / 스냅샷 있음');
  });

  /**
   * 위 409 테스트는 Table 행이 살아 있는지만 본다. 이 테스트는 그 아래
   * 실제로 보호하려는 대상 — TablePlayer 행 — 이 cascade로 함께 사라지지
   * 않았는지를 직접 확인한다. `deleteTable`이 검사(findFirst)와 삭제를
   * 분리한 채로 있었다면 이 자체는 여전히 통과할 수 있었다(레이스가 없는
   * 단일 스레드 호출이라서) — 구조적 가드(트랜잭션 안에서 점유 검사보다
   * 먼저 나가는 `SELECT ... FOR UPDATE` 행 잠금)가 실제로 그 자리에 있는지를
   * 이 테스트 하나로는 증명하지 못한다. 그래도 회귀 방지 차원에서, "참가비를
   * 낸 사람의 행이 조용히 사라지는 것"이 이 기능의 핵심 위험이므로 명시적으로
   * 남긴다.
   */
  it('좌석에 사람이 있으면 TablePlayer 행도 그대로 남는다', async () => {
    const player = await prisma.user.create({
      data: { nickname: 'player', password: 'x' },
    });
    const tablePlayer = await prisma.tablePlayer.create({
      data: {
        tableId, userId: player.id, tournamentId,
        seatPosition: 0, nickname: 'player',
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

/**
 * 상점이 좌석에서 사람을 뗀다.
 *
 * `TablePlayer` 행, Redis 스냅샷, 좌석 비트맵 셋이 함께 비어야 하고 칩
 * (`TournamentParticipation.currentStack`)은 그대로 남아야 한다 — 해제는
 * 이사일 뿐 정산이 아니다.
 */
describe('SessionService.releaseSeats', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let redisService: RedisService;
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
    redisService = new RedisService(redis);
    sessionService = new SessionService(
      prismaService, redisService, new OtpAttempts(redis), new EventEmitter2(),
    );

    ({ ownerId, tournamentId, tableId } = await seedTournamentWithTable(prisma));
    await redisService.setSeatBitmap(tournamentId, tableId);
  });

  /** 스냅샷과 좌석 행을 함께 만든다. */
  async function seat(userId: string, seatIndex: number, stack = 10000) {
    await prisma.user.create({ data: { id: userId, nickname: userId, password: 'x' } });
    await prisma.tournamentParticipation.create({
      data: {
        userId, tournamentId, playerOtp: `otp${seatIndex}0000`,
        status: 'PLAYING', currentStack: stack,
      },
    });
    await prisma.tablePlayer.create({
      data: { tournamentId, tableId, userId, nickname: userId, seatPosition: seatIndex },
    });
  }

  async function putSnapshot(phase: GamePhase, seated: { userId: string; seatIndex: number; stack: number }[]) {
    const players = Array(9).fill(null);
    for (const s of seated) {
      players[s.seatIndex] = {
        id: s.userId, tableId, nickname: s.userId, seatIndex: s.seatIndex,
        stack: s.stack, bet: 0, hasFolded: false, isAllIn: false,
        hasChecked: false, totalContributed: 0,
      };
    }
    await redis.set(`table:state:${tableId}`, JSON.stringify({
      phase, players, pot: 0, currentBet: 0, buttonUser: 0,
      currentTurnSeatIndex: -1, sidePots: [], ante: false, tournamentId, smallBlind: 100,
    }));
    await redis.hset(`tournament:${tournamentId}:seat`, `table:${tableId}`,
      Array(9).fill('0').map((c, i) => seated.some(s => s.seatIndex === i) ? '1' : c).join(''));
  }

  it('해제하면 좌석 행·스냅샷·비트맵이 함께 비고 칩은 남는다', async () => {
    await seat('u1', 3, 23400);
    await putSnapshot(GamePhase.WAITING, [{ userId: 'u1', seatIndex: 3, stack: 23400 }]);

    await sessionService.releaseSeats(tournamentId, tableId, [{ seatIndex: 3, userId: 'u1' }], ownerId);

    const rows = await prisma.tablePlayer.count({ where: { tableId, userId: 'u1' } });
    const p = await prisma.tournamentParticipation.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId, userId: 'u1' } },
    });
    const state = JSON.parse((await redis.get(`table:state:${tableId}`))!);
    const bitmap = await redis.hget(`tournament:${tournamentId}:seat`, `table:${tableId}`);

    expect(`좌석행 ${rows} / 상태 ${p.status} / 칩 ${p.currentStack} / 스냅샷 ${state.players[3] === null ? '빔' : '있음'} / 비트 ${bitmap![3]}`)
      .toBe('좌석행 0 / 상태 WAITING / 칩 23400 / 스냅샷 빔 / 비트 0');
  });

  it('해제한 테이블에 새 스냅샷을 알린다', async () => {
    // **뗀 사람의 태블릿은 그 자리에 그대로 켜져 있다.** 좌석 현황
    // (`SEAT_LIST_UPDATED`)은 대기 화면이 듣는 신호라, 이미 앉아 게임
    // 화면을 보고 있는 사람에게는 아무것도 오지 않는다 — 낡은 펠트를
    // 그대로 들고 있다가 다음 사람이 그 자리에 앉는 것을 본다.
    //
    // `game.state.updated`는 게이트웨이가 그 테이블 방에 `renderGame`으로
    // 흘려보내는 이벤트다(`ws.gateway.ts`). 좌석 화면은 자기 자리가
    // `null`이 된 것을 보고 대기 화면으로 돌아간다(`SeatGameClient`).
    const emitter = new EventEmitter2();
    const emitted: { event: string; payload: unknown }[] = [];
    emitter.emit = ((event: string, payload: unknown) => {
      emitted.push({ event, payload });
      return true;
    }) as typeof emitter.emit;
    const service = new SessionService(
      prisma as unknown as PrismaService, redisService, new OtpAttempts(redis), emitter,
    );

    await seat('u1', 3, 23400);
    await putSnapshot(GamePhase.WAITING, [{ userId: 'u1', seatIndex: 3, stack: 23400 }]);

    await service.releaseSeats(tournamentId, tableId, [{ seatIndex: 3, userId: 'u1' }], ownerId);

    const state = emitted.find((e) => e.event === 'game.state.updated');
    const players = (state?.payload as { state?: { players?: unknown[] } } | undefined)?.state
      ?.players;
    expect(`알림 ${state ? '있음' : '없음'} / 3번 자리 ${players?.[3] === null ? '빔' : '있음'}`)
      .toBe('알림 있음 / 3번 자리 빔');
  });

  /**
   * 좌석 두 개를 한 요청으로 뗀다.
   *
   * 위 단일 좌석 테스트만으로는 배치 처리를 검증하지 못한다 — n=1이면
   * 비트맵 갱신과 유저 컨텍스트 삭제를 반복문으로 하나씩 부르나 한 번에
   * 부르나 겉보기 결과가 같다. 두 좌석을 동시에 요청해 둘 다 비트가
   * 내려가고 둘 다 유저 컨텍스트가 사라지는지 함께 확인한다.
   */
  it('좌석 두 개를 한 요청으로 해제하면 둘 다 함께 비고 칩은 각자 남는다', async () => {
    await seat('u1', 3, 23400);
    await seat('u2', 5, 17700);
    await putSnapshot(GamePhase.WAITING, [
      { userId: 'u1', seatIndex: 3, stack: 23400 },
      { userId: 'u2', seatIndex: 5, stack: 17700 },
    ]);
    await redis.hset(`tournament:${tournamentId}:user`, 'u1', JSON.stringify({ tableId }));
    await redis.hset(`tournament:${tournamentId}:user`, 'u2', JSON.stringify({ tableId }));

    await sessionService.releaseSeats(
      tournamentId, tableId,
      [{ seatIndex: 3, userId: 'u1' }, { seatIndex: 5, userId: 'u2' }],
      ownerId,
    );

    const rows = await prisma.tablePlayer.count({ where: { tableId, userId: { in: ['u1', 'u2'] } } });
    const p1 = await prisma.tournamentParticipation.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId, userId: 'u1' } },
    });
    const p2 = await prisma.tournamentParticipation.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId, userId: 'u2' } },
    });
    const bitmap = await redis.hget(`tournament:${tournamentId}:seat`, `table:${tableId}`);
    const ctx1 = await redis.hget(`tournament:${tournamentId}:user`, 'u1');
    const ctx2 = await redis.hget(`tournament:${tournamentId}:user`, 'u2');

    expect(
      `좌석행 ${rows} / 상태 ${p1.status}·${p2.status} / 칩 ${p1.currentStack}·${p2.currentStack} / `
      + `비트 ${bitmap![3]}${bitmap![5]} / 컨텍스트 ${ctx1 === null ? '없음' : '있음'}·${ctx2 === null ? '없음' : '있음'}`
    ).toBe('좌석행 0 / 상태 WAITING·WAITING / 칩 23400·17700 / 비트 00 / 컨텍스트 없음·없음');
  });

  it('핸드 중에는 409고 아무것도 바뀌지 않는다', async () => {
    await seat('u1', 3);
    await putSnapshot(GamePhase.FLOP, [{ userId: 'u1', seatIndex: 3, stack: 10000 }]);

    const caught = await sessionService
      .releaseSeats(tournamentId, tableId, [{ seatIndex: 3, userId: 'u1' }], ownerId)
      .catch(e => e);

    const rows = await prisma.tablePlayer.count({ where: { tableId, userId: 'u1' } });
    expect(`${caught instanceof ConflictException ? '409' : `결과 ${String(caught)}`} / 좌석행 ${rows}`)
      .toBe('409 / 좌석행 1');
  });

  /**
   * 킥당한 사람은 좌석 행과 스냅샷 점유가 남는다.
   *
   * `handleDealerAction`의 KICK은 상태를 `ELIMINATED`로 내리고
   * `activePlayers`를 깎지만 `TablePlayer`는 지우지 않는다 — 엔진은 폴드만
   * 시킨다. 그래서 검사 1(스냅샷)도 검사 2(DB)도 통과한다. 그대로
   * `WAITING`으로 되돌리면 끝난 참가가 되살아나 자기 OTP로 다시 앉고,
   * 나중에 진짜로 터질 때 `activePlayers`가 같은 사람 몫으로 두 번 깎인다.
   */
  it('킥으로 끝난 참가는 좌석이 남아 있어도 해제되지 않는다', async () => {
    await seat('u1', 3, 23400);
    await prisma.tournamentParticipation.update({
      where: { tournamentId_userId: { tournamentId, userId: 'u1' } },
      data: { status: PlayerStatus.ELIMINATED },
    });
    await putSnapshot(GamePhase.WAITING, [{ userId: 'u1', seatIndex: 3, stack: 23400 }]);

    const caught = await sessionService
      .releaseSeats(tournamentId, tableId, [{ seatIndex: 3, userId: 'u1' }], ownerId)
      .catch(e => e);

    const rows = await prisma.tablePlayer.count({ where: { tableId, userId: 'u1' } });
    const p = await prisma.tournamentParticipation.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId, userId: 'u1' } },
    });
    expect(`${caught instanceof ConflictException ? '409' : `결과 ${String(caught)}`} / 좌석행 ${rows} / 상태 ${p.status}`)
      .toBe('409 / 좌석행 1 / 상태 ELIMINATED');
  });

  /**
   * 뗄 수 없는 사람이 한 명 섞이면 요청 전체가 막힌다.
   *
   * 조용히 건너뛰면 상점은 두 명을 뗐다고 믿는데 한 명만 떨어진다. 그리고
   * `AWARDED`를 `WAITING`으로 푸는 것은 `awardPrize`의 멱등 키
   * (`status: { notIn: ['ELIMINATED','AWARDED'] }`)를 되감는 것이라, 같은
   * 등수의 포인트 지급이 한 번 더 열린다.
   */
  it('한 명이라도 끝난 참가면 나머지 좌석도 그대로 남는다', async () => {
    await seat('u1', 3, 23400);
    await seat('u2', 5, 17700);
    await prisma.tournamentParticipation.update({
      where: { tournamentId_userId: { tournamentId, userId: 'u2' } },
      data: { status: PlayerStatus.AWARDED },
    });
    await putSnapshot(GamePhase.WAITING, [
      { userId: 'u1', seatIndex: 3, stack: 23400 },
      { userId: 'u2', seatIndex: 5, stack: 17700 },
    ]);

    const caught = await sessionService
      .releaseSeats(
        tournamentId, tableId,
        [{ seatIndex: 3, userId: 'u1' }, { seatIndex: 5, userId: 'u2' }],
        ownerId,
      )
      .catch(e => e);

    const rows = await prisma.tablePlayer.count({ where: { tableId } });
    const p1 = await prisma.tournamentParticipation.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId, userId: 'u1' } },
    });
    const bitmap = await redis.hget(`tournament:${tournamentId}:seat`, `table:${tableId}`);
    expect(`${caught instanceof ConflictException ? '409' : `결과 ${String(caught)}`} / 좌석행 ${rows} / u1 상태 ${p1.status} / 비트 ${bitmap![3]}${bitmap![5]}`)
      .toBe('409 / 좌석행 2 / u1 상태 PLAYING / 비트 11');
  });

  it('낡은 화면이 보낸 쌍은 409로 막힌다', async () => {
    await seat('u1', 3);
    await putSnapshot(GamePhase.WAITING, [{ userId: 'u1', seatIndex: 3, stack: 10000 }]);

    const caught = await sessionService
      .releaseSeats(tournamentId, tableId, [{ seatIndex: 3, userId: 'u2' }], ownerId)
      .catch(e => e);

    const rows = await prisma.tablePlayer.count({ where: { tableId } });
    expect(`${caught instanceof ConflictException ? '409' : `결과 ${String(caught)}`} / 좌석행 ${rows}`)
      .toBe('409 / 좌석행 1');
  });

  /**
   * 검사 1(스냅샷)만으로 막히는 자리.
   *
   * 위 "낡은 화면" 테스트는 스냅샷과 DB가 **같이** 틀렸다고 말하므로 검사
   * 1을 지워도 검사 2가 대신 잡는다. 두 검사가 서로를 가리고 있어서, 설계가
   * 길게 정당화한 "3번은 스냅샷(게임의 진실), 4번은 DB(좌석의 진실)"이
   * 테스트로는 한 번도 갈라진 적이 없었다.
   *
   * 그래서 여기서는 **DB를 맞춰 둔다.** 좌석 행은 3번이 u1이라 검사 2는
   * 통과한다. 스냅샷만 앞서 나가 3번을 u2로 보여 준다 — 실제로 열리는 창이다
   * (`claimSeat`이 낡은 점유자를 고쳐 쓰는 구간, `eliminatePlayer`가 DB 행을
   * 지우고 다음 핸드 준비가 스냅샷을 비우기 전까지의 구간). 상점이 그 사이의
   * 낡은 판을 보고 눌렀다면, 게임의 진실이 아니라고 말하는 쪽이 스냅샷뿐이다.
   */
  it('DB 좌석 행이 맞아도 스냅샷 점유자가 다르면 막힌다', async () => {
    await seat('u1', 3, 23400);
    await prisma.user.create({ data: { id: 'u2', nickname: 'u2', password: 'x' } });
    await prisma.tournamentParticipation.create({
      data: {
        userId: 'u2', tournamentId, playerOtp: 'otp20000',
        status: 'PLAYING', currentStack: 17700,
      },
    });
    // 스냅샷은 3번을 u2로 본다. DB(`TablePlayer`)는 여전히 u1이다.
    await putSnapshot(GamePhase.WAITING, [{ userId: 'u2', seatIndex: 3, stack: 17700 }]);

    const caught = await sessionService
      .releaseSeats(tournamentId, tableId, [{ seatIndex: 3, userId: 'u1' }], ownerId)
      .catch(e => e);

    const rows = await prisma.tablePlayer.count({ where: { tableId, userId: 'u1' } });
    const p = await prisma.tournamentParticipation.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId, userId: 'u1' } },
    });
    expect(`${caught instanceof ConflictException ? '409' : `결과 ${String(caught)}`} / 좌석행 ${rows} / 상태 ${p.status}`)
      .toBe('409 / 좌석행 1 / 상태 PLAYING');
  });

  /**
   * 해제의 레디스 쓰기가 재입장보다 늦게 도착하면 안 된다.
   *
   * 비트맵과 유저 컨텍스트는 필드 단위 원자 연산이라 그 자체는 락이 필요
   * 없지만, 필요한 것은 원자성이 아니라 **입장과의 순서**다. 락 밖에 두면
   * 우리가 락을 놓은 뒤 재입장이 비트를 1로 세우고 컨텍스트를 쓴 다음에
   * 우리 0과 삭제가 도착한다 — 좌석 목록은 빈 자리라고 하는데
   * `TablePlayer`와 스냅샷은 앉아 있다고 말하는, 스스로 낫지 않는 상태다.
   *
   * 해제가 비트를 내리기 **직전**에 재입장을 밀어 넣어 그 창을 연다.
   * 비트맵 쓰기가 락 밖이면 재입장이 그 자리에서 통째로 끝나 버리고,
   * 락 안이면 재입장이 락을 기다리다가 우리 뒤에 온다.
   *
   * 아래 500ms는 논리적 방벽이 아니라 창이다. 틀리는 방향이 한쪽뿐이라
   * 쓴다 — 고쳐진 코드에서 재입장이 기다리는 것은 락(`maxWaitMs` 5000)이라
   * 헛되이 빨개지려면 4.4초 넘게 멈춰야 하고, 그건 창을 늘려도 못 막는다.
   * 반대로 아주 느린 기계에서는 락 **밖**으로 되돌려도 재입장이 500ms 안에
   * 못 끝나 초록으로 지나갈 수 있다 — 이 테스트가 조용히 무장 해제되는 쪽은
   * 이쪽이다. 민감도를 다시 볼 때는 이 숫자를 함께 본다.
   */
  it('해제가 비트를 내리는 사이 들어온 재입장이 지워지지 않는다', async () => {
    await seat('u1', 3, 23400);
    await putSnapshot(GamePhase.WAITING, [{ userId: 'u1', seatIndex: 3, stack: 23400 }]);
    await redisService.setUserContext(tournamentId, 'u1', tableId, 3, 'ACTIVE');

    // 입장은 자기 RedisService를 쓴다 — 아래 후킹은 해제 쪽에만 걸린다.
    const entryService = new EntryService(
      prisma as unknown as PrismaService,
      new RedisService(redis),
      new JwtService({ secret: 'release-spec-secret' }),
      new EventEmitter2(),
    );

    let reentry: Promise<string> | undefined;
    const realUpdateMany = redisService.updateSeatBitmapMany.bind(redisService);
    redisService.updateSeatBitmapMany = async (...args: Parameters<typeof realUpdateMany>) => {
      if (!reentry) {
        reentry = entryService
          .enterSeat(tournamentId, { otp: 'otp30000', tableId, seatIndex: 3 })
          .then(() => 'ok', (e: unknown) => `실패 ${String(e)}`);
        // 비트맵 쓰기가 락 밖이면 이 사이에 재입장이 통째로 끝난다.
        await new Promise(r => setTimeout(r, 500));
      }
      return realUpdateMany(...args);
    };

    await sessionService.releaseSeats(tournamentId, tableId, [{ seatIndex: 3, userId: 'u1' }], ownerId);
    const entered = await reentry;

    const rows = await prisma.tablePlayer.count({ where: { tableId, userId: 'u1' } });
    const state = JSON.parse((await redis.get(`table:state:${tableId}`))!);
    const bitmap = await redis.hget(`tournament:${tournamentId}:seat`, `table:${tableId}`);
    const ctx = await redis.hget(`tournament:${tournamentId}:user`, 'u1');

    expect(
      `재입장 ${entered} / 좌석행 ${rows} / 비트 ${bitmap![3]} / `
      + `스냅샷 ${state.players[3] === null ? '없음' : '있음'} / 컨텍스트 ${ctx === null ? '없음' : '있음'}`
    ).toBe('재입장 ok / 좌석행 1 / 비트 1 / 스냅샷 있음 / 컨텍스트 있음');
  });

  /**
   * 남의 대회 테이블 id로는 락도 잡지 못한다.
   *
   * `tableId`와 `tournamentId`를 묶는 것이 트랜잭션의 `FOR UPDATE`뿐이면,
   * 거기 닿기 전에 이미 남의 테이블 게임 락을 쥔 채 DB를 한 바퀴 돈다.
   * 그래서 그 락을 다른 요청이 잡고 있는 상태를 만들어 둔다 — 확인이 락
   * 뒤에 있으면 5초를 기다렸다가 락 획득 실패로 끝나고, 앞에 있으면 그
   * 자리에서 404다.
   */
  it('다른 대회의 테이블 id는 락을 잡기도 전에 404다', async () => {
    const store = await prisma.store.findFirstOrThrow();
    const blind = await prisma.blindStructure.findFirstOrThrow();
    const other = await prisma.tournament.create({
      data: {
        name: '남의 대회', type: GameType.TOURNAMENT, storeId: store.id, blindId: blind.id,
        dealerOtpHash: 'unused-hash', startStack: 30000, avgStack: 30000, entryFee: 10000,
        rebuyUntil: 5, isRegistrationOpen: true, itmCount: 1,
        prizePayouts: [{ place: 1, percent: 100 }],
      },
    });
    const otherDealer = await prisma.dealerSession.create({ data: { tournamentId: other.id } });
    const otherTable = await prisma.table.create({
      data: { tableOrder: 1, tournamentId: other.id, dealerId: otherDealer.id },
    });
    // 그 테이블은 지금 자기 게임을 돌리는 중이다.
    await redis.set(`lock:table:state:${otherTable.id}`, 'someone-else', 'PX', 20000);

    const caught = await sessionService
      .releaseSeats(tournamentId, otherTable.id, [{ seatIndex: 3, userId: 'u1' }], ownerId)
      .catch(e => e);

    expect(caught instanceof NotFoundException ? '404' : `결과 ${String(caught)}`).toBe('404');
  });

  /**
   * 레디스 락은 좌석의 DB 쓰기를 직렬화하지 않는다 — T28이 입장의 트랜잭션을
   * 락 밖으로 뺐기 때문에 입장은 테이블 락을 건드리지 않고 INSERT한다.
   * `SELECT ... FOR UPDATE`가 그 자리를 메운다.
   *
   * 이 테스트가 대기하려면 4번 자리가 요청에 들어 있어야 한다. 스냅샷 검사
   * (검사 1)는 4번이 비어 있으면 락 안에서 먼저 걸려 `FOR UPDATE`에 닿지
   * 못한다 — 그래서 스냅샷에도 4번을 미리 채워 둔다.
   */
  it('해제 도중 들어온 착석은 지워지지 않고 해제가 409로 막힌다', async () => {
    await seat('u1', 3);
    await putSnapshot(GamePhase.WAITING, [
      { userId: 'u1', seatIndex: 3, stack: 10000 },
      { userId: 'u1', seatIndex: 4, stack: 10000 },
    ]);

    const newcomer = await prisma.user.create({ data: { nickname: 'newcomer', password: 'x' } });
    await prisma.tournamentParticipation.create({
      data: {
        userId: newcomer.id, tournamentId, playerOtp: '99999999',
        status: 'WAITING', currentStack: 10000,
      },
    });

    const entering = new Client({ connectionString: process.env.DATABASE_URL });
    await entering.connect();

    let outcome: unknown;
    try {
      await entering.query('BEGIN');
      // 해제 대상과 **다른** 자리에 앉는다. 커밋 전이라 아직 아무도 못 본다.
      await entering.query(
        `INSERT INTO "TablePlayer"(id,nickname,"tableId","userId","seatPosition","tournamentId")
         VALUES (gen_random_uuid(), 'newcomer', $1, $2, 4, $3)`,
        [tableId, newcomer.id, tournamentId],
      );

      let settled = false;
      const caught = sessionService
        .releaseSeats(tournamentId, tableId, [{ seatIndex: 3, userId: 'u1' }, { seatIndex: 4, userId: 'u1' }], ownerId)
        .then(v => { settled = true; return v; }, e => { settled = true; return e; });

      await new Promise(r => setTimeout(r, 500));
      expect(`대기 중 ${settled ? '아님' : '맞음'}`).toBe('대기 중 맞음');

      await entering.query('COMMIT');
      outcome = await caught;
    } finally {
      await entering.query('ROLLBACK').catch(() => undefined);
      await entering.end();
    }

    const seated = await prisma.tablePlayer.count({ where: { tableId } });
    expect(`${outcome instanceof ConflictException ? '409' : `결과 ${String(outcome)}`} / 좌석행 ${seated}`)
      .toBe('409 / 좌석행 2');
  });
});

/**
 * T31 — 시작 트랜잭션이 첫 버튼 추첨 결과를 DB에 남기는지.
 *
 * `initializeGame`이 테이블마다 버튼을 랜덤으로 뽑지만(session.service.ts:468)
 * 예전에는 그 값이 Redis 스냅샷에만 있었다. 첫 핸드가 끝나기 전에 서버가
 * 죽으면 재구성이 읽을 버튼이 DB 어디에도 없었다. `startSession`의 트랜잭션이
 * `Table.buttonUser`를 같은 트랜잭션으로 쓰는지 확인한다.
 */
describe('SessionService.startSession — 버튼 좌석 영속화', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let redisService: RedisService;
  let sessionService: SessionService;
  let tournamentId: string;
  let tableId: string;
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

    redisService = new RedisService(redis);
    sessionService = new SessionService(
      prisma as unknown as PrismaService, redisService, new OtpAttempts(redis), new EventEmitter2(),
    );

    ({ ownerId, tournamentId, tableId } = await seedTournamentWithTable(prisma));

    // 준비: 착석 2명. seat()·putSnapshot()과 같은 모양이지만 이 describe는
    // 자기 스냅샷을 직접 만든다 — releaseSeats 블록의 헬퍼는 그 describe
    // 스코프에 갇혀 있다.
    for (const [userId, seatIndex] of [['u1', 0], ['u2', 1]] as [string, number][]) {
      await prisma.user.create({ data: { id: userId, nickname: userId, password: 'x' } });
      await prisma.tournamentParticipation.create({
        data: {
          userId, tournamentId, playerOtp: `otp${seatIndex}0000`,
          status: 'PLAYING', currentStack: 30000,
        },
      });
      await prisma.tablePlayer.create({
        data: { tournamentId, tableId, userId, nickname: userId, seatPosition: seatIndex },
      });
    }

    // initializeGame은 착석한 테이블에 스냅샷이 이미 있어야 시작을 허용한다
    // (스냅샷 없는 테이블은 거부 — session.service.ts:478). 실제로는 입장이
    // 첫 착석에서 만드는 초기 상태다.
    await redisService.saveInitialTableSnapshots([{
      tableId,
      state: {
        phase: GamePhase.WAITING,
        players: [
          { id: 'u1', tableId, nickname: 'u1', seatIndex: 0, stack: 30000, bet: 0, hasFolded: false, isAllIn: false, hasChecked: false, totalContributed: 0 },
          { id: 'u2', tableId, nickname: 'u2', seatIndex: 1, stack: 30000, bet: 0, hasFolded: false, isAllIn: false, hasChecked: false, totalContributed: 0 },
          ...Array(7).fill(null),
        ],
        pot: 0, currentBet: 0, buttonUser: 0, currentTurnSeatIndex: -1,
        sidePots: [], ante: false, tournamentId, smallBlind: 100,
      },
    }]);
  });

  it('시작하면 그 테이블 화면들에 뽑은 버튼이 실린 스냅샷이 간다', async () => {
    // 버튼은 대회 시작에 **추첨된다.** 그 결과가 스냅샷에만 저장되고 아무에게도
    // 안 가면, 딜러와 좌석 태블릿의 펠트는 다음 핸드가 시작될 때까지 버튼이
    // 어디 있는지 모른다 — 딜러가 "지금부터 시작해도 된다"를 읽을 신호가
    // 화면에 없다는 뜻이기도 하다.
    const emitter = new EventEmitter2();
    const emitted: { event: string; payload: unknown }[] = [];
    emitter.emit = ((event: string, payload: unknown) => {
      emitted.push({ event, payload });
      return true;
    }) as typeof emitter.emit;
    const service = new SessionService(
      prisma as unknown as PrismaService, redisService, new OtpAttempts(redis), emitter,
    );

    process.env.MIN_PLAYERS_TO_START = '0';
    try {
      await service.startSession(tournamentId, ownerId);
    } finally {
      delete process.env.MIN_PLAYERS_TO_START;
    }

    const snapshot = await redisService.getSnapShot(tableId);
    const update = emitted.find((e) => e.event === 'game.state.updated');
    const payload = update?.payload as { tableId?: string; state?: { buttonUser?: number } };
    expect(`알림 ${update ? '있음' : '없음'} / 테이블 ${payload?.tableId} / 버튼 ${payload?.state?.buttonUser}`)
      .toBe(`알림 있음 / 테이블 ${tableId} / 버튼 ${snapshot!.buttonUser}`);
  });

  it('시작 트랜잭션이 뽑은 버튼 좌석을 DB에 남긴다', async () => {
    process.env.MIN_PLAYERS_TO_START = '0';
    try {
      await sessionService.startSession(tournamentId, ownerId);
    } finally {
      delete process.env.MIN_PLAYERS_TO_START;
    }

    const table = await prisma.table.findUniqueOrThrow({
      where: { id: tableId },
      select: { buttonUser: true },
    });
    const snapshot = await redisService.getSnapShot(tableId);

    expect(table.buttonUser).not.toBeNull();
    expect(`DB ${table.buttonUser}`).toBe(`DB ${snapshot!.buttonUser}`);
  });

  // T34 — startSession에는 소유권 확인이 없었다. 서버 액션이 tournamentId를
  // 클라이언트 값 그대로 넘기므로, 이게 없으면 A 상점 관리자가 B 상점 대회를
  // 시작시킬 수 있었다. 다른 소유권 테스트(getSeatOccupants의 "남의 대회는
  // 거부한다")와 같은 셋업을 따른다.
  it('남의 대회는 시작할 수 없다', async () => {
    const intruder = await prisma.user.create({
      data: { nickname: '다른-상점주', password: 'x', role: 'STORE_ADMIN' },
    });

    process.env.MIN_PLAYERS_TO_START = '0';
    try {
      await expect(
        sessionService.startSession(tournamentId, intruder.id),
      ).rejects.toThrow(ForbiddenException);
    } finally {
      delete process.env.MIN_PLAYERS_TO_START;
    }

    const tournament = await prisma.tournament.findUniqueOrThrow({
      where: { id: tournamentId },
      select: { status: true },
    });
    expect(tournament.status).toBe(TournamentStatus.PENDING);
  });
});

/**
 * T34 — 좌석 해제 화면의 입력.
 *
 * `getSeatOccupants`는 좌석 해제(`releaseSeats`)가 요구하는 `{ seatIndex,
 * userId }`를 채우기 위한 조회다. 기존 좌석 조회 셋(`GET
 * /tournaments/:id/seats`, `GET /tournaments/:id`, `GET /dealer/:id`)은
 * 전부 가드가 없어서 여기에 얹으면 남의 대회 참가자의 userId·닉네임이
 * 그대로 공개된다 — 그래서 재발급·내보내기와 같은 문(소유권 확인)을 쓴다.
 *
 * 두 번째 테스트가 이 엔드포인트의 존재 이유다. 소유권 검사가 지워지면
 * 남의 대회 좌석 명단이 그대로 샌다.
 */
describe('SessionService.getSeatOccupants', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let sessionService: SessionService;
  let entryService: EntryService;
  let tournamentId: string;
  let tableId: string;
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
    entryService = new EntryService(
      prismaService, redisService, new JwtService({ secret: 'seat-occupants-secret' }), new EventEmitter2(),
    );

    ({ ownerId, tournamentId, tableId } = await seedTournamentWithTable(prisma));
  });

  it('앉은 사람의 좌석과 userId를 준다', async () => {
    // 좌석 확정 경로(EntryService.enterSeat)로 실제로 앉힌다. TablePlayer
    // 행을 손으로 만들면 claimSeat의 실제 동작(닉네임을 참가 유저에서
    // 가져오는 것 등)과 이 조회가 서로 다른 가정을 하고 있어도 안 걸린다.
    const player = await prisma.user.create({ data: { nickname: '테스터', password: 'x' } });
    await prisma.tournamentParticipation.create({
      data: {
        userId: player.id, tournamentId, playerOtp: 'seat0000',
        status: PlayerStatus.WAITING, currentStack: 10000,
      },
    });
    await entryService.enterSeat(tournamentId, { otp: 'seat0000', tableId, seatIndex: 3 });

    const result = await sessionService.getSeatOccupants(tournamentId, ownerId);

    expect(result).toEqual([
      { tableId, tableOrder: 1, players: [{ seatIndex: 3, userId: player.id, nickname: '테스터' }] },
    ]);
  });

  it('남의 대회는 거부한다', async () => {
    const intruder = await prisma.user.create({
      data: { nickname: '다른-상점주', password: 'x', role: Role.STORE_ADMIN },
    });

    await expect(
      sessionService.getSeatOccupants(tournamentId, intruder.id),
    ).rejects.toThrow(ForbiddenException);
  });
});

/**
 * 대회 취소와 전액 환불.
 *
 * **시작 전에만 취소한다.** 리바인은 `HAND_END`에서만 나가므로 시작 전 대회의
 * `buyInCount`는 언제나 1이고, 그래서 한 사람에게 돌려줄 금액은 `entryFee`
 * 하나다. `entryFee * buyInCount`로 쓰지 않는 이유는 그 곱이 항상 1이라
 * **어떤 테스트도 그 분기를 증명하지 못하기** 때문이다 — 리바인 환불을
 * 처리하는 것처럼 보이는데 한 번도 안 타는 코드가 된다.
 *
 * 대신 가드를 둔다. 시작 전이면 `참가자 수 * entryFee == totalBuyinAmount`가
 * 성립해야 하고, 어긋나면 조용히 덜 돌려주는 대신 멈춘다.
 */
describe('SessionService.cancelSession', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let sessionService: SessionService;
  let tournamentId: string;
  let ownerId: string;

  const ENTRY_FEE = 10000;
  const START_POINTS = 50000;

  beforeAll(() => {
    prisma = createTestPrisma();
    redis = createTestRedis();
  });

  afterAll(async () => {
    await redis.quit();
    await closeTestPrisma(prisma);
  });

  /** 참가비를 실제로 낸 사람을 만든다 — 포인트 차감과 거래 내역까지 대칭으로. */
  async function seedPaidPlayer(nickname: string) {
    const user = await prisma.user.create({
      data: { nickname, password: 'x', points: START_POINTS - ENTRY_FEE },
    });
    await prisma.tournamentParticipation.create({
      data: {
        userId: user.id,
        tournamentId,
        status: PlayerStatus.WAITING,
        currentStack: 30000,
        playerOtp: `otp-${nickname}`,
      },
    });
    await prisma.pointTransaction.create({
      data: {
        userId: user.id,
        amount: -ENTRY_FEE,
        type: 'BUY_IN',
        tournamentId,
        description: '테스트 대회 바이인',
      },
    });
    await prisma.tournament.update({
      where: { id: tournamentId },
      data: {
        totalPlayers: { increment: 1 },
        activePlayers: { increment: 1 },
        totalBuyinAmount: { increment: ENTRY_FEE },
      },
    });
    return user.id;
  }

  beforeEach(async () => {
    await truncateAll(prisma);
    await flushTestRedis(redis);

    sessionService = new SessionService(
      prisma as unknown as PrismaService,
      new RedisService(redis),
      new OtpAttempts(redis),
      new EventEmitter2(),
    );

    ({ ownerId, tournamentId } = await seedTournamentWithTable(prisma));
  });

  it('취소하면 참가비가 포인트로 돌아오고 REFUND 내역이 남는다', async () => {
    const playerId = await seedPaidPlayer('player1');

    await sessionService.cancelSession(tournamentId, ownerId);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: playerId } });
    const refund = await prisma.pointTransaction.findFirst({
      where: { userId: playerId, tournamentId, type: 'REFUND' },
    });

    expect(`포인트 ${user.points} / 환불내역 ${refund === null ? '없음' : refund.amount}`)
      .toBe(`포인트 ${START_POINTS} / 환불내역 ${ENTRY_FEE}`);
  });

  it('참가자 여럿이면 각자 자기 참가비를 돌려받는다', async () => {
    const a = await seedPaidPlayer('player-a');
    const b = await seedPaidPlayer('player-b');

    await sessionService.cancelSession(tournamentId, ownerId);

    const points = await prisma.user.findMany({
      where: { id: { in: [a, b] } },
      select: { points: true },
    });

    expect(`돌려받은 사람 ${points.filter((p) => p.points === START_POINTS).length}명`)
      .toBe('돌려받은 사람 2명');
  });

  /**
   * 멱등이 요건이다. 취소를 두 번 눌러도 두 번 주지 않아야 한다 — 돈은
   * 두 번 나가면 되돌릴 근거가 없다. 판정은 코드가 아니라 조건부
   * `updateMany`의 `where`에 태워 DB에 맡긴다(`awardPrize`와 같은 자리).
   */
  it('두 번 취소해도 환불은 한 번뿐이다', async () => {
    const playerId = await seedPaidPlayer('player1');

    await sessionService.cancelSession(tournamentId, ownerId);
    await sessionService.cancelSession(tournamentId, ownerId).catch(() => undefined);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: playerId } });
    const refunds = await prisma.pointTransaction.count({
      where: { userId: playerId, tournamentId, type: 'REFUND' },
    });

    expect(`포인트 ${user.points} / 환불내역 ${refunds}건`)
      .toBe(`포인트 ${START_POINTS} / 환불내역 1건`);
  });

  it('취소한 대회는 CANCELLED로 닫히고 걷은 금액이 0이 된다', async () => {
    await seedPaidPlayer('player1');

    await sessionService.cancelSession(tournamentId, ownerId);

    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });

    expect(`상태 ${t.status} / 걷은 금액 ${t.totalBuyinAmount} / 닫힌 시각 ${t.finishedAt === null ? '없음' : '있음'}`)
      .toBe('상태 CANCELLED / 걷은 금액 0 / 닫힌 시각 있음');
  });

  /**
   * 시작한 대회는 취소하지 않는다. 블라인드가 오르고 칩이 움직인 뒤라
   * "전액 환불"의 뜻이 성립하지 않는다 — 이미 탈락한 사람에게도 전액을
   * 주는 것이 되고, 그건 정산이지 취소가 아니다.
   *
   * 판정은 `status`가 아니라 `startedAt`으로 한다. 그것이 "시작했다"의
   * 정본이다(`domain.md`의 두 `startedAt` 구분).
   */
  it('시작한 대회는 취소할 수 없고 포인트도 그대로다', async () => {
    const playerId = await seedPaidPlayer('player1');
    await prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: TournamentStatus.ONGOING, startedAt: new Date() },
    });

    await expect(
      sessionService.cancelSession(tournamentId, ownerId),
    ).rejects.toThrow(ConflictException);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: playerId } });

    expect(`포인트 ${user.points}`).toBe(`포인트 ${START_POINTS - ENTRY_FEE}`);
  });

  it('남의 대회는 취소할 수 없다', async () => {
    const playerId = await seedPaidPlayer('player1');
    const intruder = await prisma.user.create({
      data: { nickname: 'intruder', password: 'x', role: Role.STORE_ADMIN },
    });

    await expect(
      sessionService.cancelSession(tournamentId, intruder.id),
    ).rejects.toThrow(ForbiddenException);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: playerId } });

    expect(`포인트 ${user.points}`).toBe(`포인트 ${START_POINTS - ENTRY_FEE}`);
  });

  /**
   * 장부가 어긋난 대회는 멈춘다. 시작 전이면 `참가자 수 * entryFee`가
   * `totalBuyinAmount`와 같아야 하고, 다르면 얼마를 돌려줘야 하는지 서버가
   * 모른다는 뜻이다. 조용히 덜 주는 것보다 거절하는 것이 낫다.
   */
  it('걷은 금액과 참가자 수가 어긋나면 거절하고 아무것도 주지 않는다', async () => {
    const playerId = await seedPaidPlayer('player1');
    await prisma.tournament.update({
      where: { id: tournamentId },
      data: { totalBuyinAmount: ENTRY_FEE * 3 },
    });

    await expect(
      sessionService.cancelSession(tournamentId, ownerId),
    ).rejects.toThrow(ConflictException);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: playerId } });
    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });

    expect(`포인트 ${user.points} / 상태 ${t.status}`)
      .toBe(`포인트 ${START_POINTS - ENTRY_FEE} / 상태 PENDING`);
  });

  it('참가자가 없는 대회도 취소된다', async () => {
    await sessionService.cancelSession(tournamentId, ownerId);

    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });

    expect(`상태 ${t.status}`).toBe('상태 CANCELLED');
  });

  it('없는 대회를 취소하면 404다', async () => {
    await expect(
      sessionService.cancelSession('00000000-0000-0000-0000-000000000000', ownerId),
    ).rejects.toThrow(NotFoundException);
  });
});

/**
 * **상태가 하나 늘면 `!== FINISHED` 검사가 전부 새어 나간다.**
 *
 * `user.service.ts`의 `getMyParticipations` 주석이 이 함정을 이미 적어 뒀다 —
 * "상태를 나열해서 살아있는 것만 고르면, 나중에 상태가 하나 늘 때 조용히
 * 빠진다". `SYNCING`이 실제로 그랬다.
 *
 * T49가 `CANCELLED`를 더하면서 같은 일이 여덟 곳에 한꺼번에 생겼다. 그래서
 * 판정을 `isClosedTournament` 하나로 모았고, 이 스위트는 **취소된 대회가
 * 종료된 대회와 똑같이 막히는지**를 경로별로 확인한다. 검사가 여덟이므로
 * 하나가 지워졌을 때 그것만 빨개져야 한다.
 */
describe('취소된 대회는 종료된 대회와 같이 막힌다', () => {
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

    sessionService = new SessionService(
      prisma as unknown as PrismaService,
      new RedisService(redis),
      new OtpAttempts(redis),
      new EventEmitter2(),
    );

    ({ ownerId, tournamentId } = await seedTournamentWithTable(prisma));
    await sessionService.cancelSession(tournamentId, ownerId);
  });

  /**
   * **메시지까지 단언한다.** 취소는 딜러 세션도 함께 지우므로, 타입만 보면
   * `createTable`의 "딜러 세션이 없는 대회" 분기가 같은 `ConflictException`을
   * 던져 초록이 된다 — 닫힘 검사에 닿지도 못한 채로. 실제로 한 번 그렇게
   * 통과했다(CLAUDE.md "다른 계층이 이미 막고 있어서 검증 대상에 닿지도
   * 못했다").
   */
  it('테이블을 더 열 수 없다', async () => {
    await expect(
      sessionService.createTable(tournamentId, ownerId),
    ).rejects.toThrow('이미 닫힌 대회입니다.');
  });

  it('수정할 수 없다', async () => {
    await expect(
      sessionService.updateSession(tournamentId, { name: '이름 변경' } as never, ownerId),
    ).rejects.toThrow(ConflictException);
  });

  it('다시 닫을 수 없다', async () => {
    await expect(
      sessionService.completeSession(tournamentId),
    ).rejects.toThrow(ConflictException);
  });

  /**
   * 참가 OTP는 좌석 권한이다. 취소된 대회의 것을 마이페이지가 계속 보여주면
   * 유출 표면만 넓어진다 — 종료된 대회와 똑같이 지워야 한다.
   */
  it('마이페이지가 참가 OTP를 지운다', async () => {
    const player = await prisma.user.create({
      data: { nickname: 'otp-player', password: 'x' },
    });
    await prisma.tournamentParticipation.create({
      data: {
        userId: player.id, tournamentId,
        status: PlayerStatus.WAITING, currentStack: 0, playerOtp: 'otp-1234',
      },
    });

    const rows = await new UserService(prisma as unknown as PrismaService)
      .getMyParticipations(player.id);

    expect(`OTP ${rows[0].playerOtp === null ? '없음' : '있음'}`).toBe('OTP 없음');
  });
});

/**
 * 수정 경로의 상점 소유권 검사.
 *
 * T23이 재발급·내보내기에, T25가 테이블 추가·삭제에, T49가 취소에 각각
 * `assertTournamentOwnership`을 **서비스 메서드 첫 문장**으로 넣었지만
 * `updateSession`만 그대로였다. `assertTournamentOwnership`의 주석이 "그건 이
 * 태스크 이전부터 있던 별도 항목이라 여기서 같이 고치지 않는다"고 가리키는
 * 그 자리다.
 *
 * 뚫려 있는 것이 작지 않다. 참가비·시작 스택·블라인드 구조·상금 분배율이
 * 전부 이 한 경로로 바뀐다 — 남의 대회 참가비를 0으로 만들거나 분배율을
 * 자기 쪽으로 몰 수 있다는 뜻이다.
 */
describe('SessionService.updateSession — 상점 소유권', () => {
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

    sessionService = new SessionService(
      prisma as unknown as PrismaService,
      new RedisService(redis),
      new OtpAttempts(redis),
      new EventEmitter2(),
    );

    ({ ownerId, tournamentId } = await seedTournamentWithTable(prisma));
  });

  it('다른 상점 소유자가 수정을 호출하면 거부한다', async () => {
    const intruder = await prisma.user.create({
      data: { nickname: 'intruder', password: 'x', role: Role.STORE_ADMIN },
    });

    await expect(
      sessionService.updateSession(tournamentId, { name: '가로챈 대회' } as never, intruder.id),
    ).rejects.toThrow(ForbiddenException);
  });

  /**
   * 거부만으로는 부족하다. 던지기 **전에** 값이 바뀌었는지를 따로 본다 —
   * 검사를 첫 문장에 두는 이유가 그것이다.
   */
  it('거부된 수정은 값을 하나도 바꾸지 않는다', async () => {
    const intruder = await prisma.user.create({
      data: { nickname: 'intruder', password: 'x', role: Role.STORE_ADMIN },
    });

    await expect(
      sessionService.updateSession(
        tournamentId,
        { name: '가로챈 대회', entryFee: 0 } as never,
        intruder.id,
      ),
    ).rejects.toThrow(ForbiddenException);

    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });

    expect(`이름 ${t.name} / 참가비 ${t.entryFee}`).toBe('이름 테스트 대회 / 참가비 10000');
  });

  it('본인 소유면 수정이 통과한다', async () => {
    const updated = await sessionService.updateSession(
      tournamentId,
      { name: '이름 바꿈' } as never,
      ownerId,
    );

    expect(`이름 ${updated.name}`).toBe('이름 이름 바꿈');
  });

  /**
   * 없는 대회는 404여야 한다. 예전에는 `getGameSession`이 null을 주고 그대로
   * 지나가, `tournament.update`가 P2025로 죽어 **500**이 났다 — 없는 것을
   * 물었을 뿐인데 서버 오류다. `revokeDealerSession`이 같은 모양이었고
   * T23이 고쳤다.
   */
  it('없는 대회를 수정하면 404다 — 예전에는 500이었다', async () => {
    await expect(
      sessionService.updateSession(
        '00000000-0000-0000-0000-000000000000',
        { name: '없는 대회' } as never,
        ownerId,
      ),
    ).rejects.toThrow(NotFoundException);
  });
});
