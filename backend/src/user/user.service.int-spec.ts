import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { UserService } from './user.service';
import { applyTestEnv } from '../../test/helpers/test-env';
import { truncateAll } from '../../test/helpers/prisma';

/**
 * 유저 조회 경로. 마이페이지 참여 목록과 uuid 단건 조회.
 *
 * `createTestPrisma()`가 아니라 진짜 `PrismaService`를 그대로 띄운다. 검증
 * 대상인 "다른 조회 경로에는 playerOtp가 실리지 않는다"는 클라이언트 수준
 * `omit`이 실제로 걸려 있어야만 의미가 있고, 그 설정은 `prisma.service.ts`
 * 안에만 있다. 여기서 설정을 복제해 별도 클라이언트를 만들면 그 파일의
 * 줄을 지워도 이 테스트는 계속 초록일 것이다 — 검증 자체가 가짜가 된다.
 */
describe('UserService', () => {
  let prisma: PrismaService;
  let service: UserService;

  const TOURNAMENT = 'my-page-tournament-1';
  const OTHER_TOURNAMENT = 'my-page-tournament-2';

  /** 대회 둘, 참가 둘(각자 다른 유저). u1이 자기 것만 보는지 확인하려면 남의 참여가 있어야 한다. */
  async function seedDb() {
    const owner = await prisma.user.create({ data: { nickname: 'my-page-owner', password: 'x' } });
    const store = await prisma.store.create({ data: { name: 'my-page-store-1', ownerId: owner.id } });
    const blind = await prisma.blindStructure.create({
      data: {
        name: 'my-page-blind-1',
        storeId: store.id,
        structure: [{ lv: 1, sb: 100, ante: false, duration: 600 }],
      },
    });

    await prisma.tournament.create({
      data: {
        id: TOURNAMENT,
        name: '내 대회',
        blindId: blind.id,
        storeId: store.id,
        dealerOtpHash: 'unused-hash-1',
        entryFee: 1000,
        startStack: 10000,
        isRegistrationOpen: true,
      },
    });
    await prisma.tournament.create({
      data: {
        id: OTHER_TOURNAMENT,
        name: '남의 대회',
        blindId: blind.id,
        storeId: store.id,
        dealerOtpHash: 'unused-hash-2',
        entryFee: 1000,
        startStack: 10000,
        isRegistrationOpen: true,
      },
    });

    await prisma.user.create({ data: { id: 'u1', nickname: 'u1', password: 'x' } });
    await prisma.user.create({ data: { id: 'u2', nickname: 'u2', password: 'x' } });

    // 직접 create한다 — playerOtp는 NOT NULL이라 값을 반드시 줘야 한다.
    await prisma.tournamentParticipation.create({
      data: { tournamentId: TOURNAMENT, userId: 'u1', playerOtp: '11111111' },
    });
    await prisma.tournamentParticipation.create({
      data: { tournamentId: OTHER_TOURNAMENT, userId: 'u2', playerOtp: '22222222' },
    });
  }

  beforeAll(async () => {
    applyTestEnv();
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new UserService(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await seedDb();
  });

  describe('getMyParticipations', () => {
    it('본인 참여만 준다', async () => {
      const mine = await service.getMyParticipations('u1');
      expect(mine.map((p) => p.tournamentId)).toEqual([TOURNAMENT]);
    });

    it('진행 중·대기 중 대회는 OTP를 담는다', async () => {
      const [row] = await service.getMyParticipations('u1');
      expect(row.playerOtp).toMatch(/^\d{8}$/);
    });

    it('끝난 대회는 OTP를 빼고 준다', async () => {
      await prisma.tournament.update({
        where: { id: TOURNAMENT },
        data: { status: 'FINISHED' },
      });
      const [row] = await service.getMyParticipations('u1');
      expect(row.playerOtp).toBeNull();
    });

    // 규칙은 "닫힌 것만 뺀다"이지 "PENDING·ONGOING만 보여준다"가 아니다.
    //
    // 예전에는 이 자리에 `SYNCING`으로 그 성질을 지키는 검사가 있었다. T71이
    // 그 상태값을 지우면서(대입하는 코드가 한 줄도 없었다) 검사도 함께
    // 사라졌지만, **성질은 구조가 지킨다** — 판정이 `isClosedTournament`
    // 하나이고, 살아 있는 상태를 나열하는 자리는 이제 없다. 나열이 남아
    // 있던 조회 둘은 `tournament-status.spec.ts`가 여집합인지 확인한다.

    // omit 회귀. 이 검사가 없으면 새 조회 경로가 하나 늘 때마다
    // 참가자 전원의 평문 OTP가 조용히 새는 길이 생긴다.
    it('다른 조회 경로에는 playerOtp가 실리지 않는다', async () => {
      const rows = await prisma.tournamentParticipation.findMany({
        where: { tournamentId: TOURNAMENT },
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).not.toHaveProperty('playerOtp');
      }
    });

    /**
     * 딜러 토큰이 라우트 가드를 뚫고 들어오면 `req.user.userId`가
     * `undefined`다(`JwtStrategy`가 딜러에게는 `id`만 준다). 서비스가
     * 이걸 거부하지 않으면 `where: { userId: undefined }`가 필터를
     * 통째로 지워 대회 전체의 참가자가 평문 OTP와 함께 새어 나온다 —
     * 아래 시드는 u1·u2 두 대회에 걸쳐 있어서, 가드가 없다면 이 호출이
     * 한 명이 아니라 둘 다 돌려준다는 것으로 그 유출을 그대로 보여준다.
     */
    it('userId가 없으면 거부한다 — 없으면 대회 전체의 참가자가 새어 나온다', async () => {
      await expect(
        service.getMyParticipations(undefined as unknown as string),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  /**
   * `findUnique`는 행이 없으면 `null`을 준다. 이 검사가 도달 가능해야
   * 호출부가 각자 null을 막지 않아도 된다 — 없는 유저를 거르는 자리를
   * 여기 하나로 모은 근거다(`PaymentService.joinSession` · `UserService.paymentPoint`).
   */
  describe('findByUUID', () => {
    it('없는 uuid면 던진다', async () => {
      await expect(service.findByUUID('no-such-user')).rejects.toThrow(NotFoundException);
    });

    it('있는 유저는 그대로 준다', async () => {
      const user = await service.findByUUID('u1');
      expect(user.nickname).toBe('u1');
    });
  });
});
