# T25 — 테이블 생성을 상점 수동으로 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 좌석이 7개 차면 테이블이 자동 생성되는 경로를 제거하고, 상점이 콘솔에서 테이블을 추가·삭제하는 엔드포인트로 대체한다.

**Architecture:** `payment.service.ts`의 자동 생성 호출을 지우고, 이미 있는 `SessionService.createTable`을 소유권 검사가 붙은 상점 엔드포인트로 노출한다. 같은 자리에 삭제를 더한다. `Table`에 상태 컬럼은 만들지 않는다 — 딜러의 `startPreFlop`이 곧 진행 중이다.

**Tech Stack:** NestJS, Prisma 7.4 (드라이버 어댑터 구성), Redis(ioredis), Jest.

**설계 문서:** [`docs/superpowers/specs/2026-07-28-table-creation-design.md`](../specs/2026-07-28-table-creation-design.md)

## Global Constraints

- 루트에서 `npm run typecheck` 타입 에러 0건, `npm run test`·`npm run test:int` 전부 통과가 완료 조건이다.
- 현재 기준선: contract 44 / 백엔드 단위 140 / 프론트 52 / 통합 237 / 타입 에러 0.
- 통합 테스트는 `npm run test:int`가 컨테이너 기동부터 한다. 반복 실행은 `KEEP_TEST_CONTAINERS=1`.
- Prisma는 드라이버 어댑터 구성이라 `$disconnect()`가 pg Pool을 닫지 않는다. 테스트는 `closeTestPrisma()`를 쓴다.
- 버그 수정은 **실패하는 테스트를 먼저** 만들어 재현한 뒤 고친다. 새 테스트가 처음부터 통과하면 의심한다.
- 커밋 메시지·주석·문서는 한국어. 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **contract 패키지는 건드리지 않는다.** REST에 경계 규칙을 적용할지는 backlog가 B6로 미뤄놓은 결정이다.
- 브랜치는 `feat/t25-manual-table` (이미 생성됨, 스펙 커밋 `f1115a9`가 올라가 있다).

---

### Task 1: 자동 테이블 생성 제거

`payment.service.ts:167-174`가 "그 테이블의 점유 좌석이 **정확히** 7이면 생성"을 판정한다.
카운트 비교라 엣지 트리거고, 탈락으로 좌석이 비었다가(`playsync.service.ts:355`가 비트를 0으로
내린다) 리바인·늦은 등록으로 다시 차면 7을 다시 넘어 빈 테이블이 또 생긴다.

**Files:**
- Create: `backend/src/scenario/table-autocreate.int-spec.ts`
- Modify: `backend/src/payment/payment.service.ts:167-174`
- Modify: `backend/src/payment/payment.service.int-spec.ts:94`

**Interfaces:**
- Consumes: `setupTournament(players: string[], opts?): Promise<Harness>` — `backend/src/scenario/harness.ts:72`. 반환 객체에 `prisma: PrismaClient`, `tournamentId: string`, `close(): Promise<void>`가 있다.
- Produces: 없음. 이후 태스크는 `SessionService.createTable`이 **더 이상 `PaymentService`에서 불리지 않는다**는 사실에만 의존한다.

**시나리오 계층에 두는 이유:** 이 검증은 `buyIn`(착석)과 테이블 생성이라는 두 부품의
**이음매**다. `payment.service.int-spec.ts`는 prisma를 스텁으로 두고 Redis만 진짜라
`table` 행 수를 셀 수 없다. `harness.ts`는 스텁 없이 전부 진짜를 배선한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/src/scenario/table-autocreate.int-spec.ts`:

```ts
import { Harness, setupTournament } from './harness';

/**
 * 테이블은 착석으로 늘어나지 않는다.
 *
 * 예전에는 좌석 점유 수가 정확히 7이 되는 순간 `createTable`이 불렸다
 * (`payment.service.ts`의 `cnt === 7`). 카운트 비교라 엣지 트리거였고,
 * 탈락으로 좌석이 비었다가 리바인·늦은 등록으로 다시 차면 7을 다시 넘어
 * 빈 테이블이 계속 생겼다. `createTable`은 이미 빈 테이블이 있는지도 보지
 * 않았다.
 *
 * 테이블을 여는 것은 딜러를 배치하고 칩을 세팅하는 물리적 행위라 시스템이
 * 대신 결정할 근거가 없다. 이제 상점 콘솔이 만든다.
 */
describe('시나리오 — 테이블 자동 생성 제거', () => {
  let h: Harness;
  const PLAYERS = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'];

  beforeAll(async () => {
    h = await setupTournament(PLAYERS);
  });

  afterAll(async () => {
    await h.close();
  });

  it('일곱 명이 앉아도 테이블은 하나다', async () => {
    const count = await h.prisma.table.count({
      where: { tournamentId: h.tournamentId },
    });

    expect(`테이블 수 ${count}`).toBe('테이블 수 1');
  });
});
```

값을 문자열로 감싸는 것은 실패 메시지에 무엇이 틀렸는지 남기기 위한 시나리오 계층의 관행이다
(`CLAUDE.md`의 "실패 메시지에 단계 이름이 남게 값을 문자열로 감싼다").

- [ ] **Step 2: 빨간불을 확인한다**

```bash
KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- table-autocreate
```

Expected: FAIL — `Expected: "테이블 수 1"` / `Received: "테이블 수 2"`.

**빨개지지 않으면 멈춘다.** 일곱 번째 착석이 `cnt === 7`을 통과하지 못했다는 뜻이고,
그러면 이 태스크의 전제가 틀린 것이다. 원인을 먼저 밝힌다.

- [ ] **Step 3: 자동 생성 블록을 지운다**

`backend/src/payment/payment.service.ts` — `updateSeatBitmap` 호출 뒤 `getTournamentTables`
앞에 있는 블록을 제거한다. 지우기 전:

```ts
        const table = await this.redisService.updateSeatBitmap(dto.tournamentId, dto.tableId, dto.seatIndex, true);
        let cnt = 0;
        table.split('').forEach(idx => {
          if (idx === '1') cnt++;
        })
        if (cnt === 7) {
          await this.session.createTable(dto.tournamentId);
        }
        const tableStatus = await this.redisService.getTournamentTables(dto.tournamentId);
```

지운 뒤:

```ts
        // 좌석 비트맵 갱신은 남는다 — 좌석 목록과 전광판이 이 값을 읽는다.
        // 예전에는 여기서 점유 수가 7이면 테이블을 자동 생성했다. 카운트
        // 비교라 탈락으로 비었다가 다시 차면 7을 다시 넘어 빈 테이블이
        // 계속 생겼다. 테이블은 이제 상점이 만든다.
        await this.redisService.updateSeatBitmap(dto.tournamentId, dto.tableId, dto.seatIndex, true);
        const tableStatus = await this.redisService.getTournamentTables(dto.tournamentId);
```

`table` 지역 변수는 더 이상 쓰이지 않으므로 반환값을 받지 않는다.

`this.session`은 **제거하지 않는다** — `payment.service.ts:45`의 `getGameSession`이 계속 쓴다.

- [ ] **Step 4: 초록불을 확인한다**

```bash
KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- table-autocreate
```

Expected: PASS.

- [ ] **Step 5: 쓰이지 않게 된 스텁을 지운다**

`backend/src/payment/payment.service.int-spec.ts:94`:

```ts
    const session = { createTable: async () => ({}) } as unknown as SessionService;
```

를

```ts
    // 이 스위트가 부르는 경로는 SessionService를 쓰지 않는다. 예전에는
    // 착석이 createTable을 불러서 스텁이 필요했다.
    const session = {} as unknown as SessionService;
```

로 바꾼다.

- [ ] **Step 6: 전체 통합 스위트를 돌린다**

```bash
npm run test:int
```

Expected: 전부 통과. 스위트 수가 19 → 20, 테스트 수가 237 → 238이 된다.

시나리오 하네스는 `findFirstOrThrow`로 1번 테이블만 잡고 여섯 명 이하를 앉히므로
(`harness.ts:145-159`) 기존 시나리오는 영향받지 않는다.

- [ ] **Step 7: 커밋**

```bash
git add backend/src/scenario/table-autocreate.int-spec.ts backend/src/payment/payment.service.ts backend/src/payment/payment.service.int-spec.ts
git commit -m "$(cat <<'EOF'
fix: 좌석이 차면 테이블이 자동 생성되던 경로를 없앤다

판정이 "그 테이블의 점유 좌석이 정확히 7"이라 엣지 트리거였다. 탈락이
비트를 0으로 내리고 리바인·늦은 등록이 다시 1로 올리므로, 7 -> 6 -> 7이면
빈 테이블이 또 생겼다. createTable은 이미 빈 테이블이 있는지도 보지 않아
반복해서 쌓였다.

테이블을 여는 것은 딜러를 배치하고 칩을 세팅하는 물리적 행위다. 소리 없이
늘어난 테이블에 앉은 손님은 아무도 응대하지 못한다. 상점이 만든다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `createTable`의 경합과 단언을 고친다

`session.service.ts:208`이 `tournament.tables.length`를 트랜잭션 **밖에서** 읽고 안에서 쓴다.
동시에 두 번 불리면 같은 `tableOrder`가 나온다. 같은 함수의 `:214`는 `dealerSession!`
단언이라 딜러 세션이 없는 대회(`completeSession`이 닫으며 지운 경우)에 부르면 런타임에 터진다.

**Files:**
- Modify: `backend/prisma/schema.prisma` (`model Table`)
- Create: `backend/prisma/migrations/<timestamp>_add_table_order_unique/migration.sql` (Prisma가 생성)
- Modify: `backend/src/store/session/session.service.ts:202-220`
- Modify: `backend/src/store/session/session.service.int-spec.ts` (스위트 추가)

**Interfaces:**
- Consumes: Task 1이 남긴 상태 — `createTable(tournamentId: string)`은 이제 아무 데서도 불리지 않는다.
- Produces: `createTable(tournamentId: string): Promise<Table>` — 인자는 그대로고 반환이 생긴다(예전에는 아무것도 돌려주지 않았다). Task 3이 여기에 `ownerId`를 더한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/src/store/session/session.service.int-spec.ts` 파일 **끝에** 스위트를 더한다.
기존 스위트들과 같은 배선을 쓴다(`:193`의 `new SessionService(prismaService, redisService, otpAttempts)` 참고).

```ts
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
describe('SessionService.createTable — tableOrder 경합', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let sessionService: SessionService;
  let tournamentId: string;

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
    sessionService = new SessionService(prismaService, redisService, new OtpAttempts(redis));

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
        startStack: 30000,
        avgStack: 30000,
        entryFee: 10000,
        rebuyUntil: 5,
        isRegistrationOpen: true,
        itmCount: 1,
        prizePayouts: [{ place: 1, percent: 100 }],
      },
    });
    tournamentId = tournament.id;
    await prisma.dealerSession.create({ data: { tournamentId } });
    await prisma.table.create({
      data: { tableOrder: 1, tournamentId, dealerId: (await prisma.dealerSession.findFirstOrThrow({ where: { tournamentId } })).id },
    });
  });

  it('동시에 두 번 불려도 tableOrder가 겹치지 않는다', async () => {
    await Promise.allSettled([
      sessionService.createTable(tournamentId),
      sessionService.createTable(tournamentId),
    ]);

    const tables = await prisma.table.findMany({
      where: { tournamentId },
      select: { tableOrder: true },
    });
    const orders = tables.map((t) => t.tableOrder);

    expect(`중복 없는 번호 ${new Set(orders).size}개 / 전체 ${orders.length}개`)
      .toBe(`중복 없는 번호 ${orders.length}개 / 전체 ${orders.length}개`);
  });

  it('딜러 세션이 없으면 명시적으로 거부한다', async () => {
    await prisma.table.deleteMany({ where: { tournamentId } });
    await prisma.dealerSession.deleteMany({ where: { tournamentId } });

    await expect(sessionService.createTable(tournamentId)).rejects.toThrow(ConflictException);
  });
});
```

파일 상단 import에 `GameType`, `ConflictException`이 없으면 더한다.

- [ ] **Step 2: 빨간불을 확인한다**

```bash
KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- session.service
```

Expected:
- `딜러 세션이 없으면 명시적으로 거부한다` — FAIL. 지금은 `dealerSession!`이 `undefined`라
  `dealerId: undefined`로 들어가며 Prisma가 던지는 다른 예외가 나온다.
- `동시에 두 번 불려도 tableOrder가 겹치지 않는다` — FAIL (`중복 없는 번호 2개 / 전체 3개`
  vs `3개 / 3개`).

**동시성 테스트가 초록이면 두세 번 더 돌린다.** 두 트랜잭션이 우연히 직렬화되면
번호가 갈릴 수 있다. 세 번 돌려도 초록이면 아래로 제약 부재를 직접 확인한다 —
지금은 제약이 없으므로 이 삽입이 **성공해야** 한다(성공하면 RED가 성립한다).

```bash
KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- session.service -t "tableOrder"
```

그래도 판단이 서지 않으면, Step 3의 마이그레이션을 먼저 적용한 뒤 되돌려(`git stash`)
같은 테스트가 빨개지는지 본다. `CLAUDE.md`의 "사후에 추가한 검사는 제품 코드를 일부러
되돌려 빨간불을 확인한다"와 같은 절차다.

- [ ] **Step 3: 스키마에 유니크 제약을 더한다**

`backend/prisma/schema.prisma`의 `model Table`:

```prisma
model Table {
  id         String @id @default(uuid())
  tableOrder Int    @default(autoincrement())

  dealerId      String
  dealerSession DealerSession @relation(fields: [dealerId], references: [id])
  tournamentId  String
  tournament    Tournament    @relation(fields: [tournamentId], references: [id], onDelete: Cascade)

  tablePlayers TablePlayer[]

  @@unique([tournamentId, id])
  // 번호는 물리 테이블을 가리킨다. 겹치면 딜러와 전광판이 서로 다른 테이블을
  // 같은 번호로 부른다. 재시도 코드가 아니라 제약으로 막는다.
  @@unique([tournamentId, tableOrder])
}
```

마이그레이션을 만든다. 개발용 인프라가 떠 있어야 한다:

```bash
cd backend && docker-compose up -d
npx prisma migrate dev --name add_table_order_unique --schema prisma/schema.prisma
```

- [ ] **Step 4: `createTable`을 고친다**

`backend/src/store/session/session.service.ts:202-220`을 통째로 바꾼다.

```ts
  /**
   * 테이블을 하나 더 연다.
   *
   * `tableOrder`를 트랜잭션 **안에서** 센다. 밖에서 세면 동시 호출이 같은
   * 번호를 읽고 둘 다 그 번호로 넣는다. 안에서 세도 Read Committed에서는
   * 같은 값을 볼 수 있으므로, 최종 방어는 `@@unique([tournamentId, tableOrder])`다
   * — 뒤늦은 쪽이 P2002로 거부된다.
   *
   * 딜러 세션은 `!`로 단언하지 않는다. `completeSession`이 대회를 닫으며
   * 딜러 세션과 테이블을 함께 지우므로, 닫힌 대회에 이 함수를 부르면 실제로
   * 없다.
   */
  async createTable(tournamentId: string) {
    const tournament = await this.prismaService.tournament.findUnique({
      where: { id: tournamentId },
      include: { dealerSession: true },
    });
    if (!tournament) throw new NotFoundException('세션을 찾을 수 없습니다.');
    if (!tournament.dealerSession) {
      throw new ConflictException('딜러 세션이 없는 대회에는 테이블을 추가할 수 없습니다.');
    }
    const dealerId = tournament.dealerSession.id;

    const newTable = await this.insertTable(tournamentId, dealerId);

    await this.redis.setSeatBitmap(tournamentId, newTable.id);
    return newTable;
  }

  /**
   * 번호를 세고 행을 넣는다.
   *
   * Read Committed에서는 동시 트랜잭션이 같은 count를 볼 수 있으므로,
   * `@@unique([tournamentId, tableOrder])`가 뒤늦은 쪽을 P2002로 거부한다.
   * 그대로 두면 500이 나가므로 409로 바꾼다 — 다시 누르면 되는 상황이고,
   * 서버 오류가 아니다.
   */
  private async insertTable(tournamentId: string, dealerId: string) {
    try {
      return await this.prismaService.$transaction(async (tx) => {
        const tableCount = await tx.table.count({ where: { tournamentId } });
        return await tx.table.create({
          data: { tableOrder: tableCount + 1, tournamentId, dealerId },
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('테이블 추가가 동시에 요청되었습니다. 다시 시도해 주세요.');
      }
      throw e;
    }
  }
```

`include: { tables: true }`가 빠진 것에 유의한다 — 이제 트랜잭션 안에서 센다.
`Prisma`는 이미 `session.service.ts:9`에서 import되어 있다.

- [ ] **Step 5: 초록불을 확인한다**

```bash
KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- session.service
npm run test -w backend
```

Expected: 둘 다 PASS. 단위 스위트의 `createTable('없는-토너먼트')` 404 테스트
(`session.service.spec.ts:185`)가 계속 통과해야 한다 — 소유권 검사가 아직 없고
`findUnique`가 `null`이면 `NotFoundException`이라 동작이 같다.

- [ ] **Step 6: 커밋**

```bash
git add backend/prisma backend/src/store/session/session.service.ts backend/src/store/session/session.service.int-spec.ts
git commit -m "$(cat <<'EOF'
fix: 테이블 번호를 트랜잭션 안에서 세고 제약으로 겹침을 막는다

tables.length를 트랜잭션 밖에서 읽고 안에서 썼다. 동시에 두 번 불리면 같은
tableOrder가 두 개 생긴다. 번호는 물리 테이블을 가리키므로 겹치면 딜러와
전광판이 서로 다른 테이블을 같은 번호로 부른다.

@@unique([tournamentId, tableOrder])를 최종 방어로 둔다. 재시도 코드보다
구조가 낫다.

dealerSession의 non-null 단언도 지운다. completeSession이 대회를 닫으며
딜러 세션을 지우므로 실제로 없는 경우가 있다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `POST /store/sessions/:id/tables`

**Files:**
- Modify: `backend/src/store/session/session.service.ts` (`createTable` 시그니처)
- Modify: `backend/src/store/session/session.controller.ts`
- Modify: `backend/src/store/session/session.service.spec.ts` (`new SessionService(...)` 12곳 중 이 파일의 6곳)
- Modify: `backend/src/store/session/session.service.int-spec.ts`, `backend/src/dealer/dealer.int-spec.ts:61`, `backend/src/scenario/harness.ts:96`, `backend/src/scenario/full-flow.int-spec.ts:165`, `backend/src/scenario/full-tournament.int-spec.ts:153`
- Modify: `backend/src/store/session/session.controller.spec.ts`

**Interfaces:**
- Consumes: `createTable(tournamentId: string): Promise<Table>` (Task 2), `assertTournamentOwnership(tournamentId: string, ownerId: string): Promise<void>` (`session.service.ts:432`)
- Produces: `createTable(tournamentId: string, ownerId: string): Promise<Table>` — Task 4의 `deleteTable`이 같은 소유권 관행을 따른다.

**생성자가 하나 늘어난다.** `SEAT_LIST_UPDATED`를 내려면 `EventEmitter2`가 필요하다.
`EventEmitterModule.forRoot()`가 `app.module.ts:24`에 있어 전역이므로 주입만 하면 된다.
`new SessionService(...)` 호출부가 코드베이스에 12곳 있고 전부 넷째 인자를 받아야 한다 —
타입 체크가 전부 잡아준다.

- [ ] **Step 1: 실패하는 테스트를 쓴다 (권한)**

`backend/src/store/session/session.controller.spec.ts`의 `describe` 안에 스위트를 더한다.
기존 `contextFor` 헬퍼를 그대로 쓴다.

```ts
  describe('테이블 추가 (tables)', () => {
    const handler = SessionController.prototype.createTable;

    it('STORE_ADMIN은 통과한다', () => {
      expect(guard.canActivate(contextFor(handler, Role.STORE_ADMIN))).toBe(true);
    });

    it('PLATFORM_ADMIN은 거부된다', () => {
      expect(guard.canActivate(contextFor(handler, Role.PLATFORM_ADMIN))).toBe(false);
    });

    it('DEALER는 거부된다', () => {
      expect(guard.canActivate(contextFor(handler, Role.DEALER))).toBe(false);
    });
  });
```

- [ ] **Step 2: 실패하는 테스트를 쓴다 (소유권·상태)**

`backend/src/store/session/session.service.spec.ts` 파일 끝에 더한다.

```ts
/**
 * 테이블 추가는 남의 대회를 건드릴 수 없다.
 *
 * 소유권 검사를 컨트롤러가 아니라 서비스 메서드 첫 문장에 두는 이유는
 * assertTournamentOwnership의 주석에 있다 — 컨트롤러에만 있으면 서비스를
 * 직접 부르는 경로가 우회한다.
 */
describe('SessionService.createTable — 소유권과 상태', () => {
  const setup = (opts: {
    ownerId?: string;
    status?: TournamentStatus;
    hasDealerSession?: boolean;
  } = {}) => {
    const tournament = {
      id: 'tournament-1',
      status: opts.status ?? TournamentStatus.PENDING,
      store: { ownerId: opts.ownerId ?? 'owner-1' },
      dealerSession: opts.hasDealerSession === false ? null : { id: 'dealer-1' },
    };
    const tableCreate = jest.fn().mockResolvedValue({ id: 'table-2', tableOrder: 2 });
    const prisma = {
      tournament: { findUnique: jest.fn().mockResolvedValue(tournament) },
      $transaction: jest.fn((fn: (t: any) => unknown) =>
        fn({ table: { count: jest.fn().mockResolvedValue(1), create: tableCreate } }),
      ),
    };
    const redis = { setSeatBitmap: jest.fn().mockResolvedValue(undefined) };
    const emitter = { emit: jest.fn() };
    const service = new SessionService(
      prisma as any, redis as any, {} as any, emitter as any,
    );
    return { service, tableCreate, emitter };
  };

  it('남의 대회면 403이고 테이블을 만들지 않는다', async () => {
    const { service, tableCreate } = setup({ ownerId: 'someone-else' });

    await expect(service.createTable('tournament-1', 'owner-1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(tableCreate).not.toHaveBeenCalled();
  });

  it('FINISHED 대회면 409고 테이블을 만들지 않는다', async () => {
    const { service, tableCreate } = setup({ status: TournamentStatus.FINISHED });

    await expect(service.createTable('tournament-1', 'owner-1')).rejects.toThrow(
      ConflictException,
    );
    expect(tableCreate).not.toHaveBeenCalled();
  });

  it('딜러 세션이 없으면 409고 테이블을 만들지 않는다', async () => {
    const { service, tableCreate } = setup({ hasDealerSession: false });

    await expect(service.createTable('tournament-1', 'owner-1')).rejects.toThrow(
      ConflictException,
    );
    expect(tableCreate).not.toHaveBeenCalled();
  });

  it('성공하면 SEAT_LIST_UPDATED를 낸다', async () => {
    const { service, emitter } = setup();

    await service.createTable('tournament-1', 'owner-1');

    expect(emitter.emit).toHaveBeenCalledWith(
      'SEAT_LIST_UPDATED',
      expect.objectContaining({ tournamentId: 'tournament-1' }),
    );
  });
});
```

`ForbiddenException`이 이 파일 상단 import에 없으면 더한다.

`assertTournamentOwnership`은 `findUnique({ select: { store: { select: { ownerId: true } } } })`를
따로 부른다. 위 목의 `findUnique`가 어떤 인자로 불리든 같은 객체를 돌려주므로 두 호출 모두
만족한다.

- [ ] **Step 3: 빨간불을 확인한다**

```bash
npm run test -w backend -- session
```

Expected: 컨트롤러 스펙은 `SessionController.prototype.createTable`이 `undefined`라 실패하고,
서비스 스펙은 인자 개수·동작이 달라 실패한다.

- [ ] **Step 4: `SessionService`에 `EventEmitter2`를 주입한다**

`backend/src/store/session/session.service.ts` 상단 import에 더한다:

```ts
import { EventEmitter2 } from '@nestjs/event-emitter';
```

생성자:

```ts
  constructor(
    private prismaService: PrismaService,
    private redis: RedisService,
    private otpAttempts: OtpAttempts,
    private readonly eventEmitter: EventEmitter2,
  ) { };
```

- [ ] **Step 5: `createTable`에 소유권·상태·이벤트를 더한다**

Task 2가 만든 본문을 다음으로 바꾼다.

```ts
  /**
   * 테이블을 하나 더 연다. 상점 콘솔의 버튼이 여기로 온다.
   *
   * 예전에는 착석이 좌석 점유 수를 세어 자동으로 불렀다. 소리 없이 늘어난
   * 테이블에 앉은 손님은 아무도 응대하지 못한다 — 테이블을 여는 것은 딜러를
   * 배치하고 칩을 세팅하는 물리적 행위다.
   *
   * `tableOrder`를 트랜잭션 **안에서** 센다. 밖에서 세면 동시 호출이 같은
   * 번호를 읽는다. 최종 방어는 `@@unique([tournamentId, tableOrder])`다.
   */
  async createTable(tournamentId: string, ownerId: string) {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    const tournament = await this.prismaService.tournament.findUnique({
      where: { id: tournamentId },
      include: { dealerSession: true },
    });
    if (!tournament) throw new NotFoundException('세션을 찾을 수 없습니다.');
    // completeSession이 대회를 닫으며 테이블과 딜러 세션을 함께 지운다.
    // 여기서 만들면 죽은 대회에 테이블이 되살아난다.
    if (tournament.status === TournamentStatus.FINISHED) {
      throw new ConflictException('이미 종료된 대회입니다.');
    }
    if (!tournament.dealerSession) {
      throw new ConflictException('딜러 세션이 없는 대회에는 테이블을 추가할 수 없습니다.');
    }
    const dealerId = tournament.dealerSession.id;

    // Task 2가 만든 private 헬퍼. P2002를 409로 바꾼다.
    const newTable = await this.insertTable(tournamentId, dealerId);

    await this.redis.setSeatBitmap(tournamentId, newTable.id);
    await this.emitSeatList(tournamentId);

    return newTable;
  }

  /**
   * 좌석 목록 브로드캐스트.
   *
   * 예전에는 `createTable`이 착석 경로 안에서만 불려서, 바로 뒤의 `buyIn`이
   * 대신 이벤트를 냈다. 상점이 단독으로 부르면 아무도 내지 않아 전광판과
   * 좌석 목록이 새 테이블을 모른다.
   */
  private async emitSeatList(tournamentId: string) {
    const state = await this.redis.getTournamentTables(tournamentId);
    this.eventEmitter.emit('SEAT_LIST_UPDATED', { tournamentId, state });
  }
```

`TournamentStatus`는 이미 `session.service.ts:9`에서 import되어 있다.

- [ ] **Step 6: 컨트롤러에 라우트를 더한다**

`backend/src/store/session/session.controller.ts`의 `revokeDealerSession` 아래:

```ts
  // 테이블 추가/삭제도 남의 대회를 건드릴 수 없어야 한다. 소유권 확인은
  // 재발급/내보내기와 같은 자리 — 서비스 메서드 안이다. PLATFORM_ADMIN을
  // 빼는 이유도 같다: 운영 조작 경로에 우회 길을 늘리지 않는다.
  @Roles(Role.STORE_ADMIN)
  @Post(':id/tables')
  async createTable(@Req() req, @Param('id') tournamentId: string) {
    return await this.sessionService.createTable(tournamentId, req.user.userId);
  }
```

- [ ] **Step 7: `new SessionService(...)` 호출부 12곳을 고친다**

타입 체크로 전부 찾는다:

```bash
npm run typecheck
```

통합·시나리오 쪽(`session.service.int-spec.ts:46, 193`, `dealer.int-spec.ts:61`,
`harness.ts:96`, `full-flow.int-spec.ts:165`, `full-tournament.int-spec.ts:153`)은
넷째 인자로 그 파일이 이미 만들어 둔 `emitter`를 넘긴다. 없으면 `new EventEmitter2()`를
만든다(`harness.ts:92`가 이미 그렇게 한다).

단위 스펙(`session.service.spec.ts:54, 179, 239, 294, 356, 470`)은 그 스위트가 이벤트를
보지 않으므로 `{ emit: jest.fn() } as any`를 넘긴다. `{} as any`는 쓰지 않는다 — 나중에
그 경로가 이벤트를 내게 되면 `emit is not a function`으로 죽는다.

- [ ] **Step 8: 초록불을 확인한다**

```bash
npm run typecheck
npm run test
KEEP_TEST_CONTAINERS=1 npm run test:int
```

Expected: 타입 에러 0, 전부 통과.

- [ ] **Step 9: 커밋**

```bash
git add backend/src
git commit -m "$(cat <<'EOF'
feat: 상점이 POST /store/sessions/:id/tables로 테이블을 연다

소유권 검사를 서비스 메서드 첫 문장에 둔다. 컨트롤러에만 있으면 서비스를
직접 부르는 경로가 우회한다 — assertTournamentOwnership의 주석과 같은 근거다.
PLATFORM_ADMIN을 빼는 것도 재발급/내보내기와 같다.

FINISHED 대회는 거부한다. completeSession이 닫으며 테이블과 딜러 세션을
지우므로, 여기서 만들면 죽은 대회에 테이블이 되살아난다.

SEAT_LIST_UPDATED를 여기서 낸다. 예전에는 착석 경로 안에서만 불려서 바로
뒤의 buyIn이 대신 냈다. 상점이 단독으로 부르면 아무도 내지 않아 전광판이
새 테이블을 모른다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `DELETE /store/sessions/:id/tables/:tableId`

추가를 사람 손으로 옮기면 실수도 사람 손에서 나온다. 잘못 만든 빈 테이블이 좌석 선택
화면에 계속 떠서 사람을 흩는다. 취소가 없는 추가 버튼은 운영자가 누르기를 두려워한다.

**Files:**
- Modify: `backend/src/redis/redis.service.ts` (`setSeatBitmap` 아래)
- Modify: `backend/src/store/session/session.service.ts`
- Modify: `backend/src/store/session/session.controller.ts`
- Modify: `backend/src/store/session/session.service.int-spec.ts`
- Modify: `backend/src/store/session/session.controller.spec.ts`

**Interfaces:**
- Consumes: `assertTournamentOwnership`, `emitSeatList` (Task 3)
- Produces: `RedisService.removeSeatBitmap(tournamentId: string, tableId: string): Promise<void>`, `SessionService.deleteTable(tournamentId: string, tableId: string, ownerId: string): Promise<void>`

- [ ] **Step 1: 실패하는 테스트를 쓴다 (권한)**

`session.controller.spec.ts`에 Task 3과 같은 모양으로 더한다.

```ts
  describe('테이블 삭제 (tables/:tableId)', () => {
    const handler = SessionController.prototype.deleteTable;

    it('STORE_ADMIN은 통과한다', () => {
      expect(guard.canActivate(contextFor(handler, Role.STORE_ADMIN))).toBe(true);
    });

    it('PLATFORM_ADMIN은 거부된다', () => {
      expect(guard.canActivate(contextFor(handler, Role.PLATFORM_ADMIN))).toBe(false);
    });

    it('DEALER는 거부된다', () => {
      expect(guard.canActivate(contextFor(handler, Role.DEALER))).toBe(false);
    });
  });
```

- [ ] **Step 2: 실패하는 테스트를 쓴다 (동작)**

Task 2가 만든 `SessionService.createTable — tableOrder 경합` 스위트 아래에, 같은
`beforeEach` 배선을 쓰는 스위트를 더한다. 배선은 반복해서 적는다 — 태스크를 순서대로
읽지 않는 사람이 있다.

```ts
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
    const redisService = new RedisService(redis);
    sessionService = new SessionService(
      prismaService, redisService, new OtpAttempts(redis), new EventEmitter2(),
    );

    const owner = await prisma.user.create({
      data: { nickname: 'owner', password: 'x', role: 'STORE_ADMIN' },
    });
    ownerId = owner.id;
    const store = await prisma.store.create({
      data: { name: '테스트 상점', ownerId },
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
        startStack: 30000,
        avgStack: 30000,
        entryFee: 10000,
        rebuyUntil: 5,
        isRegistrationOpen: true,
        itmCount: 1,
        prizePayouts: [{ place: 1, percent: 100 }],
      },
    });
    tournamentId = tournament.id;
    const dealerSession = await prisma.dealerSession.create({ data: { tournamentId } });
    const table = await prisma.table.create({
      data: { tableOrder: 1, tournamentId, dealerId: dealerSession.id },
    });
    tableId = table.id;
    await redisService.setSeatBitmap(tournamentId, tableId);
  });

  it('빈 테이블은 DB 행과 Redis 필드가 함께 사라진다', async () => {
    await sessionService.deleteTable(tournamentId, tableId, ownerId);

    const row = await prisma.table.findUnique({ where: { id: tableId } });
    const seat = await redis.hget(`tournament:${tournamentId}:seat`, `table:${tableId}`);

    expect(`DB ${row === null ? '없음' : '있음'} / Redis ${seat === null ? '없음' : '있음'}`)
      .toBe('DB 없음 / Redis 없음');
  });

  it('좌석에 사람이 있으면 409고 아무것도 지워지지 않는다', async () => {
    const player = await prisma.user.create({
      data: { nickname: 'player', password: 'x' },
    });
    await prisma.tablePlayer.create({
      data: {
        tableId, userId: player.id, tournamentId,
        seatPosition: 0, currentStack: 30000, nickname: 'player',
      },
    });

    await expect(
      sessionService.deleteTable(tournamentId, tableId, ownerId),
    ).rejects.toThrow(ConflictException);

    const row = await prisma.table.findUnique({ where: { id: tableId } });
    const seat = await redis.hget(`tournament:${tournamentId}:seat`, `table:${tableId}`);

    expect(`DB ${row === null ? '없음' : '있음'} / Redis ${seat === null ? '없음' : '있음'}`)
      .toBe('DB 있음 / Redis 있음');
  });

  it('다른 대회의 테이블 id를 넘기면 404다', async () => {
    const other = await prisma.tournament.create({
      data: {
        name: '다른 대회',
        type: GameType.TOURNAMENT,
        storeId: (await prisma.store.findFirstOrThrow()).id,
        blindId: (await prisma.blindStructure.findFirstOrThrow()).id,
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
```

`EventEmitter2`, `NotFoundException`이 파일 상단 import에 없으면 더한다.

- [ ] **Step 3: 빨간불을 확인한다**

```bash
npm run test -w backend -- session.controller
KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- session.service
```

Expected: 둘 다 FAIL — `deleteTable`이 없다.

- [ ] **Step 4: `RedisService.removeSeatBitmap`을 더한다**

`backend/src/redis/redis.service.ts`의 `setSeatBitmap` 바로 아래:

```ts
  /**
   * 좌석 비트맵에서 테이블 하나를 지운다.
   *
   * 대회 종료는 `tournament:*:seat` 키를 통째로 지우지만, 테이블 삭제는
   * 필드 하나만 없애야 한다.
   */
  async removeSeatBitmap(tournamentId: string, tableId: string) {
    const key = `tournament:${tournamentId}:seat`;
    await this.redis.hdel(key, `table:${tableId}`);
  }
```

- [ ] **Step 5: `SessionService.deleteTable`을 더한다**

`createTable` 아래:

```ts
  /**
   * 잘못 연 테이블을 닫는다.
   *
   * **빈 테이블만** 지운다. `TablePlayer`는 `onDelete: Cascade`라 사람이 앉은
   * 테이블을 지우면 참가자 행이 조용히 함께 사라진다 — 참가비를 낸 사람이
   * 장부에서 없어지는 것이라 거부한다.
   *
   * `tableOrder`는 재정렬하지 않는다. 2번을 지우면 1, 3이 남는다. 번호는
   * 물리 테이블을 가리키므로, 재정렬하면 전광판과 딜러 화면이 부르는 번호가
   * 통째로 바뀌어 방 안의 테이블과 어긋난다.
   */
  async deleteTable(tournamentId: string, tableId: string, ownerId: string) {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    const table = await this.prismaService.table.findFirst({
      where: { id: tableId, tournamentId },
      include: { _count: { select: { tablePlayers: true } } },
    });
    if (!table) throw new NotFoundException('테이블을 찾을 수 없습니다.');
    if (table._count.tablePlayers > 0) {
      throw new ConflictException('좌석에 참가자가 있는 테이블은 삭제할 수 없습니다.');
    }

    await this.prismaService.table.delete({ where: { id: tableId } });
    await this.redis.removeSeatBitmap(tournamentId, tableId);
    await this.emitSeatList(tournamentId);
  }
```

- [ ] **Step 6: 컨트롤러에 라우트를 더한다**

`session.controller.ts` — 상단 import에 `Delete`를 더한다.

```ts
import { Controller, Delete, Get, Post, Patch, Body, Param, Req, UseGuards } from '@nestjs/common';
```

`createTable` 아래:

```ts
  @Roles(Role.STORE_ADMIN)
  @Delete(':id/tables/:tableId')
  async deleteTable(
    @Req() req,
    @Param('id') tournamentId: string,
    @Param('tableId') tableId: string,
  ) {
    await this.sessionService.deleteTable(tournamentId, tableId, req.user.userId);
    return { ok: true };
  }
```

- [ ] **Step 7: 초록불을 확인한다**

```bash
npm run typecheck
npm run test
KEEP_TEST_CONTAINERS=1 npm run test:int
```

Expected: 타입 에러 0, 전부 통과.

- [ ] **Step 8: 커밋**

```bash
git add backend/src
git commit -m "$(cat <<'EOF'
feat: 상점이 잘못 연 빈 테이블을 닫을 수 있게 한다

추가를 사람 손으로 옮기면 실수도 사람 손에서 나온다. 취소가 없는 추가
버튼은 운영자가 누르기를 두려워한다.

빈 테이블만 지운다. TablePlayer가 onDelete: Cascade라 사람이 앉은 테이블을
지우면 참가비를 낸 사람이 장부에서 조용히 사라진다.

tableOrder는 재정렬하지 않는다. 번호는 물리 테이블을 가리키므로 재정렬하면
전광판과 딜러 화면이 부르는 번호가 방 안의 테이블과 어긋난다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 문서 갱신

**Files:**
- Modify: `docs/backlog.md`
- Modify: `docs/tickets-next.md`
- Modify: `CLAUDE.md` (기준선 숫자)

- [ ] **Step 1: 기준선 숫자를 실제 출력으로 확인한다**

```bash
npm run typecheck
npm run test
npm run test:int
```

세 명령의 출력에서 contract / 백엔드 단위 / 프론트 / 통합 수를 그대로 적는다.
**짐작해서 적지 않는다.**

- [ ] **Step 2: `CLAUDE.md`의 기준선 블록을 갱신한다**

"현재 기준선 (T24 완료 시점)"을 "(T25 완료 시점)"으로 바꾸고 숫자를 Step 1의 출력으로 채운다.

- [ ] **Step 3: `docs/tickets-next.md`에 T25를 적는다**

기존 T23·T24 항목과 같은 구조로 쓴다: 항목 / 범위 / 프론트 영향 / 문제 / 결정 /
버린 선택지 / RED 확인 방법 / 작업 중 추가로 나온 것 / 테스트 / 기준선.

버린 선택지로 반드시 남길 것:
- **테이블 상태 컬럼** — 딜러의 `startPreFlop`이 곧 진행 중이고, 별도 컬럼은 같은 사실의
  두 번째 기록이 되어 언젠가 어긋난다.
- **대기열** — 환불 경로가 없다. 참가비는 포인트 차감이 먼저 일어나므로 좌석을 나중에
  배정하면 실패 시 되돌릴 방법이 있어야 한다.
- **자동 생성을 멱등하게 고쳐 유지** — 조건을 "빈 좌석 있는 테이블이 없으면 만든다"로
  바꾸면 버그는 사라지지만, 딜러 없는 테이블이 소리 없이 생기는 문제는 남는다.
- **Redis 유실 지연 복구** — 브레인스토밍에서 한 번 채택했다가 뺐다. `createTable`의
  DB→Redis 순서 노출은 T25가 만드는 것이 아니라 `buyIn`·`startSession`과 같은 기존
  패턴이고, 빈 비트맵으로 채우는 반쪽 복구는 앉아 있던 사람이 사라진 화면을 만든다.
  B2에서 `buttonUser`·스냅샷과 함께 본다.

- [ ] **Step 4: `docs/backlog.md`를 갱신한다**

- B1 항목의 상태 줄에 T25가 닫은 것을 적는다.
- "T24가 남긴 이월 항목" 아래에 **T25가 남긴 이월 항목**을 더한다:
  - 상점 콘솔 화면이 없어 `POST/DELETE .../tables`에 호출자가 없다. T23의
    재발급·내보내기와 같은 상태다(B5 명세 → B7 구현).
  - 좌석 선택 화면의 "빈 자리 없음" 판정이 없다. 백엔드는 `getSeatStatus`가 비트맵을
    주는 것으로 끝났고, 화면이 그것을 읽어야 한다.
  - 더블클릭으로 빈 테이블이 둘 생기는 것은 막지 않는다. 콘솔이 버튼을 비활성화하는
    문제고, 삭제가 있으므로 되돌릴 수 있다.
- B8(다중 테이블·밸런싱)에 인원 균형이 여기서 넘어왔음을 한 줄 적는다.

- [ ] **Step 5: 커밋**

```bash
git add CLAUDE.md docs/backlog.md docs/tickets-next.md
git commit -m "$(cat <<'EOF'
docs: T25로 테이블 생성을 상점 수동으로 옮긴 기록을 남긴다

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## 완료 조건

```bash
npm run typecheck   # 타입 에러 0
npm run test        # contract + 백엔드 단위 + 프론트 단위
npm run test:int    # 통합
```

세 명령을 **실제로 실행하고 출력을 확인한 뒤에만** 완료를 주장한다.

PR 제목과 본문은 한국어로 쓴다.
