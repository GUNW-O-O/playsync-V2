# T130 접기 전에 딜러를 확인한다 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 턴 시간 초과와 리바인 시간 초과가 사람을 접기·탈락시키기 **직전에** 그 테이블의 딜러가 살아 있는지 확인하고, 답이 없으면 접지 않는다. 대신 2초 딜러 확인(`probeDealers`)을 걷어낸다.

**Architecture:** 감지를 앞당기는 대신 「모르는 동안에는 접지 않는다」로 바꾼다. 게이트웨이가 테이블의 딜러 소켓에 ping을 보내 pong을 기다리는 확인(`confirmDealer`)을 프로세스 메모리의 등록부(`DealerLiveness`, `LinePause`와 같은 자리)에 건다. 타임아웃 워커와 리바인 대기가 그 등록부로 묻는다. 답이 없으면 타임아웃 잡은 같은 id로 지연 상태로 돌아가 2초 뒤 다시 묻고, 리바인은 `dealerSilent`로 끝나 기존 「딜러의 재개 뒤 다시 묻기」 길을 탄다. 회선이 끊긴 대회는 테이블마다 이렇게 서 있다가, 10초 청소가 딜러 소켓을 전부 끊으면 기존 `pauseIfNoDealer`가 대회를 `SYNCING`으로 멈춘다.

**Tech Stack:** NestJS · `ws` · BullMQ 5 (`DelayedError`, `job.moveToDelayed`) · jest

**Spec:** 별도 문서 없음. 결정은 2026-10-13 대화에서 했고 아래 「결정」에 옮긴다. 근거 실측은 [`docs/results/2026-10-13-standard-stage.md`](../../results/2026-10-13-standard-stage.md) — 556테이블 대회 20초 끊김에서 서버가 알기 전(5.6초 안)의 폴드 1건.

## 결정

| | 정한 것 | 왜 |
|---|---|---|
| 확인 대상 | **그 테이블의 딜러 소켓**(대회 전체가 아니다) | 딜러 태블릿 하나가 꺼지면 그 테이블만 서고 나머지는 돈다. 회선이 끊기면 테이블이 하나씩 서다가 청소가 대회를 멈춘다 |
| 확인 방법 | 그 순간 ping → pong을 `DEALER_CONFIRM_MS`(1,500ms)까지 기다린다 | 문제가 없을 때는 서버가 한가해 수십 ms에 끝난다. 실측 고원 lag p99 1ms, 재접속 피크 500ms |
| 딜러 소켓이 없거나 답이 없다 | 턴: 접지 않고 `TIMEOUT_HOLD_MS`(2,000ms) 뒤 다시 묻는다. 리바인: `dealerSilent` → 딜러의 재개 뒤 다시 묻는다 | 돈이 걸린 판정 두 곳 |
| 2초 딜러 확인 | **지운다.** 좀비 판정은 10초 청소 하나 | 회선 감지는 10~20초로 늦어지지만 그동안 아무도 안 접힌다. 블라인드 정지 시작점이 최대 10초 이르게 잡힌다(감수) |
| 게이트웨이가 없는 프로세스 | 확인을 통과시킨다(`true`) | 시나리오 · 통합 테스트는 게이트웨이 없이 PlaysyncService를 세운다. 운영은 늘 `WsModule`이 선다 |

## Global Constraints

- 코드 주석 · 테스트 이름 · 로그는 **한국어**, 기존 파일의 말투(「~다」)를 따른다. 코드는 **이름으로** 가리킨다(줄 번호 금지).
- 테스트 단언은 **값을 문자열로 감싼다**(`expect(\`단계 ${x}\`).toBe('단계 1')`) — 실패 메시지에 단계 이름이 남게.
- 새 검사는 **실패를 먼저 본다.** 처음부터 초록이면 제품 코드를 되돌려 빨간불을 확인한다.
- 하위 에이전트는 `docs/`와 `CLAUDE.md`를 만지지 않는다(Task 6은 메인).
- 계약(`packages/contract`)은 바꾸지 않는다 — 리바인 정지 사유는 기존 `'lineDown'`을 쓴다.
- 브랜치: `load-1000`이 머지된 뒤 최신 `main`에서 `t130-confirm-before-fold`.

## Review Focus

1. **딜러 태블릿만 꺼진 테이블** — 회선은 멀쩡하고 그 테이블 딜러만 없다. 그 테이블의 시간 초과가 접지 않고 서 있고, 같은 대회의 다른 테이블은 평소대로 접혀야 한다(Task 4에 테스트).
2. **잡이 서 있는 사이 차례가 넘어갔다** — 플레이어가 늦게 눌러 세대가 올랐다. 서 있던 잡이 다시 깨어나도 접지 않고 영원히 돌지도 않아야 한다(Task 4의 세대 사전 검사).
3. **짧은 흔들림** — 딜러가 1초 늦게 답했다. 확인 안에 답이 오면 그대로 접는다(Task 3의 「늦게 와도 기다리는 동안이면 true」).
4. **확인을 기다리는 사이 리바인 수락이 도착** — 마감 직후 1.5초 안의 수락은 받아들여진다(`settle`이 한 번만). Task 5에 테스트.
5. **게이트웨이가 내려간 뒤(`onModuleDestroy`)의 확인** — 등록이 풀려 `true`로 돌아간다. 닫힌 소켓에 ping하지 않는다(Task 2 · Task 3).

---

## File Structure

| 파일 | 하는 일 |
|---|---|
| `backend/src/ws/keepalive.ts` (수정) | `awaitPong` · `answerPongWaiters` 추가. `probe` · `isSilent` · `DEALER_PROBE_MS` · `DEALER_SILENT_PROBES` · `dealerProbeMs` 삭제 |
| `backend/src/redis/dealer-liveness.ts` (새) | 등록부. 게이트웨이가 확인 함수를 걸고, 워커 · 리바인이 묻는다 |
| `backend/src/redis/redis.service.ts` (수정) | `dealerLiveness` 필드 (`linePause`와 같은 자리) |
| `backend/src/ws/ws.gateway.ts` (수정) | `confirmDealer` · 등록/해제 · `onPong`이 대기자를 깨운다. `probeDealers` · 확인 타이머 · `isSilent` 사용처 삭제 |
| `backend/src/playsync/timeout.processor.ts` (수정) | 세대 사전 검사 · 확인 · 지연 복귀 |
| `backend/src/playsync/playsync.service.ts` (수정) | `RebuyOutcome`에 `'dealerSilent'`, 리바인 마감에서 확인 |
| `backend/src/dealer/dealer.service.ts` (수정) | `askRebuys`가 `dealerSilent`를 다시 묻는 쪽으로, 사유 `lineDown` |
| `backend/src/recovery/recovery.service.ts` (수정) | `pauseForLineOutage` 주석의 `DEALER_PROBE_MS` 언급 |

---

### Task 1: `awaitPong` — 소켓 하나에 답을 기다린다

**Files:**
- Modify: `backend/src/ws/keepalive.ts`
- Test: `backend/src/ws/keepalive.spec.ts`

**Interfaces:**
- Produces:
  - `export const DEALER_CONFIRM_MS = 1_500;`
  - `export function awaitPong(socket: KeepaliveSocket, ms: number): Promise<boolean>` — ping을 보내고 `ms` 안에 pong이 오면 `true`, 아니면 `false`. 열리지 않은 소켓은 곧바로 `false`.
  - `export function answerPongWaiters(socket: KeepaliveSocket): void` — pong을 받은 자리(`WsGateway.onPong`)가 부른다.
  - `KeepaliveSocket`에 `pongWaiters?: Set<() => void>` 추가. `probeSentAt` · `probeMisses` 삭제.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`keepalive.spec.ts`에서 `describe('딜러 빠른 확인', ...)` 블록을 통째로 지우고 같은 자리에 넣는다. import 줄은 `import { answerPongWaiters, awaitPong, markAlive, socketPingMs, sweep, SOCKET_PING_MS, KeepaliveSocket } from './keepalive';`로 바꾼다.

```ts
  /**
   * 접기 직전에 딜러에게 묻는다(T130). 2초마다 전 딜러를 확인하던 것을 그 순간의 확인
   * 하나로 바꿨다 — 모르는 동안에는 접지 않는다.
   */
  describe('awaitPong', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('기다리는 동안 pong이 오면 true다 — 늦게 와도 기다리는 동안이면', async () => {
      const s = fake();
      const answer = awaitPong(s, 1_500);
      jest.advanceTimersByTime(1_000);
      answerPongWaiters(s);
      expect(`답 ${await answer} ping ${s.pings}`).toBe('답 true ping 1');
    });

    /** 반대 입력 — 「언제나 true」가 위를 통과한다. */
    it('기다리는 동안 pong이 없으면 false다', async () => {
      const s = fake();
      const answer = awaitPong(s, 1_500);
      jest.advanceTimersByTime(1_500);
      answerPongWaiters(s); // 늦었다
      expect(`답 ${await answer}`).toBe('답 false');
    });

    it('열리지 않은 소켓에는 ping하지 않고 false다', async () => {
      const s = fake();
      s.readyState = 3;
      expect(`답 ${await awaitPong(s, 1_500)} ping ${s.pings}`).toBe('답 false ping 0');
    });

    it('ping이 던져도 던지지 않고 false다', async () => {
      const s = fake();
      s.ping = () => { throw new Error('boom'); };
      expect(`답 ${await awaitPong(s, 1_500)}`).toBe('답 false');
    });

    /** 끝난 대기는 남지 않는다 — 남으면 소켓마다 대기자가 쌓인다. */
    it('끝나면 대기자를 치운다', async () => {
      const s = fake();
      const a = awaitPong(s, 1_500);
      answerPongWaiters(s);
      await a;
      const b = awaitPong(s, 1_500);
      jest.advanceTimersByTime(1_500);
      await b;
      expect(`남은 대기 ${s.pongWaiters?.size ?? 0}`).toBe('남은 대기 0');
    });
  });
```

`fake()`가 `pings` 카운터를 이미 드는지 본다(기존 `probe` 테스트가 `s.pings`를 썼다). 없으면 `fake()`의 `ping`이 `this.pings++`하게 맞춘다.

- [ ] **Step 2: 실패를 본다**

Run: `npx jest -c backend/jest.config.ts backend/src/ws/keepalive.spec.ts` (루트에서. 설정 파일 이름이 다르면 `backend/package.json`의 `test` 스크립트를 따른다)
Expected: FAIL — `awaitPong is not a function` / import 에러

- [ ] **Step 3: 구현한다**

`keepalive.ts`에서 `probeSentAt` · `probeMisses` 필드와 그 주석, `DEALER_PROBE_MS` · `DEALER_SILENT_PROBES` · `dealerProbeMs` · `probe` · `isSilent`를 지운다. 인터페이스에 대기자를 넣고 아래를 추가한다.

```ts
  /** `awaitPong`이 기다리는 중(T130). pong이 오면 `answerPongWaiters`가 깨운다. */
  pongWaiters?: Set<() => void>;
```

```ts
/**
 * 접기 직전에 딜러에게 묻는 시간(T130). 문제가 없을 때 서버는 한가해 수십 ms에 답이
 * 온다 — 재접속 피크의 이벤트 루프 p99가 약 500ms라 그 세 배를 둔다.
 */
export const DEALER_CONFIRM_MS = 1_500;

/**
 * ping을 보내고 `ms` 안에 pong이 오면 true(T130). **끊지 않는다** — 답이 없다는 것만
 * 말한다. 끊는 것은 `sweep`의 일이다.
 */
export function awaitPong(socket: KeepaliveSocket, ms: number): Promise<boolean> {
  if (socket.readyState !== OPEN) return Promise.resolve(false);
  return new Promise((resolve) => {
    const waiters = (socket.pongWaiters ??= new Set());
    const done = (answer: boolean) => {
      clearTimeout(timer);
      waiters.delete(onPong);
      resolve(answer);
    };
    const onPong = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    waiters.add(onPong);
    try { socket.ping(); } catch { done(false); }
  });
}

/** pong을 받았다. 기다리던 확인을 전부 깨운다. */
export function answerPongWaiters(socket: KeepaliveSocket) {
  for (const fn of [...(socket.pongWaiters ?? [])]) fn();
}
```

- [ ] **Step 4: 통과를 본다**

Run: 위와 같은 명령
Expected: PASS. `ws.gateway.ts`는 아직 `probe` · `isSilent`를 import해 타입 체크가 깨진다 — Task 3에서 고친다. 이 태스크는 jest 단독 파일로만 본다.

- [ ] **Step 5: 커밋**

```bash
git add backend/src/ws/keepalive.ts backend/src/ws/keepalive.spec.ts
git commit -m "feat(T130): awaitPong — 접기 직전에 소켓 하나에 답을 기다린다"
```

---

### Task 2: `DealerLiveness` 등록부

**Files:**
- Create: `backend/src/redis/dealer-liveness.ts`
- Create: `backend/src/redis/dealer-liveness.spec.ts`
- Modify: `backend/src/redis/redis.service.ts`

**Interfaces:**
- Produces:
  - `export type DealerCheck = (tableId: string) => Promise<boolean>;`
  - `class DealerLiveness { attach(check: DealerCheck): () => void; confirm(tableId: string): Promise<boolean> }`
  - `export function dealerLivenessOf(client: object): DealerLiveness`
  - `RedisService.dealerLiveness: DealerLiveness` (readonly)

- [ ] **Step 1: 실패하는 테스트**

```ts
import { DealerLiveness, dealerLivenessOf } from './dealer-liveness';

describe('DealerLiveness (T130)', () => {
  /** 시나리오 · 통합 테스트는 게이트웨이 없이 서비스를 세운다. 물을 소켓 계층이 없다. */
  it('건 확인이 없으면 true다', async () => {
    expect(`답 ${await new DealerLiveness().confirm('t')}`).toBe('답 true');
  });

  it('건 확인에 묻는다 — 테이블 id를 그대로 넘긴다', async () => {
    const l = new DealerLiveness();
    const asked: string[] = [];
    l.attach(async (tableId) => { asked.push(tableId); return false; });
    expect(`답 ${await l.confirm('t1')} 물음 ${asked.join(',')}`).toBe('답 false 물음 t1');
  });

  /** 게이트웨이가 내려가면 그 확인은 죽은 소켓 방을 본다. */
  it('해제하면 다시 true다', async () => {
    const l = new DealerLiveness();
    const off = l.attach(async () => false);
    off();
    expect(`답 ${await l.confirm('t')}`).toBe('답 true');
  });

  /** 늦게 푼 낡은 해제가 새 등록을 지우면 안 된다(게이트웨이를 `new`로 여러 번 세우는 테스트). */
  it('낡은 해제는 새 등록을 건드리지 않는다', async () => {
    const l = new DealerLiveness();
    const offOld = l.attach(async () => true);
    l.attach(async () => false);
    offOld();
    expect(`답 ${await l.confirm('t')}`).toBe('답 false');
  });

  it('클라이언트 하나에 하나다', () => {
    const client = {};
    expect(`같다 ${dealerLivenessOf(client) === dealerLivenessOf(client)}`).toBe('같다 true');
  });
});
```

- [ ] **Step 2: 실패를 본다**

Run: `npx jest backend/src/redis/dealer-liveness.spec.ts` (Task 1과 같은 설정)
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`backend/src/redis/dealer-liveness.ts`:

```ts
/**
 * 접기 직전에 딜러가 살아 있는지 묻는 자리(T130). **프로세스 메모리에 산다.**
 *
 * 묻는 쪽(타임아웃 워커 · 리바인 대기)은 `PlaysyncModule`에 있고 답하는 쪽(소켓)은
 * 게이트웨이에 있다. 게이트웨이가 `PlaysyncService`에 기대므로 반대로 주입하면 고리가
 * 된다 — `LinePause`처럼 Redis 클라이언트에 붙은 등록부를 둘이 같이 본다.
 *
 * **건 확인이 없으면 true다.** 시나리오 · 통합 테스트는 게이트웨이 없이 서비스를 세운다.
 * 운영에서는 늘 `WsModule`이 서서 건다.
 *
 * `LinePause`와 같이 **인스턴스가 여럿이 되면 틀린다**(`backlog.md` B9).
 */
export type DealerCheck = (tableId: string) => Promise<boolean>;

export class DealerLiveness {
  private check: DealerCheck | null = null;

  /** 게이트웨이가 건다. 반환값을 부르면 푼다 — 그새 다른 확인이 걸렸으면 그대로 둔다. */
  attach(check: DealerCheck): () => void {
    this.check = check;
    return () => { if (this.check === check) this.check = null; };
  }

  /** 그 테이블의 딜러가 지금 답하나. */
  confirm(tableId: string): Promise<boolean> {
    return this.check ? this.check(tableId) : Promise.resolve(true);
  }
}

const registries = new WeakMap<object, DealerLiveness>();

/** 클라이언트 하나에 하나. `linePauseOf`와 같은 이유다. */
export function dealerLivenessOf(client: object): DealerLiveness {
  let l = registries.get(client);
  if (!l) {
    l = new DealerLiveness();
    registries.set(client, l);
  }
  return l;
}
```

`redis.service.ts` — `linePause` 선언 아래와 생성자에:

```ts
import { DealerLiveness, dealerLivenessOf } from "./dealer-liveness";
```

```ts
  /**
   * 접기 직전의 딜러 확인(T130). `linePause`와 같은 이유로 여기 둔다 — 게이트웨이가 걸고
   * 타임아웃 워커와 리바인 대기가 묻는다.
   */
  readonly dealerLiveness: DealerLiveness;
```

```ts
    this.dealerLiveness = dealerLivenessOf(redis);
```

- [ ] **Step 4: 통과를 본다** — 같은 명령, PASS

- [ ] **Step 5: 커밋**

```bash
git add backend/src/redis/dealer-liveness.ts backend/src/redis/dealer-liveness.spec.ts backend/src/redis/redis.service.ts
git commit -m "feat(T130): DealerLiveness — 게이트웨이가 걸고 워커가 묻는 딜러 확인 등록부"
```

---

### Task 3: 게이트웨이 — `confirmDealer`를 걸고 2초 확인을 걷어낸다

**Files:**
- Modify: `backend/src/ws/ws.gateway.ts`
- Modify: `backend/src/recovery/recovery.service.ts` (주석 한 문장)
- Test: `backend/src/ws/ws.gateway.int-spec.ts`

**Interfaces:**
- Consumes: `awaitPong`, `answerPongWaiters`, `DEALER_CONFIRM_MS` (Task 1), `RedisService.dealerLiveness` (Task 2)
- Produces: `WsGateway.confirmDealer(tableId: string): Promise<boolean>` (public — 테스트가 직접 부른다), 테스트용 필드 `dealerConfirmMs`

- [ ] **Step 1: 실패하는 테스트**

`ws.gateway.int-spec.ts`의 `describe('딜러 빠른 확인', ...)`을 다음으로 바꾼다.

- **지운다**: 「그 대회의 딜러가 연달아 두 번 답이 없으면 멈춘다」, 「한 대라도 답하고 있으면 안 멈춘다」, 「침묵한 딜러는 n/n에 안 세고, 답이 돌아오면 다시 세어 푼다」 — 2초 확인이 없어진다.
- **옮긴다**: 「상점이 강제로 푼 뒤에는 같은 침묵으로 다시 멈추지 않는다」(T126)와 「대회가 닫혀서 끊긴 딜러는 회선 기록을 다시 남기지 않는다」는 그대로 둔다. 본문이 `probeOnce`를 쓰면 같은 일을 청소로 한다 — `dealerClient.isAlive = false; gateway.sweepSockets();` 뒤 `await (gateway as any).syncQueue.enqueue(TOURNAMENT, async () => {})`. T126 테스트는 「푼 뒤 청소가 같은 `aliveAt`의 딜러를 끊어도 다시 안 멈춘다」를 본다. 바꾼 뒤 `RecoveryService`의 `forcedAt` 검사(`pauseIfNoDealer`의 `seenAt <= forcedAt`)를 잠시 지워 빨간불을 확인한다.
- **더한다** (describe 이름을 `'접기 직전의 딜러 확인 (T130)'`으로):

```ts
        /** 그 소켓이 pong을 보냈다 — `handleConnection`이 건 핸들러를 부른다. */
        const pong = (client: any) => client.on.mock.calls.find(([name]: [string]) => name === 'pong')[1]();

        it('그 테이블 딜러가 확인 안에 답하면 true다', async () => {
          await seedSyncingTournament(TournamentStatus.ONGOING);
          await seedSeats();
          const dealerClient = await connect(await dealerTicket(TABLE), TABLE);
          dealerClient.ping = jest.fn(() => setImmediate(() => pong(dealerClient)));

          expect(`답 ${await gateway.confirmDealer(TABLE)} ping ${dealerClient.ping.mock.calls.length}`).toBe('답 true ping 1');
        });

        /** 반대 입력 — 「언제나 true」가 위를 통과한다. 소켓은 끊지 않는다(끊는 것은 청소다). */
        it('답이 없으면 false다 — 소켓은 끊지 않는다', async () => {
          await seedSyncingTournament(TournamentStatus.ONGOING);
          await seedSeats();
          const dealerClient = await connect(await dealerTicket(TABLE), TABLE);
          dealerClient.ping = jest.fn();
          dealerClient.terminate = jest.fn();
          (gateway as any).dealerConfirmMs = 50;

          expect(`답 ${await gateway.confirmDealer(TABLE)} 끊음 ${dealerClient.terminate.mock.calls.length}`).toBe('답 false 끊음 0');
        });

        /** 딜러 태블릿이 꺼진 테이블 — 물을 소켓이 없다. 좌석 소켓은 딜러가 아니다. */
        it('그 테이블에 딜러 소켓이 없으면 false다 — 좌석만 있어도', async () => {
          await seedSyncingTournament(TournamentStatus.ONGOING);
          await seedSeats();
          await connect(await seatTicket(TABLE, 0), TABLE);

          expect(`답 ${await gateway.confirmDealer(TABLE)}`).toBe('답 false');
        });

        /** 다른 테이블의 딜러는 이 테이블의 증거가 아니다 — (a) 결정. */
        it('다른 테이블의 딜러만 답해도 false다', async () => {
          await seedSyncingTournament(TournamentStatus.ONGOING);
          await seedSeats();
          const other = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);
          other.ping = jest.fn(() => setImmediate(() => pong(other)));
          (gateway as any).dealerConfirmMs = 50;

          expect(`답 ${await gateway.confirmDealer(TABLE)}`).toBe('답 false');
        });

        it('게이트웨이가 확인을 등록부에 건다', async () => {
          await seedSyncingTournament(TournamentStatus.ONGOING);
          await seedSeats();
          gateway.onModuleInit();
          const dealerClient = await connect(await dealerTicket(TABLE), TABLE);
          dealerClient.ping = jest.fn(() => setImmediate(() => pong(dealerClient)));

          expect(`등록부 ${await redisService.dealerLiveness.confirm(TABLE)} ping ${dealerClient.ping.mock.calls.length}`).toBe('등록부 true ping 1');
          gateway.onModuleDestroy();
        });
```

이 파일에 `seatTicket` · `OTHER_TABLE` · `redisService` 이름이 없으면, 같은 파일에서 좌석 티켓을 만들고 두 번째 테이블을 시드하고 `RedisService`를 쥐는 기존 헬퍼를 찾아 그 이름으로 바꾼다(`grep -n "seatTicket\|OTHER\|new RedisService" backend/src/ws/ws.gateway.int-spec.ts`). 두 번째 테이블이 시드에 없으면 `seedSeats`가 쓰는 방식으로 하나 더 시드한다.

- [ ] **Step 2: 실패를 본다**

Run: `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- src/ws/ws.gateway.int-spec.ts -t "T130|강제로 푼|회선 기록"`
Expected: FAIL — `confirmDealer is not a function`

- [ ] **Step 3: 구현**

`ws.gateway.ts`:

1. import를 `import { answerPongWaiters, awaitPong, DEALER_CONFIRM_MS, markAlive, socketPingMs, sweep } from './keepalive';`로.
2. `probeTimer` 필드, `onModuleInit`의 확인 타이머 두 줄, `onModuleDestroy`의 `probeTimer` 정리, `probeDealers` 메서드를 통째로 지운다.
3. 필드와 등록:

```ts
  /** 접기 직전에 딜러를 기다리는 시간(T130). 테스트가 줄인다. */
  private dealerConfirmMs = DEALER_CONFIRM_MS;
  private detachLiveness: (() => void) | null = null;
```

`onModuleInit` 끝에:

```ts
    // 타임아웃 워커와 리바인 대기가 접기 직전에 묻는다(T130).
    this.detachLiveness = this.redis.dealerLiveness.attach((tableId) => this.confirmDealer(tableId));
```

`onModuleDestroy`에:

```ts
    this.detachLiveness?.();
    this.detachLiveness = null;
```

4. `onPong`을:

```ts
  /** pong을 받았다. 접기 직전의 확인이 기다리고 있으면 깨운다(T130). */
  private onPong(client: any) {
    markAlive(client);
    answerPongWaiters(client);
  }
```

5. `confirmDealer` (`hasDealer` 위에):

```ts
  /**
   * 그 테이블의 딜러가 지금 답하나(T130). 턴 · 리바인 시간 초과가 사람을 접기 **직전에**
   * 묻는다(`DealerLiveness`). 답이 없으면 접지 않는다 — 회선이 끊겼는지 아직 모르는
   * 동안에도 아무도 안 접힌다.
   *
   * **그 테이블의 딜러만 본다.** 딜러 태블릿 하나가 꺼지면 그 테이블만 서고 나머지는
   * 돈다. 회선이 끊기면 테이블이 하나씩 서다가, 청소(`sweepSockets`)가 딜러 소켓을 전부
   * 끊으면 `pauseIfNoDealer`가 대회를 멈춘다.
   *
   * 끊지 않는다. 열린 딜러 소켓이 여럿이면(새로고침 직후) 하나라도 답하면 true다.
   */
  async confirmDealer(tableId: string): Promise<boolean> {
    const dealers = [...(this.tableSessions.get(tableId) ?? [])].filter(
      (s: any) => s.role === Role.DEALER && s.readyState === WebSocket.OPEN,
    );
    if (dealers.length === 0) return false;
    const answers = await Promise.all(dealers.map((s) => awaitPong(s as any, this.dealerConfirmMs)));
    return answers.some(Boolean);
  }
```

6. `hasDealer`의 조건에서 `&& !isSilent(socket)`을 지우고 주석의 「열려 있어도 빠른 확인에 침묵한 소켓은 안 센다(`probeDealers`)」를 지운다.
7. `tablePresence`의 딜러 줄을 `if (socket.role === Role.DEALER) dealer = true;`로, 위 주석(「침묵한 딜러는…」)을 지운다.
8. `grep -n "isSilent\|probe\|DEALER_PROBE\|빠른 확인" backend/src/ws/ws.gateway.ts` 가 0건이 될 때까지 남은 주석을 고친다. `pauseIfNoDealer` · `handleDisconnect` 주석의 「빠른 확인」 언급은 「청소(`sweepSockets`)」로.

`recovery.service.ts`의 `pauseForLineOutage` 주석에서 `@param pausedAt` 설명을 바꾼다:

```ts
   * @param pausedAt 마지막 딜러가 마지막으로 응답한 시각. 서버가 끊김을 아는 데
   *   시간이 걸리므로 지금보다 과거다 — 청소(`WsGateway.sweepSockets`)가 끊은 소켓이면
   *   10~20초다. 그동안 접힌 사람은 없다 — 접기 직전에 딜러를 확인한다(T130).
```

- [ ] **Step 4: 통과를 본다**

Run: Step 2 명령, 그리고 그 파일 전체 `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- src/ws/ws.gateway.int-spec.ts`
Expected: PASS. 그리고 `npm run typecheck` 0건.

- [ ] **Step 5: 커밋**

```bash
git add backend/src/ws/ws.gateway.ts backend/src/ws/ws.gateway.int-spec.ts backend/src/recovery/recovery.service.ts
git commit -m "feat(T130): 게이트웨이가 접기 직전의 딜러 확인을 걸고, 2초 딜러 확인을 걷어낸다"
```

---

### Task 4: 타임아웃 워커 — 딜러가 답할 때만 접는다

**Files:**
- Modify: `backend/src/playsync/timeout.processor.ts`
- Test: `backend/src/playsync/timeout.processor.int-spec.ts`

**Interfaces:**
- Consumes: `RedisService.dealerLiveness.confirm` (Task 2)
- Produces: `export const TIMEOUT_HOLD_MS = 2_000;` (timeout.processor.ts)

- [ ] **Step 1: 실패하는 테스트**

모듈을 세우는 부분을 파일 맨 위의 함수로 뽑아 T122 테스트와 새 테스트가 같이 쓴다. T122 테스트는 `build({ boot })`로 바꾸고 기대는 그대로 둔다(스냅샷 기본값에 `timerEpoch: 3`이 들어가 세대 사전 검사를 지난다).

```ts
type Opts = {
  boot?: Promise<void>;
  confirm?: (tableId: string) => Promise<boolean>;
  snapshot?: object;
  snapshotFor?: (tableId: string) => object;
};

/** 진짜 큐와 진짜 워커. `init()`은 부르는 쪽이 한다 — T122는 그 순간을 붙잡는다. */
async function build(opts: Opts = {}) {
  const handleAction = jest.fn().mockResolvedValue(undefined);
  const snapshot = opts.snapshot ?? { currentTurnSeatIndex: 0, players: [{ id: 'victim' }], timerEpoch: 3 };
  const moduleRef = await Test.createTestingModule({
    imports: [
      BullModule.forRoot({
        connection: {
          host: process.env.REDIS_HOST,
          port: Number(process.env.REDIS_PORT),
          password: process.env.REDIS_PASSWORD,
        },
      }),
      BullModule.registerQueue({ name: 'player-timeout' }),
    ],
    providers: [
      TimeoutProcessor,
      { provide: PlaysyncService, useValue: { handleAction } },
      {
        provide: RedisService,
        useValue: {
          getSnapShot: async (tableId: string) => (opts.snapshotFor ? opts.snapshotFor(tableId) : snapshot),
          dealerLiveness: { confirm: opts.confirm ?? (async () => true) },
        },
      },
      { provide: RecoveryService, useValue: { bootOnce: () => opts.boot ?? Promise.resolve() } },
    ],
  }).compile();
  const queue = moduleRef.get<Queue>(getQueueToken('player-timeout'));
  return { moduleRef, queue, handleAction };
}

async function until(pred: () => boolean | Promise<boolean>, ms = 8000) {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error('until timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}
```

그 아래에 새 `describe`. 각 `it`은 `const built = await build({...}); await built.moduleRef.init();`로 시작하고, `afterEach`가 정리한다.

```ts
describe('TimeoutProcessor — 접기 직전에 딜러를 확인한다 (T130)', () => {
  let current: { moduleRef: TestingModule; queue: Queue } | undefined;
  /** 남은 지연 잡이 다음 테스트의 무대 위에서 돈다 — 큐째 지우고 닫는다. */
  afterEach(async () => {
    await current?.queue.obliterate({ force: true });
    await current?.moduleRef.close();
    current = undefined;
  });
  const build2 = async (opts: Opts) => {
    const built = await build(opts);
    current = built;
    await built.moduleRef.init();
    return built;
  };
  // 아래 테스트의 `build(`는 전부 `build2(`로 쓴다.

  /**
   * 딜러 태블릿만 꺼졌거나 회선이 끊겼다 — 그 테이블의 딜러가 답하지 않는다. 접지 않고
   * 같은 잡을 미뤄 다시 묻는다. 딜러가 돌아오면 그때 접는다.
   */
  it('딜러가 답하지 않으면 접지 않고 미뤘다가, 답하면 접는다', async () => {
    let alive = false;
    const asked: string[] = [];
    const { queue, handleAction } = await build({
      confirm: async (tableId: string) => { asked.push(tableId); return alive; },
    });
    await queue.add('timeout', { tableId: 'table', userId: 'victim', timerEpoch: 3 }, { jobId: 'table-3' });

    await until(() => asked.length >= 1);
    // 확인 뒤 잡이 같은 id로 지연 상태로 돌아갔다 — 플레이어가 누르면 `removeTimeoutJob`이 그 id로 지운다.
    await until(async () => (await queue.getJob('table-3'))?.isDelayed() ?? false);
    expect(`답없음 handleAction ${handleAction.mock.calls.length}번`).toBe('답없음 handleAction 0번');

    alive = true;
    await until(() => handleAction.mock.calls.length === 1, 10_000);
    expect(`물은 테이블 ${asked[0]} 두번이상 ${asked.length >= 2}`).toBe('물은 테이블 table 두번이상 true');
  });

  /** 반대 입력 — 「언제나 미룬다」가 위의 앞 절반을 통과한다. */
  it('딜러가 답하면 곧바로 접는다', async () => {
    const { queue, handleAction } = await build({ confirm: async () => true });
    await queue.add('timeout', { tableId: 'table', userId: 'victim', timerEpoch: 3 }, { jobId: 'table-3' });
    await until(() => handleAction.mock.calls.length === 1);
    expect(handleAction).toHaveBeenCalledWith('victim', 'table', { action: ActionType.TIME_OUT }, 3);
  });

  /**
   * 미뤄 둔 사이 차례가 넘어갔다(세대가 올랐다). 그 잡은 낡았다 — 딜러에게 묻지도,
   * 다시 미루지도 않고 끝나야 한다. 안 그러면 딜러가 안 돌아오는 동안 영영 돈다.
   */
  it('세대가 낡은 잡은 묻지 않고 끝난다', async () => {
    const asked: string[] = [];
    const { queue, handleAction } = await build({
      confirm: async (t: string) => { asked.push(t); return false; },
      snapshot: { currentTurnSeatIndex: 0, players: [{ id: 'victim' }], timerEpoch: 4 },
    });
    await queue.add('timeout', { tableId: 'table', userId: 'victim', timerEpoch: 3 }, { jobId: 'table-3' });
    await until(async () => (await queue.getJob('table-3')) === undefined);
    expect(`물음 ${asked.length} handleAction ${handleAction.mock.calls.length}`).toBe('물음 0 handleAction 0');
  });
});
```

**딜러 태블릿만 꺼진 테이블(Review Focus 1)** — 같은 `describe`에 네 번째 `it`:

```ts
  it('딜러가 꺼진 테이블만 서고 다른 테이블은 접힌다', async () => {
    const { queue, handleAction } = await build({
      confirm: async (t: string) => t !== 'dead',
      snapshotFor: (tableId: string) => ({ currentTurnSeatIndex: 0, players: [{ id: `${tableId}-p` }], timerEpoch: 3 }),
    });
    await queue.add('timeout', { tableId: 'dead', userId: 'dead-p', timerEpoch: 3 }, { jobId: 'dead-3' });
    await queue.add('timeout', { tableId: 'alive', userId: 'alive-p', timerEpoch: 3 }, { jobId: 'alive-3' });
    await until(() => handleAction.mock.calls.length >= 1);
    await new Promise((r) => setTimeout(r, 500));
    expect(`접힌 테이블 ${handleAction.mock.calls.map((c) => c[1]).join(',')}`).toBe('접힌 테이블 alive');
  });
```

- [ ] **Step 2: 실패를 본다**

Run: `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- src/playsync/timeout.processor.int-spec.ts`
Expected: FAIL — 답이 없어도 `handleAction`이 1번 불린다 / 세대 검사 없음

- [ ] **Step 3: 구현**

`timeout.processor.ts`:

```ts
import { DelayedError, Job } from 'bullmq';
```

```ts
/**
 * 딜러가 답하지 않을 때 다시 묻기까지(T130). 딜러가 돌아오면 이 안에 접힌다.
 */
export const TIMEOUT_HOLD_MS = 2_000;
```

`process`를:

```ts
  async process(job: Job<{ tableId: string; userId: string; timerEpoch?: number }>, token?: string) {
    const { tableId, userId, timerEpoch } = job.data;

    // 여기서도 한 번 걸러 두면 불필요한 락 획득을 줄일 수 있다. 다만 이 검사는
    // 락 밖이라 신뢰할 수 없다 — 진짜 판정은 handleAction이 락을 잡은 뒤에 한다.
    const state = await this.redis.getSnapShot(tableId);
    if (!state) return;
    if (state.players[state.currentTurnSeatIndex]?.id !== userId) return;
    // 세대가 낡은 잡은 딜러에게 묻지 않는다(T130) — 미뤄 둔 사이 차례가 넘어갔으면
    // 이 잡은 끝났다. 안 거르면 딜러가 안 돌아오는 동안 영영 미뤄지며 돈다.
    if (timerEpoch !== undefined && timerEpoch !== (state.timerEpoch ?? 0)) return;

    // **접기 직전에 그 테이블의 딜러에게 묻는다**(T130). 답이 없으면 회선이 끊겼는지
    // 딜러 태블릿만 꺼졌는지 아직 모른다 — 모르는 동안에는 접지 않는다. 같은 id로
    // 미뤄 두므로 플레이어가 누르면 `removeTimeoutJob`이 그대로 지운다.
    if (!(await this.redis.dealerLiveness.confirm(tableId))) {
      await job.moveToDelayed(Date.now() + TIMEOUT_HOLD_MS, token);
      throw new DelayedError();
    }

    await this.playsyncService.handleAction(
      userId,
      tableId,
      { action: ActionType.TIME_OUT },
      timerEpoch,
    );
  }
```

`@nestjs/bullmq`의 `WorkerHost.process`가 `token`을 두 번째 인자로 넘기는지 `node_modules/@nestjs/bullmq/dist/hosts/worker-host.class.d.ts`에서 확인한다. 안 넘기면 `this.worker`의 processor 시그니처를 따른다.

- [ ] **Step 4: 통과를 본다** — Step 2 명령 PASS, 그리고 `npm run typecheck` 0건

- [ ] **Step 5: 커밋**

```bash
git add backend/src/playsync/timeout.processor.ts backend/src/playsync/timeout.processor.int-spec.ts
git commit -m "feat(T130): 타임아웃 워커는 그 테이블 딜러가 답할 때만 접고, 아니면 미뤄 다시 묻는다"
```

---

### Task 5: 리바인 마감 — 딜러가 답하지 않으면 탈락시키지 않는다

**Files:**
- Modify: `backend/src/playsync/playsync.service.ts`
- Modify: `backend/src/dealer/dealer.service.ts`
- Test: `backend/src/scenario/line-outage.int-spec.ts` (같은 파일에 `describe` 하나 더)

**Interfaces:**
- Consumes: `RedisService.dealerLiveness` (Task 2)
- Produces: `RebuyOutcome`에 `'dealerSilent'` — 「마감이 왔는데 그 테이블 딜러가 답하지 않았다. 아무것도 확정하지 않았다」

- [ ] **Step 1: 실패하는 테스트**

`line-outage.int-spec.ts` 끝에:

```ts
/**
 * T130 — 리바인 마감이 왔는데 그 테이블의 딜러가 답하지 않는다. 회선이 끊겼는지 아직
 * 모른다(청소가 알기까지 10~20초). 탈락시키지 않고 딜러의 재개 뒤에 다시 묻는다.
 */
describe('시나리오 — 리바인 마감에 딜러가 답하지 않는다', () => {
  // 위 describe의 PLAYERS · STACKS · until · pointsOf · statusOf · bustAandB를 파일 맨 위로 올려 둘이 같이 쓴다.
  let h: Harness;
  let chips = STACKS.a + STACKS.b + STACKS.winner;
  const prompts: { userId: string; deadline: number }[] = [];
  let dealerAnswers = false;
  let detach: () => void;

  beforeAll(async () => {
    process.env.REBUY_TIMEOUT_MS = '1000';
    h = await setupTournament(PLAYERS, { registrationOpen: true });
    h.emitter.on('rebuy.request.sent', (p: { userId: string; deadline: number }) => { prompts.push(p); });
    detach = h.redisService.dealerLiveness.attach(async () => dealerAnswers);
  });
  afterAll(async () => {
    delete process.env.REBUY_TIMEOUT_MS;
    detach();
    await h.close();
  });

  it('1~3. 마감에 딜러가 답하지 않으면 탈락이 아니라 재개 대기다 — 재개 뒤 다시 묻는다', async () => {
    await bustAandB(h);
    await checkInvariants(h, '1. 쇼다운', chips);
    const aPoints = await pointsOf(h, 'a');

    let settled = false;
    const settling = h.dealer.resolveWinners(h.tableId, h.tournamentId, [['winner']]).finally(() => { settled = true; });
    await until(() => prompts.some(p => p.userId === 'a') && prompts.some(p => p.userId === 'b'));

    // 2. 둘 다 답하지 않는다. 마감에 딜러도 답하지 않는다 → 둘 다 재개 대기
    await until(async () => settled || (await h.snapshot()).resumePending !== undefined);
    const paused = await checkInvariants(h, '2. 재개 대기', chips);
    expect(`2. 사유 ${paused.resumePending?.reason} a상태 ${await statusOf(h, 'a')} b상태 ${await statusOf(h, 'b')} a포인트 ${await pointsOf(h, 'a') === aPoints}`)
      .toBe('2. 사유 lineDown a상태 PLAYING b상태 PLAYING a포인트 true');

    // 3. 딜러가 돌아와 재개 → 다시 묻는다. 이번에는 딜러가 답하므로 마감이 거절로 센다
    dealerAnswers = true;
    await h.dealer.resumeTable(h.tableId);
    await settling;
    expect(`3. a묻기 ${prompts.filter(p => p.userId === 'a').length} a상태 ${await statusOf(h, 'a')} b상태 ${await statusOf(h, 'b')}`)
      .toBe('3. a묻기 2 a상태 ELIMINATED b상태 ELIMINATED');
  });

});

/**
 * Review Focus 4 — 마감 직후, 딜러를 확인하는 사이 수락이 도착했다. 그 사람의 의사다.
 * `settle`은 한 번만 정하므로 수락이 이기고, 확인의 false는 버려진다.
 */
describe('시나리오 — 딜러를 확인하는 사이 리바인 수락이 도착한다', () => {
  let h: Harness;
  let chips = STACKS.a + STACKS.b + STACKS.winner;
  let detach: () => void;

  beforeAll(async () => {
    process.env.REBUY_TIMEOUT_MS = '1000';
    h = await setupTournament(PLAYERS, { registrationOpen: true });
    // b는 묻자마자 거절한다 — 이 검사는 a만 본다.
    h.emitter.on('rebuy.request.sent', ({ userId }: { userId: string }) => {
      if (userId === 'b') setImmediate(() => h.emitter.emit('rebuy_res_b', false));
    });
    // 마감의 확인 도중 a의 수락이 도착하고, 확인 자체는 「답 없음」으로 끝난다.
    detach = h.redisService.dealerLiveness.attach(async () => {
      h.emitter.emit('rebuy_res_a', true);
      await new Promise((r) => setTimeout(r, 20));
      return false;
    });
  });
  afterAll(async () => {
    delete process.env.REBUY_TIMEOUT_MS;
    detach();
    await h.close();
  });

  it('수락이 반영되고 재개 대기로 가지 않는다', async () => {
    await bustAandB(h);
    const aPoints = await pointsOf(h, 'a');
    await h.dealer.resolveWinners(h.tableId, h.tournamentId, [['winner']]);

    chips += SCENARIO.startStack;
    const after = await checkInvariants(h, '수락 뒤', chips);
    expect(`대기 ${after.resumePending === undefined} a스택 ${after.players[h.seatOf(after, 'a')]!.stack} a차감 ${aPoints - (await pointsOf(h, 'a'))} a상태 ${await statusOf(h, 'a')}`)
      .toBe(`대기 true a스택 ${SCENARIO.startStack} a차감 ${SCENARIO.entryFee} a상태 PLAYING`);
  });
});
```

- [ ] **Step 2: 실패를 본다**

Run: `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- src/scenario/line-outage.int-spec.ts`
Expected: FAIL — 2단계에서 `a상태 ELIMINATED`(마감이 그대로 거절로 셌다)

- [ ] **Step 3: 구현**

`playsync.service.ts`:

1. `RebuyOutcome`에 `'dealerSilent'`를 더하고 그 위 주석 목록에 한 줄:

```ts
 * - `dealerSilent`: 마감이 왔는데 그 테이블의 딜러가 답하지 않았다(T130). 회선이
 *   끊겼는지 아직 모른다. 아무것도 확정하지 않았다
```

2. `waitForRebuyResponse`의 반환 타입에 `'dealerSilent'`를 더하고(`settle`의 인자 타입도), 마감 타이머를:

```ts
      // **마감에 그 테이블의 딜러에게 묻는다**(T130). 답이 없으면 회선이 끊겼는지 아직
      // 모른다 — 거절로 세면 끊긴 태블릿의 파산자가 탈락한다. 묻는 사이 도착한 수락은
      // 그대로 받는다(`settle`은 한 번만 정한다).
      const timer = setTimeout(() => {
        this.redis.dealerLiveness.confirm(tableId).then(
          (alive) => {
            if (!alive) this.logger.warn(`리바인 마감에 딜러가 답하지 않는다 — 미룬다 (table=${tableId}, user=${userId})`);
            else this.logger.log(`리바인 응답 시간초과 (user=${userId})`);
            settle(alive ? 'timeout' : 'dealerSilent');
          },
          () => settle('dealerSilent'),
        );
      }, timeoutMs);
```

3. `processRebuy`(이 대기를 부르는 메서드) 안 `if (answer !== 'accepted') return answer;`는 그대로 `dealerSilent`를 돌려준다. 반환 타입이 `RebuyOutcome`이면 추가 작업 없음 — `npm run typecheck`가 말해 준다.

`dealer.service.ts`의 `askRebuys`:

```ts
        // `deferred`(DB의 일시 실패, T118)와 `dealerSilent`(마감에 딜러가 답하지 않았다,
        // T130)도 같은 길을 탄다 — 확정하지 않고 딜러의 재개 뒤에 다시 묻는다.
        const interrupted = asked.filter((_, i) =>
          outcomes[i] === 'interrupted' || outcomes[i] === 'deferred' || outcomes[i] === 'dealerSilent');
        if (interrupted.length === 0) break;
        // 서버가 멈춘 것이 아니면 화면이 「N초 멈췄다」 대신 그 원인을 적는다 — 회선이
        // 끊겼거나(T121, 이 판 사이에 회선 세대가 올랐다 · T130, 마감에 딜러가 답하지
        // 않았다) 일시 오류다.
        const reason = this.redis.linePause.generationOf(tournamentId) !== lineGeneration || outcomes.includes('dealerSilent')
          ? 'lineDown' as const
          : outcomes.includes('interrupted') ? undefined : 'transientError' as const;
```

`grep -rn "RebuyOutcome\|'interrupted'" backend/src --include=*.ts | grep -v spec`로 결과를 가르는 다른 자리(`switch` · 로그 · 이벤트)가 있으면 `dealerSilent`를 `interrupted`와 같은 쪽에 넣는다.

- [ ] **Step 4: 통과를 본다**

Run: Step 2 명령 PASS, `npm run typecheck` 0건, 그리고 리바인을 건드리는 시나리오 묶음 `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- src/scenario`

- [ ] **Step 5: 커밋**

```bash
git add backend/src/playsync/playsync.service.ts backend/src/dealer/dealer.service.ts backend/src/scenario/line-outage.int-spec.ts
git commit -m "feat(T130): 리바인 마감에 딜러가 답하지 않으면 탈락시키지 않고 재개 뒤에 다시 묻는다"
```

---

### Task 6: 전체 검증 · 실측 · SSOT (메인)

**Files:**
- Modify: `docs/domain/recovery.md`, `docs/tickets-recovery.md`, `CLAUDE.md`, `load/README.md`(T121 언급이 있으면)

- [ ] **Step 1: 최종 전체 리뷰** — opus 하나로 브랜치 전체(`git diff main...`). 동시성에 닿는 자리(지연 복귀와 `removeTimeoutJob`의 경합, `settle` 이중 호출)를 짚게 한다.

- [ ] **Step 2: 기준선 실측** — `npm run typecheck` · `npm run test` · `npm run test:int` · `cd load && npm test` · `npm run test:outage`(실제 kill — 회선 감지 타이밍이 바뀌므로 반드시). 값을 그대로 적는다.

- [ ] **Step 3: 회선 끊김 실측 (사용자에게 먼저 묻는다)** — `npm run load:standard -- t130`. 기대: 20초 · 90초 끊김의 시간 초과 폴드 0 / 0 / 0, 「서버가 안 시각」은 10~20초로 늦어진다, kill 결과는 그대로.

- [ ] **Step 4: SSOT** — `domain/recovery.md` 「대회장의 회선이 끊겨도 같은 길을 탄다」에서 「딜러만 2초마다 따로 확인한다」 항목을 「접기 직전에 그 테이블의 딜러를 확인한다」로 바꾸고, 「못 막는 것」(서버가 알기 전의 마감)을 지운다. 감지 10~20초 · 블라인드 정지 시작점이 최대 10초 이르다는 대가를 적는다. `tickets-recovery.md`에 T130 행(`완료 (#PR)`), `CLAUDE.md` 기준선.
