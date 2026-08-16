import { GameType } from '@prisma/client';
import { truncateAll } from '../../test/helpers/prisma';
import { applyTestEnv } from '../../test/helpers/test-env';
import { PrismaService } from './prisma.service';

/**
 * **비밀은 호출부 규율이 아니라 클라이언트 설정이 감춘다.**
 *
 * `omit`을 쿼리마다 손으로 붙이는 방식은 T23이 딜러 OTP 해시에 대해 실제로
 * 해 봤고, **두 곳을 빠뜨려 누출됐다**(`startSession`·`updateSession`). 리뷰가
 * 잡았지 테스트가 잡은 것이 아니다 — 빠뜨림이 아무 신호도 내지 않기 때문이다.
 *
 * 그래서 기본을 감춤으로 두고 **읽는 단 한 곳**에서만 명시적으로 켠다. 그러면
 * 빠뜨림이 조용한 누출이 아니라 **컴파일 에러**가 된다.
 *
 * 이 스펙이 `createTestPrisma()`가 아니라 `new PrismaService()`를 쓰는 것이
 * 요점이다. 테스트 헬퍼는 omit 설정이 없는 맨 `PrismaClient`라, 그것으로
 * 검사하면 **제품이 실제로 쓰는 설정을 한 번도 밟지 않는다.**
 */
describe('PrismaService — 비밀 필드는 기본이 감춤이다', () => {
  let prisma: PrismaService;

  const STORE_OWNER = 'owner-1';
  const TOURNAMENT = 'tournament-1';

  beforeAll(async () => {
    applyTestEnv();
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    await truncateAll(prisma);

    await prisma.user.create({
      data: { id: STORE_OWNER, nickname: 'owner', password: 'x' },
    });
    const store = await prisma.store.create({
      data: { name: '테스트 상점', ownerId: STORE_OWNER },
    });
    const blind = await prisma.blindStructure.create({
      data: {
        name: '기본 구조',
        storeId: store.id,
        structure: [{ lv: 1, sb: 100, ante: false, duration: 20 }],
      },
    });
    await prisma.tournament.create({
      data: {
        id: TOURNAMENT,
        name: '테스트 대회',
        type: GameType.TOURNAMENT,
        storeId: store.id,
        blindId: blind.id,
        dealerOtpHash: '$2b$10$hash-that-must-never-leave',
        startStack: 30000,
        avgStack: 30000,
        entryFee: 10000,
        rebuyUntil: 5,
        isRegistrationOpen: true,
        itmCount: 1,
        prizePayouts: [{ place: 1, percent: 100 }],
      },
    });
  });

  /**
   * **`omit`을 쓰지 않은 조회**를 일부러 쓴다. 이게 이 티켓의 전부다 — 새
   * 쿼리를 무심코 쓴 사람이 되는 것이고, 그때 해시가 나오면 안 된다.
   */
  it('omit을 쓰지 않은 조회도 딜러 OTP 해시를 담지 않는다', async () => {
    const row = await prisma.tournament.findUniqueOrThrow({
      where: { id: TOURNAMENT },
    });

    expect(`해시 ${'dealerOtpHash' in row ? '있음' : '없음'}`).toBe('해시 없음');
  });

  it('여러 건 조회도 마찬가지다', async () => {
    const rows = await prisma.tournament.findMany();

    expect(`해시 든 행 ${rows.filter((r) => 'dealerOtpHash' in r).length}건`)
      .toBe('해시 든 행 0건');
  });

  /**
   * 쓰기 응답도 같은 규칙을 받는다. T23이 빠뜨린 두 곳
   * (`startSession`·`updateSession`)이 정확히 이 모양이었다 —
   * `update`가 돌려주는 행에 해시가 실려 나갔다.
   */
  it('update가 돌려주는 행에도 해시가 없다', async () => {
    const row = await prisma.tournament.update({
      where: { id: TOURNAMENT },
      data: { name: '이름 변경' },
    });

    expect(`해시 ${'dealerOtpHash' in row ? '있음' : '없음'}`).toBe('해시 없음');
  });

  /**
   * 감추기만 하면 로그인이 불가능하다. **읽는 단 한 곳**은 명시적으로 켤 수
   * 있어야 하고, 그 한 줄이 곧 "여기가 유일한 열람 경로다"라는 선언이다.
   */
  it('명시적으로 켜면 읽을 수 있다 — 딜러 로그인이 쓰는 경로다', async () => {
    const row = await prisma.tournament.findUniqueOrThrow({
      where: { id: TOURNAMENT },
      omit: { dealerOtpHash: false },
    });

    expect(`해시 ${row.dealerOtpHash}`).toBe('해시 $2b$10$hash-that-must-never-leave');
  });

  /** 참가 OTP는 이미 같은 방식으로 감춰져 있다. 함께 회귀 방어한다. */
  it('참가 OTP도 기본이 감춤이다', async () => {
    await prisma.tournamentParticipation.create({
      data: { tournamentId: TOURNAMENT, userId: STORE_OWNER, playerOtp: '11111111' },
    });

    const row = await prisma.tournamentParticipation.findFirstOrThrow();

    expect(`OTP ${'playerOtp' in row ? '있음' : '없음'}`).toBe('OTP 없음');
  });
});
