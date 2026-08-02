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
