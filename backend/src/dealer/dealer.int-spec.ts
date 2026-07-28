import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { GameType, PrismaClient, TournamentStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { CreateTournamentDto } from 'shared/dto/tournament.dto';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { SessionService } from 'src/store/session/session.service';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';
import { DealerService } from './dealer.service';
import { LOCK_SECONDS, MAX_ATTEMPTS, OtpAttempts } from './otp-attempts';

/**
 * 딜러 로그인과 토큰 갱신.
 *
 * `dealer.service.int-spec.ts`는 딜러 경로의 동시성(락)을 본다. 여기는
 * 인증 그 자체 — 해시 대조가 실제로 틀린 값을 걸러내는지, 잠금이 대회
 * 단위로 걸리고 성공하면 풀리는지, 그리고 발급된 토큰이 대회 종료와
 * 세션 폐기(tokenVersion)에 맞춰 갱신을 거부하는지를 본다. Redis(잠금
 * 카운터·락)와 PostgreSQL(해시·세션 저장) 둘 다 진짜라야 의미가 있다.
 */
const SECRET = 'test-only-not-a-real-secret';

let prisma: PrismaClient;
let redis: Redis;
let queueConnection: Redis;
let queue: Queue;
let dealerService: DealerService;
let sessionService: SessionService;
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

/**
 * 대회 하나를 세우고 평문 OTP를 함께 돌려준다.
 *
 * `status`를 넘기면 생성 직후(PENDING) 상태를 그 값으로 덮어쓴다 — 갱신
 * 테스트는 ONGOING/FINISHED 같은 진행 상태가 필요하다.
 */
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
    dealerSessionId: table.dealerId,
  };
}

describe('딜러 로그인', () => {
  it('맞는 OTP는 통과하고 틀린 OTP는 거부된다', async () => {
    const { tournamentId, tableId, otp } = await seedTournament();

    await expect(
      dealerService.loginDealer({ tournamentId, tableId, otp: '000000' }),
    ).rejects.toThrow(UnauthorizedException);

    const result = await dealerService.loginDealer({ tournamentId, tableId, otp });
    expect(typeof result.accessToken).toBe('string');
  });

  it('5회 실패하면 맞는 OTP도 거부된다', async () => {
    const { tournamentId, tableId, otp } = await seedTournament();

    for (let i = 0; i < 5; i++) {
      await expect(
        dealerService.loginDealer({ tournamentId, tableId, otp: '000000' }),
      ).rejects.toThrow(UnauthorizedException);
    }

    // 여기가 핵심이다. 잠금이 없으면 이 줄이 통과해 버린다.
    await expect(
      dealerService.loginDealer({ tournamentId, tableId, otp }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('잠금은 대회 단위다 — 다른 대회는 영향받지 않는다', async () => {
    const a = await seedTournament();
    const b = await seedTournament();

    for (let i = 0; i < 5; i++) {
      await expect(
        dealerService.loginDealer({ tournamentId: a.tournamentId, tableId: a.tableId, otp: '000000' }),
      ).rejects.toThrow(UnauthorizedException);
    }

    const result = await dealerService.loginDealer({
      tournamentId: b.tournamentId,
      tableId: b.tableId,
      otp: b.otp,
    });
    expect(typeof result.accessToken).toBe('string');
  });

  it('성공하면 실패 카운터가 지워진다', async () => {
    const { tournamentId, tableId, otp } = await seedTournament();

    for (let i = 0; i < 4; i++) {
      await expect(
        dealerService.loginDealer({ tournamentId, tableId, otp: '000000' }),
      ).rejects.toThrow(UnauthorizedException);
    }

    await dealerService.loginDealer({ tournamentId, tableId, otp });

    // 카운터가 지워지지 않았다면 다음 실패 하나로 잠긴다.
    await expect(
      dealerService.loginDealer({ tournamentId, tableId, otp: '000000' }),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      dealerService.loginDealer({ tournamentId, tableId, otp }),
    ).resolves.toBeDefined();
  });

  /**
   * 순차 5회가 아니라 **동시 버스트**를 본다.
   *
   * 카운터를 읽고(GET) → bcrypt를 돌리고(~80ms) → 그 뒤에 증가(INCR)하면, 읽기와
   * 증가 사이가 bcrypt 한 라운드만큼 벌어진다. 그 창에 들어온 요청은 전부 같은
   * 값을 읽으므로 한도가 "창당 5회"가 아니라 "순차 5회 + 무제한 동시 버스트
   * 1회"가 된다. 10^6 공간에 10^4짜리 버스트면 완전 열거가 잠금 창 100번으로
   * 내려온다. 게다가 cost 10짜리 bcrypt가 libuv 스레드풀(기본 4개)에 줄을 서서,
   * 버스트 한 번이 진행 중인 딜러의 게임 조작까지 멈춘다.
   *
   * 그래서 단언 대상은 카운터의 최종값이 아니다 — 게이트가 증가 자체가 되면
   * 카운터는 공격자가 보낸 만큼 올라간다(그건 정상이다). 봐야 할 것은 **몇 개가
   * 자격 검사에 닿았는가**다. 게이트에서 걸리면 403, bcrypt까지 가서 틀리면
   * 401이라 401의 개수가 곧 그 숫자다.
   */
  it('동시 버스트가 와도 창당 MAX_ATTEMPTS개만 자격 검사에 닿는다', async () => {
    const { tournamentId, tableId } = await seedTournament();
    const BURST = 50;

    // 배열을 먼저 다 만들어 넘긴다. 루프 안에서 await하면 순차 실행이 되어
    // 검증 대상인 동시성 자체가 사라진다.
    const settled = await Promise.allSettled(
      Array.from({ length: BURST }, () =>
        dealerService.loginDealer({ tournamentId, tableId, otp: '000000' }),
      ),
    );

    expect(settled.every((r) => r.status === 'rejected')).toBe(true);

    const reachedCredentialCheck = settled.filter(
      (r) => r.status === 'rejected' && r.reason instanceof UnauthorizedException,
    ).length;

    // 상한만 보면 "게이트가 전부 막는" 퇴화 구현도 통과한다. INCR이 원자적이라
    // 1~5를 받은 다섯 개가 정확히 통과하므로 등호로 못 박는다.
    expect(reachedCredentialCheck).toBe(MAX_ATTEMPTS);
  });

  it('실패 카운터에 TTL이 붙는다 — 없으면 대회가 영구 잠긴다', async () => {
    const { tournamentId, tableId } = await seedTournament();

    await expect(
      dealerService.loginDealer({ tournamentId, tableId, otp: '000000' }),
    ).rejects.toThrow(UnauthorizedException);

    // TTL이 없으면 -1이 나온다. 그 상태로 5회가 차면 대회가 영구히 잠기고,
    // 탈출구인 재발급은 아직 화면이 없다.
    const ttl = await redis.ttl(`dealer:otp:fail:${tournamentId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(LOCK_SECONDS);
  });

  it('다른 대회의 테이블로는 로그인할 수 없다', async () => {
    const a = await seedTournament();
    const b = await seedTournament();

    // otp는 a 것이 맞지만 tableId가 b 소속이다 — 이걸 그대로 서명하면
    // 다른 대회의 테이블로 인증받는 경로가 열린다.
    await expect(
      dealerService.loginDealer({ tournamentId: a.tournamentId, tableId: b.tableId, otp: a.otp }),
    ).rejects.toThrow(ForbiddenException);
  });
});

/**
 * 딜러 토큰 갱신.
 *
 * 만료는 1시간, 대회는 몇 시간이라 갱신이 필요하다. 갱신이 지켜야 할 것은
 * 세 가지 — 대회가 끝나면 막고, 상점이 세션을 폐기(tokenVersion 증가)하면
 * 막고, 갱신 자체가 다른 테이블로 옮겨 붙는 권한 상승 경로가 되지 않아야
 * 한다.
 */
describe('딜러 토큰 갱신', () => {
  it('진행 중인 대회는 갱신된다', async () => {
    const { tournamentId, tableId, otp } = await seedTournament({ status: 'ONGOING' });
    const { accessToken } = await dealerService.loginDealer({ tournamentId, tableId, otp });

    const payload = jwtService.verify(accessToken);
    const refreshed = await dealerService.refreshToken(payload);

    expect(jwtService.verify(refreshed.accessToken).sub).toBe(payload.sub);
  });

  it('종료된 대회는 갱신되지 않는다', async () => {
    const { tournamentId, tableId, otp } = await seedTournament({ status: 'ONGOING' });
    const { accessToken } = await dealerService.loginDealer({ tournamentId, tableId, otp });
    const payload = jwtService.verify(accessToken);

    await prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: 'FINISHED' },
    });

    await expect(dealerService.refreshToken(payload)).rejects.toThrow(ForbiddenException);
  });

  it('세션 버전이 올라가면 갱신되지 않는다', async () => {
    const { tournamentId, tableId, otp, dealerSessionId } = await seedTournament({ status: 'ONGOING' });
    const { accessToken } = await dealerService.loginDealer({ tournamentId, tableId, otp });
    const payload = jwtService.verify(accessToken);

    await prisma.dealerSession.update({
      where: { id: dealerSessionId },
      data: { tokenVersion: { increment: 1 } },
    });

    await expect(dealerService.refreshToken(payload)).rejects.toThrow(ForbiddenException);
  });

  it('다른 대회의 테이블로는 갱신되지 않는다', async () => {
    const a = await seedTournament({ status: 'ONGOING' });
    const b = await seedTournament({ status: 'ONGOING' });
    const { accessToken } = await dealerService.loginDealer({
      tournamentId: a.tournamentId,
      tableId: a.tableId,
      otp: a.otp,
    });
    const payload = jwtService.verify(accessToken);

    // payload.tableId를 검증 없이 그대로 서명하면, 다른 대회의 테이블 id를
    // 실어 보내는 것만으로 그 테이블 딜러가 되는 권한 상승 경로가 된다.
    await expect(
      dealerService.refreshToken({ ...payload, tableId: b.tableId }),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('assertDealerSessionValid', () => {
  it('유효한 세션이면 통과한다', async () => {
    const { tournamentId, otp, tableId } = await seedTournament({
      status: TournamentStatus.ONGOING,
    });
    const { accessToken } = await dealerService.loginDealer({ tournamentId, tableId, otp });
    const payload = jwtService.verify(accessToken);

    await expect(
      dealerService.assertDealerSessionValid({
        sub: payload.sub,
        tournamentId: payload.tournamentId,
        tableId: payload.tableId,
        tokenVersion: payload.tokenVersion,
      }),
    ).resolves.toMatchObject({ tournamentId });
  });

  it('폐기된 세션(tokenVersion 불일치)을 거부한다', async () => {
    const { tournamentId, otp, tableId } = await seedTournament({
      status: TournamentStatus.ONGOING,
    });
    const { accessToken } = await dealerService.loginDealer({ tournamentId, tableId, otp });
    const payload = jwtService.verify(accessToken);

    await expect(
      dealerService.assertDealerSessionValid({
        sub: payload.sub,
        tournamentId: payload.tournamentId,
        tableId: payload.tableId,
        tokenVersion: payload.tokenVersion + 1,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
