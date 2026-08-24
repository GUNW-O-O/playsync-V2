import { PrismaPg } from '@prisma/adapter-pg';
import { PlayerStatus, Prisma, PrismaClient, Role, TournamentStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { writeFileSync } from 'fs';
import Redis from 'ioredis';
import { resolve } from 'path';
import { Pool } from 'pg';
import { generateDealerOtp, hashDealerOtp } from '../src/dealer/dealer-otp';
import { generatePlayerOtp } from '../src/payment/player-otp';
import { DEFAULT_PAYOUT_TABLE } from '../src/playsync/payout-table';
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

/* ────────────────────────── 정산 무대 ──────────────────────────
 *
 * **두 번째 대회를 같은 상점에 세운다.** 장면 1~5의 대회와 나누는 이유는
 * 규모가 다르기 때문이다 — 마무리(종료 · ICM · 중단)는 **파이널 테이블에
 * 도달해야** 문이 열리고, 그러려면 필드가 줄어드는 과정 자체가 필요하다.
 * 일곱 명짜리 무대에서는 첫 핸드가 곧 파이널 테이블이라 「줄어든다」가
 * 사라진다.
 *
 * 시드 파일을 나누지 않는다. 두 벌이 되면 어긋나고, 어긋난 것을 잡아 주는
 * 장치가 없다(`CLAUDE.md`). **무대가 둘이지 시드가 둘이 아니다.**
 *
 * 여기서도 앉히지 않는다. 35명을 미리 앉혀 두면 촬영이 「이미 앉아 있는
 * 사람들」에서 시작하는데, 그러면 좌석 비트맵도 스냅샷도 제품 경로가 아니라
 * 시드가 만든 것이 되어 **화면이 증명하는 것이 줄어든다.** 착석은 촬영이
 * 백스테이지 API로 한다(`frontend/e2e/fixtures/backstage.ts`).
 */
const SETTLEMENT_NAME = '정산 데모 토너먼트';

/**
 * 테이블 넷 · 딜러 화면 넷.
 *
 * `DealerSession`은 대회당 하나지만(스키마) 딜러 토큰은 **테이블마다** 다르다
 * (`loginDealer`가 `tableId`를 서명해 넣는다). 그래서 같은 딜러 OTP로 태블릿
 * 넷이 각자의 테이블에 붙고, 그중 하나가 남의 테이블을 조작할 수 없다는 것이
 * 화면에서 드러난다(T66).
 */
const SETTLEMENT_LAYOUT = [
  { tableOrder: 1, seats: 9 },
  { tableOrder: 2, seats: 9 },
  { tableOrder: 3, seats: 9 },
  { tableOrder: 4, seats: 8 },
];

/**
 * **35명이다. 36이 아니다.**
 *
 * 기본 분배표(`DEFAULT_PAYOUT_TABLE`)의 구간 경계가 25와 36에 있다. 36명으로
 * 시작하면 이미 경계 위에 앉아 있어서 리바인이 일어나도 상금권이 안 움직인다.
 * 35에서 출발해 **리바인 하나로 36을 넘기면** 전광판의 상금 목록이 다섯
 * 줄에서 여섯 줄로 그 자리에서 늘어난다.
 *
 * 그때 **사람 수는 35 그대로**다 — 그것이 「분모는 사람 수가 아니라 엔트리
 * 수다」의 증명이고(`payout-table.ts`), `itm-scaling.int-spec.ts`가 값으로
 * 보는 성질을 화면이 같이 본다.
 *
 * 이름이 `A1`~`D8`인 것은 **어느 테이블에서 왔는지가 병합 뒤에도 남아야**
 * 하기 때문이다. 파이널 테이블에 A와 C가 섞여 앉은 것이 좌석 카드만 보고
 * 읽힌다 — 장면 1~5가 역할 이름(`숏스택`·`딥스택`)으로 얻은 것과 같은 것을
 * 규모가 큰 쪽에서는 출신으로 얻는다.
 */
const SETTLEMENT_PLAYERS = SETTLEMENT_LAYOUT.flatMap(({ tableOrder, seats }) =>
  Array.from({ length: seats }, (_, seatIndex) => ({
    nickname: `${'ABCD'[tableOrder - 1]}${seatIndex + 1}`,
    tableOrder,
    seatIndex,
  })),
);

/**
 * 상점 몫 10%.
 *
 * 0으로 두면 `걷은 참가비 == 나간 상금`이라 등식의 항이 하나 줄어든다.
 * 붙여 두면 마무리 확인 대화의 마지막 줄이 실제로 **셋의 합**이 된다 —
 * 상금 + 환불 + 상점 몫.
 */
const SETTLEMENT_RAKE_PERCENT = 10;

/**
 * 정산 무대의 블라인드. **레벨 1의 길이가 촬영의 유일한 창이다.**
 *
 * 마감이 촬영 중간에 와야 한다. 앞뒤로 이유가 하나씩이다.
 *
 * **너무 이르면 안 된다.** 리바인은 등록이 열려 있는 동안에만 묻는다
 * (`rebuyUntil: 2` → `curLv < 2`). 그 리바인 하나가 엔트리를 36으로 올려
 * 상금권 인원을 다섯에서 여섯으로 늘리는데, 마감이 그 전에 오면 이 무대가
 * 보여주려던 장면 자체가 사라진다.
 *
 * **너무 늦어도 안 된다.** 파이널 테이블 판정이
 * `!isRegistrationOpen && tableCount === 1`이라(T77 · `isFinalTable`),
 * 마감 전에는 테이블을 하나로 합쳐도 ICM의 문이 열리지 않는다.
 *
 * 10분은 그 사이다. 실측(개발 서버 · `slowMo` 220ms)으로 리바인이 **+2분 10초**,
 * 네 테이블의 첫 판이 다 끝나는 것이 **+3분 30초**였다. 리바인까지 네 배 남짓
 * 여유가 있고, 남는 시간은 **기다린 구간이라 잘려 나간다**(`mark()` 경계).
 *
 * 더 줄이지 않는 이유는 실패의 값이 다르기 때문이다 — 마감이 일찍 오면 리바인을
 * 못 물어 **그 장면 자체가 사라지고 촬영을 다시 돌려야** 한다. 기다리는 것은
 * 시간만 든다.
 *
 * 마감에 발화하는 스케줄러는 없다. 레벨이 시각에서 파생되고 누군가 그 대회를
 * 읽을 때 게으르게 닫히는데(`registration-gate.ts`), 전광판이 계속 폴링하므로
 * 그 일을 전광판이 한다.
 *
 * 뒤 레벨은 길게 둔다. 촬영이 레벨 2 안에서 끝나야 **실행마다 같은 블라인드**로
 * 갈림목에 도착한다 — 레벨이 더 오르면 그만큼 걷힌 칩이 달라지고, ICM은 칩
 * 비율로 나누는 것이라 금액까지 갈린다.
 */
const SETTLEMENT_BLIND_STRUCTURE = [
  { lv: 1, sb: 100, ante: false, duration: 10 },
  { lv: 2, sb: 200, ante: false, duration: 90 },
  { lv: 3, sb: 400, ante: false, duration: 15 },
  { lv: 4, sb: 800, ante: false, duration: 15 },
  { lv: 5, sb: 1_500, ante: false, duration: 15 },
];

const SETTLEMENT_REBUY_UNTIL = 2;

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

    const settlement = await seedSettlementStage({ prisma, redis, store: store.id, password });

    const manifest = {
      seededAt: new Date().toISOString(),
      password: DEMO_PASSWORD,
      store: { id: store.id, name: STORE_NAME },
      settlement,
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

    report({
      tournament: tournament.id,
      store: store.id,
      dealerOtp,
      tables,
      players,
      settlement: {
        tournament: settlement.tournament.id,
        dealerOtp: settlement.dealerOtp,
        playerCount: settlement.players.length,
        tableCount: settlement.tables.length,
      },
    });
  } finally {
    await prisma.$disconnect();
    // 드라이버 어댑터 구성에서는 `$disconnect()`가 pg Pool을 닫지 않는다.
    // 닫지 않으면 프로세스가 끝나지 않는다.
    await pool.end();
    redis.disconnect();
  }
}

/**
 * 정산 무대를 세운다. **여기도 무대까지다** — 앉히지도, 시작하지도 않는다.
 *
 * 장면 1~5의 대회와 나란히 선다. 같은 상점 · 같은 계정 규칙 · 같은 「결제까지
 * 마친 상태」이고, 다른 것은 **규모와 분배표**뿐이다.
 *
 * 분배표를 손으로 적지 않고 `DEFAULT_PAYOUT_TABLE`을 그대로 쓴다. 촬영이
 * 보여줄 것이 「참가 규모가 상금권 인원을 정한다」인데, 그 표를 시드가 따로
 * 지어내면 화면에 뜬 숫자가 제품의 기본값이 아니라 촬영용 값이 된다.
 */
async function seedSettlementStage(ctx: {
  prisma: PrismaClient;
  redis: Redis;
  store: string;
  /** 이미 해시된 공용 비밀번호. 35번 다시 해시하면 시드가 눈에 띄게 느려진다. */
  password: string;
}) {
  const { prisma, redis, store, password } = ctx;

  const blind = await prisma.blindStructure.create({
    data: { name: '정산 데모 (짧은 구조)', structure: SETTLEMENT_BLIND_STRUCTURE, storeId: store },
  });

  const dealerOtp = generateDealerOtp();
  const tournament = await prisma.tournament.create({
    data: {
      name: SETTLEMENT_NAME,
      status: TournamentStatus.PENDING,
      storeId: store,
      blindId: blind.id,
      entryFee: ENTRY_FEE,
      startStack: START_STACK,
      rebuyUntil: SETTLEMENT_REBUY_UNTIL,
      rakePercent: SETTLEMENT_RAKE_PERCENT,
      // Prisma의 Json 입력 타입은 인덱스 시그니처를 요구한다. 표의 형태는
      // 이미 `PayoutTier[]`로 고정돼 있으니 여기서만 좁힌다 — 값을 손으로
      // 다시 적으면 화면에 뜨는 것이 제품의 기본표가 아니게 된다.
      payoutTable: DEFAULT_PAYOUT_TABLE as unknown as Prisma.InputJsonValue,
      dealerOtpHash: await hashDealerOtp(dealerOtp),
    },
  });

  const dealerSession = await prisma.dealerSession.create({
    data: { tournamentId: tournament.id },
  });

  const tables: { id: string; tableOrder: number }[] = [];
  for (const { tableOrder } of SETTLEMENT_LAYOUT) {
    const table = await prisma.table.create({
      data: { tableOrder, tournamentId: tournament.id, dealerId: dealerSession.id },
    });
    tables.push({ id: table.id, tableOrder });
    await setSeatBitmap(redis, tournament.id, table.id);
    await setEmptySnapshot(redis, tournament.id, table.id);
  }

  const players: { nickname: string; otp: string; tableOrder: number; seatIndex: number }[] = [];
  for (const { nickname, tableOrder, seatIndex } of SETTLEMENT_PLAYERS) {
    const user = await prisma.user.create({
      data: { nickname, password, role: Role.USER, points: INITIAL_POINTS },
    });
    const otp = generatePlayerOtp();
    // 결제 경로(`PaymentService.joinSession`)가 하는 셋을 그대로 한다.
    // 포인트 차감이 빠지면 「걷은 참가비 == 나간 상금 + 환불 + 상점 몫」의
    // 왼쪽 항이 시드부터 거짓이 된다.
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { points: { decrement: ENTRY_FEE } } });
      await tx.pointTransaction.create({
        data: {
          userId: user.id,
          amount: -ENTRY_FEE,
          type: 'BUY_IN',
          tournamentId: tournament.id,
          description: `${SETTLEMENT_NAME} 바이인`,
        },
      });
      await tx.tournamentParticipation.create({
        data: {
          userId: user.id,
          tournamentId: tournament.id,
          status: PlayerStatus.WAITING,
          currentStack: START_STACK,
          playerOtp: otp,
        },
      });
    });
    players.push({ nickname, otp, tableOrder, seatIndex });
  }

  await prisma.tournament.update({
    where: { id: tournament.id },
    data: {
      totalPlayers: players.length,
      // 위 대회와 같은 이유로 0이다 — `claimSeat`이 첫 착석에서 올린다.
      activePlayers: 0,
      totalBuyinAmount: ENTRY_FEE * players.length,
    },
  });

  return {
    tournament: {
      id: tournament.id,
      name: SETTLEMENT_NAME,
      entryFee: ENTRY_FEE,
      startStack: START_STACK,
      rebuyUntil: SETTLEMENT_REBUY_UNTIL,
      rakePercent: SETTLEMENT_RAKE_PERCENT,
      blindStructure: SETTLEMENT_BLIND_STRUCTURE,
    },
    dealerOtp,
    tables,
    players,
  };
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
  /** 정산 무대. 딜러 OTP는 해시로만 남으므로 **여기가 유일한 열람 경로다.** */
  settlement: { tournament: string; dealerOtp: string; playerCount: number; tableCount: number };
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
    '  정산 무대 (두 번째 대회 — 마무리 촬영용)',
    `    ${'대회'.padEnd(20)}${data.settlement.tournament}  (PENDING)`,
    `    ${'딜러 OTP'.padEnd(20)}${data.settlement.dealerOtp}  ← 테이블 ${data.settlement.tableCount}개 공용`,
    `    ${'참가자'.padEnd(20)}${data.settlement.playerCount}명 (A1~D8). 참가 OTP는 매니페스트에 있다`,
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
