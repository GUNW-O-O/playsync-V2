import { PrismaClient } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from 'src/prisma/prisma.service';
import { UserService } from 'src/user/user.service';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * `POST /auth/join`이 만드는 **역할**을 고정한다.
 *
 * 단위 스펙으로 "컨트롤러가 `createUser`를 부른다"를 단언하면 배선만 보고
 * 결과를 못 본다 — `createUser`가 나중에 역할을 올리면 그 스펙은 초록인 채로
 * 통과한다. 실제로 만들어진 행의 `role`을 읽어야 이 검사가 값을 갖는다.
 *
 * 막는 것: 상점 계정을 따로 만드는 경로가 없던 시절, 이 라우트가
 * `createStoreAdmin`을 가리켰다. 가입만 하면 `/stores/*` 가드를 통과했다.
 */
describe('AuthController.join', () => {
  let prisma: PrismaClient;
  let controller: AuthController;

  beforeAll(async () => {
    prisma = createTestPrisma();
    const service = new AuthService(
      prisma as unknown as PrismaService,
      {} as UserService,
      {} as JwtService,
    );
    controller = new AuthController(service);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await closeTestPrisma(prisma);
  });

  it('가입자는 USER다 — 상점 관리자가 아니다', async () => {
    await controller.join({ nickname: 'joiner', password: 'pw-joiner' } as never);

    const created = await prisma.user.findUniqueOrThrow({ where: { nickname: 'joiner' } });
    expect(`역할 ${created.role}`).toBe('역할 USER');
  });

  it('비밀번호는 평문으로 남지 않는다', async () => {
    await controller.join({ nickname: 'joiner', password: 'pw-joiner' } as never);

    const created = await prisma.user.findUniqueOrThrow({ where: { nickname: 'joiner' } });
    expect(created.password).not.toBe('pw-joiner');
  });
});

/**
 * C-2. 부하 램프의 `NEW_USER_RATIO`(`load/lib/table.js`) 분기가 실행 중에
 * signup → login → joinTournament를 탄다. 가입은 `points @default(0)`이고
 * 충전 경로가 없어서, `PaymentService.joinSession`의
 * `user.points < session.entryFee` 게이트가 신규 가입 봇을 409로 막고
 * `load/lib/api.js`의 `must()`가 VU를 중단시켰다.
 *
 * 실 PG 연동이 없는 지금 일반 가입에 기본으로 포인트를 얹으면 결제 없이
 * 참가할 길이 열린다 — 그래서 환경변수 없이는 지금과 똑같이 0이어야 한다.
 * 값은 `seed-load.ts`의 `BOT_POINTS`와 같은 `SIGNUP_INITIAL_POINTS`를 읽는다
 * (근거는 `load/README.md`) — 두 벌이 되면 어긋난다.
 */
describe('AuthController.join — 초기 포인트(SIGNUP_INITIAL_POINTS)', () => {
  let prisma: PrismaClient;
  let controller: AuthController;

  beforeAll(async () => {
    prisma = createTestPrisma();
    const service = new AuthService(
      prisma as unknown as PrismaService,
      {} as UserService,
      {} as JwtService,
    );
    controller = new AuthController(service);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    delete process.env.SIGNUP_INITIAL_POINTS;
  });

  afterAll(async () => {
    delete process.env.SIGNUP_INITIAL_POINTS;
    await closeTestPrisma(prisma);
  });

  it('환경변수가 없으면 포인트는 0이다 — 일반 가입에는 열지 않는다', async () => {
    await controller.join({ nickname: 'freepoints-off', password: 'pw' } as never);

    const created = await prisma.user.findUniqueOrThrow({ where: { nickname: 'freepoints-off' } });
    expect(created.points).toBe(0);
  });

  it('SIGNUP_INITIAL_POINTS를 켜면 가입이 그 값을 싣고 나온다', async () => {
    process.env.SIGNUP_INITIAL_POINTS = '5000000';

    await controller.join({ nickname: 'freepoints-on', password: 'pw' } as never);

    const created = await prisma.user.findUniqueOrThrow({ where: { nickname: 'freepoints-on' } });
    expect(created.points).toBe(5000000);
  });
});
