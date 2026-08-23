import { PrismaPg } from '@prisma/adapter-pg';
import { PlayerStatus, PrismaClient, Role, TournamentStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { writeFileSync } from 'fs';
import Redis from 'ioredis';
import { resolve } from 'path';
import { Pool } from 'pg';
import { generateDealerOtp, hashDealerOtp } from '../src/dealer/dealer-otp';
import { generatePlayerOtp } from '../src/payment/player-otp';
import { resetAll, setEmptySnapshot, setSeatBitmap } from './seed-helpers';

/**
 * 데모용 시드.
 *
 * 목적은 **무대를 깔아 두는 것**이지 대회를 진행시키는 것이 아니다. 시드가
 * 끝난 시점의 상태는 "상점이 대회를 만들고 참가자 대부분이 결제까지 마친
 * 직후"이고, 그 다음부터는 전부 화면에서 사람이 한다 — 상점 콘솔에서 시작을
 * 누르고, 참가자가 태블릿에 OTP를 넣어 앉는다.
 *
 * 그래서 여기서 하지 않는 것이 셋 있다.
 *
 * - **좌석을 앉히지 않는다.** 착석은 `EntryService`가 OTP를 받는 순간의
 *   일이고(T28), 그게 데모가 보여줄 장면 자체다. `TablePlayer`를 미리 만들면
 *   그 장면이 사라진다.
 * - **대회를 시작하지 않는다.** `PENDING`으로 둔다. 시작은 `startSession`이
 *   버튼을 추첨하고 Redis에 스냅샷을 올리는 트랜잭션이라, 그 순서 자체가
 *   보여줄 것이다.
 * - **참가자 한 명은 결제도 시키지 않는다**(`demo` 계정). 폰 흐름(대회 검색
 *   → 상세 → 참가 → OTP 확인)을 처음부터 찍을 수 있어야 한다.
 *
 * **비밀은 stdout으로만 나간다.** 딜러 OTP는 해시로만 저장되므로 여기서
 * 출력하지 않으면 다시 볼 방법이 재발급뿐이다. 참가 OTP는 평문으로 남지만
 * (설계다 — 마이페이지가 다시 보여줘야 한다), 데모 진행자가 태블릿에 바로
 * 넣을 수 있도록 같이 찍는다.
 */

const STORE_NAME = '플레이싱크 강남점';

/**
 * 데모와 무관한 다른 상점들. **검색이 검색으로 보이려면 걸러낼 것이 있어야
 * 한다** — 상점이 하나뿐이면 검색어를 넣기 전과 후의 목록이 같아서, 화면만
 * 보고는 이 시스템이 상점 하나짜리인지 여럿을 나눠 담는지 알 수 없다.
 *
 * 대회는 만들지 않는다. 상점이 여럿이라는 사실만 필요하고, 빈 상점을 골랐을
 * 때 "이 상점에는 열린 대회가 없습니다"가 뜨는 것도 그 자체로 경계의 증거다.
 */
const OTHER_STORES = ['리버벳 홀덤 판교', '카드하우스 홍대', '올인클럽 부산서면'];
const TOURNAMENT_NAME = '데모 토너먼트';

const ENTRY_FEE = 50_000;
const START_STACK = 5_000;
const INITIAL_POINTS = 500_000;

/**
 * 결제까지 마친 참가자. 첫 사람(`숏스택`)은 폰 흐름을 찍기 위해 결제하지 않는다.
 *
 * **이름이 곧 그 사람이 데모에서 맡은 역할이다.**
 *
 * `player1`~`player7`은 펠트의 좌석 카드에서도, 콘솔의 좌석 도식에서도,
 * 딜러의 승자 결정 목록에서도 구분되지 않았다 — 촬영본을 보면 누가 올인했고
 * 누가 탈락했는지 따라갈 수가 없다. 사람 이름으로 바꿔 보니 구분은 되는데,
 * 이번에는 **누가 왜 거기 있는지**를 영상 밖에서 설명해야 했다.
 *
 * 역할로 부르면 그 설명이 화면 안에 들어온다. `숏스택`이 올인하고 `미드스택`이
 * 사이드팟 2층에서 지고 `딥스택`이 그 층을 먹는 것을, 캡션 없이 좌석 카드만
 * 보고 따라갈 수 있다.
 */
const PAID_PLAYERS = ['미드스택', '딥스택', '합석A', '합석B', '합석C', '대기1', '대기2'];
const UNPAID_PLAYER = '숏스택';

/**
 * 데모용으로 압축한 블라인드 구조.
 *
 * 운영 구조는 레벨당 15~20분이라 영상 안에서 블라인드가 한 번도 안 오른다.
 * 레벨업·휴식·등록 마감이 전부 시간 기반이라(`getCurrentBlindLevel`), 시간을
 * 줄이는 것 말고는 화면에 드러낼 방법이 없다.
 *
 * `lv: 99`가 휴식이다(`getCurrentBlindLevel`이 이 값으로 `isBreak`을 정한다).
 * **휴식을 리바인 종료 뒤에 놓았다.** 예전에는 그래야만 했다 — 마감 판정이
 * 휴식의 `lv`(99)를 그대로 비교해, 휴식이 중간에 끼면 그 순간 등록이 닫히고
 * 다시 열리지 않았다. 시드가 우회해야 한다는 것 자체가 결함이었고 T63이
 * 고쳤다(`currentRegistrationLevel`이 휴식을 건너뛴다).
 *
 * 자리는 그대로 둔다. **강제가 아니라 선택이 됐을 뿐**이고, "리바인 마감 →
 * 휴식 → 후반부"는 실제 토너먼트 순서와도 맞는다.
 *
 * 휴식 자리가 곧 **테이블 합치기**를 시연하는 자리다. `releaseSeats`가
 * `GamePhase.WAITING`을 요구하는데(T29) 휴식 중에는 `startPreFlop`이 이미
 * 거부하므로 테이블이 자연히 그 상태에 머문다.
 */
const BLIND_STRUCTURE = [
  { lv: 1, sb: 100, ante: false, duration: 3 },
  { lv: 2, sb: 200, ante: false, duration: 3 },
  { lv: 3, sb: 300, ante: false, duration: 3 },
  { lv: 99, sb: 300, ante: false, duration: 2 },
  { lv: 4, sb: 500, ante: false, duration: 3 },
  { lv: 5, sb: 800, ante: false, duration: 3 },
];

/** `curLv < rebuyUntil`이면 열림. lv 1~3 동안 리바인, 휴식부터 마감이다. */
const REBUY_UNTIL = 4;

const PRIZE_PAYOUTS = [
  { place: 1, percent: 50 },
  { place: 2, percent: 30 },
  { place: 3, percent: 20 },
];

/**
 * 테이블 둘로 연다. 하나로는 "몇 명 탈락한 뒤 한 테이블로 합친다"를 보여줄 수
 * 없다 — 그 흐름이 T27~T29가 실제로 만든 경로다(상점이 좌석을 해제하고,
 * 사람이 걸어가서 OTP를 다시 넣고, 상점이 빈 테이블을 닫는다).
 */
const TABLE_COUNT = 2;

const DEMO_PASSWORD = 'password123';

/**
 * 시드가 만든 것의 **기계가 읽는 사본**. 리포 루트에 떨어진다(`.gitignore`).
 *
 * stdout만으로는 촬영 스크립트가 대회를 가리킬 방법이 없다. id가 전부 cuid라
 * 사람이 옮겨 적어야 하고, 시드를 다시 돌릴 때마다 바뀐다. 그렇다고 id를
 * 고정값으로 박으면 이번엔 제품 코드가 만들어 내는 id와 다른 종류가 섞인다.
 *
 * 경로를 `__dirname` 기준으로 잡는 이유는 컨테이너의 작업 디렉터리가
 * `/app/backend`라서다. 바인드 마운트(`../:/app`)로 `/app`이 곧 리포 루트이므로,
 * 컨테이너로 돌리든 호스트로 돌리든 같은 파일 하나에 쓴다.
 */
const MANIFEST_PATH = resolve(__dirname, '../../.demo-seed.json');

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

    const password = await bcrypt.hash(DEMO_PASSWORD, 10);

    await prisma.user.create({
      data: { nickname: 'platform', password, role: Role.PLATFORM_ADMIN },
    });

    // 상점 계정은 가입 폼으로 만들어지지 않는다. `POST /auth/join`은 `USER`만
    // 만들고, SaaS라면 이 자리가 플랫폼의 온보딩이다. 그 화면은 범위 밖이라
    // (`docs/backlog.md`의 B5 절) 시드가 대신한다.
    const owner = await prisma.user.create({
      data: { nickname: 'owner', password, role: Role.STORE_ADMIN },
    });

    const store = await prisma.store.create({
      data: { name: STORE_NAME, ownerId: owner.id },
    });

    // 검색이 걸러낼 다른 상점들. 주인은 같아도 된다 — 화면이 보는 것은
    // 이름과 소속 대회뿐이다.
    for (const name of OTHER_STORES) {
      await prisma.store.create({ data: { name, ownerId: owner.id } });
    }

    const blind = await prisma.blindStructure.create({
      data: { name: '데모 (짧은 구조)', structure: BLIND_STRUCTURE, storeId: store.id },
    });

    const dealerOtp = generateDealerOtp();
    const tournament = await prisma.tournament.create({
      data: {
        name: TOURNAMENT_NAME,
        status: TournamentStatus.PENDING,
        storeId: store.id,
        blindId: blind.id,
        entryFee: ENTRY_FEE,
        startStack: START_STACK,
        rebuyUntil: REBUY_UNTIL,
        payoutTable: [{ minEntries: 0, payouts: PRIZE_PAYOUTS }],
        dealerOtpHash: await hashDealerOtp(dealerOtp),
      },
    });

    // `Table.dealerId`가 필수라 대회마다 딜러 세션이 하나 있어야 한다.
    const dealerSession = await prisma.dealerSession.create({
      data: { tournamentId: tournament.id },
    });

    const tables: { id: string; tableOrder: number }[] = [];
    for (let order = 1; order <= TABLE_COUNT; order++) {
      const table = await prisma.table.create({
        data: { tableOrder: order, tournamentId: tournament.id, dealerId: dealerSession.id },
      });
      tables.push({ id: table.id, tableOrder: table.tableOrder });

      // 좌석 비트맵을 여기서 세워야 한다. `UPDATE_SEAT_BIT`은 필드가 없으면
      // 아무것도 하지 않으므로(T25 — 지워진 테이블이 착석으로 되살아나는 것을
      // 막는다), 비트맵 없이 시작하면 사람이 앉아도 좌석 목록이 계속 비어
      // 있다. 정상 경로에서는 `createSession`·`createTable`이 같은 일을 한다.
      await setSeatBitmap(redis, tournament.id, table.id);
      // **T38의 불변식을 시드도 지킨다** — 테이블이 있으면 스냅샷이 있다.
      // 제품 경로에서는 `createTable`이 세우지만 여기는 그 경로를 타지 않는다.
      // 없으면 아무도 앉기 전에 딜러 화면이 500을 받는다.
      await setEmptySnapshot(redis, tournament.id, table.id);
    }

    const players: { nickname: string; otp: string }[] = [];
    for (const nickname of [...PAID_PLAYERS, UNPAID_PLAYER]) {
      const user = await prisma.user.create({
        data: { nickname, password, role: Role.USER, points: INITIAL_POINTS },
      });
      if (nickname === UNPAID_PLAYER) continue;

      const otp = generatePlayerOtp();
      // 결제 경로(`PaymentService.joinSession`)가 하는 것과 같은 세 가지를 한다 —
      // 포인트 차감, 거래 내역, 참가 행. 하나라도 빠지면 시나리오가 검사하는
      // 장부 불변식(참가 전후 포인트 총합 일치)이 시작부터 어긋난다.
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { points: { decrement: ENTRY_FEE } },
        });
        await tx.pointTransaction.create({
          data: {
            userId: user.id,
            amount: -ENTRY_FEE,
            type: 'BUY_IN',
            tournamentId: tournament.id,
            description: `${TOURNAMENT_NAME} 바이인`,
          },
        });
        await tx.tournamentParticipation.create({
          data: {
            userId: user.id,
            tournamentId: tournament.id,
            // 착석이 아니라 결제까지다. `PLAYING`으로 올리는 것은 입장의 몫이다.
            status: PlayerStatus.WAITING,
            currentStack: START_STACK,
            playerOtp: otp,
          },
        });
      });
      players.push({ nickname, otp });
    }

    await prisma.tournament.update({
      where: { id: tournament.id },
      data: {
        totalPlayers: players.length,
        // T55 이후 이 값은 **첫 착석만** 올린다(`EntryService.claimSeat`).
        // 참가자를 전원 WAITING으로 만들면서 여기에 인원을 써 넣으면, 그들이
        // OTP로 앉는 순간 두 배가 된다 — 첫 탈락이 "14위"가 되어 상금이 한 푼도
        // 안 나가고 대회를 닫을 수 없다. `seed-load.ts`는 이 필드를 건드리지 않는다.
        activePlayers: 0,
        totalBuyinAmount: ENTRY_FEE * players.length,
      },
    });

    const manifest = {
      seededAt: new Date().toISOString(),
      password: DEMO_PASSWORD,
      store: { id: store.id, name: STORE_NAME },
      tournament: {
        id: tournament.id,
        name: TOURNAMENT_NAME,
        entryFee: ENTRY_FEE,
        startStack: START_STACK,
        rebuyUntil: REBUY_UNTIL,
        blindStructure: BLIND_STRUCTURE,
      },
      dealerOtp,
      tables,
      players,
      unpaidPlayer: UNPAID_PLAYER,
    };
    writeManifest(manifest);

    report({ tournament: tournament.id, store: store.id, dealerOtp, tables, players });
  } finally {
    await prisma.$disconnect();
    // 드라이버 어댑터 구성에서는 `$disconnect()`가 pg Pool을 닫지 않는다.
    // 닫지 않으면 프로세스가 끝나지 않는다.
    await pool.end();
    redis.disconnect();
  }
}

/**
 * 시드는 **덮어쓰지 않고 지우고 다시 만든다.**
 *
 * 덮어쓰기로 만들면 유니크 제약(닉네임, 상점 이름, 블라인드 구조 이름)마다
 * upsert 분기가 생기고, 그러다 "이전 시드의 대회 하나가 남은 채로 새 대회가
 * 생긴" 상태가 조용히 만들어진다. 데모는 매번 같은 화면에서 시작해야 한다.
 *
 * Redis도 같이 지운다. DB만 지우면 지난 대회의 스냅샷과 좌석 비트맵이 남고,
 * 부팅 복구(`RecoveryService`)가 없는 대회의 상태를 들고 돌게 된다.
 */
function writeManifest(manifest: unknown) {
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function report(data: {
  tournament: string;
  store: string;
  dealerOtp: string;
  tables: { id: string; tableOrder: number }[];
  players: { nickname: string; otp: string }[];
}) {
  const lines = [
    '',
    '  시드 완료. 비밀번호는 전부 password123 이다.',
    '',
    `  상점 ${data.store}`,
    `  대회 ${data.tournament}  (PENDING — 상점 콘솔에서 시작을 누른다)`,
    `  딜러 OTP ${data.dealerOtp}  ← 해시로만 저장된다. 여기서만 볼 수 있다`,
    '',
    '  계정',
    `    ${'platform / owner'.padEnd(22)}플랫폼 관리자, 상점 관리자`,
    `    ${UNPAID_PLAYER.padEnd(22)}결제 전 — 폰 흐름(참가 → OTP 수령)을 여기서 찍는다`,
    '',
    '  테이블',
    ...data.tables.map((t) => `    ${String(t.tableOrder).padEnd(22)}${t.id}`),
    '',
    '  참가 OTP (태블릿 입장용)',
    ...data.players.map((p) => `    ${p.nickname.padEnd(22)}${p.otp}`),
    '',
    `  같은 내용이 ${MANIFEST_PATH} 에도 있다 (촬영 스크립트가 읽는다).`,
    '',
  ];
  console.log(lines.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
