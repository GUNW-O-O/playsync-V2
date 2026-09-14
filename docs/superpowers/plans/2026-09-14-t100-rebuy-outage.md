# T100 — 리바인 창에 Redis 장애가 끼는 경우 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 리바인 창에 Redis 장애가 끼어도 포인트만 빠지거나 장애 때문에 탈락하지 않고, 딜러가 판을 다시 열 때 새로 묻는다.

**Architecture:** `processRebuy`가 스냅샷에 칩을 먼저 넣고(락 안 장애 세대 가드) DB를 나중에 쓴다. 장애가 대기를 끊으면 결과가 「중단」이 되고, `DealerService.resolveWinners`의 리바인 단계가 복구를 기다려 테이블에 `resumePending`을 세운 뒤 딜러의 `resumeTable`을 기다렸다가 중단된 사람에게만 다시 묻는다. 게이트웨이는 장애 중 `REBUY_RESPONSE`를 거절하고, 좌석 팝업은 장애·재개 대기 동안 버튼을 막는다.

**Tech Stack:** NestJS · ioredis · Prisma · EventEmitter2 · zod(`@playsync/contract`) · Next.js · vitest · jest

**Spec:** `docs/superpowers/specs/2026-09-14-t100-rebuy-outage-design.md` — 구현 전에 반드시 읽는다. 끝의 「계획에서 좁힌 것」 절이 본문보다 우선한다.

## Global Constraints

- 장애 문구는 `packages/contract`의 `SERVER_RECOVERING_MESSAGE` 한 곳에서만 온다. 백엔드·프론트 어디에도 문자열을 다시 적지 않는다
- **생성자 시그니처를 바꾸지 않는다** — `RedisService` · `PlaysyncService` · `DealerService` · `RecoveryService` · `WsGateway`
- 코드·주석은 한국어, 코드를 가리킬 때는 줄 번호가 아니라 이름으로 적는다(`CLAUDE.md`)
- **하위 에이전트는 `docs/`와 `CLAUDE.md`를 만지지 않는다.** 스펙·계획은 읽기만 한다
- 버그 수정은 실패하는 테스트를 먼저 보고 고친다. 사후에 붙인 검사는 제품 코드를 되돌려 빨간불을 확인한다
- 시나리오 계층(`src/scenario/`)에는 스텁을 두지 않는다. 순서를 강제하는 스파이만 허용한다
- 순서가 필요한 테스트는 타이밍을 기다리지 않고 스파이로 한쪽을 붙잡는다(`CLAUDE.md` 「통과한 테스트를 믿지 않는다」)
- 명령은 루트 기준: `npm run test -w backend -- <패턴>`, `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- <패턴>`, `npm run test -w frontend -- <패턴>`, `npm run typecheck`

---

## 검수 — 쓰는 순서가 안전한가, 딸려 오는 문제는 없는가

계획을 쓰며 코드를 따라가 확인한 결과다. **이 절이 태스크의 근거다.** 실행자는 읽기만 한다.

### 순서 자체 (스냅샷 → DB → 전광판)

| # | 경로 | 판정 |
|---|---|---|
| S1 | 장애 중 수락 | 첫 쓰기(스냅샷)가 락 안 세대 가드나 Redis 오류로 멈춘다 → DB 안 불림. **안전** |
| S2 | DB 거절(포인트 경합 · 닫힌 대회 · 중단된 대회) | 락 안에서 칩을 되돌리고 되돌린 상태를 전파한다. 이중 장애(되돌리는 순간 Redis까지 끊김)면 칩이 돈 없이 남는다 → `error` 로그, 범위 밖 |
| S3 | 전광판 `rebuyPlayer` 실패 | **돈을 안 건드린다** — `eliminatePlayer`·`tournamentFinished`가 풀·등수·상금을 전부 트랜잭션 안 DB에서 읽는다. `tournamentInfo`에서 쓰는 것은 `syncActivePlayer`의 `startStack`·`entryFee`(대회 상수)뿐. 표시만 어긋난다 → 로그 |
| S4 | 닫힌 대회 | 스냅샷이 지워졌으면 1에서 멈춰 DB·전광판 키를 안 건드린다. 닫힘 커밋과 스냅샷 삭제 사이면 1은 성공, 2가 P2025로 거절 → 되돌림(스냅샷이 그 사이 지워졌으면 no-op) |
| S5 | 체크포인트와의 겹침 | `resolveWinners` 4단계는 리바인 전원이 끝난 뒤라 커밋된 칩만 본다. **단, 딜러의 `retryCheckpoint`는 예외** → D1 |
| S6 | 오프라인 큐(짧은 장애) | 칩 쓰기가 큐에 들었다가 복구 뒤 실행되면 promise가 **늦게 성공**한다 → `processRebuy`가 이어서 DB를 쓴다 → 일관. 「실행됐는데 응답만 잃고 재시도 초과로 거절」만 칩이 남는다 → 다시 묻는 대상에서 걸러 **이중 지급은 막는다**(D4). 남는 칩은 범위 밖 |

### 이 변경이 끌고 오는 문제 — 태스크에서 막는다

리바인 대기는 지금 최대 15초다. 이 변경으로 **「장애 + 딜러가 재개할 때까지」**가 된다. 15초라 드러나지 않던 창이 분 단위로 벌어진다.

| # | 문제 | 막는 법 | 태스크 |
|---|---|---|---|
| D1 | `retryCheckpoint`는 `phase === HAND_END`만 본다. 긴 대기 동안 들어오면 `finishHand`가 `WAITING`으로 넘기고, 다음 핸드가 시작된 판에 재개 뒤 리바인 칩이 들어가거나 탈락 확정이 돈다 | 리바인 고리가 도는 테이블은 **메모리의** `rebuyInFlight`로 거절한다. **스냅샷 표시(`rebuyPending`)로 막지 않는다** — 그 표시는 Redis가 힘들면 못 지워지고, 그러면 나올 길이 막다른 골목이 된다(`domain.md` 「나올 길의 문지기도 페이즈다 — 표시가 아니다」, T62) | 2 |
| D2 | 재개 신호 유실 — `resumePending`을 쓴 뒤 대기를 등록하면 그 사이에 누른 재개가 풀 대상을 못 찾는다 | 대기를 **먼저** 등록하고 `resumePending`을 쓴다. 그 전에 누른 재개는 `resumePending`이 없어 `resumeTable`이 거절한다 | 2 |
| D3 | 복구 직후 다시 끊기면 `resumePending` 쓰기·`markRebuyPending`이 던져 고리를 빠져나가고 `finally`까지 던진다 | 쓰기가 던졌는데 up이 아니면 삼키고 다시 복구를 기다린다. up인데 던지면 올린다 | 2 |
| D4 | 대기 중 딜러가 킥한 사람, 칩이 늦게 들어간 사람(S6)에게 다시 묻는다 | 다시 묻는 대상 = 중단 ∧ **스냅샷에 있다** ∧ 스택 ≤ 0 | 2 |
| D5 | 대기 리스너 수 — 테이블마다 파산자마다 `down` 리스너를 달면 동시 리바인 창이 많을 때 `MaxListenersExceededWarning`(기본 10) | `RedisOutage`가 `EventEmitter` 리스너가 아니라 **Set**으로 대기자를 든다(`onceDown` · `whenUp`) | 1 |
| D6 | `processRebuy`의 반환이 금액 → 결과로 바뀐다 | 기존 검사 넷(`playsync.service.int-spec`)·목 다섯(`dealer.service.int-spec`)을 결과로 고친다 | 1 · 2 |

### 확인했고 문제없는 것

- **등록 마감** — 긴 대기 뒤 리바인 레벨이 지났을 수 있다. **다시 확인하지 않는다.** 리바인 자격은 `resolveWinners`가 핸드 끝에 읽은 `isRegistrationOpen`이 정하고(판정 시점 = 핸드 종료), 장애가 그 자격을 빼앗으면 막으려는 결함이다. `executeRebuyTransaction`도 마감을 안 본다
- **딜러 요청이 막히지 않는다** — `RESOLVE_WINNERS`가 재개까지 걸려 있어도 Nest `ws` 어댑터가 소켓의 메시지를 `mergeMap`으로 병렬 처리한다(`@nestjs/platform-ws`의 `bindMessageHandlers`)
- **`resumeTable`을 그대로 쓴다** — 차례 없는 `HAND_END`에서 `scheduleTurnTimeout`은 세대만 올리고 `actionDeadline`을 비운다
- **T97 스윕과 안 겹친다** — `planPause`가 차례 없는 테이블에 `null`이라 `HAND_END`에 정지 표시를 안 단다
- **n/n 전 재개 거절** — `WsGateway.runDealerAction`의 `SYNCING` 가드가 이미 있다

### 계획이 스펙에서 좁힌 것

- `rebuyPlayer`는 `executeRebuyTransaction` **안에 남긴다**(DB 커밋 뒤). 던지면 삼키고 로그만. 스펙은 「함수 밖으로 뺀다」였지만, 안에 두면 A-2(지운 전광판 키 부활 없음)가 지금 자리 그대로 지켜지고 그 함수를 직접 부르는 검사(`payment` · `prize` · `closed-tournament` · `abort-settlement`)가 안 바뀐다
- 결과 「해당 없음」의 이름은 `'skipped'`
- `resumePending` 쓰기는 `PlaysyncService.markRebuyInterrupted` — `markRebuyPending`과 같은 자리·같은 모양(전파를 `PlaysyncService`가 든다. `DealerService`에는 이미터가 없다)

---

## 파일 지도

| 파일 | 무엇 | 태스크 |
|---|---|---|
| `backend/src/redis/outage.ts` · `outage.spec.ts` | `whenUp` · `onceDown` | 1 |
| `backend/src/playsync/playsync.service.ts` | `RebuyOutcome` · `processRebuy` 순서 · `waitForRebuyResponse` 중단 · `revertRebuy` · `executeRebuyTransaction` 전광판 삼킴 · `markRebuyInterrupted` | 1 |
| `backend/src/playsync/playsync.service.int-spec.ts` | 결과 · 순서 · 중단 · 되돌림 | 1 |
| `backend/src/dealer/dealer.service.ts` | 리바인 고리 · 재개 대기 · `rebuyInFlight` | 2 |
| `backend/src/dealer/dealer.service.int-spec.ts` | 목 결과화 · 고리 · `retryCheckpoint` 거절 | 2 |
| `backend/src/ws/ws.gateway.ts` · `ws.gateway.int-spec.ts` | `REBUY_RESPONSE` 장애 가드 | 2 |
| `backend/src/scenario/rebuy-outage.int-spec.ts` (신규) | 조립 | 2 |
| `frontend/src/app/(terminal)/table/[tableId]/RebuyOverlay.tsx` · `SeatGameClient.tsx` · `SeatGameClient.test.tsx` | 팝업 막기 · 거절 탈락 화면 걷기 | 3 |

리뷰: Task 1 · 2는 동시성 제품 코드라 태스크 리뷰를 받는다. Task 3은 최종 리뷰가 덮는다(`CLAUDE.md` 「서브에이전트」).

---

### Task 1: 쓰는 순서와 중단 — `RedisOutage` · `PlaysyncService`

**Files:**
- Modify: `backend/src/redis/outage.ts`, `backend/src/redis/outage.spec.ts`
- Modify: `backend/src/playsync/playsync.service.ts`
- Modify: `backend/src/playsync/playsync.service.int-spec.ts`
- Modify: `backend/src/dealer/dealer.service.int-spec.ts` (목 다섯의 반환만 — 반환형이 바뀌어 안 고치면 타입 체크가 깨진다)

**Interfaces:**
- Consumes: `RedisService.outage: RedisOutage`(T97) — `phase` · `generation` · `isUp()` · `markRecovered()`
- Produces:
  - `RedisOutage.whenUp(): Promise<void>` — up이면 즉시, 아니면 `markRecovered`에 풀린다
  - `RedisOutage.onceDown(fn: () => void): () => void` — 다음 끊김에 한 번 부른다. 반환은 구독 해제
  - `export type RebuyOutcome = 'applied' | 'declined' | 'timeout' | 'skipped' | 'interrupted'` (`playsync.service.ts`)
  - `PlaysyncService.processRebuy(tournamentId, tableId, userId, entryFee, startStack, tournamentName, generation?: number): Promise<RebuyOutcome>` — `generation` 기본값은 호출 시점의 `outage.generation`
  - `PlaysyncService.markRebuyInterrupted(tableId: string, downMs: number): Promise<void>` — 락 안에서 `rebuyPending` 삭제 · `resumePending ??= { downMs }` · 전파. 스냅샷이 없으면 아무것도 안 한다

- [ ] **Step 1: `outage.spec.ts`에 실패하는 검사**

파일 끝에 붙인다.

```ts
describe('RedisOutage — 기다리는 쪽', () => {
  it('up이면 whenUp이 곧바로 풀린다 (반대 입력)', async () => {
    const o = new RedisOutage(fakeClient('ready') as never, () => 0);
    await expect(o.whenUp()).resolves.toBeUndefined();
  });

  it('down이면 whenUp은 markRecovered에서야 풀린다', async () => {
    const client = fakeClient('ready');
    const o = new RedisOutage(client as never, () => 0);
    client.emit('reconnecting');
    let done = false;
    const waiting = o.whenUp().then(() => { done = true; });
    client.emit('ready');
    await Promise.resolve();
    expect(`recovering에서 ${done}`).toBe('recovering에서 false');
    o.markRecovered();
    await waiting;
    expect(done).toBe(true);
  });

  it('onceDown은 다음 끊김에 한 번만 부르고, 해제하면 안 부른다', () => {
    const client = fakeClient('ready');
    const o = new RedisOutage(client as never, () => 0);
    const kept = jest.fn();
    const dropped = jest.fn();
    o.onceDown(kept);
    const off = o.onceDown(dropped);
    off();
    client.emit('reconnecting');
    client.emit('ready');
    o.markRecovered();
    client.emit('reconnecting');
    expect(`${kept.mock.calls.length} ${dropped.mock.calls.length}`).toBe('1 0');
  });

  it('대기자가 많아도 EventEmitter 리스너를 늘리지 않는다', () => {
    const o = new RedisOutage(fakeClient('ready') as never, () => 0);
    for (let i = 0; i < 50; i++) o.onceDown(() => {});
    expect(o.listenerCount('down')).toBe(0);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm run test -w backend -- outage.spec`
Expected: FAIL — `o.whenUp is not a function`

- [ ] **Step 3: `outage.ts` 구현**

`RedisOutage` 안, `downSince` 필드 아래에:

```ts
  /**
   * 끊김·복구를 **기다리는 쪽**(T100). `EventEmitter` 리스너로 달지 않는다 —
   * 리바인 창마다 파산자마다 하나씩이라 동시 창이 많으면 기본 한도(10)를 넘어
   * 경고가 나고, 그 경고는 진짜 누수를 찾는 도구라 끄지 않는다.
   */
  private readonly downWaiters = new Set<() => void>();
  private readonly upWaiters = new Set<() => void>();

  /** 다음 끊김에 한 번 부른다. 반환값을 부르면 구독을 푼다. */
  onceDown(fn: () => void): () => void {
    this.downWaiters.add(fn);
    return () => { this.downWaiters.delete(fn); };
  }

  /** up이면 곧바로, 아니면 복구 스윕이 끝날 때(`markRecovered`) 풀린다. */
  whenUp(): Promise<void> {
    if (this.isUp()) return Promise.resolve();
    return new Promise((resolve) => { this.upWaiters.add(resolve); });
  }
```

`markRecovered`의 `this.emit('recovered');` 바로 앞에:

```ts
    const up = [...this.upWaiters];
    this.upWaiters.clear();
    for (const fn of up) fn();
```

`onLost`의 `this.emit('down', this.downSince, previous);` 바로 앞에:

```ts
    const down = [...this.downWaiters];
    this.downWaiters.clear();
    for (const fn of down) fn();
```

- [ ] **Step 4: 통과 확인**

Run: `npm run test -w backend -- outage.spec`
Expected: PASS

- [ ] **Step 5: `playsync.service.int-spec.ts` — 기존 검사를 결과로 고치고, 새 검사를 붙인다**

`describe('PlaysyncService.processRebuy')` 안의 기존 기대값을 바꾼다.

| 검사 | 지금 | 바꾼다 |
|---|---|---|
| 시간이 초과돼도 리스너를 남기지 않는다 | `expect(result).toBe(0)` | `expect(result).toBe('timeout')` |
| 거절해도 리스너를 남기지 않는다 | `expect(result).toBe(0)` | `expect(result).toBe('declined')` |
| 전파되는 상태에 리바인 스택이 이미 반영돼 있다 | `expect(result).toBe(10000)` | `expect(result).toBe('applied')` |
| 트랜잭션이 실패하면 0을 돌려주고 상태를 건드리지 않는다 | `expect(result).toBe(0)` | 이름을 「트랜잭션이 거절되면 칩을 되돌리고 되돌린 상태를 전파한다」로, `expect(result).toBe('skipped')`, 그리고 아래 전파 단언 추가 |
| (포인트 부족, `poorService`) | `toBe(0)` 류 | `toBe('skipped')` |

「트랜잭션이 거절되면」 검사의 마지막에 붙인다(`emitter.on('game.state.updated', …)`로 받은 마지막 상태):

```ts
      let last: TableState | null = null;
      emitter.on('game.state.updated', (p: { state: TableState }) => { last = p.state; });
      // (answerWhenPrompted(true) 와 callProcessRebuy() 앞에 둔다)
      expect(last!.players[0]!.stack).toBe(0);
```

`describe('수락')` 아래에 새 describe를 붙인다.

```ts
  describe('쓰는 순서 (T100)', () => {
    it('DB를 쓰는 순간 스냅샷에 칩이 이미 있다 — 스냅샷이 먼저다', async () => {
      let stackAtDb = -1;
      jest.spyOn(service, 'executeRebuyTransaction').mockImplementation(async () => {
        const mid: TableState = JSON.parse((await redis.get(stateKey))!);
        stackAtDb = mid.players[0]!.stack;
        return 10000;
      });
      answerWhenPrompted(true);

      await callProcessRebuy();

      expect(`DB 시점 스택 ${stackAtDb}`).toBe('DB 시점 스택 10000');
    });

    it('스냅샷이 없으면(닫힌 대회) DB를 부르지 않는다', async () => {
      const tx = jest.spyOn(service, 'executeRebuyTransaction');
      emitter.once('rebuy.request.sent', () => {
        setImmediate(async () => {
          await redis.del(stateKey);
          emitter.emit(`rebuy_res_${USER}`, true);
        });
      });

      const result = await callProcessRebuy();

      expect(`${result} DB ${tx.mock.calls.length}`).toBe('skipped DB 0');
    });
  });

  describe('장애 (T100)', () => {
    const outage = () => redisService.outage;
    /** 실제 끊김 없이 전이만 일으킨다 — 이 파일에는 복구 스윕이 없어 진짜로 끊으면 up으로 못 돌아온다. */
    function simulateDown() {
      (outage() as unknown as { onLost(): void }).onLost();
    }
    afterEach(() => {
      outage().phase = 'up';
      outage().downSince = null;
    });

    it('들어올 때 이미 up이 아니면 묻지도 않고 중단이다', async () => {
      outage().phase = 'down';
      const prompted = jest.fn();
      emitter.on('rebuy.request.sent', prompted);

      const result = await callProcessRebuy();

      expect(`${result} 팝업 ${prompted.mock.calls.length}`).toBe('interrupted 팝업 0');
    });

    it('기다리는 중에 끊기면 마감을 기다리지 않고 곧바로 중단이다', async () => {
      process.env.REBUY_TIMEOUT_MS = '60000';
      try {
        emitter.once('rebuy.request.sent', () => setImmediate(simulateDown));
        const started = Date.now();

        const result = await callProcessRebuy();

        expect(`${result} 빨리 ${Date.now() - started < 5000}`).toBe('interrupted 빨리 true');
        expect(emitter.listenerCount(`rebuy_res_${USER}`)).toBe(0);
      } finally {
        process.env.REBUY_TIMEOUT_MS = '300';
      }
    });

    it('수락이 락 안에 들어간 뒤 세대가 바뀌었으면 칩도 DB도 안 쓴다', async () => {
      const tx = jest.spyOn(service, 'executeRebuyTransaction');
      const generation = outage().generation;
      // 수락은 받았는데, 칩을 넣으러 락에 들어가기 전에 한 번 끊겼다 돌아왔다.
      emitter.once('rebuy.request.sent', () => {
        setImmediate(() => {
          emitter.emit(`rebuy_res_${USER}`, true);
          simulateDown();
          outage().phase = 'up';
        });
      });

      const result = await service.processRebuy(TOURNAMENT, TABLE, USER, 1000, 10000, 'T', generation);

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(`${result} 스택 ${state.players[0]!.stack} DB ${tx.mock.calls.length}`)
        .toBe('interrupted 스택 0 DB 0');
    });

    it('장애가 없으면 끝까지 간다 (반대 입력)', async () => {
      jest.spyOn(service, 'executeRebuyTransaction').mockResolvedValue(10000);
      answerWhenPrompted(true);

      expect(await callProcessRebuy()).toBe('applied');
    });
  });

  describe('markRebuyInterrupted (T100)', () => {
    it('리바인 표시를 지우고 재개 대기를 세우고 전파한다', async () => {
      const s = brokeState();
      s.rebuyPending = { seatIndexes: [0], deadline: Date.now() + 15000 };
      await redis.set(stateKey, JSON.stringify(s));
      let last: TableState | null = null;
      emitter.on('game.state.updated', (p: { state: TableState }) => { last = p.state; });

      await service.markRebuyInterrupted(TABLE, 4200);

      const saved: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(`${saved.rebuyPending === undefined} ${saved.resumePending?.downMs}`).toBe('true 4200');
      expect(last!.resumePending?.downMs).toBe(4200);
    });
  });
```

`brokeState()`가 `rebuyPending`·`resumePending` 필드를 허용하지 않는 타입이면 `as TableState`로 받는다(파일의 기존 헬퍼 모양을 따른다).

- [ ] **Step 6: 실패 확인**

Run: `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- playsync.service`
Expected: FAIL — 결과 문자열 기대(`Expected: "timeout" Received: 0`), 「DB 시점 스택 0」, `markRebuyInterrupted is not a function`

- [ ] **Step 7: `playsync.service.ts` 구현**

`rebuyTimeoutMs` 아래에:

```ts
/**
 * 리바인 한 사람의 결과(T100). 금액이 아니라 **다시 물을지**를 가르는 값이다 —
 * `DealerService.resolveWinners`가 `interrupted`만 딜러의 재개 뒤에 다시 묻는다.
 *
 * - `applied`: 칩이 들어가고 돈이 빠졌다
 * - `declined`: 본인이 거절했다(게이트웨이는 up일 때만 응답을 받는다)
 * - `timeout`: 장애 없이 마감이 지났다
 * - `skipped`: 묻지 않았거나 반영할 수 없었다 — 포인트 부족, DB 거절(칩은 되돌렸다), 스냅샷·좌석 없음
 * - `interrupted`: Redis 장애가 끼었다. 아무것도 확정하지 않았다
 */
export type RebuyOutcome = 'applied' | 'declined' | 'timeout' | 'skipped' | 'interrupted';
```

`markRebuyPending` 아래에:

```ts
  /**
   * 장애가 리바인 창을 끊었다 — 테이블을 **딜러의 재개를 기다리는** 상태로 둔다(T100).
   *
   * `markRebuyPending`과 같은 자리·같은 모양이다. `resumePending`은 T95의 정지
   * 표시 그대로라 좌석은 「딜러가 판을 다시 열기를 기다리는 중」을, 딜러는 정지
   * 배너와 「이어서 진행」을 이미 그린다. 리바인 표시는 지운다 — 남기면 지난
   * 마감의 카운트다운이 0에 멈춘 채 남는다.
   *
   * 이미 서 있는 `resumePending`은 덮지 않는다. 먼저 멈춘 시간이 진짜다.
   */
  public async markRebuyInterrupted(tableId: string, downMs: number) {
    const state = await this.redis.mutateSnapshot(tableId, async (snapshot) => {
      if (!snapshot) return null;
      delete snapshot.rebuyPending;
      snapshot.resumePending ??= { downMs };
      return snapshot;
    });
    if (state) {
      this.eventEmitter.emit('game.state.updated', { tableId, state });
    }
  }
```

`processRebuy`를 통째로 바꾼다(docblock 포함).

```ts
  /**
   * 탈락 위기 플레이어에게 리바인을 묻고, 수락하면 반영까지 한다.
   *
   * **테이블 락을 쥐지 않은 채로 불러야 한다.** 응답 대기는 사람을 기다리는
   * I/O고, 그 구간을 락 안에 두면 최대 15초 동안 테이블 전체가 멎는다.
   *
   * **쓰는 순서는 스냅샷 → DB → 전광판이다(T100).** 예전에는 DB가 먼저라, Redis가
   * 죽은 순간에 수락하면 포인트는 빠지고 칩은 못 들어갔다. 스냅샷을 먼저 쓰면
   * 장애가 **돈이 움직이기 전에** 첫 쓰기를 멈춘다. 대신 DB가 거절하면 넣은 칩을
   * 되돌린다(`revertRebuy`). 전광판(`rebuyPlayer`)은 없는 키를 만들므로 DB 뒤다.
   *
   * @param generation 이 리바인 판을 시작할 때의 장애 세대. 락 안에서 달라졌으면
   *   그 사이에 끊겼다는 뜻이라 쓰지 않는다(`handleAction`의 세대 가드와 같다).
   */
  public async processRebuy(
    tournamentId: string,
    tableId: string,
    userId: string,
    entryFee: number,
    startStack: number,
    tournamentName: string,
    generation: number = this.redis.outage.generation,
  ): Promise<RebuyOutcome> {
    const userPoints = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { points: true }
    });
    if (!userPoints) throw new Error('플레이어 정보 오류');
    if (userPoints.points < entryFee) return 'skipped';

    const answer = await this.waitForRebuyResponse(
      userId, tableId, userPoints, entryFee, tournamentName, generation,
    );
    if (answer !== 'accepted') return answer;

    // 1. 스냅샷에 칩 — 락 안에서 장애를 다시 본다.
    const outage = this.redis.outage;
    // `as`로 넓힌다 — 주석 타입만 달면 TS가 초기값 'skipped'로 좁혀, 콜백 안의
    // 대입을 못 보고 아래 비교를 「겹치지 않는 타입」 오류로 막는다.
    let verdict = 'skipped' as 'applied' | 'skipped' | 'interrupted';
    let applied: TableState | null;
    try {
      applied = await this.redis.mutateSnapshot(tableId, async (state) => {
        if (outage.generation !== generation || !outage.isUp()) {
          verdict = 'interrupted';
          return null;
        }
        if (!state || !state.players.some(p => p?.id === userId)) return null;
        new TableEngine(state).applyRebuy(userId, startStack);
        verdict = 'applied';
        return state;
      });
    } catch (error) {
      // 락·읽기·쓰기가 장애로 던졌다. 돈은 아직 안 움직였다.
      if (!outage.isUp() || outage.generation !== generation) return 'interrupted';
      throw error;
    }
    if (verdict !== 'applied') return verdict;

    // 2. DB — 거절되면 1을 되돌린다.
    try {
      await this.executeRebuyTransaction(
        tournamentId, tableId, userId, entryFee, startStack, tournamentName,
      );
    } catch (error) {
      this.logger.error(`리바인 트랜잭션 거절 — 칩을 되돌린다 (table=${tableId}, user=${userId}): ${error.message}`);
      await this.revertRebuy(tableId, userId, startStack);
      return 'skipped';
    }

    // 3은 `executeRebuyTransaction` 안(커밋 뒤). 4. 전파는 돈이 빠진 뒤다 —
    // 커밋 전의 칩을 화면에 먼저 보이지 않는다.
    if (applied) {
      this.eventEmitter.emit('game.state.updated', { tableId, state: applied });
    }
    return 'applied';
  }

  /**
   * DB가 거절한 리바인의 칩을 스냅샷에서 뺀다(T100).
   *
   * **뺄 만큼 없으면 손대지 않는다.** 그 사이 스택이 줄었다면 무언가가 이미
   * 바뀐 것이고, 음수로 만들면 칩 총량이 깨진다. 되돌리기 자체가 실패하면
   * (이중 장애) 칩이 돈 없이 남는다 — 알 수 있는 곳이 로그뿐이라 `error`로 남긴다.
   */
  private async revertRebuy(tableId: string, userId: string, amount: number) {
    try {
      const state = await this.redis.mutateSnapshot(tableId, async (snapshot) => {
        const player = snapshot?.players.find(p => p?.id === userId);
        if (!snapshot || !player || player.stack < amount) return null;
        player.stack -= amount;
        return snapshot;
      });
      if (state) {
        this.eventEmitter.emit('game.state.updated', { tableId, state });
      }
    } catch (error) {
      this.logger.error(`리바인 되돌리기 실패 — 칩이 돈 없이 남았을 수 있다 (table=${tableId}, user=${userId})`, error);
    }
  }
```

`waitForRebuyResponse`를 바꾼다 — 반환형, `generation` 인자, 장애 분기.

```ts
  private waitForRebuyResponse(
    userId: string,
    tableId: string,
    userPoints: { points: number },
    entryFee: number,
    tournamentName: string,
    generation: number,
  ): Promise<'accepted' | 'declined' | 'timeout' | 'interrupted'> {
    const outage = this.redis.outage;
    // 이미 끊겼거나 이 판을 시작한 뒤 한 번 끊겼다 — 묻지 않는다. 물으면 답을
    // 받아도 반영할 수 없고, 사람은 눌렀는데 아무 일도 없는 화면을 본다.
    if (!outage.isUp() || outage.generation !== generation) {
      return Promise.resolve('interrupted');
    }

    return new Promise((resolve) => {
      const eventName = `rebuy_res_${userId}`;
      const timeoutMs = rebuyTimeoutMs();
      let settled = false;

      const settle = (answer: 'accepted' | 'declined' | 'timeout' | 'interrupted') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        offDown();
        // 핵심. `once`는 "실행되면 제거"라, 시간 초과로 끝난 경우 리스너가
        // 그대로 남는다. 리바인이 일어날 때마다 하나씩 영구 누적됐다.
        this.eventEmitter.removeListener(eventName, handler);
        resolve(answer);
      };

      const handler = (accept: boolean) => settle(accept ? 'accepted' : 'declined');

      const timer = setTimeout(() => {
        this.logger.log(`리바인 응답 시간초과 (user=${userId})`);
        settle('timeout');
      }, timeoutMs);

      // **장애가 오면 마감을 기다리지 않는다**(T100). 서버 타이머는 프로세스
      // 메모리라 장애와 무관하게 흐르고, 그대로 두면 화면이 「기다리라」고 하는
      // 동안 거절로 세어 탈락시킨다.
      const offDown = outage.onceDown(() => settle('interrupted'));

      // 리스너를 먼저 등록한 뒤 팝업을 띄운다. 순서가 반대면 응답이 아주 빨리
      // 돌아온 경우 받을 사람이 없다.
      this.eventEmitter.once(eventName, handler);

      try {
        this.eventEmitter.emit('rebuy.request.sent', {
          userId,
          tableId,
          deadline: Date.now() + timeoutMs,
          userPoints,
          entryFee,
          tournamentName,
        });
      } catch (error) {
        this.logger.warn(`리바인 팝업 전송 실패 (user=${userId}): ${error.message}`);
        settle('declined');
      }
    });
  }
```

기존 docblock(executor에 `async`를 붙이지 않는 이유)은 그대로 둔다. `const timer`가 `settle`보다 뒤에 선언돼도 `settle`은 타이머가 선 뒤에만 불리므로 지금 코드와 같다. `offDown`도 같다 — `onceDown`은 등록만 하고 부르지 않는다.

`executeRebuyTransaction`의 끝을 바꾼다.

```ts
    // 3. 전광판 — **커밋 뒤, 던지지 않는다**(T100). 파산자 풀·등수·상금은 전부
    // DB에서 읽으므로(`eliminatePlayer`) 여기가 실패해도 돈은 맞다. 예전에는
    // 이것이 던져서 **커밋된 리바인**을 호출자가 실패로 보고 칩을 안 넣었다.
    if (result.success) {
      try {
        await this.redis.rebuyPlayer(tournamentId, entryFee, startStack);
      } catch (error) {
        this.logger.error(`리바인 전광판 반영 실패 — 돈과 칩은 맞다 (tournament=${tournamentId})`, error);
      }
    }
    return result.success ? startStack : 0;
```

- [ ] **Step 8: 통과 확인**

Run: `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- playsync.service`
Expected: PASS

`dealer.service.int-spec.ts`의 `describe('resolveWinners …')` 리바인 목 다섯을 결과로 고친다(반환형이 바뀌어 그대로 두면 타입 체크가 깨진다).

| 자리 | 지금 | 바꾼다 |
|---|---|---|
| 리바인 응답을 기다리는 동안에는 락을 놓는다 | `return 0;` | `return 'declined' as const;` |
| 리바인 대기 중에는 다음 핸드가 시작되지 않는다 | `return 0;` | `return 'declined' as const;` |
| 리바인을 기다리는 동안 스냅샷에 그 사실이 남는다 | `return 0;` | `return 'declined' as const;` |
| 리바인이 끝나면 표시가 사라진다 | `mockResolvedValue(0)` | `mockResolvedValue('declined')` |
| 리바인으로 살아난 플레이어는 탈락시키지 않는다 | `return 10000;` | `return 'applied' as const;` |

Run: `npm run typecheck` · `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- dealer.service`
Expected: 0 · PASS (`resolveWinners`는 반환값을 안 쓰므로 제품 코드는 그대로 통과한다)

- [ ] **Step 9: 실패를 먼저 본다(사후)**

1. `processRebuy`의 1과 2의 순서를 되돌린다(DB 먼저, 칩 나중) → 「DB를 쓰는 순간 스냅샷에 칩이 이미 있다」가 빨개지는지 → 복원
2. `waitForRebuyResponse`의 `outage.onceDown(...)` 줄을 `() => {}`로 → 「기다리는 중에 끊기면」이 빨개지는지 → 복원
3. mutator의 `outage.generation !== generation` 조건을 지운다 → 「락 안에 들어간 뒤 세대가 바뀌었으면」이 빨개지는지 → 복원

- [ ] **Step 10: Commit**

```bash
git add backend/src/redis/outage.ts backend/src/redis/outage.spec.ts backend/src/playsync/playsync.service.ts backend/src/playsync/playsync.service.int-spec.ts backend/src/dealer/dealer.service.int-spec.ts
git commit -m "fix(T100): 리바인은 스냅샷에 칩을 먼저 넣고, 장애가 끼면 아무것도 확정하지 않는다"
```

---

### Task 2: 딜러의 재개를 기다리는 고리 — `DealerService` · 게이트웨이 · 시나리오

**Files:**
- Modify: `backend/src/dealer/dealer.service.ts`
- Modify: `backend/src/dealer/dealer.service.int-spec.ts`
- Modify: `backend/src/ws/ws.gateway.ts`, `backend/src/ws/ws.gateway.int-spec.ts`
- Create: `backend/src/scenario/rebuy-outage.int-spec.ts`

**Interfaces:**
- Consumes (Task 1): `RebuyOutcome` · `processRebuy(…, generation)` · `markRebuyInterrupted(tableId, downMs)` · `RedisOutage.whenUp()` · `outage.generation` · `outage.isUp()`
- Produces: 없음(내부). `DealerService.resumeTable`의 공개 동작은 같다 — 성공하면 그 테이블의 리바인 대기를 추가로 푼다. `DealerService.retryCheckpoint`는 리바인 고리가 도는 테이블에서 `'리바인을 기다리는 중입니다.'`로 거절한다

- [ ] **Step 1: 목이 결과로 바뀌어 있는지 본다**

Task 1 Step 8이 `dealer.service.int-spec.ts`의 리바인 목 다섯을 이미 결과(`'declined'` · `'applied'`)로 고쳤다. 숫자를 돌려주는 목이 남아 있으면 같은 표대로 고친다.

- [ ] **Step 2: `dealer.service.int-spec.ts` — 실패하는 새 검사**

같은 describe 끝(「리바인으로 살아난 플레이어는 탈락시키지 않는다」 뒤)에 붙인다. `showdownState()`의 파산자는 `carol`(좌석 2)이다.

```ts
    describe('장애가 리바인을 끊으면 (T100)', () => {
      async function until(pred: () => boolean | Promise<boolean>, ms = 5000) {
        const start = Date.now();
        while (!(await pred())) {
          if (Date.now() - start > ms) throw new Error('until timeout');
          await new Promise((r) => setTimeout(r, 20));
        }
      }
      const saved = async (): Promise<TableState> => JSON.parse((await redis.get(stateKey))!);

      it('재개 전에는 다시 묻지 않고, 재개하면 중단된 사람에게만 다시 묻는다', async () => {
        await seedMeta(true);
        await redis.set(stateKey, JSON.stringify(showdownState()));
        const outcomes: RebuyOutcome[] = ['interrupted', 'declined'];
        const rebuy = jest.spyOn(playsync, 'processRebuy').mockImplementation(async () => outcomes.shift()!);

        const settling = dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

        await until(async () => (await saved()).resumePending !== undefined);
        const paused = await saved();
        expect(`재개 전 호출 ${rebuy.mock.calls.length} 리바인표시 ${paused.rebuyPending === undefined} 페이즈 ${paused.phase}`)
          .toBe(`재개 전 호출 1 리바인표시 true 페이즈 ${GamePhase.HAND_END}`);

        await dealer.resumeTable(TABLE);
        await settling;

        expect(`재개 뒤 호출 ${rebuy.mock.calls.length} 대상 ${rebuy.mock.calls[1]![2]}`).toBe('재개 뒤 호출 2 대상 carol');
      });

      it('중단 뒤 칩이 이미 들어가 있으면 다시 묻지 않는다 (반대 입력)', async () => {
        await seedMeta(true);
        await redis.set(stateKey, JSON.stringify(showdownState()));
        const rebuy = jest.spyOn(playsync, 'processRebuy').mockResolvedValueOnce('interrupted');

        const settling = dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);
        await until(async () => (await saved()).resumePending !== undefined);

        // 오프라인 큐가 늦게 실행한 칩 쓰기(검수 S6) — 재개 전에 스택이 생겼다.
        const landed = await saved();
        landed.players[2]!.stack = 10000;
        await redis.set(stateKey, JSON.stringify(landed));

        await dealer.resumeTable(TABLE);
        await settling;

        expect(`호출 ${rebuy.mock.calls.length}`).toBe('호출 1');
      });

      it('리바인 고리가 도는 동안 체크포인트 재시도는 거절한다', async () => {
        await seedMeta(true);
        await redis.set(stateKey, JSON.stringify(showdownState()));
        let retry: unknown = null;
        jest.spyOn(playsync, 'processRebuy').mockImplementation(async () => {
          retry = await dealer.retryCheckpoint(TABLE).then(() => 'passed', (e: Error) => e.message);
          return 'declined';
        });

        await dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

        expect(retry).toBe('리바인을 기다리는 중입니다.');
      });

      it('재개 대기 중에도 체크포인트 재시도는 거절한다', async () => {
        await seedMeta(true);
        await redis.set(stateKey, JSON.stringify(showdownState()));
        jest.spyOn(playsync, 'processRebuy').mockResolvedValueOnce('interrupted').mockResolvedValue('declined');

        const settling = dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);
        await until(async () => (await saved()).resumePending !== undefined);

        await expect(dealer.retryCheckpoint(TABLE)).rejects.toThrow('리바인을 기다리는 중입니다.');

        await dealer.resumeTable(TABLE);
        await settling;
      });
    });
```

파일 위쪽 import에 `RebuyOutcome`을 더한다: `import { PlaysyncService, RebuyOutcome } from 'src/playsync/playsync.service';`(기존 import 줄의 모양을 따른다).

「체크포인트 재시도가 끝나면 다시 된다」는 기존 검사(「딜러가 실패한 체크포인트를 다시 시도할 수 있다」)가 반대 입력이다 — 고리가 끝난 뒤 부르므로 통과해야 한다.

- [ ] **Step 3: 실패 확인**

Run: `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- dealer.service`
Expected: FAIL — `until timeout`(재개 대기가 없어 `resumePending`이 안 선다), 「passed」(재시도 거절 없음)

- [ ] **Step 4: `dealer.service.ts` 구현**

import에 `RebuyOutcome`을 더한다(`PlaysyncService`를 가져오는 줄). 클래스 필드(`logger` 아래):

```ts
  /**
   * 리바인 고리가 도는 테이블(T100). **메모리다 — 스냅샷 표시로 막지 않는다.**
   *
   * 고리는 이제 「장애 + 딜러 재개」만큼 길 수 있고, 그동안 `retryCheckpoint`가
   * 들어오면 `finishHand`가 판을 `WAITING`으로 넘겨 다음 핸드가 시작된 판에
   * 리바인 칩이 들어간다. `rebuyPending`으로 막으면 그 표시는 Redis가 힘들 때
   * 못 지워지고, 그러면 나올 길이 막다른 골목이 된다(T62). 메모리 표시는
   * `finally`에서 반드시 지워지고, 프로세스가 죽으면 고리도 함께 사라진다.
   */
  private readonly rebuyInFlight = new Set<string>();

  /** 테이블별 「딜러가 다시 열었다」 대기(T100). `resumeTable`이 푼다. */
  private readonly resumeWaiters = new Map<string, () => void>();
```

`resolveWinners`의 2단계 블록(`if (tournamentInfo.isRegistrationOpen && brokePlayerIds.length > 0) { … }` 전체, 기존 긴 주석 포함)을 바꾼다. **기존 블록 주석(판이 멈춘 이유를 스냅샷에 남긴다 …)은 `askRebuys`의 docblock으로 옮긴다.**

```ts
    // 2. 리바인 — 락 밖. 전원에게 동시에 묻고 같은 마감을 준다.
    //    수락한 사람은 남을 기다리지 않고 그 즉시 반영·전파된다.
    if (tournamentInfo.isRegistrationOpen && brokePlayerIds.length > 0) {
      await this.askRebuys(tournamentId, tableId, brokePlayerIds, tournamentInfo);
    }
```

`resolveWinners` 아래에 메서드 넷을 둔다.

```ts
  /**
   * 파산자에게 리바인을 묻는다. **장애가 끼면 딜러가 판을 다시 열 때 다시 묻는다**(T100).
   *
   * (여기에 기존 2단계 블록 주석 「판이 멈춘 이유를 스냅샷에 남긴다 …」를 옮긴다.)
   *
   * **자격은 핸드 끝에 정해진다.** `isRegistrationOpen`을 다시 읽지 않는다 — 재개가
   * 늦어 리바인 레벨이 지났어도, 장애가 그 자격을 빼앗으면 막으려는 결함이다.
   *
   * **다시 묻는 대상은 중단 ∧ 아직 앉아 있음 ∧ 스택 ≤ 0.** 대기 중 킥된 사람과,
   * 칩 쓰기가 오프라인 큐에서 늦게 들어간 사람(이중 지급)을 거른다.
   */
  private async askRebuys(
    tournamentId: string,
    tableId: string,
    brokePlayerIds: string[],
    tournamentInfo: Dashboard,
  ) {
    const outage = this.redis.outage;
    this.rebuyInFlight.add(tableId);
    try {
      let asked = brokePlayerIds;
      while (asked.length > 0) {
        const generation = outage.generation;
        const outcomes = await this.askRebuyRound(tournamentId, tableId, asked, tournamentInfo, generation);
        const interrupted = asked.filter((_, i) => outcomes[i] === 'interrupted');
        if (interrupted.length === 0) break;

        const stoppedAt = Date.now();
        // **대기를 먼저 건다**(검수 D2). `resumePending`을 쓴 뒤에 걸면 그 사이에
        // 누른 재개가 풀 대상을 못 찾고, 이 고리는 영영 기다린다. 먼저 걸면 그
        // 전의 재개는 `resumePending`이 없어 `resumeTable`이 거절한다.
        const resumed = new Promise<void>((resolve) => this.resumeWaiters.set(tableId, resolve));
        await this.holdForDealer(tableId, stoppedAt);
        await resumed;
        asked = await this.stillBroke(tableId, interrupted);
      }
    } finally {
      this.rebuyInFlight.delete(tableId);
      this.resumeWaiters.delete(tableId);
      // **어떻게 끝나든 지운다.** 수락·거절·시간초과가 각각 다른 자리에서
      // 끝나고(`processRebuy`), 그중 하나가 던져도 표시가 남으면 다음 핸드가
      // 도는 내내 화면이 「리바인을 기다립니다」를 띄운다.
      await this.playsync.markRebuyPending(tableId, null);
    }
  }

  /** 한 판 묻는다. 표시를 못 세운 것이 장애 때문이면 전원 중단이다(검수 D3). */
  private async askRebuyRound(
    tournamentId: string,
    tableId: string,
    asked: string[],
    tournamentInfo: Dashboard,
    generation: number,
  ): Promise<RebuyOutcome[]> {
    try {
      await this.playsync.markRebuyPending(tableId, asked);
    } catch (error) {
      if (this.redis.outage.isUp()) throw error;
      return asked.map(() => 'interrupted' as const);
    }
    return Promise.all(
      asked.map(playerId =>
        this.playsync.processRebuy(
          tournamentId, tableId, playerId,
          tournamentInfo.entryFee, tournamentInfo.startStack, tournamentInfo.tournamentName,
          generation,
        ),
      ),
    );
  }

  /**
   * 복구를 기다려 테이블을 「딜러의 재개 대기」로 둔다. 복구 직후 또 끊겨 쓰기가
   * 던지면 다시 기다린다 — up인데 던진 것만 올린다(검수 D3).
   */
  private async holdForDealer(tableId: string, stoppedAt: number) {
    for (;;) {
      await this.redis.outage.whenUp();
      try {
        await this.playsync.markRebuyInterrupted(tableId, Date.now() - stoppedAt);
        return;
      } catch (error) {
        if (this.redis.outage.isUp()) throw error;
      }
    }
  }

  /** 다시 물을 사람 — 아직 앉아 있고 스택이 없다(검수 D4). */
  private async stillBroke(tableId: string, ids: string[]): Promise<string[]> {
    const state = await this.redis.getSnapShot(tableId);
    if (!state) throw new Error(SNAPSHOT_MISSING);
    return ids.filter(id => {
      const player = state.players.find(p => p?.id === id);
      return player != null && player.stack <= 0;
    });
  }
```

`Dashboard` 타입이 이 파일에 import돼 있지 않으면 `import { Dashboard } from 'shared/types/tournamentMeta';`를 더한다(`playsync.service.ts`와 같은 경로).

`retryCheckpoint`의 페이즈 검사 바로 뒤에:

```ts
    // 리바인 고리가 도는 동안은 받지 않는다(T100). `finishHand`가 판을 넘기면
    // 재개 뒤의 리바인 칩과 탈락 확정이 다음 핸드 위에서 돈다.
    if (this.rebuyInFlight.has(tableId)) {
      throw new Error('리바인을 기다리는 중입니다.');
    }
```

`resumeTable`의 `if (!next) throw …` 뒤, `return next;` 앞에:

```ts
    // 장애로 끊긴 리바인이 이 재개를 기다리고 있으면 푼다(T100).
    const waiter = this.resumeWaiters.get(tableId);
    if (waiter) {
      this.resumeWaiters.delete(tableId);
      waiter();
    }
```

- [ ] **Step 5: 통과 확인**

Run: `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- dealer.service`
Expected: PASS

- [ ] **Step 6: 게이트웨이 — 실패하는 검사**

`ws.gateway.int-spec.ts`의 `describe('Redis 장애 (T97)')` 안, 「up이면 거절하지 않는다 (반대 입력)」 뒤에:

```ts
    it('down이면 리바인 응답을 즉시 거절하고 흘려보내지 않는다 (T100)', async () => {
      const seat = await connect(await seatTicket('alice'));
      const emit = jest.spyOn((gateway as any).eventEmitter, 'emit');
      outage().phase = 'down';

      const res = gateway.handleRebuyResponse(seat, { accept: true });

      expect(res).toEqual({ event: 'error', data: SERVER_RECOVERING_MESSAGE });
      expect(emit.mock.calls.some(([name]) => String(name).startsWith('rebuy_res_'))).toBe(false);
      emit.mockRestore();
    });

    it('up이면 리바인 응답을 흘려보낸다 (반대 입력, T100)', async () => {
      const seat = await connect(await seatTicket('alice'));
      const emit = jest.spyOn((gateway as any).eventEmitter, 'emit');

      const res = gateway.handleRebuyResponse(seat, { accept: true });

      expect(res).toBeUndefined();
      expect(emit).toHaveBeenCalledWith('rebuy_res_alice', true);
      emit.mockRestore();
    });
```

`seatTicket('alice')`로 붙은 소켓의 `userId`가 `'alice'`가 아니면(파일의 헬퍼를 확인한다) 기대값의 이벤트 이름을 그 값으로 맞춘다.

- [ ] **Step 7: 실패 확인**

Run: `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- ws.gateway`
Expected: FAIL — 첫 검사 `Received: undefined`

- [ ] **Step 8: 게이트웨이 구현**

`handleRebuyResponse` 맨 앞(스키마 검사 앞)에:

```ts
    // T100. 장애 중의 응답은 받아도 반영할 수 없다 — 칩을 넣는 첫 쓰기가 Redis다.
    // 누른 사람에게 이유를 돌려주고, 판은 딜러가 다시 열 때 새로 묻는다.
    if (!this.redis.outage.isUp()) return { event: 'error', data: SERVER_RECOVERING_MESSAGE };
```

- [ ] **Step 9: 통과 확인**

Run: `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- ws.gateway`
Expected: PASS

- [ ] **Step 10: 시나리오 — `src/scenario/rebuy-outage.int-spec.ts`**

```ts
import { ActionType, GamePhase } from 'src/game-engine/types';
import { checkInvariants, Harness, SCENARIO, setupTournament } from './harness';

/**
 * T100 — 리바인 창에 Redis만 죽었다 돌아온다.
 *
 * 스텁은 없다. 장애는 실제 ioredis 클라이언트를 `disconnect(true)`로 끊고
 * `retryStrategy`로 돌아올 시각을 쥔다(T97 시나리오와 같다). 딜러의 n/n은
 * 게이트웨이의 일이라 하네스에 없다 — `completeSync`를 직접 불러 대신한다.
 *
 * 단계마다 칩 총량과 포인트를 본다. 리바인은 칩이 정당하게 느는 유일한 경로라
 * 반영된 순간에만 기대값을 올린다.
 */
describe('시나리오 — 리바인 창에 Redis가 죽는다', () => {
  const PLAYERS = ['a', 'b', 'winner'];
  const STACKS: Record<string, number> = { a: 1000, b: 1000, winner: 10000 };
  const HOLD_MS = 1500;

  async function until(pred: () => boolean | Promise<boolean>, ms = 8000) {
    const start = Date.now();
    while (!(await pred())) {
      if (Date.now() - start > ms) throw new Error('until timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  function latch() {
    let open!: () => void;
    const opened = new Promise<void>((r) => { open = r; });
    return { open, opened };
  }
  const pointsOf = async (h: Harness, id: string) =>
    (await h.prisma.user.findUniqueOrThrow({ where: { id } })).points;
  const statusOf = async (h: Harness, id: string) =>
    (await h.prisma.tournamentParticipation.findFirstOrThrow({ where: { tournamentId: h.tournamentId, userId: id } })).status;

  async function bustAandB(h: Harness) {
    const state = await h.snapshot();
    for (const p of state.players) if (p) p.stack = STACKS[p.id];
    await h.saveSnapshot(state);
    await h.dealer.startPreFlop(h.tournamentId, h.tableId);
    for (let guard = 0; guard < 20; guard++) {
      const s = await h.snapshot();
      if (s.phase === GamePhase.SHOWDOWN) break;
      const id = h.turnId(s);
      if (!id) break;
      const me = s.players[h.seatOf(s, id)]!;
      const target = Math.min(me.stack + me.bet, 1000);
      const action = target > s.currentBet ? ActionType.RAISE : ActionType.CALL;
      await h.playsync.handleAction(id, h.tableId,
        { action, ...(action === ActionType.RAISE ? { amount: target } : {}) } as never);
    }
  }

  function outage(h: Harness) { return h.redisService.outage; }
  async function dropFor(h: Harness) {
    h.redis.options.retryStrategy = () => HOLD_MS;
    h.redis.disconnect(true);
    await until(() => outage(h).phase === 'down');
  }

  describe('창이 열린 채 끊긴다', () => {
    let h: Harness;
    let chips = STACKS.a + STACKS.b + STACKS.winner;
    const prompts: { userId: string; deadline: number }[] = [];

    beforeAll(async () => {
      process.env.REBUY_TIMEOUT_MS = '60000';
      h = await setupTournament(PLAYERS, { registrationOpen: true });
      h.emitter.on('rebuy.request.sent', (p: { userId: string; deadline: number }) => { prompts.push(p); });
    });
    afterAll(async () => {
      delete process.env.REBUY_TIMEOUT_MS;
      await h.close();
    });

    it('1~6. 장애 중엔 아무것도 확정하지 않고, 딜러가 재개해야 다시 묻는다', async () => {
      await bustAandB(h);
      await checkInvariants(h, '1. 쇼다운', chips);
      const aPoints = await pointsOf(h, 'a');

      const settling = h.dealer.resolveWinners(h.tableId, h.tournamentId, [['winner']]);

      // 1~2. 둘에게 묻고, b는 up일 때 거절한다
      await until(() => prompts.filter(p => p.userId === 'a').length === 1 && prompts.some(p => p.userId === 'b'));
      h.emitter.emit('rebuy_res_b', false);
      const firstDeadline = prompts.find(p => p.userId === 'a')!.deadline;

      // 3. 끊는다 — a의 대기는 마감(60초)을 기다리지 않고 끝난다
      await dropFor(h);
      await until(() => outage(h).isUp());   // 복구 스윕이 markRecovered

      // 4. 돌아왔다 — 재개 대기가 서고, 다시 묻지 않는다
      await until(async () => (await h.snapshot()).resumePending !== undefined);
      const paused = await checkInvariants(h, '4. 재개 대기', chips);
      expect(`4. 리바인표시 ${paused.rebuyPending === undefined} a스택 ${paused.players[h.seatOf(paused, 'a')]!.stack} a포인트 ${await pointsOf(h, 'a') === aPoints} a묻기 ${prompts.filter(p => p.userId === 'a').length} a상태 ${await statusOf(h, 'a')}`)
        .toBe('4. 리바인표시 true a스택 0 a포인트 true a묻기 1 a상태 PLAYING');

      // 5. n/n(하네스는 직접) → 재개 → a에게만 새 마감으로 묻는다
      await h.recovery.completeSync(h.tournamentId);
      h.emitter.once('rebuy.request.sent', ({ userId }: { userId: string }) => {
        setImmediate(() => h.emitter.emit(`rebuy_res_${userId}`, true));
      });
      await h.dealer.resumeTable(h.tableId);
      await settling;

      const aPrompts = prompts.filter(p => p.userId === 'a');
      expect(`5. a묻기 ${aPrompts.length} 새마감 ${aPrompts[1]!.deadline !== firstDeadline} b묻기 ${prompts.filter(p => p.userId === 'b').length}`)
        .toBe('5. a묻기 2 새마감 true b묻기 1');

      // 6. a는 한 번 반영되고 한 번 빠졌다. b는 탈락했다.
      chips += SCENARIO.startStack;
      const after = await checkInvariants(h, '6. 재개 뒤 수락', chips);
      expect(`6. a스택 ${after.players[h.seatOf(after, 'a')]!.stack} a차감 ${aPoints - (await pointsOf(h, 'a'))} b상태 ${await statusOf(h, 'b')}`)
        .toBe(`6. a스택 ${SCENARIO.startStack} a차감 ${SCENARIO.entryFee} b상태 ELIMINATED`);
    });
  });

  describe('수락이 락 안에 들어간 뒤 끊긴다', () => {
    let h: Harness;
    let chips = STACKS.a + STACKS.b + STACKS.winner;

    beforeAll(async () => {
      process.env.REBUY_TIMEOUT_MS = '60000';
      h = await setupTournament(PLAYERS, { registrationOpen: true });
    });
    afterAll(async () => {
      delete process.env.REBUY_TIMEOUT_MS;
      await h.close();
    });

    it('7. DB가 한 번도 불리지 않고, 재개 뒤 다시 물어 한 번만 반영된다', async () => {
      await bustAandB(h);
      const aPoints = await pointsOf(h, 'a');
      const tx = jest.spyOn(h.playsync, 'executeRebuyTransaction');

      // 수락한 a의 칩 쓰기를 락 안(스냅샷 읽기)에서 붙잡는다.
      const entered = latch();
      const gate = latch();
      let armed = false;
      const read = h.redisService.getSnapShot.bind(h.redisService);
      const hold = jest.spyOn(h.redisService, 'getSnapShot').mockImplementation(async (id: string) => {
        if (armed) { armed = false; entered.open(); await gate.opened; }
        return read(id);
      });

      let round = 0;
      h.emitter.on('rebuy.request.sent', ({ userId }: { userId: string }) => {
        setImmediate(() => {
          if (userId === 'b') return h.emitter.emit('rebuy_res_b', false);
          round += 1;
          if (round === 1) armed = true;
          h.emitter.emit('rebuy_res_a', true);
        });
      });

      const settling = h.dealer.resolveWinners(h.tableId, h.tournamentId, [['winner']]);
      await entered.opened;
      await dropFor(h);
      gate.open();

      await until(() => outage(h).isUp());
      await until(async () => (await h.snapshot()).resumePending !== undefined);
      expect(`7. 재개 전 DB ${tx.mock.calls.length} 포인트 ${await pointsOf(h, 'a') === aPoints}`).toBe('7. 재개 전 DB 0 포인트 true');

      hold.mockRestore();
      await h.recovery.completeSync(h.tournamentId);
      await h.dealer.resumeTable(h.tableId);
      await settling;

      chips += SCENARIO.startStack;
      const after = await checkInvariants(h, '7. 재개 뒤', chips);
      expect(`7. DB ${tx.mock.calls.length} a스택 ${after.players[h.seatOf(after, 'a')]!.stack} a차감 ${aPoints - (await pointsOf(h, 'a'))}`)
        .toBe(`7. DB 1 a스택 ${SCENARIO.startStack} a차감 ${SCENARIO.entryFee}`);
    });
  });
});
```

`h.recovery.completeSync`는 대회가 `SYNCING`일 때만 `true`다. 끊김이 `onRedisDown`으로 대회를 켜므로 켜져 있어야 한다 — 아니면 `false`를 돌려줄 뿐 검사에는 영향이 없다. `checkInvariants`가 `HAND_END`의 팟 0을 허용하지 않으면 그 호출의 단계만 스냅샷 단언으로 바꾼다(`harness.ts`의 `checkInvariants`를 읽고 판단한다).

- [ ] **Step 11: 시나리오 실행**

Run: `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- rebuy-outage`
Expected: PASS (2 tests)

- [ ] **Step 12: 실패를 먼저 본다(사후)**

1. `askRebuys`에서 `await resumed;`를 지운다 → 시나리오 4(「a묻기 1」)와 dealer 스펙 「재개 전에는 다시 묻지 않고」가 빨개지는지 → 복원
2. `retryCheckpoint`의 `rebuyInFlight` 검사를 지운다 → 「리바인 고리가 도는 동안 체크포인트 재시도는 거절한다」가 빨개지는지 → 복원
3. `stillBroke`의 `player.stack <= 0` 조건을 지운다 → 「중단 뒤 칩이 이미 들어가 있으면 다시 묻지 않는다」가 빨개지는지 → 복원
4. 게이트웨이 가드를 지운다 → 「down이면 리바인 응답을 즉시 거절」이 빨개지는지 → 복원

- [ ] **Step 13: 넓게 돌린다**

Run: `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- dealer playsync ws.gateway scenario recovery`
Expected: PASS, `MaxListenersExceededWarning` 없음

Run: `npm run test -w backend` · `npm run typecheck`
Expected: PASS · 0

- [ ] **Step 14: Commit**

```bash
git add backend/src/dealer/dealer.service.ts backend/src/dealer/dealer.service.int-spec.ts backend/src/ws/ws.gateway.ts backend/src/ws/ws.gateway.int-spec.ts backend/src/scenario/rebuy-outage.int-spec.ts
git commit -m "fix(T100): 장애가 끊은 리바인은 딜러가 판을 다시 열 때 다시 묻는다"
```

---

### Task 3: 좌석 팝업 — 장애·재개 대기 동안 막는다

**Files:**
- Modify: `frontend/src/app/(terminal)/table/[tableId]/RebuyOverlay.tsx`
- Modify: `frontend/src/app/(terminal)/table/[tableId]/SeatGameClient.tsx`
- Modify: `frontend/src/app/(terminal)/table/[tableId]/SeatGameClient.test.tsx`

**Interfaces:**
- Consumes: `useTableSocket().outage`(T97) · `TableState.resumePending`(T95) · 계약 `SERVER_RECOVERING_MESSAGE`. 백엔드는 재개 뒤 `REBUY_PROMPT`를 새 `deadline`으로 다시 보낸다(Task 2)
- Produces: `RebuyOverlay`의 새 prop `blockedReason?: string | null` — 있으면 두 버튼 `disabled`, 카운트다운을 그리지 않고 그 문구를 팝업 안에 그린다

- [ ] **Step 1: 실패하는 검사**

`SeatGameClient.test.tsx`의 `describe('리바인 응답 — 소켓이 닫혀 있을 때')` 뒤에 붙인다. 파일 위쪽 import에 `SERVER_RECOVERING_MESSAGE`가 없으면 `import { SERVER_RECOVERING_MESSAGE } from '@playsync/contract';`를 더한다.

```tsx
  /**
   * T100. 장애 중의 리바인 응답은 서버가 받아도 반영할 수 없다. 팝업이 열려
   * 있으면 사람은 누르고, 누른 것은 조용히 사라진다 — 그래서 막고 이유를 적는다.
   * 재개 대기(`resumePending`) 동안도 같다: 복구는 됐지만 서버의 그 판은 이미
   * 끝나 있어 받을 곳이 없고, 딜러가 다시 열면 새 프롬프트가 온다.
   */
  describe('리바인 팝업 — 장애와 재개 대기 (T100)', () => {
    it('장애 중에는 두 버튼이 막히고 장애 문구가 팝업 안에 뜬다', async () => {
      const { socket } = await renderWithSocket();
      socket.emitServerEvent('REBUY_PROMPT', { deadline: Date.now() + 30_000, entryFee: 50_000 });
      await screen.findByRole('button', { name: '리바인' });

      socket.emitServerEvent('serverOutage', { down: true });

      await waitFor(() => expect(screen.getByRole('button', { name: '리바인' })).toBeDisabled());
      expect(screen.getByRole('button', { name: '거절' })).toBeDisabled();
      expect(screen.getAllByText(SERVER_RECOVERING_MESSAGE).length).toBeGreaterThan(0);
    });

    it('재개 대기 중에는 두 버튼이 막히고 딜러를 기다린다고 적는다', async () => {
      const { socket } = await renderWithSocket();
      socket.emitServerEvent('REBUY_PROMPT', { deadline: Date.now() + 30_000, entryFee: 50_000 });
      await screen.findByRole('button', { name: '리바인' });

      socket.emitServerEvent('renderGame', { ...BASE_STATE, resumePending: { downMs: 30_000 } });

      await waitFor(() => expect(screen.getByRole('button', { name: '리바인' })).toBeDisabled());
      expect(screen.getByText(/딜러가 판을 다시 열면 다시 묻습니다/)).toBeInTheDocument();
    });

    it('둘 다 없으면 누를 수 있다 (반대 입력)', async () => {
      const { socket } = await renderWithSocket();
      socket.emitServerEvent('REBUY_PROMPT', { deadline: Date.now() + 30_000, entryFee: 50_000 });

      expect(await screen.findByRole('button', { name: '리바인' })).toBeEnabled();
      expect(screen.getByRole('button', { name: '거절' })).toBeEnabled();
    });

    it('거절로 탈락 화면이 떴어도 새 프롬프트가 오면 걷고 다시 묻는다', async () => {
      const { socket } = await renderWithSocket();
      socket.emitServerEvent('REBUY_PROMPT', { deadline: Date.now() + 30_000 });
      await userEvent.click(await screen.findByRole('button', { name: /거절/ }));
      await screen.findByRole('button', { name: /지금 돌아가기/ });

      socket.emitServerEvent('REBUY_PROMPT', { deadline: Date.now() + 45_000 });

      expect(await screen.findByRole('button', { name: '리바인' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /지금 돌아가기/ })).not.toBeInTheDocument();
    });
  });
```

`waitFor`가 import돼 있지 않으면 `@testing-library/react` import에 더한다.

- [ ] **Step 2: 실패 확인**

Run: `npm run test -w frontend -- SeatGameClient`
Expected: FAIL — 첫 둘 `toBeDisabled`, 넷째 「지금 돌아가기」가 남음

- [ ] **Step 3: `RebuyOverlay.tsx` 구현**

props에 추가:

```tsx
  /**
   * 지금은 답할 수 없는 이유(T100). 있으면 두 버튼을 막고 카운트다운 대신 이
   * 문구를 그린다 — 서버 장애 중이거나, 복구 뒤 딜러가 판을 다시 열기를 기다리는
   * 중이다. 그 동안 누른 응답은 받을 곳이 없어 조용히 사라진다.
   */
  blockedReason?: string | null;
```

함수 인자에 `blockedReason = null,`을 더하고, 카운트다운 블록과 버튼을 바꾼다.

```tsx
        {blockedReason ? (
          <p role="status" data-testid="rebuy-blocked" className="mt-3 border border-tb-line px-3 py-2 text-sm text-tb-sub">
            {blockedReason}
          </p>
        ) : (
          <div className="mt-3">
            <ActionTimer key={rebuyData.deadline} deadline={rebuyData.deadline} />
          </div>
        )}

        <div className="mt-5 flex gap-2.5">
          <button
            type="button"
            disabled={blockedReason !== null}
            onClick={() => onRespond(false)}
            className="h-14 flex-1 border border-tb-line text-sm text-tb-muted disabled:opacity-40"
          >
            거절
          </button>
          <button
            type="button"
            disabled={blockedReason !== null}
            onClick={() => onRespond(true)}
            className="h-14 flex-1 border border-tb-act bg-tb-act text-sm font-semibold text-[#06201a] disabled:opacity-40"
          >
            리바인
          </button>
        </div>
```

- [ ] **Step 4: `SeatGameClient.tsx` 구현**

import에 `SERVER_RECOVERING_MESSAGE`를 더한다(`@playsync/contract`). 파일 위쪽 상수들 옆에:

```tsx
/** 복구 뒤 딜러의 재개를 기다리는 동안 리바인 팝업에 적는다(T100). */
const REBUY_WAIT_DEALER = '딜러가 판을 다시 열면 다시 묻습니다.';
```

`onMessage`의 `REBUY_PROMPT` 분기를 바꾼다.

```tsx
      } else if (serverEvent === 'REBUY_PROMPT') {
        setRebuyError(null);
        // **거절로 그린 탈락 화면을 걷는다**(T100). 장애 알림이 오기 직전에
        // 거절을 눌렀는데 서버가 이미 끊겨 받지 않았으면, 딜러가 판을 다시 열 때
        // 새 프롬프트가 온다. 좌석 소멸로 난 진짜 탈락 뒤에는 프롬프트가 오지 않는다.
        setExitReason((prev) => (prev === 'eliminated' ? null : prev));
        updateRebuyData(data as RebuyPrompt);
```

`resumePending` 선언(`const resumePending = gameState?.resumePending;`) 아래에:

```tsx
  // 리바인 팝업을 막는 이유(T100). 장애가 먼저다 — 둘 다면 원인이 장애다.
  const rebuyBlockedReason = outage ? SERVER_RECOVERING_MESSAGE : resumePending ? REBUY_WAIT_DEALER : null;
```

`RebuyOverlay` 렌더에 prop을 넘긴다.

```tsx
        <RebuyOverlay
          rebuyData={rebuyData}
          error={rebuyError}
          blockedReason={rebuyBlockedReason}
          onRespond={handleRebuyResponse}
        />
```

`setExitReason`의 상태 타입이 함수형 갱신을 받지 않는 커스텀 setter면 그 모양에 맞춘다(지금 `useState`면 그대로 된다).

- [ ] **Step 5: 통과 확인**

Run: `npm run test -w frontend -- SeatGameClient`
Expected: PASS

- [ ] **Step 6: 실패를 먼저 본다(사후)**

1. `rebuyBlockedReason`을 `null` 고정으로 → 첫 둘이 빨개지는지 → 복원
2. `setExitReason((prev) => …)` 줄을 지운다 → 넷째가 빨개지는지 → 복원

- [ ] **Step 7: 넓게 돌린다**

Run: `npm run test -w frontend` · `npm run typecheck`
Expected: PASS · 0

- [ ] **Step 8: Commit**

```bash
git add "frontend/src/app/(terminal)/table/[tableId]/RebuyOverlay.tsx" "frontend/src/app/(terminal)/table/[tableId]/SeatGameClient.tsx" "frontend/src/app/(terminal)/table/[tableId]/SeatGameClient.test.tsx"
git commit -m "fix(T100): 장애와 재개 대기 동안 리바인 팝업을 막고, 다시 묻는 프롬프트가 거절 탈락 화면을 걷는다"
```

---

## 메인이 할 일 (하위 에이전트 몫이 아니다)

1. 최종 전체 리뷰(opus) — 위 「검수」의 D1~D6이 실제로 막혔는지를 함께 보게 한다
2. 기준선 실측 — contract · 백엔드 단위 · 프론트 단위 · 통합 · 부하 하네스(`test:outage`는 이 PR이 안 건드리므로 선택)
3. SSOT 커밋 — `tickets-recovery.md`(T100 행 · 완료 절 · 잔여 목록의 「장애 중 리바인 창」 닫음 · 스펙 「범위 밖」 추가), `domain.md`(「사람을 기다리는 상태가 둘 있다」에 장애가 낀 리바인, 「닫힌 대회에는 아무것도 쓰지 않는다」에 리바인의 쓰는 순서와 `retryCheckpoint`의 메모리 문지기), `CLAUDE.md` 기준선
4. PR 열고 번호를 상태 열에 반영해 커밋, 머지
