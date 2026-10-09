# T117 재기동 뒤 대회를 모든 기기가 돌아온 뒤에 연다 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `SYNCING`을 딜러뿐 아니라 좌석 기기까지 전부 돌아와야 풀고, 끝내 안 돌아오는 자리는 상점 콘솔이 「지금 진행」으로 푼다.

**Architecture:** 게이트웨이의 재집계(`WsGateway.recount`)가 테이블마다 「딜러 1 + 비트맵에 켜진 자리마다 좌석 1」을 센다. 좌석 소켓은 접속할 때 스냅샷에서 자기 자리 번호를 소켓에 적어 두고, 재집계는 비트맵 해시 하나만 읽는다. 재집계 요청은 대회별로 합친다(`SyncQueue`). 상점용 `GET/POST store/sessions/:id/sync(/force)`는 소켓 맵을 가진 `WsModule`의 컨트롤러가 든다.

**Tech Stack:** NestJS · ws · ioredis · Prisma · jest(백엔드) · zod(contract) · Next.js · vitest + testing-library(프론트)

**Spec:** `docs/superpowers/specs/2026-10-08-t117-sync-all-devices-design.md`

## Global Constraints

- 코드 주석 · 테스트 이름 · 사용자 문구는 한국어. 주석과 문서는 코드를 **이름으로** 가리킨다(줄 번호 금지).
- 하위 에이전트는 `docs/`와 `CLAUDE.md`를 건드리지 않는다. 주석은 코드라 같이 간다.
- contract: 아웃바운드 스키마는 zod 기본 스트립, 프론트는 contract 타입을 import한다(손으로 복사하지 않는다).
- 버그 수정 검사는 **고치기 전 코드에서 빨간불을 먼저 본다.** 사후에 추가한 검사는 제품 코드를 되돌려 빨간불을 확인한다.
- 통합 테스트는 `npm run test:int -w backend`(컨테이너 자동). 반복은 `KEEP_TEST_CONTAINERS=1`.
- 기존 재집계 체인의 성질(T96 리뷰 I1 — 앞선 `recount`가 `completeSync`를 커밋한 뒤에 다음 것이 다시 읽는다)을 깨지 않는다.
- 판을 여는 테이블별 `RESUME_TABLE`, `SYNCING` 중 딜러 명령 전부 거절, `pausedAt` ⇔ `SYNCING`은 그대로다.

## Review Focus

1. **비트맵에 없는 자리의 소켓** — 탈락 · 해제된 사람의 소켓이 열린 채 남아도 세지 않는다(Task 1 · Task 3에 검사).
2. **같은 자리에 소켓 둘**(옛 태블릿 + OTP로 다시 들어온 새 태블릿) — 한 번만 센다(Task 1 검사).
3. **SYNCING 중 좌석이 끊기면 present가 준다, 풀린 뒤 끊기면 다시 SYNCING이 되지 않는다**(Task 3 검사).
4. **강제 해제와 자연 완료가 겹친다** — `completeSync`가 한쪽만 이기게 하고, 진 쪽 강제는 409(Task 4 검사).
5. **재집계 1만 번** — 기다리는 재집계가 있으면 합쳐 한 번만 돈다(Task 2 검사가 횟수를 센다).

---

### Task 1: `syncProgress`가 딜러와 좌석 기기를 센다

**Files:**
- Modify: `backend/src/ws/sync-progress.ts`
- Test: `backend/src/ws/sync-progress.spec.ts` (전부 다시 쓴다)

**Interfaces:**
- Produces:
  ```ts
  export type RequiredTable = { tableId: string; seats: number[] };
  export type TablePresence = { dealer: boolean; seats: ReadonlySet<number> };
  export type MissingDevice = { tableId: string; seatIndex: number | null }; // null = 딜러
  export function syncProgress(
    required: RequiredTable[],
    presence: ReadonlyMap<string, TablePresence>,
  ): { present: number; required: number; done: boolean; missing: MissingDevice[] };
  ```

- [ ] **Step 1: 실패하는 검사를 쓴다** — `sync-progress.spec.ts`를 통째로 바꾼다.

```ts
import { syncProgress, TablePresence } from './sync-progress';

function at(dealer: boolean, seats: number[]): TablePresence {
  return { dealer, seats: new Set(seats) };
}

it('딜러와 좌석이 다 있으면 done', () => {
  const r = syncProgress(
    [{ tableId: 'a', seats: [0, 1] }],
    new Map([['a', at(true, [0, 1])]]),
  );
  expect(r).toEqual({ present: 3, required: 3, done: true, missing: [] });
});

/** T117. 딜러가 다 와도 좌석 하나가 없으면 아직이다 — 옛 판정은 여기서 done이었다. */
it('딜러가 다 와도 좌석 하나가 없으면 아직이다', () => {
  const r = syncProgress(
    [{ tableId: 'a', seats: [0, 1] }, { tableId: 'b', seats: [4] }],
    new Map([['a', at(true, [0])], ['b', at(true, [4])]]),
  );
  expect(r).toEqual({ present: 4, required: 5, done: false, missing: [{ tableId: 'a', seatIndex: 1 }] });
});

it('딜러가 없으면 딜러가 빠진 자리로 나온다', () => {
  const r = syncProgress([{ tableId: 'a', seats: [2] }], new Map([['a', at(false, [2])]]));
  expect(r).toEqual({ present: 1, required: 2, done: false, missing: [{ tableId: 'a', seatIndex: null }] });
});

/** **반대 입력.** 비트맵에 없는 자리(탈락 · 해제된 사람)의 소켓은 present를 부풀리지 않는다. */
it('필요 없는 자리의 소켓은 세지 않는다', () => {
  const r = syncProgress([{ tableId: 'a', seats: [0] }], new Map([['a', at(true, [0, 5, 7])]]));
  expect(r).toEqual({ present: 2, required: 2, done: true, missing: [] });
});

it('필요 없는 테이블의 소켓은 세지 않는다', () => {
  const r = syncProgress(
    [{ tableId: 'a', seats: [0] }],
    new Map([['a', at(false, [])], ['z', at(true, [0])]]),
  );
  expect(r.present).toBe(0);
  expect(r.done).toBe(false);
});

it('소켓이 하나도 없는 테이블은 전부 빠진 자리다', () => {
  const r = syncProgress([{ tableId: 'a', seats: [3] }], new Map());
  expect(r).toEqual({
    present: 0, required: 2, done: false,
    missing: [{ tableId: 'a', seatIndex: null }, { tableId: 'a', seatIndex: 3 }],
  });
});

it('앉은 테이블이 없으면 done', () => {
  expect(syncProgress([], new Map())).toEqual({ present: 0, required: 0, done: true, missing: [] });
});
```

`TablePresence.seats`가 집합이라 같은 자리의 소켓 둘은 호출자가 넣을 때 이미 하나다(Review Focus 2). Task 3의 `tablePresence`가 집합에 넣는다.

- [ ] **Step 2: 실패를 본다**

Run: `npx jest src/ws/sync-progress.spec.ts` (`backend`에서)
Expected: FAIL — 타입 에러(`TablePresence` 없음) 또는 기대값 불일치.

- [ ] **Step 3: 구현한다** — `sync-progress.ts`를 바꾼다.

```ts
/**
 * 재기동 뒤 기기 복귀 k/n(T96 · T117). 순수 함수 — 소켓도 Redis도 모른다.
 *
 * **필요한 기기는 앉은 사람이 있는 테이블마다 딜러 1 + 켜진 자리마다 좌석 1이다**(T117).
 * 딜러만 세던 동안 딜러가 좌석보다 먼저 돌아와 띠가 걷히고, 끊긴 태블릿의 파산자가
 * 리바인 시간초과로 탈락했다(1,000테이블 kill에서 111명).
 *
 * **present는 필요한 자리 안에서만 센다** — 빈 테이블의 딜러나 비트맵에서 빠진 자리의
 * 소켓이 k를 부풀리면 멈춘 자리가 남았는데 n/n이 된다.
 */
export type RequiredTable = { tableId: string; seats: number[] };
export type TablePresence = { dealer: boolean; seats: ReadonlySet<number> };
/** `seatIndex`가 `null`이면 그 테이블의 딜러다. */
export type MissingDevice = { tableId: string; seatIndex: number | null };

export function syncProgress(
  required: RequiredTable[],
  presence: ReadonlyMap<string, TablePresence>,
) {
  let present = 0;
  let total = 0;
  const missing: MissingDevice[] = [];
  for (const table of required) {
    const here = presence.get(table.tableId);
    total += 1 + table.seats.length;
    if (here?.dealer) present += 1;
    else missing.push({ tableId: table.tableId, seatIndex: null });
    for (const seat of table.seats) {
      if (here?.seats.has(seat)) present += 1;
      else missing.push({ tableId: table.tableId, seatIndex: seat });
    }
  }
  return { present, required: total, done: present === total, missing };
}
```

- [ ] **Step 4: 통과를 본다**

Run: `npx jest src/ws/sync-progress.spec.ts`
Expected: PASS 7. (`ws.gateway.ts`는 아직 옛 시그니처로 부르므로 `npm run typecheck`는 Task 3에서 맞춘다.)

- [ ] **Step 5: 커밋**

```bash
git add backend/src/ws/sync-progress.ts backend/src/ws/sync-progress.spec.ts
git commit -m "feat(T117): syncProgress가 딜러와 좌석 기기를 센다"
```

---

### Task 2: 재집계 요청을 대회별로 합친다 — `SyncQueue`

**Files:**
- Create: `backend/src/ws/sync-queue.ts`
- Test: `backend/src/ws/sync-queue.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export class SyncQueue<W> {
    constructor(
      recount: (key: string, joiners: W[]) => Promise<void>,
      onError: (e: unknown) => void,
    );
    /** 재집계를 줄 세운다. 아직 시작 안 한 재집계가 있으면 거기에 합친다. 거부되지 않는다. */
    recountLater(key: string, joiner?: W): Promise<void>;
    /** 다른 일을 같은 줄에 세운다. 합치지 않는다. 결과와 거부를 그대로 돌려준다. */
    enqueue<T>(key: string, task: () => Promise<T>): Promise<T>;
  }
  ```

- [ ] **Step 1: 실패하는 검사를 쓴다**

```ts
import { SyncQueue } from './sync-queue';

/** 테스트가 직접 여는 문. 열기 전까지 그 일은 끝나지 않는다. */
function gate() {
  let open: () => void = () => {};
  const shut = new Promise<void>((r) => { open = r; });
  return { shut, open };
}

describe('SyncQueue', () => {
  /** **몇 번 돌았나를 센다** — 값만 보면 「안 돌았다」와 「돌았는데 같다」를 못 가른다. */
  it('기다리는 재집계가 있으면 새로 세우지 않고 합친다', async () => {
    const calls: string[][] = [];
    const q = new SyncQueue<string>(async (_k, joiners) => { calls.push([...joiners]); }, () => {});
    const g = gate();
    const head = q.enqueue('t', () => g.shut);

    const waits = [q.recountLater('t', 'a'), q.recountLater('t'), q.recountLater('t', 'b')];
    g.open();
    await head;
    await Promise.all(waits);

    expect(calls).toEqual([['a', 'b']]);
  });

  it('달리는 중에 부르면 그 뒤에 한 번 더 돈다', async () => {
    const g = gate();
    let runs = 0;
    const q = new SyncQueue<string>(async () => { runs += 1; if (runs === 1) await g.shut; }, () => {});

    const first = q.recountLater('t');
    await new Promise((r) => setImmediate(r));
    const second = q.recountLater('t');
    g.open();
    await Promise.all([first, second]);

    expect(runs).toBe(2);
  });

  it('enqueue는 합치지 않고 순서대로 돈다', async () => {
    const order: string[] = [];
    const q = new SyncQueue<string>(async () => { order.push('recount'); }, () => {});
    await Promise.all([
      q.enqueue('t', async () => { order.push('force-1'); }),
      q.recountLater('t'),
      q.enqueue('t', async () => { order.push('force-2'); }),
    ]);
    expect(order).toEqual(['force-1', 'recount', 'force-2']);
  });

  it('대회가 다르면 서로 기다리지 않는다', async () => {
    const g = gate();
    const seen: string[] = [];
    const q = new SyncQueue<string>(async (k) => { seen.push(k); }, () => {});
    const blocked = q.enqueue('a', () => g.shut);
    await q.recountLater('b');
    expect(seen).toEqual(['b']);
    g.open();
    await blocked;
  });

  it('재집계가 던지면 onError로 보내고 줄은 계속 돈다', async () => {
    const errors: unknown[] = [];
    let runs = 0;
    const q = new SyncQueue<string>(async () => { runs += 1; if (runs === 1) throw new Error('boom'); }, (e) => errors.push(e));
    await q.recountLater('t');
    await q.recountLater('t');
    expect(`${runs} ${errors.length}`).toBe('2 1');
  });

  it('enqueue의 거부는 호출자에게 간다', async () => {
    const q = new SyncQueue<string>(async () => {}, () => {});
    await expect(q.enqueue('t', async () => { throw new Error('x'); })).rejects.toThrow('x');
    await q.recountLater('t'); // 줄이 끊기지 않았다
  });

  /** 안 지우면 맵이 대회 수만큼 서버 수명 내내 는다. */
  it('다 끝나면 맵을 비운다', async () => {
    const q = new SyncQueue<string>(async () => {}, () => {});
    await Promise.all([q.recountLater('t', 'a'), q.enqueue('t', async () => 1)]);
    await new Promise((r) => setImmediate(r));
    expect(`${(q as any).chains.size} ${(q as any).waiting.size}`).toBe('0 0');
  });
});
```

- [ ] **Step 2: 실패를 본다**

Run: `npx jest src/ws/sync-queue.spec.ts`
Expected: FAIL — `Cannot find module './sync-queue'`.

- [ ] **Step 3: 구현한다**

```ts
/**
 * 대회별 재집계 줄(T96 리뷰 I1 · T117). 순수하다 — 소켓도 Redis도 모른다.
 *
 * **줄을 세우는 이유**(T96 리뷰 I1): 끝난 판정의 `await completeSync` 창에서 새
 * 재집계가 아직 커밋 전인 `SYNCING`을 읽으면 `{syncing:false}` 뒤에 낡은
 * `{syncing:true}`를 보낸다. 줄을 세우면 뒤의 것은 앞의 것이 커밋한 뒤에 다시 읽는다.
 *
 * **합치는 이유**(T117): 좌석 소켓까지 재집계를 부르면 대회 하나(1,400테이블)에서
 * 재접속 1만여 번이 줄 1만여 개가 된다. 아직 시작 안 한 재집계는 어차피 그 차례의
 * 최신 상태를 읽으므로 하나로 충분하다. 「달리는 것 하나 + 기다리는 것 하나」라
 * 위 성질은 그대로다.
 *
 * 프로세스가 하나라(`backlog.md` B9) 메모리 줄로 충분하다.
 */
export class SyncQueue<W> {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly waiting = new Map<string, { joiners: W[]; done: Promise<void> }>();

  constructor(
    private readonly recount: (key: string, joiners: W[]) => Promise<void>,
    private readonly onError: (e: unknown) => void,
  ) {}

  recountLater(key: string, joiner?: W): Promise<void> {
    const pending = this.waiting.get(key);
    if (pending) {
      if (joiner !== undefined) pending.joiners.push(joiner);
      return pending.done;
    }
    const joiners: W[] = joiner === undefined ? [] : [joiner];
    const done = this.enqueue(key, () => {
      // 시작하는 순간 합치기를 닫는다 — 이 뒤에 온 요청은 이 재집계가 못 본
      // 변화를 들고 있을 수 있어 새로 줄을 선다.
      this.waiting.delete(key);
      return this.recount(key, joiners);
    }).catch((e) => this.onError(e));
    this.waiting.set(key, { joiners, done });
    return done;
  }

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(key) ?? Promise.resolve();
    const next = prior.then(task);
    const settled = next.then(() => undefined, () => undefined);
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return next;
  }
}
```

- [ ] **Step 4: 통과를 본다**

Run: `npx jest src/ws/sync-queue.spec.ts`
Expected: PASS 7.

- [ ] **Step 5: 되돌려 빨간불을 본다** — `recountLater`의 `if (pending) { ... return pending.done; }` 블록을 지우고 첫 검사가 `[['a'],[],['b']]`로 빨개지는 것을 본 뒤 되돌린다.

- [ ] **Step 6: 커밋**

```bash
git add backend/src/ws/sync-queue.ts backend/src/ws/sync-queue.spec.ts
git commit -m "feat(T117): 재집계 요청을 대회별로 합치는 SyncQueue"
```

---

### Task 3: 게이트웨이가 좌석 기기까지 세고 좌석 접속 · 끊김에 다시 센다

**Files:**
- Modify: `backend/src/ws/ws.gateway.ts` — `handleConnection` · `handleDisconnect` · `reportSync` · `recount` · `runDealerAction`의 SYNCING 거절 문구, `syncChains` 삭제
- Modify: `packages/contract/src/tournament-syncing.ts` — `TournamentSyncingSchema` 주석만(`present/required`가 기기 수)
- Test: `backend/src/ws/ws.gateway.int-spec.ts` — `describe('SYNCING (T96)')`

**Interfaces:**
- Consumes: Task 1의 `syncProgress` · `RequiredTable` · `TablePresence`, Task 2의 `SyncQueue`
- Produces (Task 4가 쓴다):
  ```ts
  // WsGateway 안
  private readonly syncQueue: SyncQueue<WebSocket>;
  private async measureSync(tournamentId: string): Promise<{
    seatMaps: { tableId: string; seatStatus: boolean[] }[];
    progress: ReturnType<typeof syncProgress>;
  }>;
  private sendSyncing(seatMaps: { tableId: string }[], payload: TournamentSyncing): void;
  ```
  좌석 소켓에 붙는 필드: `(client as any).seatIndex: number`, `(client as any).syncTournamentId: string`.

- [ ] **Step 1: 기존 SYNCING 검사를 기기 수로 맞추고 새 검사를 쓴다**

`describe('SYNCING (T96)')` 안, `lastSyncingPayload` 아래에 도우미를 둔다:

```ts
    /**
     * T117. `seedSeats`가 켠 자리(두 테이블의 0번)에 좌석 소켓을 붙인다 — 그 자리의
     * 주인은 최상위 `beforeEach`의 스냅샷에서 alice다. 필요한 기기는 테이블마다
     * 딜러 1 + 좌석 1이라 `seedSeats` 뒤에는 required가 4다.
     */
    async function connectSeats(tables: string[] = [TABLE, OTHER_TABLE]) {
      const clients = [];
      for (const t of tables) clients.push(await connect(await seatTicket('alice'), t));
      return clients;
    }
```

`seatTicket`은 `ensureParticipation`으로 `TOURNAMENT`를 `upsert`하는데, `seedSyncingTournament`가 먼저 만든 행은 `update: {}`라 상태가 그대로다 — **반드시 `seedSyncingTournament` 뒤에** 부른다.

기존 검사의 기대값을 이렇게 바꾼다(검사 이름 기준):

| 검사 | 바꿀 것 |
|---|---|
| 테이블 딜러가 접속하면 present 1/2를… | 이름 `present 1/4`, 기대 `{ syncing: true, present: 1, required: 4 }` |
| 나머지 딜러까지 접속하면 completeSync를… | 딜러보다 먼저 `await connectSeats();`, 기대 둘 다 `{ syncing: false, present: 4, required: 4 }`. 이름을 「좌석과 딜러가 다 붙으면…」으로 |
| completeSync가 false를 돌려주면… | 첫 딜러 전에 `await connectSeats();`, 마지막 기대 `{ syncing: true, present: 3, required: 4 }` |
| 진짜 RecoveryService로… (M4) | 두 딜러 `handleConnection` **앞에** `realGateway.handleConnection(makeClient(), makeRequest(\`tableId=${t}&ticket=${await seatTicket('alice')}\`, ORIGIN))`를 `TABLE`·`OTHER_TABLE` 각각 |
| SYNCING인 동안 딜러 명령을 거절한다 | 문구 `'모든 기기가 돌아올 때까지 기다려 주세요.'` |
| 좌석 소켓은 딜러 복귀로 세지 않는다 | **바꾼다**: 이름 「좌석 소켓은 자기 자리로 센다」, 기대 `{ syncing: true, present: 2, required: 4 }` (OTHER_TABLE의 alice 좌석 + TABLE 딜러) |
| 딜러 소켓이 끊기면… | 기대 `{ syncing: true, present: 1, required: 4 }` |
| 빈 테이블의 딜러도 required 밖에서… (m3) | 첫 기대 `{ syncing: true, present: 0, required: 2 }` (마지막 `{false,0,0}`은 그대로) |
| completeSync가 끝나기 전에 줄 선… (I1) | `tableDealer` 앞에 `await connectSeats();`, 기대 `{ syncing: false, present: 4, required: 4 }` |
| recovered 뒤 딜러가 이미 n/n이면… (T97) | 딜러 앞에 `await connectSeats();`, 기대 둘 다 `{ syncing: false, present: 4, required: 4 }` |
| recovering 동안 n/n이 채워져도… | 첫 딜러 앞에 `await connectSeats();`, 첫 기대 `{ syncing: true, present: 3, required: 4 }`, 뒤의 `present: 2, required: 2`는 `present: 4, required: 4` |

새 검사를 describe 끝에 더한다:

```ts
    /** T117. 옛 판정(딜러만)이면 여기서 completeSync가 불려 대회가 열렸다. */
    it('딜러가 다 와도 좌석 하나가 없으면 SYNCING에 머물고 딜러 명령을 거절한다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      await connectSeats([TABLE]);
      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);
      await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);

      expect(recovery.completeSync).not.toHaveBeenCalled();
      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: true, present: 3, required: 4 });
      const result = await gateway.handleDealerAction(tableDealer, { action: 'START_PRE_FLOP' });
      expect(result).toEqual({ event: 'error', data: '모든 기기가 돌아올 때까지 기다려 주세요.' });
    });

    it('마지막 좌석이 붙으면 completeSync를 부르고 딜러들이 syncing:false를 받는다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      await connectSeats([TABLE]);
      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);
      const otherDealer = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);

      await connectSeats([OTHER_TABLE]);

      expect(recovery.completeSync).toHaveBeenCalledWith(TOURNAMENT);
      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: false, present: 4, required: 4 });
      expect(lastSyncingPayload(otherDealer)).toEqual({ syncing: false, present: 4, required: 4 });
    });

    /** **반대 입력.** bob은 스냅샷 1번이지만 비트맵은 0번만 켰다 — 필요 없는 자리다. */
    it('비트맵에 없는 자리의 좌석 소켓은 세지 않는다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      await connect(await seatTicket('bob'), TABLE);
      await connect(await seatTicket('bob'), OTHER_TABLE);

      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);

      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: true, present: 1, required: 4 });
    });

    it('좌석 소켓이 끊기면 딜러가 줄어든 present를 받는다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      const [tableSeat] = await connectSeats([TABLE]);
      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);
      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: true, present: 2, required: 4 });

      await gateway.handleDisconnect(tableSeat);

      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: true, present: 1, required: 4 });
    });
```

- [ ] **Step 2: 실패를 본다**

Run: `KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json src/ws/ws.gateway.int-spec.ts -t "SYNCING"` (`backend`에서. 컨테이너가 없으면 먼저 `npm run test:int -w backend`를 한 번 돌려 띄운다)
Expected: FAIL — 새 검사 넷과 기대값을 바꾼 검사들(옛 코드는 딜러만 세고 좌석 접속에 재집계하지 않는다).

- [ ] **Step 3: 게이트웨이를 바꾼다**

import에 `import { SyncQueue } from './sync-queue';`, `syncProgress`와 함께 `RequiredTable, TablePresence`를 가져온다. `TournamentSyncing` 타입을 contract import에 더한다.

`syncChains` 필드와 그 주석을 지우고 그 자리에:

```ts
  /**
   * 대회별 재집계 줄(T96 리뷰 I1 · T117). 줄 세우기와 합치기의 이유는 `SyncQueue`에.
   */
  private readonly syncQueue = new SyncQueue<WebSocket>(
    (tournamentId, joiners) => this.recount(tournamentId, joiners),
    (e) => this.logger.error('SYNCING 재집계 실패', e),
  );
```

`reportSync`의 본문을 바꾼다(주석의 첫 문단은 남기고 체인 설명은 `SyncQueue`를 가리키게 줄인다):

```ts
  private reportSync(tournamentId: string, joiner?: WebSocket): Promise<void> {
    return this.syncQueue.recountLater(tournamentId, joiner);
  }
```

`recount(tournamentId, joiner?)`를 `recount(tournamentId: string, joiners: WebSocket[])`로 바꾸고, 비-SYNCING 분기의 joiner 송신을 `for (const joiner of joiners)` 루프로, 세는 부분을 `measureSync`로, 보내는 루프를 `sendSyncing`으로 뺀다:

```ts
  /**
   * 그 대회에 필요한 기기와 지금 붙은 기기(T117). 읽는 것은 비트맵 해시 하나다 —
   * 좌석 소켓의 자리 번호는 접속할 때 소켓에 적어 둔다(`handleConnection`).
   * 대회 하나에 1,400테이블이면 재집계마다 스냅샷을 읽을 수 없다.
   */
  private async measureSync(tournamentId: string) {
    const seatMaps = await this.redis.getTournamentTables(tournamentId);
    const required: RequiredTable[] = seatMaps
      .filter((m) => m.seatStatus.some(Boolean))
      .map((m) => ({ tableId: m.tableId, seats: m.seatStatus.flatMap((on, i) => (on ? [i] : [])) }));
    const presence = new Map(required.map((r) => [r.tableId, this.tablePresence(r.tableId)] as const));
    return { seatMaps, progress: syncProgress(required, presence) };
  }

  /** 그 테이블에 열린 딜러 소켓이 있나, 열린 좌석 소켓이 든 자리 번호들. */
  private tablePresence(tableId: string): TablePresence {
    let dealer = false;
    const seats = new Set<number>();
    for (const s of this.tableSessions.get(tableId) ?? []) {
      const socket = s as any;
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.role === Role.DEALER) dealer = true;
      else if (typeof socket.seatIndex === 'number') seats.add(socket.seatIndex);
    }
    return { dealer, seats };
  }

  /**
   * 이 대회의 테이블 전부(`seatMaps`)의 딜러에게 보낸다 — 세는 쪽(`required`)만 돌면 빈
   * 테이블에 붙은 딜러와 n=0으로 끝난 경우 아무도 못 받는다(최종 리뷰 I2 · Task 4 M2).
   */
  private sendSyncing(seatMaps: { tableId: string }[], payload: TournamentSyncing) {
    const data = TournamentSyncingSchema.parse(payload);
    for (const m of seatMaps) {
      for (const s of this.tableSessions.get(m.tableId) ?? []) {
        if ((s as any).role !== Role.DEALER || s.readyState !== WebSocket.OPEN) continue;
        try { s.send(JSON.stringify({ event: TOURNAMENT_SYNCING_EVENT, data })); } catch { /* 다음 틱이 치운다 */ }
      }
    }
  }
```

`recount`의 SYNCING 분기는:

```ts
    const { seatMaps, progress } = await this.measureSync(tournamentId);
    let syncing = true;
    if (progress.done) {
      // 진 쪽(동시 n/n)은 false다. 이긴 쪽이 알린다.
      if (!(await this.recovery.completeSync(tournamentId))) return;
      syncing = false;
    }
    this.sendSyncing(seatMaps, { syncing, present: progress.present, required: progress.required });
```

`handleConnection`의 테이블 분기에서 `const state = await this.redis.getSnapShot(tableId);` 바로 뒤에:

```ts
        // T117. 좌석 소켓은 자기 자리 번호를 들고 다닌다 — 재집계가 스냅샷을
        // 다시 읽지 않고 이 값으로 「그 자리가 돌아왔나」를 센다(`tablePresence`).
        if (payload.role !== Role.DEALER && state) {
          const seatIndex = state.players.findIndex((p) => p?.id === payload.sub);
          if (seatIndex >= 0) {
            (client as any).seatIndex = seatIndex;
            (client as any).syncTournamentId = state.tournamentId;
          }
        }
```

같은 분기 끝, 딜러의 `reportSync` 블록 뒤에:

```ts
        // 좌석이 돌아왔다 — 그 대회가 SYNCING이면 다시 센다(T117). 실패는
        // 딜러 블록과 같은 이유로 삼킨다(M1 · M7).
        const seatTournament = (client as any).syncTournamentId as string | undefined;
        if (seatTournament) {
          await this.reportSync(seatTournament).catch(() => { /* reportSync가 이미 로그로 남긴다 */ });
        }
```

`handleDisconnect`의 딜러 재집계 블록 뒤에:

```ts
    // 끊긴 소켓이 좌석이면 그 대회의 복귀 집계가 하나 줄었을 수 있다(T117).
    const seatTournament = (client as any).syncTournamentId as string | undefined;
    if (seatTournament) {
      await this.reportSync(seatTournament).catch(() => { /* reportSync가 이미 로그로 남긴다 */ });
    }
```

`runDealerAction`의 SYNCING 거절 문구를 `'모든 기기가 돌아올 때까지 기다려 주세요.'`로 바꾼다. 그 위 주석과 `recount`의 주석에서 「딜러 복귀」를 「기기 복귀」로 고친다.

`packages/contract/src/tournament-syncing.ts`의 `TournamentSyncingSchema` 주석 첫 줄을 「서버 복구 중 기기 복귀 진행 — 딜러와 좌석(T96 · T117). 그 대회의 딜러에게만 간다.」로 바꾸고 「`present`/`required`는 딜러 + 앉은 자리의 기기 수다(T117 전에는 딜러 수였다).」를 덧붙인다. 스키마 모양은 그대로다.

- [ ] **Step 4: 통과를 본다**

Run: 위 Step 2 명령, 그리고 `npx jest src/ws` · `npm run typecheck`(루트)
Expected: PASS. 타입 에러 0.

- [ ] **Step 5: 되돌려 빨간불을 본다** — `measureSync`에서 `seats: m.seatStatus.flatMap(...)`을 `seats: []`로 바꾸면(= 딜러만 센다) 「딜러가 다 와도 좌석 하나가 없으면…」이 빨개지는지 본 뒤 되돌린다. `handleConnection`의 좌석 `reportSync` 블록을 지우면 「마지막 좌석이 붙으면…」이 빨개지는지 본 뒤 되돌린다.

- [ ] **Step 6: 통합 전체를 돌린다**

Run: `npm run test:int -w backend`
Expected: 전부 PASS(기준선 762 + 이번에 더한 넷). 실패가 있으면 이름을 적는다.

- [ ] **Step 7: 커밋**

```bash
git add backend/src/ws/ws.gateway.ts backend/src/ws/ws.gateway.int-spec.ts packages/contract/src/tournament-syncing.ts
git commit -m "feat(T117): SYNCING을 딜러와 좌석 기기가 다 돌아와야 푼다"
```

---

### Task 4: 상점이 복구 상태를 보고 강제로 푼다

**Files:**
- Modify: `packages/contract/src/tournament-syncing.ts` — `SyncStatusSchema`
- Create: `packages/contract/src/tournament-syncing.spec.ts`
- Modify: `backend/src/ws/ws.gateway.ts` — `syncStatus` · `forceSync` (public)
- Create: `backend/src/ws/sync.controller.ts`
- Create: `backend/src/ws/sync.controller.spec.ts`
- Modify: `backend/src/ws/ws.module.ts` — `SessionModule` import, `SyncController` 등록
- Test: `backend/src/ws/ws.gateway.int-spec.ts` — SYNCING describe에 넷

**Interfaces:**
- Consumes: Task 3의 `measureSync` · `sendSyncing` · `syncQueue`
- Produces:
  ```ts
  // contract
  export const SyncStatusSchema: z.ZodObject<{ syncing; present; required; missing: Array<{ tableId: string; seatIndex: number | null }> }>;
  export type SyncStatus = z.infer<typeof SyncStatusSchema>;
  // WsGateway
  async syncStatus(tournamentId: string): Promise<SyncStatus>;
  async forceSync(tournamentId: string): Promise<boolean>; // 이 호출이 풀었으면 true
  // HTTP
  GET  /store/sessions/:id/sync        → SyncStatus
  POST /store/sessions/:id/sync/force  → { ok: true } | 409 '복구 중인 대회가 아닙니다.'
  ```

- [ ] **Step 1: contract 검사를 쓴다** — `tournament-syncing.spec.ts`

```ts
import { SyncStatusSchema, TournamentSyncingSchema } from './tournament-syncing';

describe('SyncStatus', () => {
  it('안 돌아온 자리를 싣고 딜러는 seatIndex null이다', () => {
    const parsed = SyncStatusSchema.parse({
      syncing: true, present: 3, required: 5, extra: 1,
      missing: [{ tableId: 't1', seatIndex: null }, { tableId: 't1', seatIndex: 4, nickname: 'x' }],
    });
    expect(parsed).toEqual({
      syncing: true, present: 3, required: 5,
      missing: [{ tableId: 't1', seatIndex: null }, { tableId: 't1', seatIndex: 4 }],
    });
  });
  it('missing이 없으면 거부한다', () => {
    expect(SyncStatusSchema.safeParse({ syncing: false, present: 0, required: 0 }).success).toBe(false);
  });
});

describe('TournamentSyncing', () => {
  it('missing은 소켓으로 안 나간다', () => {
    expect(TournamentSyncingSchema.parse({ syncing: true, present: 1, required: 2, missing: [] }))
      .toEqual({ syncing: true, present: 1, required: 2 });
  });
});
```

- [ ] **Step 2: 실패를 본다** — Run: `npm test -w packages/contract` → FAIL(`SyncStatusSchema` 없음).

- [ ] **Step 3: contract를 더한다** — `tournament-syncing.ts` 끝에:

```ts
/**
 * 상점 콘솔의 복구 상태(T117, `GET store/sessions/:id/sync`). 끝내 안 돌아오는 자리가
 * 있으면 상점이 이 목록을 보고 「지금 진행」으로 푼다. 테이블 번호 · 닉네임은 콘솔이
 * 이미 받는 좌석 목록으로 잇는다 — 여기 싣지 않는다.
 */
export const SyncStatusSchema = z.object({
  syncing: z.boolean(),
  present: z.int().min(0),
  required: z.int().min(0),
  missing: z.array(
    z.object({
      tableId: z.string(),
      /** `null`이면 그 테이블의 딜러다. */
      seatIndex: z.int().min(0).nullable(),
    }),
  ),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;
```

Run: `npm test -w packages/contract` → PASS.

- [ ] **Step 4: 게이트웨이 통합 검사를 쓴다** — SYNCING describe 끝에

```ts
    it('syncStatus는 안 돌아온 자리를 낸다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      await connectSeats([TABLE]);
      await connect(await dealerTicket(TABLE), TABLE);

      expect(await gateway.syncStatus(TOURNAMENT)).toEqual({
        syncing: true, present: 2, required: 4,
        missing: [{ tableId: OTHER_TABLE, seatIndex: null }, { tableId: OTHER_TABLE, seatIndex: 0 }],
      });
    });

    it('SYNCING이 아니면 syncStatus는 비어 있다', async () => {
      await seedSyncingTournament(TournamentStatus.ONGOING);
      expect(await gateway.syncStatus(TOURNAMENT)).toEqual({ syncing: false, present: 0, required: 0, missing: [] });
    });

    it('forceSync는 completeSync를 부르고 딜러들에게 syncing:false를 보낸다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);

      expect(await gateway.forceSync(TOURNAMENT)).toBe(true);

      expect(recovery.completeSync).toHaveBeenCalledWith(TOURNAMENT);
      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: false, present: 1, required: 4 });
    });

    /** 자연 완료와 겹쳐 진 쪽이거나 이미 풀린 대회 — 아무에게도 보내지 않는다. */
    it('forceSync는 SYNCING이 아니거나 completeSync가 지면 false다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);
      tableDealer.send.mockClear();
      recovery.completeSync.mockResolvedValueOnce(false);

      expect(await gateway.forceSync(TOURNAMENT)).toBe(false);
      expect(lastSyncingPayload(tableDealer)).toBeUndefined();

      await prisma.tournament.update({ where: { id: TOURNAMENT }, data: { status: TournamentStatus.ONGOING, pausedAt: null } });
      recovery.completeSync.mockClear();
      expect(await gateway.forceSync(TOURNAMENT)).toBe(false);
      expect(recovery.completeSync).not.toHaveBeenCalled();
    });
```

그리고 진짜 `RecoveryService`로 한 번(M4와 같은 방식 — `realGateway`/`realRecovery`를 만들고 `finally`에서 `onModuleDestroy`):

```ts
    it('진짜 RecoveryService로 forceSync하면 DB가 ONGOING이 되고 두 번째는 false다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      const realRecovery = new RecoveryService(prisma as unknown as PrismaService, new RedisService(redis));
      const realGateway = new WsGateway(
        dealer as unknown as DealerService, playsync, new RedisService(redis), tickets,
        new EventEmitter2(), prisma as unknown as PrismaService, realRecovery,
      );
      try {
        expect(await realGateway.forceSync(TOURNAMENT)).toBe(true);
        const t = await prisma.tournament.findUniqueOrThrow({ where: { id: TOURNAMENT } });
        expect(`상태 ${t.status} ${t.pausedAt}`).toBe('상태 ONGOING null');
        expect(await realGateway.forceSync(TOURNAMENT)).toBe(false);
      } finally {
        realGateway.onModuleDestroy();
        realRecovery.onModuleDestroy();
      }
    });
```

- [ ] **Step 5: 실패를 본다** — Task 3 Step 2의 명령 → FAIL(`syncStatus`·`forceSync` 없음).

- [ ] **Step 6: 게이트웨이에 둘을 더한다** (`recount` 아래, import에 `SyncStatus, SyncStatusSchema`)

```ts
  /**
   * 상점 콘솔의 복구 상태(T117). 판정은 재집계와 같은 함수다 — 딜러 띠와 상점
   * 목록이 같은 숫자를 본다.
   */
  async syncStatus(tournamentId: string): Promise<SyncStatus> {
    const t = await this.prisma.tournament.findUnique({ where: { id: tournamentId }, select: { status: true } });
    if (t?.status !== TournamentStatus.SYNCING) {
      return SyncStatusSchema.parse({ syncing: false, present: 0, required: 0, missing: [] });
    }
    const { progress } = await this.measureSync(tournamentId);
    return SyncStatusSchema.parse({ syncing: true, ...progress });
  }

  /**
   * 상점의 「지금 진행」(T117). 참가자가 장애 뒤 아무 의사도 밝히지 않고 떠나면 그
   * 자리는 끝내 안 돌아와 대회가 영영 멈춘다 — 현장 판단으로 푼다. 안 돌아온 자리는
   * 평소 규칙대로 접히고 칩이 떨어지면 리바인 시간초과로 탈락한다.
   *
   * **재집계와 같은 줄에 선다** — 앞선 재집계가 낡은 `{syncing:true}`를 이 뒤에 보내지
   * 않게(T96 리뷰 I1). 자연 완료와 겹치면 `completeSync`의 조건부 갱신이 한쪽만
   * 이기게 한다.
   *
   * @returns 이 호출이 풀었으면 true. 이미 풀렸거나 진 쪽이면 false
   */
  async forceSync(tournamentId: string): Promise<boolean> {
    return this.syncQueue.enqueue(tournamentId, async () => {
      const t = await this.prisma.tournament.findUnique({ where: { id: tournamentId }, select: { status: true } });
      if (t?.status !== TournamentStatus.SYNCING) return false;
      const { seatMaps, progress } = await this.measureSync(tournamentId);
      if (!(await this.recovery.completeSync(tournamentId))) return false;
      this.logger.warn(
        `상점이 SYNCING을 풀었다 (tournament=${tournamentId}, 기기 ${progress.present}/${progress.required})`,
      );
      this.sendSyncing(seatMaps, { syncing: false, present: progress.present, required: progress.required });
      return true;
    });
  }
```

Run: Task 3 Step 2의 명령 → PASS.

- [ ] **Step 7: 컨트롤러 검사를 쓴다** — `sync.controller.spec.ts`

```ts
import 'reflect-metadata';
import { ConflictException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RolesGuard } from 'src/auth/guard/roles.guard';
import { SyncController } from './sync.controller';

describe('SyncController', () => {
  const guard = new RolesGuard(new Reflector());
  function contextFor(handler: Function, role: Role): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => SyncController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext;
  }

  it.each([
    ['status', SyncController.prototype.status],
    ['force', SyncController.prototype.force],
  ])('%s는 STORE_ADMIN만 통과한다', (_name, handler) => {
    expect(guard.canActivate(contextFor(handler, Role.STORE_ADMIN))).toBe(true);
    expect(guard.canActivate(contextFor(handler, Role.PLATFORM_ADMIN))).toBe(false);
    expect(guard.canActivate(contextFor(handler, Role.DEALER))).toBe(false);
  });

  function make(forceResult = true) {
    const gateway = { syncStatus: jest.fn().mockResolvedValue({ syncing: false }), forceSync: jest.fn().mockResolvedValue(forceResult) };
    const sessions = { assertTournamentOwnership: jest.fn().mockResolvedValue(undefined) };
    return { gateway, sessions, controller: new SyncController(gateway as any, sessions as any) };
  }
  const req = { user: { userId: 'owner-1' } };

  /** 소유권이 먼저다 — 남의 대회면 게이트웨이에 닿지 않는다. */
  it('소유권이 실패하면 게이트웨이를 부르지 않는다', async () => {
    const { gateway, sessions, controller } = make();
    sessions.assertTournamentOwnership.mockRejectedValue(new ForbiddenException('본인의 매장이 아닙니다.'));
    await expect(controller.force(req, 't1')).rejects.toThrow(ForbiddenException);
    await expect(controller.status(req, 't1')).rejects.toThrow(ForbiddenException);
    expect(gateway.forceSync).not.toHaveBeenCalled();
    expect(gateway.syncStatus).not.toHaveBeenCalled();
  });

  it('풀지 못했으면 409다', async () => {
    const { controller } = make(false);
    await expect(controller.force(req, 't1')).rejects.toThrow(ConflictException);
  });

  it('풀었으면 ok', async () => {
    const { controller, sessions } = make(true);
    await expect(controller.force(req, 't1')).resolves.toEqual({ ok: true });
    expect(sessions.assertTournamentOwnership).toHaveBeenCalledWith('t1', 'owner-1');
  });
});
```

- [ ] **Step 8: 실패를 본다** — Run: `npx jest src/ws/sync.controller.spec.ts` → FAIL(모듈 없음).

- [ ] **Step 9: 컨트롤러와 모듈 배선**

`backend/src/ws/sync.controller.ts`:

```ts
import { ConflictException, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/roles.guard';
import { SessionService } from 'src/store/session/session.service';
import { WsGateway } from './ws.gateway';

/**
 * 상점 콘솔의 재기동 복구(T117). 경로는 `store/sessions`지만 이 모듈에 있다 —
 * 판정이 게이트웨이의 소켓 맵에 있고, `SessionModule`에 두면 `DealerModule`을
 * 거쳐 모듈 순환이 된다. 소유권은 다른 운영 조작과 같은
 * `SessionService.assertTournamentOwnership`이다.
 *
 * STORE_ADMIN만 — 대회를 여는 돈 경로와 같은 문이다(`SessionController`의 abort).
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.STORE_ADMIN)
@Controller('store/sessions')
export class SyncController {
  constructor(
    private readonly gateway: WsGateway,
    private readonly sessions: SessionService,
  ) {}

  @Get(':id/sync')
  async status(@Req() req, @Param('id') id: string) {
    await this.sessions.assertTournamentOwnership(id, req.user.userId);
    return this.gateway.syncStatus(id);
  }

  @Post(':id/sync/force')
  async force(@Req() req, @Param('id') id: string) {
    await this.sessions.assertTournamentOwnership(id, req.user.userId);
    if (!(await this.gateway.forceSync(id))) {
      throw new ConflictException('복구 중인 대회가 아닙니다.');
    }
    return { ok: true };
  }
}
```

`ws.module.ts`: `imports`에 `SessionModule`(`src/store/session/session.module`), `controllers`에 `SyncController`. 모듈 주석 끝에 「SessionModule은 상점 복구 컨트롤러(`SyncController`)의 소유권 확인 때문이다(T117). 반대 방향(SessionModule → WsModule)은 없어 순환이 아니다.」를 더한다.

- [ ] **Step 10: 통과를 본다**

Run: `npx jest src/ws` · `npm run typecheck`(루트) · `npm run test -w backend`
Expected: PASS, 타입 에러 0. 백엔드 부팅 배선은 `npm run build -w backend`로 컴파일만 확인한다(순환이면 런타임에 나므로 Task 6의 무대에서 확인한다).

- [ ] **Step 11: 커밋**

```bash
git add packages/contract/src/tournament-syncing.ts packages/contract/src/tournament-syncing.spec.ts backend/src/ws/
git commit -m "feat(T117): 상점이 복구 상태를 보고 SYNCING을 강제로 푼다"
```

---

### Task 5: 화면 — 딜러 띠는 기기 수, 콘솔에 복구 패널

**Files:**
- Modify: `frontend/src/app/(terminal)/dealer/table/[tableId]/DealerGameClient.tsx` — 두 문구
- Modify: `frontend/src/app/(terminal)/dealer/table/[tableId]/DealerGameClient.test.tsx` — 두 기대
- Create: `frontend/src/app/(console)/stores/[storeId]/tournaments/[tournamentId]/SyncPanel.tsx`
- Create: `frontend/src/app/(console)/stores/[storeId]/tournaments/[tournamentId]/SyncPanel.test.tsx`
- Modify: 같은 폴더 `action.ts` · `page.tsx` · `ConsoleClient.tsx`

**Interfaces:**
- Consumes: Task 4의 `SyncStatus` · `SyncStatusSchema`, `POST /store/sessions/:id/sync/force`
- Produces: `forceSync(tournamentId: string): Promise<ActionResult>` (서버 액션), `ConsoleClient`의 새 props `sync: SyncStatus | null`, `forceSync`.

- [ ] **Step 1: 딜러 문구 검사를 바꾼다** — `DealerGameClient.test.tsx`의 `'딜러 7/9 복귀'` 둘을 `'기기 7/9 복귀'`로. Run: `npx vitest run "src/app/(terminal)/dealer/table/[tableId]/DealerGameClient.test.tsx"` (`frontend`에서) → FAIL 둘.

- [ ] **Step 2: 딜러 문구를 바꾼다** — `DealerGameClient.tsx`의 `` ` 딜러 ${sync.present}/${sync.required} 복귀 — 전원이 돌아오면 이어서 진행할 수 있습니다.` ``와 `딜러 {sync.present}/{sync.required} 복귀 — 전원이 돌아오면 이어서 진행할 수 있습니다.`를 각각 「기기 … 복귀 — 딜러와 좌석이 모두 돌아오면 이어서 진행할 수 있습니다.」로. Run 같은 명령 → PASS.

- [ ] **Step 3: 복구 패널 검사를 쓴다** — `SyncPanel.test.tsx`

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SyncPanel from './SyncPanel';

const tables = [{ id: 't1', tableOrder: 1 }, { id: 't2', tableOrder: 2 }];
const seatOccupants = [
  { tableId: 't1', tableOrder: 1, players: [{ seatIndex: 3, userId: 'u1', nickname: '민수' }] },
];

describe('SyncPanel', () => {
  it('기기 수와 안 돌아온 자리를 테이블 번호 · 좌석 번호 · 닉네임으로 보여준다', () => {
    render(
      <SyncPanel
        sync={{ syncing: true, present: 10, required: 12, missing: [{ tableId: 't1', seatIndex: 3 }, { tableId: 't2', seatIndex: null }] }}
        tables={tables}
        seatOccupants={seatOccupants}
        pending={false}
        onForce={() => {}}
      />,
    );
    expect(screen.getByTestId('sync-panel')).toHaveTextContent('기기 10/12 복귀');
    expect(screen.getByText('테이블 1 · 4번 민수')).toBeInTheDocument();
    expect(screen.getByText('테이블 2 · 딜러')).toBeInTheDocument();
  });

  /** 되돌릴 수 없는 조작이라 한 번 더 묻는다 — 첫 클릭은 확인만 연다. */
  it('지금 진행은 확인을 거쳐야 부른다', () => {
    const onForce = vi.fn();
    render(
      <SyncPanel sync={{ syncing: true, present: 1, required: 2, missing: [] }} tables={tables} seatOccupants={[]} pending={false} onForce={onForce} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '지금 진행' }));
    expect(onForce).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '진행한다' }));
    expect(onForce).toHaveBeenCalledTimes(1);
  });

  it('처리 중에는 누를 수 없다', () => {
    render(
      <SyncPanel sync={{ syncing: true, present: 1, required: 2, missing: [] }} tables={tables} seatOccupants={[]} pending onForce={() => {}} />,
    );
    expect(screen.getByRole('button', { name: '지금 진행' })).toBeDisabled();
  });
});
```

Run: `npx vitest run "src/app/(console)/stores/[storeId]/tournaments/[tournamentId]/SyncPanel.test.tsx"` → FAIL(모듈 없음).

- [ ] **Step 4: 패널을 만든다** — `SyncPanel.tsx`

```tsx
'use client';

import { useState } from 'react';
import type { SyncStatus } from '@playsync/contract';
import type { TableInfo, TableSeatInfo } from './ConsoleClient';

/**
 * 재기동 복구 중인 대회(T117). 서버는 딜러와 좌석 기기가 다 돌아와야 대회를 연다 —
 * 끝내 안 돌아오는 자리가 있으면 상점이 이 목록을 보고 연다.
 *
 * 테이블 번호와 닉네임은 콘솔이 이미 받은 좌석 목록으로 잇는다(`SyncStatus`는
 * 자리만 싣는다). Carbon 토큰만 쓴다(`ConsoleClient`와 같은 면).
 */
export default function SyncPanel({
  sync,
  tables,
  seatOccupants,
  pending,
  onForce,
}: {
  sync: SyncStatus;
  tables: TableInfo[];
  seatOccupants: TableSeatInfo[];
  pending: boolean;
  onForce: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const order = new Map(tables.map((t) => [t.id, t.tableOrder]));
  const nickname = (tableId: string, seatIndex: number) =>
    seatOccupants.find((t) => t.tableId === tableId)?.players.find((p) => p.seatIndex === seatIndex)?.nickname ?? '';

  return (
    <div data-testid="sync-panel" className="border border-[var(--hairline)] bg-[var(--surface)] p-4 text-sm">
      <p className="font-semibold">
        서버 복구 중 — 기기 {sync.present}/{sync.required} 복귀
      </p>
      <p className="mt-1 text-[var(--ink-subtle)]">
        딜러와 좌석 태블릿이 모두 돌아오면 서버가 대회를 엽니다. 끝내 안 돌아오는 자리가 있으면 지금 진행할 수
        있습니다 — 그 자리는 시간초과로 접힙니다.
      </p>
      {sync.missing.length > 0 && (
        <ul className="mt-2 list-disc pl-5">
          {sync.missing.map((m) => (
            <li key={`${m.tableId}:${m.seatIndex ?? 'dealer'}`}>
              {m.seatIndex === null
                ? `테이블 ${order.get(m.tableId) ?? '?'} · 딜러`
                : `테이블 ${order.get(m.tableId) ?? '?'} · ${m.seatIndex + 1}번 ${nickname(m.tableId, m.seatIndex)}`.trimEnd()}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex gap-2">
        {confirming ? (
          <>
            <button type="button" disabled={pending} onClick={() => { setConfirming(false); onForce(); }}
              className="bg-[var(--blue)] px-4 py-2 text-white disabled:opacity-40">
              진행한다
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="border border-[var(--hairline)] px-4 py-2">
              취소
            </button>
          </>
        ) : (
          <button type="button" disabled={pending} onClick={() => setConfirming(true)}
            className="bg-[var(--blue)] px-4 py-2 text-white disabled:opacity-40">
            지금 진행
          </button>
        )}
      </div>
    </div>
  );
}
```

Run: Step 3 명령 → PASS.

- [ ] **Step 5: 서버 액션 · 페이지 · 콘솔 배선**

`action.ts` 끝에(같은 파일의 `abortTournament`와 같은 모양):

```ts
/** 재기동 복구를 상점 판단으로 끝낸다(T117). */
export async function forceSync(tournamentId: string): Promise<ActionResult> {
  const result = await callConsoleApi(`/store/sessions/${tournamentId}/sync/force`, { method: 'POST' });
  return 'error' in result ? result : { ok: true };
}
```

`page.tsx`: import에 `SyncStatusSchema, type SyncStatus`와 `forceSync`. `fetchPreview` 아래에:

```ts
/**
 * 재기동 복구 상태(T117). 실패하거나 모양이 어긋나면 `null` — 패널을 안 그린다.
 * 소유권 문지기는 `fetchSeatOccupants`다.
 */
async function fetchSync(tournamentId: string, token: string | undefined): Promise<SyncStatus | null> {
  if (!token) return null;
  const res = await fetch(`${BACKEND_URL}/store/sessions/${tournamentId}/sync`, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const parsed = SyncStatusSchema.safeParse(await res.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}
```

`Promise.all`에 `fetchSync(tournamentId, token)`을 더해 `sync`로 받고, `ConsoleClient`에 `sync={ownershipDenied ? null : sync}`와 `forceSync={forceSync}`를 넘긴다.

`ConsoleClient.tsx`: props에 `sync: SyncStatus | null;`과 `forceSync: (tournamentId: string) => Promise<ActionResult>;`, `import SyncPanel from './SyncPanel';`, `SyncStatus` 타입 import. 대회 머리글 블록(대회 이름과 상태 배지를 그리는 `div`) 바로 아래, 같은 바깥 `flex flex-col gap-5` 안에:

```tsx
        {sync?.syncing && (
          <SyncPanel
            sync={sync}
            tables={tables}
            seatOccupants={seatOccupants}
            pending={pending}
            onForce={() => run(() => forceSync(tournamentId))}
          />
        )}
```

기존 `ConsoleClient.test.tsx` · `page.test.tsx`가 props를 손으로 넘기면 `sync={null}` · `forceSync={vi.fn()}`을 더해 타입을 맞춘다. `page.test.tsx`가 `fetch` 호출 수나 URL 목록을 단언하면 `/sync`를 기대에 더한다.

- [ ] **Step 6: 통과를 본다**

Run: `npm run test -w frontend` · `npm run typecheck`(루트)
Expected: 전부 PASS(기준선 369 + 새 셋), 타입 에러 0.

- [ ] **Step 7: 커밋**

```bash
git add "frontend/src/app/(terminal)/dealer/table/[tableId]/" "frontend/src/app/(console)/stores/[storeId]/tournaments/[tournamentId]/"
git commit -m "feat(T117): 딜러 띠는 기기 수, 콘솔에 복구 패널과 지금 진행"
```

---

### Task 6 (메인): 1,000테이블 kill 재측정과 SSOT

하위 에이전트에게 맡기지 않는다 — 무대 · 측정 · 문서.

- [ ] 무대(T116과 같은 절차: `load:down` → `load:up` → `migrate deploy` → 6코어 → `seed:load` 9,000 → k6 램프 A, 예약 폭발 없음 → 착석 후 2코어 → 1코어 → 시작 20분 kill → 8초 뒤 start), 원시 · 콘솔 · 백엔드 로그를 `t117-kill-*`로 남긴다.
- [ ] 합격: **「리바인 응답 시간초과」가 kill 뒤 0**, 167대회 `SYNCING 종료` 전부, 좌석이 남은 소켓 5분 안. 1006 외 코드로 닫힌 테이블까지 잰 `reconnect_ms` 표본이 1,000에 가까운지(T116의 `406a4e6`을 처음 실행에서 태운다). lag · CPU를 T116과 비교(재집계 비용).
- [ ] 백엔드가 부팅하는지(모듈 순환 없음)는 이 무대가 첫 확인이다.
- [ ] SSOT: `tickets-recovery.md` T117 완료, `domain.md`의 「정지의 끝은 부팅이 아니다 — `SYNCING`」 절(n은 기기, k는 붙은 기기, 상점의 강제 해제), `results/`에 재측정, `CLAUDE.md` 기준선.
