// `shared/dto/tournament.dto`가 class-validator 데코레이터를 쓰고
// (`emitDecoratorMetadata: true`), 그 메타데이터가 `Reflect.getMetadata`를
// 찾는다. Nest 부트스트랩(main.ts)에서는 프레임워크가 미리 불러 두지만 이
// 시드는 그 경로를 안 타므로 여기서 직접 불러야 한다 — 없으면
// `TypeError: Reflect.getMetadata is not a function`으로 죽는다.
import 'reflect-metadata';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role, TournamentStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { mkdirSync, writeFileSync } from 'fs';
import Redis from 'ioredis';
import { resolve } from 'path';
import { Pool } from 'pg';
import { hashDealerOtp } from '../src/dealer/dealer-otp';
import { resetAll, setEmptySnapshot, setSeatBitmap } from './seed-helpers';
// `shared/...` 별칭(jest의 moduleNameMapper·tsconfig의 baseUrl)은 컴파일
// 타임 타입 체크는 통과시키지만 ts-node의 실제 require 호출까지는 풀어 주지
// 않는다 — 실행하면 `Cannot find module 'shared/dto/tournament.dto'`로 죽는다.
// 상대경로로 내려간다.
import { ENTRY_FEE_MIN } from '../shared/dto/tournament.dto';

/**
 * 부하테스트용 시드.
 *
 * **무대와 계정만 세운다.** 상점, 상점 관리자, 블라인드 구조, 대회 하나,
 * 테이블, 그리고 계정 풀. 참가·착석·게임은 전부 k6가 실행 중에 한다 — 그
 * 만드는 일 자체가 부하다.
 *
 * 계정을 미리 만드는 이유는 아래 `ACCOUNT_POOL` 주석에 있다. 요점은 bcrypt
 * 두 종류가 **실제로 일어나는 시점이 다르다**는 것이다 — 가입의 `hash`는 몇
 * 주 전에 흩어져 일어나고, 로그인의 `compare`만 대회 직전에 몰린다.
 *
 * **참가비가 1이다.** 회원가입이 포인트를 주지 않고(`schema.prisma`의
 * `points @default(0)`) 충전 경로도 없다 — 실제 PG 결제가 아직 판단하지 않은
 * 항목이라 포인트 차감이 결제를 대신하고 있다. 예전에는 참가비를 0으로 두어
 * `joinSession`의 `user.points < session.entryFee` 게이트를 비껴갔는데,
 * **그 값이 `recalculateAvgStack`의 분모라 `0 / 0 = NaN`이 되어 전광판이
 * 죽은 상태로 부하를 쟀다**(T64 6-3). 지금은 참가비를 `ENTRY_FEE_MIN`으로 두고
 * 풀 계정에 포인트를 미리 실어, 결제 경로가 게이트까지 정직하게 지나간다.
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
 * 세울 상점(= 대회) 수. **램프 A의 x축이다.**
 *
 * 램프가 실행 중에 대회를 만들 수 없어서 여기서 세운다 — k6는 VU 사이에
 * 상태를 공유하지 않으므로(`SharedArray`는 읽기 전용, `setup()`은 실행 전에
 * 한 번) 7번째 VU가 앞선 VU가 만든 대회의 id를 알 방법이 없다.
 *
 * 측정 밖에 두는 것이 옳기도 하다. 대회 생성은 실제로 대회 몇 시간~며칠 전에
 * 상점이 한 번 하는 일이고, 대회 직전에 몰리는 것은 로그인과 착석이다 —
 * T40이 bcrypt의 `hash`와 `compare`를 시점으로 가른 것과 같은 자리다.
 *
 * 기본 12인 이유는 계정 풀 600이 66테이블을 덮고, 램프 A(상점당 6테이블)로
 * 환산하면 11상점이기 때문이다.
 */
const STORE_COUNT = Number(process.env.LOAD_STORES ?? 12);

/**
 * 시드가 미리 여는 테이블 수. 나머지는 램프가 상점 콘솔 경로
 * (`POST /store/sessions/:id/tables`)로 실행 중에 연다 — 그것도 부하다.
 */
const INITIAL_TABLES = Number(process.env.LOAD_TABLES ?? 1);

/**
 * 미리 만들어 두는 계정 풀. **여기가 앞선 판단을 한 번 뒤집은 자리다.**
 *
 * 처음에는 계정을 하나도 만들지 않고 k6가 실행 중에 전부 가입시켰다. bcrypt가
 * 측정 밖으로 사라지면 안 된다는 이유였는데, **반쪽만 맞았다.**
 *
 * | | 실제로 언제 | 측정 안에 있어야 하나 |
 * |---|---|---|
 * | `hash` (가입) | 몇 주 전, 흩어져서 | 아니다 — 소수 비율만 |
 * | `compare` (로그인) | 대회 직전, 몰려서 | **그렇다** — 이것이 문 앞의 부하 |
 *
 * 실제 홀덤펍에서 대회 직전에 몰리는 것은 로그인이다. 손님 대부분은 계정이
 * 이미 있고, 회원가입은 첫 방문자 소수뿐이다. 사람마다 가입과 로그인을 둘 다
 * 태우면 bcrypt가 실제의 두 배로 잡혀 정원이 낮게 나온다.
 *
 * 그래서 계정은 시드가 미리 만들고(해시를 한 번 계산해 복사하므로 비용이
 * 거의 없다) 램프는 **로그인만** 탄다. 신규 가입은 봇이 10%쯤만 실행 중에
 * 한다(`LOAD_NEW_USER_RATIO`).
 *
 * 닉네임은 `p0000` 형식이다 — 3~10자 제한(`CreateUserDto`) 안에 들어가고
 * 봇이 인덱스만으로 만들 수 있어야 한다.
 */
const ACCOUNT_POOL = Number(process.env.LOAD_ACCOUNT_POOL ?? 600);
const ACCOUNT_PREFIX = 'p';

/**
 * 풀 계정의 초기 포인트. 참가와 리바인이 전부 이 잔고에서 나간다.
 *
 * 참가비가 `ENTRY_FEE_MIN`(1)이라 게이트 자체는 잔고를 거의 요구하지 않지만,
 * 램프가 한 계정으로 여러 대회에 들어가고 리바인도 여러 번 돈다 — 넉넉히
 * 줘서 부하 무대의 관심이 잔고가 아니라 처리량에 머물게 한다.
 */
const BOT_POINTS = 100_000_000;

/**
 * k6가 읽는 매니페스트.
 *
 * 데모 시드는 리포 루트에 떨어뜨리는데 이건 `load/` 안이다. **k6 컨테이너가
 * `../load`만 마운트하기 때문**이다 — 루트에 두면 컨테이너 안에서 보이지
 * 않는다. 마운트를 늘리는 대신 파일을 옮겼다.
 *
 * 경로를 `__dirname` 기준으로 잡는 이유는 컨테이너의 작업 디렉터리가
 * `/app/backend`라서다.
 */
const MANIFEST_PATH = resolve(__dirname, '../../load/.load-seed.json');

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

    // 풀 계정. `createMany`로 한 번에 넣는다 — 해시가 전부 같은 값이라
    // bcrypt는 위에서 이미 한 번만 돌았다. 대회를 가리지 않는 공용 풀이다.
    if (ACCOUNT_POOL > 0) {
      await prisma.user.createMany({
        data: Array.from({ length: ACCOUNT_POOL }, (_, i) => ({
          nickname: `${ACCOUNT_PREFIX}${String(i).padStart(4, '0')}`,
          password,
          role: Role.USER,
          // 참가와 리바인이 전부 이 잔고에서 나간다. 근거는 위 `BOT_POINTS` 주석.
          points: BOT_POINTS,
        })),
      });
    }

    // 상점 하나 = 대회 하나. 브로드캐스트가 대회 경계를 넘지 않으므로
    // (`ws.gateway.ts`의 Map이 tournamentId 키다) 부하의 단위도 대회다.
    // 상점을 따로 만드는 것은 "홀덤펍 몇 곳"이라는 질문의 모양을 지키기
    // 위해서고, 소유자는 하나라 램프가 토큰을 하나만 들면 된다.
    const tournaments: {
      id: string;
      storeId: string;
      tables: { id: string; tableOrder: number }[];
    }[] = [];

    for (let s = 0; s < STORE_COUNT; s++) {
      // `Store.name`은 `@@unique([ownerId, name])`다(상점 범위가 아니라 소유자
      // 범위). 이 시드는 상점을 전부 같은 `owner` 하나에 붙이므로 이름이
      // 겹치면 두 번째 상점부터 P2002다 — 인덱스를 상점 스코프로 좁힌
      // 마이그레이션(cf92f74) 뒤에도 여기서는 여전히 인덱스와 부딪힌다.
      const store = await prisma.store.create({
        data: { name: `${STORE_NAME} ${s + 1}`, ownerId: owner.id },
      });

      // `BlindStructure.name`은 `@@unique([storeId, name])`다(cf92f74로 전역
      // 유니크에서 상점 스코프로 좁혔다). 상점마다 `storeId`가 다르므로 이제는
      // 같은 이름을 여러 상점에서 그대로 써도 부딪히지 않는다 — 위 `Store`와
      // 달리 여기서는 상점별 접미사가 더 필요 없다.
      const blind = await prisma.blindStructure.create({
        data: {
          name: '부하 (한 레벨)',
          structure: BLIND_STRUCTURE,
          storeId: store.id,
        },
      });

      const tournament = await prisma.tournament.create({
        data: {
          name: `${TOURNAMENT_NAME} ${s + 1}`,
          status: TournamentStatus.PENDING,
          storeId: store.id,
          blindId: blind.id,
          // 0이 아니다 — 머리말 참고. 분모로 쓰이는 값이라 0이면
          // `recalculateAvgStack`이 NaN을 만든다.
          entryFee: ENTRY_FEE_MIN,
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

      tournaments.push({ id: tournament.id, storeId: store.id, tables });
    }

    const manifest = {
      ownerNickname: OWNER_NICKNAME,
      password: LOAD_PASSWORD,
      dealerOtp: DEALER_OTP,
      startStack: START_STACK,
      // 봇의 레이즈 단위. 블라인드 구조의 sb를 두 배 한 값이고, 레벨이
      // 하나뿐이라 실행 내내 고정이다.
      bigBlind: BLIND_STRUCTURE[0].sb * 2,
      accountPrefix: ACCOUNT_PREFIX,
      accountPool: ACCOUNT_POOL,
      tournaments,
    };
    mkdirSync(resolve(MANIFEST_PATH, '..'), { recursive: true });
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    console.log('부하 시드 완료');
    console.log(`  상점·대회  ${tournaments.length}개`);
    console.log(`  테이블     대회마다 ${INITIAL_TABLES}개 (나머지는 램프가 연다)`);
    console.log(`  계정 풀    ${ACCOUNT_POOL}개 (${ACCOUNT_PREFIX}0000 ~)`);
    console.log(`  딜러 OTP   ${DEALER_OTP}`);
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
