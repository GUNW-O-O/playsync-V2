# T37 정합성 부하 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 같은 자원을 동시에 노리는 요청 다발에서도 좌석·차례·팟이 하나로 정해지는 것을, 시나리오 계층의 불변식과 함께 회귀 테스트로 못 박는다.

**Architecture:** 기존 시나리오 하네스(`src/scenario/harness.ts`) 위에 스펙 파일 하나를 얹는다. `Promise.allSettled`로 같은 자원에 요청을 동시에 던지고, 성공 건수·거절 메시지·`checkInvariants`를 함께 본다. 새 인프라도 새 제품 코드도 없다 — 통합 테스트 컨테이너(5433/6380)를 그대로 쓴다.

**Tech Stack:** TypeScript, jest(`test/jest-int.json`), Prisma(드라이버 어댑터), ioredis, NestJS 예외 클래스

## Global Constraints

- 스펙 파일은 `*.int-spec.ts`로 끝나야 `test/jest-int.json`이 잡는다.
- `close()`를 부르지 못하고 죽는 경우를 대비해 `afterAll`에서 `forceClose()`를 부른다. 안 그러면 jest가 종료되지 않는다(Prisma 드라이버 어댑터가 pg Pool을 안 닫는다).
- 단언 값은 문자열로 감싼다. `expect('성공 1')` 형태라야 실패 메시지에 단계 이름이 남는다 — 시나리오 계층의 관행이다.
- 이 계층에는 스텁을 두지 않는다. 서비스는 전부 진짜다.
- **모든 태스크에서 RED를 실제로 본다.** 사후에 추가하는 검사이므로 처음부터 초록이다. 제품 코드를 지정된 방식으로 되돌려 빨간불을 확인한 뒤 복원한다. 되돌리지 않고 통과만 확인하면 그 테스트는 아무것도 증명하지 않는다.
- 실행 명령(컨테이너 재기동 없이):
  ```bash
  cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json \
    --testPathPatterns concurrent-burst
  ```
  첫 실행은 `KEEP_TEST_CONTAINERS` 없이 `npm run test:int -w backend`로 컨테이너를 띄운다.

## File Structure

- **Create:** `backend/src/scenario/concurrent-burst.int-spec.ts` — 이 계획이 만드는 유일한 파일. 네 개의 `it`이 각각 하나의 경합을 본다.
- **Modify:** 없음. 제품 코드는 건드리지 않는다(RED 확인 중의 임시 편집은 반드시 복원한다).
- **Read-only 참조:** `backend/src/scenario/harness.ts`(배선과 `checkInvariants`), `backend/src/entry/entry.service.ts`(거절 메시지), `backend/src/game-engine/table-engine.ts`(블라인드 계산)

`src/scenario/`에 두는 이유: 이 테스트가 보는 것이 부품이 아니라 조립이다 — 좌석 유니크 제약, 테이블 락, 스냅샷, 좌석 비트맵이 동시에 맞아야 통과한다.

---

### Task 1: 같은 좌석을 동시에 노리는 다섯

**Files:**
- Create: `backend/src/scenario/concurrent-burst.int-spec.ts`
- Test: 같은 파일

**Interfaces:**
- Consumes: `setupTournament(players, opts)`, `checkInvariants(h, label, expectedChips, tableId?)`, `forceClose()`, `SCENARIO`, `Harness` — 전부 `./harness`에서.
- Produces: 같은 파일 안의 헬퍼 둘. Task 2~4가 그대로 쓴다.
  - `payAll(h: Harness, ids: string[]): Promise<void>` — 유저를 만들고 참가비를 결제시킨다(착석은 하지 않는다)
  - `otpsOf(h: Harness, ids: string[]): Promise<string[]>` — 참가 OTP를 `ids` 순서대로 돌려준다

- [ ] **Step 1: 스펙 파일을 만들고 첫 테스트를 쓴다**

`backend/src/scenario/concurrent-burst.int-spec.ts`:

```ts
import { SCENARIO, checkInvariants, forceClose, setupTournament, Harness } from './harness';

/**
 * 동시 요청 폭탄.
 *
 * 시나리오 계층이 순서대로 검증하는 불변식을, 같은 자원을 동시에 노리는
 * 요청 다발 위에서 다시 본다. 여기서 보는 이음매는 **경합의 최종 판정자가
 * 누구인가**다 — 락인가, 유니크 제약인가, 아니면 아무도 아닌가.
 */
describe('시나리오: 동시 요청 폭탄', () => {
  let h: Harness;

  afterEach(async () => { await h.close(); });
  afterAll(async () => { await forceClose(); });

  /** 유저를 만들고 참가비만 낸다. 좌석은 각 테스트가 경합으로 정한다. */
  async function payAll(h: Harness, ids: string[]) {
    await h.prisma.user.createMany({
      data: ids.map(id => ({
        id, nickname: id, password: 'x', points: SCENARIO.initialPoints,
      })),
    });
    for (const id of ids) {
      await h.payment.joinSession({ tournamentId: h.tournamentId }, id);
    }
  }

  /** 참가 OTP. 실제로는 폰의 마이페이지가 하는 일을 DB 조회로 대신한다. */
  async function otpsOf(h: Harness, ids: string[]) {
    const rows = await Promise.all(ids.map(userId =>
      h.prisma.tournamentParticipation.findUniqueOrThrow({
        where: { tournamentId_userId: { tournamentId: h.tournamentId, userId } },
      }),
    ));
    return rows.map(r => r.playerOtp);
  }

  it('같은 좌석을 다섯이 동시에 노리면 한 명만 앉는다', async () => {
    h = await setupTournament(['p1', 'p2'], {});
    const burst = ['b1', 'b2', 'b3', 'b4', 'b5'];
    await payAll(h, burst);
    const otps = await otpsOf(h, burst);

    const results = await Promise.allSettled(
      otps.map(otp => h.entry.enterSeat(h.tournamentId, {
        otp, tableId: h.tableId, seatIndex: 5,
      })),
    );

    const ok = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    expect(`성공 ${ok.length}`).toBe('성공 1');
    expect(`실패 ${failed.length}`).toBe('실패 4');

    // 거절 사유가 "자리 싸움"으로 정확히 갈려야 한다. 이 메시지가 흐려지면
    // 딜러가 손님에게 무엇을 안내해야 하는지가 사라진다.
    for (const f of failed) {
      expect(`거절 ${(f.reason as Error).message}`)
        .toBe('거절 이미 다른 참가자가 앉은 좌석입니다.');
    }

    // 좌석 행은 하나. 비트맵과 스냅샷도 그 하나에만 동의해야 한다.
    const seatRows = await h.prisma.tablePlayer.count({
      where: { tableId: h.tableId, seatPosition: 5 },
    });
    expect(`좌석 행 ${seatRows}`).toBe('좌석 행 1');

    // 원래 둘 + 새로 앉은 하나.
    await checkInvariants(h, '좌석 폭탄 후', 3 * SCENARIO.startStack);
  });
});
```

- [ ] **Step 2: 컨테이너를 띄우고 돌린다**

Run: `npm run test:int -w backend -- --testPathPatterns concurrent-burst`
Expected: PASS (1 test). 사후 검사라 처음부터 초록인 것이 정상이다.

- [ ] **Step 3: 제품 코드를 되돌려 RED를 본다**

`backend/src/entry/entry.service.ts:229-231`의 좌석 싸움 분기를 잠시 지운다. 지금:

```ts
        if (violatedFields.some((field) => field.includes('seatPosition'))) {
          throw new ConflictException('이미 다른 참가자가 앉은 좌석입니다.');
        }
        throw new ConflictException('이미 다른 좌석에 앉아 있습니다. 상점에 문의해주세요.');
```

`if` 블록 세 줄을 지워 아래 한 줄만 남긴다:

```ts
        throw new ConflictException('이미 다른 좌석에 앉아 있습니다. 상점에 문의해주세요.');
```

- [ ] **Step 4: RED를 확인하고 expected/received를 그대로 기록한다**

Run:
```bash
cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json \
  --testPathPatterns concurrent-burst
```
Expected: FAIL. 실패한 단언은 거절 메시지 루프이고, 받은 값이
`거절 이미 다른 좌석에 앉아 있습니다. 상점에 문의해주세요.`,
기대한 값이 `거절 이미 다른 참가자가 앉은 좌석입니다.`다. 출력에 뜬 expected/received 두 줄을 보고서에 그대로 옮긴다.

- [ ] **Step 5: 제품 코드를 복원하고 다시 돌린다**

Run: `cd backend && git checkout -- src/entry/entry.service.ts && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json --testPathPatterns concurrent-burst`
Expected: PASS. `git status`가 `src/entry/entry.service.ts`를 수정으로 표시하지 않아야 한다.

- [ ] **Step 6: 커밋**

```bash
git add backend/src/scenario/concurrent-burst.int-spec.ts
git commit -m "test: 같은 좌석을 동시에 노리는 다섯 중 하나만 앉는다"
```

---

### Task 2: 같은 사람이 두 테이블에 동시에 앉으려 할 때

**Files:**
- Modify: `backend/src/scenario/concurrent-burst.int-spec.ts` (Task 1이 만든 `describe` 안에 `it` 추가)

**Interfaces:**
- Consumes: Task 1의 `payAll`, `otpsOf`. `h.session.createTable(tournamentId, ownerId)`는 새 `Table`의 행을 돌려준다(`table-move.int-spec.ts:23`의 용법과 같다 — `.id`로 테이블 id를 얻는다).
- Produces: 없음.

**왜 별도 태스크인가:** Task 1이 보는 판정자는 `@@unique([tableId, seatPosition])`이고, 여기서 보는 판정자는 `@@unique([tournamentId, userId])`다. 테이블마다 락이 따로라 락은 이 경합을 막지 못한다 — 제약만이 막는다. 리뷰어가 하나를 통과시키고 다른 하나를 반려할 수 있는 경계다.

- [ ] **Step 1: 테스트를 쓴다**

`concurrent-burst.int-spec.ts`의 첫 `it` 아래에 추가:

```ts
  it('한 사람이 두 테이블에 동시에 앉으려 하면 한 자리만 얻는다', async () => {
    h = await setupTournament(['p1', 'p2'], {});
    const table2 = await h.session.createTable(h.tournamentId, SCENARIO.owner);
    await payAll(h, ['b1']);
    const [otp] = await otpsOf(h, ['b1']);

    // 같은 OTP로 서로 다른 테이블을 동시에 노린다. 테이블마다 락이 따로라
    // 락은 이 둘을 서로 막지 못한다 — `@@unique([tournamentId, userId])`가
    // 유일한 판정자다(`entry.service.ts:72-77`의 주석이 말하는 바로 그 경합).
    const results = await Promise.allSettled([
      h.entry.enterSeat(h.tournamentId, { otp, tableId: h.tableId, seatIndex: 5 }),
      h.entry.enterSeat(h.tournamentId, { otp, tableId: table2.id, seatIndex: 0 }),
    ]);

    const ok = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    expect(`성공 ${ok.length}`).toBe('성공 1');
    expect(`실패 ${failed.length}`).toBe('실패 1');
    expect(`거절 ${(failed[0].reason as Error).message}`)
      .toBe('거절 이미 다른 좌석에 앉아 있습니다. 상점에 문의해주세요.');

    // 좌석 행은 대회 전체에서 하나.
    const rows = await h.prisma.tablePlayer.count({
      where: { tournamentId: h.tournamentId, userId: 'b1' },
    });
    expect(`b1 좌석 행 ${rows}`).toBe('b1 좌석 행 1');

    // 비트맵도 하나에만 동의한다. 어느 테이블이 이겼는지는 경합이 정하므로
    // 두 테이블의 켜진 비트를 합쳐서 본다 — 원래 둘 + b1 하나.
    const bitmaps = await h.redis.hgetall(`tournament:${h.tournamentId}:seat`);
    const bits = Object.values(bitmaps)
      .join('')
      .split('')
      .filter(c => c === '1').length;
    expect(`켜진 비트 ${bits}`).toBe('켜진 비트 3');
  });
```

`checkInvariants`를 부르지 않는 이유를 테스트 아래 주석 없이 두지 말고, 위 마지막 단언 바로 앞 주석에 담았다 — 어느 테이블이 이길지 경합이 정하므로 검사할 `tableId`와 기대 칩이 실행마다 달라진다. 대신 좌석 행 수와 비트맵 합이 같은 것을 증명한다.

- [ ] **Step 2: 돌린다**

Run:
```bash
cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json \
  --testPathPatterns concurrent-burst
```
Expected: PASS (2 tests).

- [ ] **Step 3: 제품 코드를 되돌려 RED를 본다**

`backend/src/entry/entry.service.ts:222`의 P2002 판정을 잠시 무력화한다. 지금:

```ts
        if (err.code !== 'P2002') throw e;
```

이렇게 바꾼다 — P2002를 삼키고 아무 일 없었다는 듯 진행시킨다:

```ts
        if (err.code !== 'P2002') throw e;
        return;
```

이러면 두 요청 모두 예외 없이 락 구간으로 들어가고, 각자 자기 테이블의 좌석 주인을 확인하므로 둘 다 통과해 스냅샷에 자신을 그린다. `TablePlayer` 행은 하나뿐인데 비트맵은 둘이 켜진다.

- [ ] **Step 4: RED를 확인하고 expected/received를 기록한다**

Run:
```bash
cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json \
  --testPathPatterns concurrent-burst
```
Expected: FAIL. `성공 2`가 `성공 1`이 아니어서 먼저 걸리고, 그 줄을 지나면 `켜진 비트 4`가 `켜진 비트 3`과 다르다. 출력의 expected/received를 그대로 보고서에 옮긴다.

- [ ] **Step 5: 복원하고 다시 돌린다**

Run: `cd backend && git checkout -- src/entry/entry.service.ts && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json --testPathPatterns concurrent-burst`
Expected: PASS (2 tests). `git status`에 `src/entry/entry.service.ts`가 없어야 한다.

- [ ] **Step 6: 커밋**

```bash
git add backend/src/scenario/concurrent-burst.int-spec.ts
git commit -m "test: 같은 사람이 두 테이블을 동시에 노려도 자리는 하나다"
```

---

### Task 3: 한 테이블에서 여섯이 동시에 액션

**Files:**
- Modify: `backend/src/scenario/concurrent-burst.int-spec.ts`

**Interfaces:**
- Consumes: `h.dealer.startPreFlop(tournamentId, tableId)`, `h.playsync.handleAction(userId, tableId, dto)` — `dto`는 `{ action: 'CALL' }` 형태(`ActionType`은 문자열 상수다).
- Produces: 없음.

**여기서 알아야 할 제품 동작:** 차례가 아닌 사람의 액션은 **예외가 아니라 무시**다. `table-engine.ts:31-32`가 `return this.state`로 조용히 돌아간다. 그래서 이 테스트는 거절 건수를 세지 않고 **상태가 정확히 한 번만 움직였는지**를 본다.

- [ ] **Step 1: 테스트를 쓴다**

```ts
  it('여섯이 동시에 액션을 밀어 넣어도 차례인 사람만 반영된다', async () => {
    const players = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    h = await setupTournament(players, {});
    const total = players.length * SCENARIO.startStack;

    await h.dealer.startPreFlop(h.tournamentId, h.tableId);
    const before = await checkInvariants(h, '프리플랍 시작', total);

    const turn = h.turnId(before)!;
    const turnSeat = h.seatOf(before, turn);
    // 차례인 사람이 콜하면 팟은 딱 이만큼 는다.
    const delta = before.currentBet - before.players[turnSeat]!.bet;
    // 차례가 아닌 사람들의 베팅액은 그대로여야 한다.
    const otherBets = players
      .filter(id => id !== turn)
      .map(id => `${id}:${before.players[h.seatOf(before, id)]!.bet}`)
      .join(',');

    // 전원이 동시에 CALL을 민다. 락이 없으면 여럿이 같은 스냅샷을 읽고
    // 각자 쓴 것이 서로를 덮는다.
    await Promise.allSettled(
      players.map(id => h.playsync.handleAction(id, h.tableId, { action: 'CALL' })),
    );

    const after = await checkInvariants(h, '동시 액션 후', total);
    expect(`팟 ${after.pot}`).toBe(`팟 ${before.pot + delta}`);

    const afterOtherBets = players
      .filter(id => id !== turn)
      .map(id => `${id}:${after.players[h.seatOf(after, id)]!.bet}`)
      .join(',');
    expect(`차례 아닌 베팅 ${afterOtherBets}`).toBe(`차례 아닌 베팅 ${otherBets}`);
  });
```

- [ ] **Step 2: 돌린다**

Run:
```bash
cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json \
  --testPathPatterns concurrent-burst
```
Expected: PASS (3 tests).

- [ ] **Step 3: 락을 무력화해 RED를 본다**

`backend/src/playsync/playsync.service.ts:61`. 지금:

```ts
    return this.redis.withTableLock(tableId, async () => {
```

락 키를 호출마다 다르게 만들어 상호 배제를 없앤다:

```ts
    return this.redis.withTableLock(`${tableId}:${Math.random()}`, async () => {
```

키만 바꾸므로 스냅샷 읽기·쓰기 경로는 그대로다 — 사라지는 것은 직렬화뿐이다.

- [ ] **Step 4: RED를 확인하고 expected/received를 기록한다**

Run:
```bash
cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json \
  --testPathPatterns concurrent-burst
```
Expected: FAIL. 여섯이 같은 스냅샷을 읽고 각자 쓰므로 마지막 쓰기가 이깁니다 — `checkInvariants('동시 액션 후')`의 칩 총량이나 `팟` 단언 중 하나가 깨진다. 어느 쪽이 먼저 걸리는지는 실행마다 다를 수 있으므로, **실제로 뜬 단언의 expected/received를 그대로** 보고서에 옮긴다. 세 번 돌려 세 번 다 FAIL인지 확인한다 — 한 번이라도 초록이면 이 RED는 증거가 되지 못한다.

- [ ] **Step 5: 복원하고 다시 돌린다**

Run: `cd backend && git checkout -- src/playsync/playsync.service.ts && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json --testPathPatterns concurrent-burst`
Expected: PASS (3 tests).

- [ ] **Step 6: 커밋**

```bash
git add backend/src/scenario/concurrent-burst.int-spec.ts
git commit -m "test: 동시에 밀어 넣은 액션 중 차례인 것만 반영된다"
```

---

### Task 4: 딜러가 핸드 시작을 동시에 두 번

**Files:**
- Modify: `backend/src/scenario/concurrent-burst.int-spec.ts`

**Interfaces:**
- Consumes: `h.dealer.startPreFlop(tournamentId, tableId)`.
- Produces: 없음.

**왜 이것까지 보나:** 도메인상 딜러가 게임 진행의 트리거이고, 딜러 경로와 플레이어 경로가 같은 상태를 동시에 건드린다. 딜러 태블릿의 더블클릭은 실제로 일어나는 조작이다. 그리고 블라인드가 두 번 나가도 **칩 총량은 보존된다**(스택에서 팟으로 옮길 뿐) — 그래서 `checkInvariants`만으로는 잡히지 않고 팟 값을 직접 봐야 한다. 검사가 둘일 때 둘이 어긋나는 입력을 넣어야 각각이 증명된다는 규칙이 여기서 적용된다.

- [ ] **Step 1: 테스트를 쓴다**

```ts
  it('딜러가 핸드 시작을 동시에 두 번 눌러도 블라인드는 한 번만 나간다', async () => {
    const players = ['p1', 'p2', 'p3'];
    h = await setupTournament(players, {});
    const total = players.length * SCENARIO.startStack;

    const results = await Promise.allSettled([
      h.dealer.startPreFlop(h.tournamentId, h.tableId),
      h.dealer.startPreFlop(h.tournamentId, h.tableId),
    ]);

    const ok = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    expect(`성공 ${ok.length}`).toBe('성공 1');
    expect(`실패 ${failed.length}`).toBe('실패 1');
    expect(`거절 ${(failed[0].reason as Error).message}`)
      .toBe('거절 대기 상태가 아닙니다.');

    // 하네스 기본 블라인드는 sb=100, ante=false다. 엔진이 bb를 sb*2로 놓으므로
    // (`table-engine.ts:433,436`) 한 번 시작하면 팟은 정확히 300이다.
    // 두 번 나가면 600 — 칩 총량은 그대로라 이 단언만이 그것을 잡는다.
    const state = await checkInvariants(h, '중복 시작 후', total);
    expect(`팟 ${state.pot}`).toBe('팟 300');
  });
```

- [ ] **Step 2: 돌린다**

Run:
```bash
cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json \
  --testPathPatterns concurrent-burst
```
Expected: PASS (4 tests).

- [ ] **Step 3: 락을 무력화해 RED를 본다**

`backend/src/dealer/dealer.service.ts:185`. 지금:

```ts
    return this.redis.withTableLock(tableId, async () => {
```

바꾼다:

```ts
    return this.redis.withTableLock(`${tableId}:${Math.random()}`, async () => {
```

둘 다 `WAITING` 스냅샷을 읽으므로 `state.phase !== GamePhase.WAITING` 가드를 둘 다 통과하고, 블라인드가 두 번 나간다.

- [ ] **Step 4: RED를 확인하고 expected/received를 기록한다**

Run:
```bash
cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json \
  --testPathPatterns concurrent-burst
```
Expected: FAIL. `성공 2`가 `성공 1`과 다르고, 그 줄을 지나면 `팟 600`이 `팟 300`과 다르다. 뜬 expected/received를 그대로 옮긴다. 여기서도 세 번 돌려 세 번 다 FAIL인지 확인한다.

- [ ] **Step 5: 복원하고 전체 통합 스위트를 돌린다**

Run:
```bash
cd backend && git checkout -- src/dealer/dealer.service.ts
cd .. && npm run test:int
```
Expected: 기존 336건 + 새 4건 = 340건 통과. 숫자가 다르면 그대로 보고한다.

- [ ] **Step 6: 커밋**

```bash
git add backend/src/scenario/concurrent-burst.int-spec.ts
git commit -m "test: 딜러의 중복 시작에도 블라인드는 한 번만 나간다"
```

---

### Task 5: 기준선과 문서 갱신

**Files:**
- Modify: `CLAUDE.md`(베이스라인 숫자), `docs/tickets-next.md`(T37 절 추가), `docs/backlog.md`(부하테스트 항목)

**Interfaces:**
- Consumes: Task 4 Step 5가 출력한 실제 통합 테스트 건수.
- Produces: 없음.

**문서를 태스크로 세운 이유:** 이 리포는 판단의 기록이 결과물이다. 숫자와 근거가 코드와 같은 PR에 들어가지 않으면 다음 세션이 낡은 기준선을 믿는다.

- [ ] **Step 1: `CLAUDE.md`의 베이스라인 숫자를 실측으로 고친다**

`CLAUDE.md`의 "현재 기준선 (T36 완료 시점)" 블록에서 `통합          336  (27 suites)` 줄을 Task 4 Step 5가 실제로 출력한 값으로 바꾸고, 블록 제목을 `현재 기준선 (T37 완료 시점)`으로 바꾼다. **출력을 보지 않고 340을 적지 않는다.**

- [ ] **Step 2: `docs/tickets-next.md`에 T37 절을 쓴다**

파일 맨 아래 `## T22 — 제목` 템플릿 앞에 `## T37 — 정합성 부하` 절을 추가한다. 담을 것:

- 무엇을 보는가 — 네 경합과 각각의 판정자(좌석 유니크 제약 / 대회·유저 유니크 제약 / 테이블 락 / 테이블 락 + 페이즈 가드)
- 차례가 아닌 액션이 예외가 아니라 무시라는 것(`table-engine.ts:31`). 그래서 Task 3이 거절 건수가 아니라 상태 변화를 센다
- 딜러 중복 시작은 칩 총량이 보존돼 `checkInvariants`가 못 잡고 팟 값만이 잡는다는 것
- 네 태스크에서 각각 어떻게 RED를 만들었는지와, 실제로 뜬 expected/received

- [ ] **Step 3: `docs/backlog.md`에 부하테스트 항목을 세운다**

`## B10 — 감사 로그` 절 뒤, `## 아직 판단하지 않은 것` 앞에 `## B11 — 부하테스트` 절을 추가한다. 설계 문서
(`docs/superpowers/specs/2026-08-09-load-test-design.md`)를 가리키고, T37 완료 / T38~T40 미착수를 적는다. 설계 문서의 내용을 옮겨 적지 않는다 — 링크 하나와 상태 한 줄이다.

- [ ] **Step 4: 타입 체크와 전체 단위 테스트로 문서 편집이 아무것도 깨지 않았는지 확인한다**

Run: `npm run typecheck && npm run test`
Expected: 타입 에러 0, 단위 테스트 전부 통과.

- [ ] **Step 5: 커밋**

```bash
git add CLAUDE.md docs/tickets-next.md docs/backlog.md
git commit -m "docs: T37의 기준선과 판단 근거를 남긴다"
```

---

## 이 계획이 다루지 않는 것

- **T38~T40(수치 하네스).** 인프라(컨테이너·k6)도 산출물도 달라 별도 계획이다. 설계 문서의 티켓 표를 따른다.
- **동시 리바인·탈락.** 경합은 있지만 판정자가 위 넷과 같은 것(테이블 락)이라 새로 증명하는 것이 없다. 램프 실행(T40)에서 실제 부하로 지나간다.
- **발견된 병목의 수정.** `SEAT_LIST_UPDATED`의 O(테이블²), 소켓당 UTF-8 인코딩. 측정이 먼저다.
