import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role, TournamentStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { writeFileSync } from 'fs';
import Redis from 'ioredis';
import { resolve } from 'path';
import { Pool } from 'pg';
import { hashDealerOtp } from '../src/dealer/dealer-otp';
import { resetAll, setEmptySnapshot, setSeatBitmap } from './seed-helpers';

/**
 * 부하테스트용 시드.
 *
 * **참가자를 만들지 않는다.** 데모 시드와 갈리는 지점이 여기다.
 *
 * 처음에는 수천 명을 미리 만들어 두려고 했는데, 그러면 두 가지가 어긋난다.
 * 하나는 시드가 bcrypt를 수천 번 돌려 몇 분이 걸리는 것이고, 더 나쁜 것은
 * **그 비용이 측정 밖에서 사라지는 것**이다. 회원가입과 로그인의 bcrypt는
 * 일부러 느리게 만든 함수라 1코어에서 무겁고, 실제 운영에서도 대회 직전에
 * 몰린다. 미리 발급한 토큰으로 건너뛰면 진짜 부하의 한 축을 빼먹는다.
 *
 * 그래서 시드는 **무대만 세운다** — 상점, 상점 관리자, 블라인드 구조, 대회
 * 하나, 테이블. 사람은 k6가 실행 중에 만들고, 그 만드는 일 자체가 부하다.
 *
 * **참가비가 0이다.** 회원가입이 포인트를 주지 않고(`schema.prisma`의
 * `points @default(0)`) 충전 경로도 없다 — 실제 PG 결제가 아직 판단하지 않은
 * 항목이라 포인트 차감이 결제를 대신하고 있다. `joinSession`의 게이트가
 * `user.points < session.entryFee`라 0원이면 통과하므로, 결제 경로의 DB 쓰기
 * (참가 행 · 참가 OTP · 거래 내역 · 프라이즈풀 갱신)는 그대로 돌면서 잔고
 * 문제만 비껴간다.
 *
 * **비밀은 매니페스트로 나간다.** 딜러 OTP는 해시로만 저장되므로 여기서
 * 내보내지 않으면 다시 볼 방법이 재발급뿐이다. k6가 읽어야 하므로 stdout이
 * 아니라 파일에 쓴다.
 */

const STORE_NAME = '부하테스트 상점';
const TOURNAMENT_NAME = '부하테스트 대회';

/**
 * 로드용 계정은 전부 같은 비밀번호를 쓴다.
 *
 * k6가 회원가입할 때마다 이 값을 보내고, 시드는 상점 관리자에게 같은 값을
 * 준다. 부하 전용 인프라(tmpfs, 컨테이너가 죽으면 사라짐)에만 존재하는
 * 값이라 비밀이 아니다.
 */
const LOAD_PASSWORD = 'loadtest1234';

/** 상점 관리자 계정. k6가 이 계정으로 로그인해 테이블을 열고 대회를 시작한다. */
const OWNER_NICKNAME = 'loadowner';

/**
 * 딜러 OTP를 고정한다.
 *
 * 제품은 `generateDealerOtp()`로 무작위 6자리를 만들지만, 부하 시드는 값을
 * 정해 놓고 해시만 넣는다. 매니페스트는 어차피 읽으므로 값을 몰라서가 아니라,
 * **시드를 다시 돌려도 같은 값이라 재현이 쉬워서**다. 형식(6자리 문자열)은
 * 제품과 같다.
 */
const DEALER_OTP = '123456';

/**
 * 블라인드가 오르지 않게 한 레벨만 둔다.
 *
 * 램프의 축은 테이블 수이고, 레벨 상승은 그 축과 무관하게 상태를 흔든다 —
 * 블라인드가 오르면 스택 대비 팟이 커져 올인이 늘고, 그러면 같은 테이블 수에서
 * 부하 모양이 달라진다. 측정 중에 변수를 하나 줄인다.
 */
const BLIND_STRUCTURE = [{ lv: 1, sb: 100, ante: false, duration: 600 }];

/** 등록 마감까지의 분. 램프가 이 안에서 끝나야 착석이 계속 열려 있다. */
const REBUY_UNTIL = 600;

const START_STACK = 100_000;

/**
 * 시드가 미리 여는 테이블 수. 나머지는 램프가 상점 콘솔 경로
 * (`POST /store/sessions/:id/tables`)로 실행 중에 연다 — 그것도 부하다.
 */
const INITIAL_TABLES = Number(process.env.LOAD_TABLES ?? 1);

/**
 * k6가 읽는 매니페스트.
 *
 * 경로를 `__dirname` 기준으로 잡는 이유는 컨테이너의 작업 디렉터리가
 * `/app/backend`라서다. 데모 시드의 `.demo-seed.json`과 같은 자리이고 같은
 * 이유다.
 */
const MANIFEST_PATH = resolve(__dirname, '../../.load-seed.json');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL 환경 변수가 설정되지 않았습니다.');
  }

  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
  });

  try {
    await resetAll(prisma, redis);

    // 해시를 한 번만 계산해 돌려 쓴다. 부하 계정이 전부 같은 비밀번호라
    // 가능하고, 시드에서 bcrypt를 반복하는 비용을 없앤다 — 측정하고 싶은
    // bcrypt는 시드의 것이 아니라 **실행 중 회원가입·로그인의 것**이다.
    const password = await bcrypt.hash(LOAD_PASSWORD, 10);

    const owner = await prisma.user.create({
      data: { nickname: OWNER_NICKNAME, password, role: Role.STORE_ADMIN },
    });

    const store = await prisma.store.create({
      data: { name: STORE_NAME, ownerId: owner.id },
    });

    const blind = await prisma.blindStructure.create({
      data: { name: '부하 (한 레벨)', structure: BLIND_STRUCTURE, storeId: store.id },
    });

    const tournament = await prisma.tournament.create({
      data: {
        name: TOURNAMENT_NAME,
        status: TournamentStatus.PENDING,
        storeId: store.id,
        blindId: blind.id,
        // 위 주석 참고 — 포인트 충전 경로가 없어서 0이어야 결제가 통과한다.
        entryFee: 0,
        startStack: START_STACK,
        rebuyUntil: REBUY_UNTIL,
        itmCount: 1,
        prizePayouts: [{ place: 1, percent: 100 }],
        isRegistrationOpen: true,
        dealerOtpHash: await hashDealerOtp(DEALER_OTP),
      },
    });

    // `Table.dealerId`가 필수라 대회마다 딜러 세션이 하나 있어야 한다.
    const dealerSession = await prisma.dealerSession.create({
      data: { tournamentId: tournament.id },
    });

    const tables: { id: string; tableOrder: number }[] = [];
    for (let order = 1; order <= INITIAL_TABLES; order++) {
      const table = await prisma.table.create({
        data: { tableOrder: order, tournamentId: tournament.id, dealerId: dealerSession.id },
      });
      tables.push({ id: table.id, tableOrder: table.tableOrder });

      // 제품 경로에서는 `createTable`이 둘 다 한다. 시드는 그 경로를 타지
      // 않으므로 여기서 세운다 — 비트맵이 없으면 좌석 목록이 비어 있고,
      // 스냅샷이 없으면 딜러 화면이 500을 받는다(T38).
      await setSeatBitmap(redis, tournament.id, table.id);
      await setEmptySnapshot(redis, tournament.id, table.id);
    }

    const manifest = {
      tournamentId: tournament.id,
      storeId: store.id,
      ownerNickname: OWNER_NICKNAME,
      password: LOAD_PASSWORD,
      dealerOtp: DEALER_OTP,
      startStack: START_STACK,
      tables,
    };
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    console.log('부하 시드 완료');
    console.log(`  대회      ${tournament.id}`);
    console.log(`  테이블    ${tables.length}개`);
    console.log(`  딜러 OTP  ${DEALER_OTP}`);
    console.log(`  매니페스트 ${MANIFEST_PATH}`);
  } finally {
    await redis.quit();
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
