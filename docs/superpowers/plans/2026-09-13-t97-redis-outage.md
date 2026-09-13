# T97 — Redis 장애를 짧은 부팅으로 다룬다 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 백엔드가 살아 있고 Redis만 죽었다 돌아올 때, 차례였던 사람이 폴드되지 않고, 블라인드가 멈추고, 모든 화면이 장애를 안다.

**Architecture:** `RedisService`가 자기 ioredis 클라이언트의 이벤트로 장애 상태(메모리)를 든다. 끊기면 게이트웨이가 액션을 즉시 거절하고 DB에서 대회를 `SYNCING`으로 켠다. 돌아오면 `RecoveryService`가 부팅과 같은 함수로 테이블을 락 안에서 멈춰 세우고, 게이트웨이가 n/n을 다시 세며, 딜러가 재개한다. REST는 503, 소켓은 `serverOutage` 이벤트로 화면에 알린다.

**Tech Stack:** NestJS · ioredis · BullMQ · Prisma · zod(`@playsync/contract`) · Next.js · vitest · jest

**Spec:** `docs/superpowers/specs/2026-09-13-t97-redis-outage-design.md` — 구현 전에 반드시 읽는다. 기각한 안과 감수한 창이 거기 있다.

## Global Constraints

- 문구: `서버 장애를 복구하는 중입니다.` — `packages/contract`의 `SERVER_RECOVERING_MESSAGE` 한 곳에서만 온다. 백엔드·프론트 어디에도 문자열을 다시 적지 않는다
- REST 상태 코드: `503` — `SERVER_RECOVERING_STATUS`
- 소켓 이벤트 이름: `serverOutage`, 페이로드 `{ down: boolean }` — `SERVER_OUTAGE_EVENT` · `ServerOutageSchema`
- **생성자 시그니처를 바꾸지 않는다.** `new RedisService(redis)` · `new PlaysyncService(...)` · `new RecoveryService(prisma, redisService)` · `new WsGateway(...)`가 테스트에 90곳 있다. 장애 상태는 `RedisService`의 필드로 들고 다닌다
- 코드·주석은 한국어, 좌표는 줄 번호가 아니라 이름으로 적는다(`CLAUDE.md`)
- **하위 에이전트는 `docs/`와 `CLAUDE.md`를 만지지 않는다.** 스펙·계획은 읽기만 한다
- 버그 수정은 실패하는 테스트를 먼저 보고 고친다. 사후에 붙인 검사는 제품 코드를 되돌려 빨간불을 확인한다(`git stash push <파일>` 또는 임시 편집 후 복원)
- 시나리오 계층(`src/scenario/`)에는 스텁을 두지 않는다. 순서 강제용 스파이는 허용된다(스펙 5절)
- 명령은 루트 기준: `npm run test -w backend`, `npm run test:int -w backend -- <패턴>`, `npm run test -w frontend`, `npm run test -w @playsync/contract`, `npm run typecheck`

---

## 파일 지도

| 파일 | 무엇 | 태스크 |
|---|---|---|
| `packages/contract/src/server-outage.ts` (신규) | 이벤트·상태 코드·문구 | 1 |
| `backend/src/redis/outage.ts` (신규) | 장애 상태 전이(순수) + `RedisOutage` 클래스 | 1 |
| `backend/src/redis/redis.service.ts` | `readonly outage` 필드, 클라이언트 이벤트 배선 | 1 |
| `backend/src/playsync/playsync.service.ts` | `handleAction`의 세대 가드 | 1 |
| `backend/src/recovery/recovery.service.ts` | 감지 순간 DB · 복귀 스윕 · 멈춰 세우기 락 한 벌 | 1 |
| `backend/src/scenario/redis-outage.int-spec.ts` (신규) | 조립 시나리오 | 1 |
| `backend/src/ws/ws.gateway.ts` | 게이트 · 방송 · 복구 뒤 재집계 | 2 |
| `backend/src/common/redis-outage.filter.ts` (신규) · `app.module.ts` | 503 필터 | 2 |
| `frontend/src/lib/server-outage.ts` (신규) | `isServerRecovering` | 3 |
| `frontend/src/lib/use-table-socket.ts` · 좌석·딜러·대기·SSR·전광판·참가자·콘솔 | 화면 | 3 |
| `backend/docker-compose.outage.yml` · `backend/test/outage/*` (신규) | 실제 kill 검사 | 4 |

---

### Task 1: 백엔드 코어 — 감지 · 가드 · 복구 스윕

**Files:**
- Create: `packages/contract/src/server-outage.ts`, `packages/contract/src/server-outage.spec.ts`
- Modify: `packages/contract/src/index.ts`
- Create: `backend/src/redis/outage.ts`, `backend/src/redis/outage.spec.ts`
- Modify: `backend/src/redis/redis.service.ts` (생성자와 필드)
- Modify: `backend/src/playsync/playsync.service.ts` (`handleAction`)
- Modify: `backend/src/recovery/recovery.service.ts` (`pauseTurnClock` → `pauseTable`, 새 메서드 둘, 생성자에서 구독)
- Create: `backend/src/scenario/redis-outage.int-spec.ts`

**Interfaces:**
- Produces:
  - contract: `SERVER_OUTAGE_EVENT = "serverOutage"`, `ServerOutageSchema = z.object({ down: z.boolean() })`, `type ServerOutage`, `SERVER_RECOVERING_STATUS = 503`, `SERVER_RECOVERING_MESSAGE = "서버 장애를 복구하는 중입니다."`
  - `backend/src/redis/outage.ts`: `type OutagePhase = 'booting' | 'up' | 'down' | 'recovering'`, `class RedisOutage extends EventEmitter` with `phase: OutagePhase`, `generation: number`, `downSince: number | null`, `isUp(): boolean`, `markRecovered(): void`; 이벤트 `'down'`(인자 `downSince: number`) · `'up'`(인자 없음) · `'recovered'`(인자 없음)
  - `RedisService.outage: RedisOutage` (public readonly)
  - `RecoveryService.onRedisDown(downSince: number): Promise<void>`, `RecoveryService.recoverFromOutage(): Promise<void>`

- [ ] **Step 1: 계약 — 실패하는 스펙**

`packages/contract/src/server-outage.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  SERVER_OUTAGE_EVENT,
  SERVER_RECOVERING_MESSAGE,
  SERVER_RECOVERING_STATUS,
  ServerOutageSchema,
} from "./server-outage";

describe("serverOutage", () => {
  it("down 하나만 싣는다", () => {
    expect(ServerOutageSchema.parse({ down: true, extra: 1 })).toEqual({ down: true });
  });
  it("down이 없으면 거부한다", () => {
    expect(ServerOutageSchema.safeParse({}).success).toBe(false);
  });
  it("이름 · 상태 코드 · 문구", () => {
    expect(SERVER_OUTAGE_EVENT).toBe("serverOutage");
    expect(SERVER_RECOVERING_STATUS).toBe(503);
    expect(SERVER_RECOVERING_MESSAGE).toBe("서버 장애를 복구하는 중입니다.");
  });
});
```

기존 contract 스펙이 vitest인지 jest인지 `packages/contract/package.json`에서 확인하고 import를 맞춘다.

- [ ] **Step 2: 실패 확인** — `npm run test -w @playsync/contract` → 모듈 없음으로 FAIL

- [ ] **Step 3: 계약 구현**

`packages/contract/src/server-outage.ts`:

```ts
import { z } from "zod";

/**
 * Redis 장애 알림(T97). 좌석·딜러 소켓 전원에게 간다.
 *
 * **스냅샷 필드가 아니라 별도 이벤트다.** 장애 중에는 스냅샷을 쓸 수 없다 —
 * 스냅샷이 Redis에 있다. 서버 프로세스 메모리에서 바로 나가는 이벤트라야
 * 끊긴 순간에 닿는다.
 */
export const ServerOutageSchema = z.object({ down: z.boolean() });
export type ServerOutage = z.infer<typeof ServerOutageSchema>;
export const SERVER_OUTAGE_EVENT = "serverOutage" as const;

/**
 * REST가 장애 중에 내는 상태와 문구. **문구는 여기 한 곳에만 있다** — 백엔드
 * 필터·게이트웨이·프론트 화면이 전부 이 값을 쓴다. 화면마다 적으면 한쪽만
 * 고쳐지는 날이 온다.
 */
export const SERVER_RECOVERING_STATUS = 503 as const;
export const SERVER_RECOVERING_MESSAGE = "서버 장애를 복구하는 중입니다." as const;
```

`packages/contract/src/index.ts` 끝에 `export * from "./server-outage";`

- [ ] **Step 4: 통과 확인** — `npm run test -w @playsync/contract` PASS, `npm run build:contract`

- [ ] **Step 5: 상태 전이 — 실패하는 단위 스펙**

`backend/src/redis/outage.spec.ts`:

```ts
import { EventEmitter } from 'events';
import { RedisOutage } from './outage';

/** ioredis 클라이언트 대역. 이벤트와 `status`만 쓴다. */
function fakeClient(status = 'connecting') {
  const e = new EventEmitter() as EventEmitter & { status: string };
  e.status = status;
  return e;
}

describe('RedisOutage', () => {
  it('부팅 중 첫 ready는 복구를 부르지 않는다 (반대 입력)', () => {
    const client = fakeClient();
    const o = new RedisOutage(client as never, () => 1000);
    const up = jest.fn();
    o.on('up', up);
    client.emit('ready');
    expect(`${o.phase} up호출 ${up.mock.calls.length}`).toBe('up up호출 0');
  });

  it('이미 연결된 클라이언트로 만들면 up에서 시작한다', () => {
    expect(new RedisOutage(fakeClient('ready') as never, () => 0).phase).toBe('up');
  });

  it('up에서 reconnecting → down, 세대 +1, 감지 시각', () => {
    const client = fakeClient('ready');
    const o = new RedisOutage(client as never, () => 5000);
    const down = jest.fn();
    o.on('down', down);
    client.emit('reconnecting');
    expect([o.phase, o.generation, o.downSince, o.isUp()]).toEqual(['down', 1, 5000, false]);
    expect(down).toHaveBeenCalledWith(5000);
  });

  it('down에서 ready → recovering, up 발행. markRecovered → up, recovered 발행', () => {
    const client = fakeClient('ready');
    const o = new RedisOutage(client as never, () => 0);
    const up = jest.fn();
    const recovered = jest.fn();
    o.on('up', up);
    o.on('recovered', recovered);
    client.emit('reconnecting');
    client.emit('ready');
    expect([o.phase, up.mock.calls.length]).toEqual(['recovering', 1]);
    o.markRecovered();
    expect([o.phase, o.downSince, recovered.mock.calls.length]).toEqual(['up', null, 1]);
  });

  it('복구 중 다시 끊기면 세대 +1, 감지 시각은 첫 장애 것을 유지한다', () => {
    let now = 1000;
    const client = fakeClient('ready');
    const o = new RedisOutage(client as never, () => now);
    client.emit('reconnecting');
    client.emit('ready');
    now = 9000;
    client.emit('reconnecting');
    expect([o.phase, o.generation, o.downSince]).toEqual(['down', 2, 1000]);
  });

  it('down 중 reconnecting이 반복돼도 세대는 한 번만 오른다', () => {
    const client = fakeClient('ready');
    const o = new RedisOutage(client as never, () => 0);
    client.emit('reconnecting');
    client.emit('reconnecting');
    client.emit('reconnecting');
    expect(o.generation).toBe(1);
  });

  it('부팅 중 끊기면 down이 되고, 돌아오면 복구한다', () => {
    const client = fakeClient();
    const o = new RedisOutage(client as never, () => 7);
    const up = jest.fn();
    o.on('up', up);
    client.emit('reconnecting');
    client.emit('ready');
    expect([o.phase, up.mock.calls.length]).toEqual(['recovering', 1]);
  });

  it('종료(quit)는 장애가 아니다 — close/end만 오고 reconnecting이 없다 (반대 입력)', () => {
    const client = fakeClient('ready');
    const o = new RedisOutage(client as never, () => 0);
    client.emit('close');
    client.emit('end');
    expect([o.phase, o.generation]).toEqual(['up', 0]);
  });
});
```

- [ ] **Step 6: 실패 확인** — `npm run test -w backend -- outage.spec` → FAIL (모듈 없음)

- [ ] **Step 7: 상태 전이 구현**

`backend/src/redis/outage.ts`:

```ts
import { EventEmitter } from 'events';
import type Redis from 'ioredis';

/**
 * Redis 장애 상태(T97). **프로세스 메모리에 산다.**
 *
 * 부팅 복구(`RecoveryService.recoverAll`)는 프로세스가 새로 뜰 때만 돈다.
 * 백엔드는 살아 있고 Redis만 죽었다 돌아오면 부팅이 없어서, 차례였던 사람이
 * 이미 지난 마감으로 폴드됐다. 이 클래스가 그 경로의 시작점이다.
 *
 * **`close`가 아니라 `reconnecting`으로 감지한다.** ioredis는 `quit()`·
 * `disconnect()`로 닫을 때도 `close`를 내지만, 그때는 다시 붙지 않으므로
 * `reconnecting`이 오지 않는다. `close`로 보면 앱을 끌 때마다 대회가
 * `SYNCING`이 된다.
 *
 * **인스턴스가 여럿이 되면 이 설계는 틀린다**(`backlog.md` B9). 판정에 쓰는
 * 사실을 Redis로 옮길 모양은 스펙의 「인스턴스가 여럿이 되면」에 있다.
 */
export type OutagePhase = 'booting' | 'up' | 'down' | 'recovering';

export class RedisOutage extends EventEmitter {
  phase: OutagePhase;
  /** 장애가 날 때마다 오른다. 락 안에서 이 값이 바뀌었으면 그 사이에 끊겼다는 뜻이다. */
  generation = 0;
  /** 이번 장애가 **처음** 감지된 시각. 복구 중 다시 끊겨도 덮지 않는다. */
  downSince: number | null = null;

  constructor(client: Pick<Redis, 'on' | 'status'>, private readonly now: () => number = Date.now) {
    super();
    this.phase = client.status === 'ready' ? 'up' : 'booting';
    client.on('reconnecting', () => this.onLost());
    client.on('ready', () => this.onReady());
  }

  isUp(): boolean {
    return this.phase === 'up';
  }

  /** 복구 스윕이 끝났다. `RecoveryService.recoverFromOutage`만 부른다. */
  markRecovered(): void {
    if (this.phase !== 'recovering') return;
    this.phase = 'up';
    this.downSince = null;
    this.emit('recovered');
  }

  private onLost() {
    if (this.phase === 'down') return;
    this.generation += 1;
    this.downSince ??= this.now();
    this.phase = 'down';
    this.emit('down', this.downSince);
  }

  private onReady() {
    if (this.phase === 'booting') {
      this.phase = 'up';
      return;
    }
    if (this.phase !== 'down') return;
    this.phase = 'recovering';
    this.emit('up');
  }
}
```

`RedisService` 생성자:

```ts
  /** Redis 장애 상태(T97). 생성자 시그니처를 늘리지 않으려고 필드로 든다. */
  readonly outage: RedisOutage;

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {
    this.outage = new RedisOutage(redis);
  }
```

`EventEmitter`의 리스너 한도 경고가 나면(`MaxListenersExceededWarning`) 테스트가 `RedisService`를 많이 만든 탓이 아니라 같은 인스턴스에 구독이 쌓인 것이다 — 원인을 찾는다. `setMaxListeners`로 덮지 않는다.

- [ ] **Step 8: 통과 확인** — `npm run test -w backend -- outage.spec` PASS

- [ ] **Step 9: 시나리오 — 실패하는 통합 스펙**

`backend/src/scenario/redis-outage.int-spec.ts`. 하네스(`harness.ts`)의 `setupTournament`로 셋을 앉히고 판을 연다. **장애는 실제 클라이언트를 끊어 만든다**: `h.redis.options.retryStrategy = () => HOLD_MS` 뒤 `h.redis.disconnect(true)` — `reconnect=true`라 ioredis가 `reconnecting`을 내고 `HOLD_MS` 뒤 다시 붙는다.

```ts
import { ActionType } from 'src/game-engine/types';
import { SERVER_RECOVERING_MESSAGE } from '@playsync/contract';
import { checkInvariants, Harness, setupTournament } from './harness';

/**
 * T97 — 백엔드는 살고 Redis만 죽었다 돌아온다.
 *
 * 부팅 복구는 안 돈다. 여기서 보는 것은 **런타임 복구의 조립**이다 — 끊긴 순간
 * DB가 대회를 켜고, 돌아온 순간 스윕이 테이블을 멈춰 세우고, 그 사이에 흘러든
 * 타임아웃이 사람을 폴드시키지 못하는가.
 *
 * 장애는 흉내 내지 않는다. 실제 ioredis 클라이언트를 `disconnect(true)`로 끊고
 * `retryStrategy`로 돌아올 시각을 쥔다.
 */
describe('시나리오 — Redis만 죽는다', () => {
  let h: Harness;
  const PLAYERS = ['p0', 'p1', 'p2'];
  const chips = 10000 * 3;
  const HOLD_MS = 1500;

  afterAll(async () => { await h.close(); });

  async function until(pred: () => boolean | Promise<boolean>, ms = 5000) {
    const start = Date.now();
    while (!(await pred())) {
      if (Date.now() - start > ms) throw new Error('until timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('0. 판이 돈다 — 차례인 사람의 마감을 과거로 돌린다', async () => {
    h = await setupTournament(PLAYERS);
    await h.dealer.startPreFlop(h.tournamentId, h.tableId);
    const state = await h.snapshot();
    state.actionDeadline = Date.now() - 1000;
    await h.saveSnapshot(state);
    await checkInvariants(h, '0. 프리플랍', chips);
  });

  it('1~4. 끊긴 동안 DB가 켜고, 복구 스윕 전에 온 타임아웃은 폴드시키지 못한다', async () => {
    const before = await h.snapshot();
    const victim = h.turnId(before)!;
    const epoch = before.timerEpoch ?? 0;

    // 스윕을 붙잡아 둔다 — 복구 창에 타임아웃을 먼저 흘리기 위해서다.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const original = h.recovery.recoverFromOutage.bind(h.recovery);
    const sweep = jest.spyOn(h.recovery, 'recoverFromOutage').mockImplementationOnce(async () => {
      await gate;
      await original();
    });

    h.redis.options.retryStrategy = () => HOLD_MS;
    h.redis.disconnect(true);

    // 1. 끊긴 순간
    await until(() => h.redisService.outage.phase === 'down');
    await until(async () =>
      (await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } })).status === 'SYNCING');
    const t = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    expect(`1. pausedAt ${t.pausedAt?.getTime() === h.redisService.outage.downSince}`).toBe('1. pausedAt true');

    // 2~3. 돌아왔지만 스윕 전 — 타임아웃 잡이 먼저 온다
    await until(() => h.redisService.outage.phase === 'recovering');
    await expect(
      h.playsync.handleAction(victim, h.tableId, { action: ActionType.TIME_OUT } as never, epoch),
    ).rejects.toThrow(SERVER_RECOVERING_MESSAGE);
    const mid = await h.snapshot();
    expect(`3. ${victim} 폴드 ${mid.players[h.seatOf(mid, victim)]!.hasFolded}`).toBe(`3. ${victim} 폴드 false`);

    // 4. 스윕을 놓는다
    release();
    await until(() => h.redisService.outage.isUp());
    const after = await checkInvariants(h, '4. 스윕 뒤', chips);
    expect(`4. 세대 ${after.timerEpoch} 마감 ${after.actionDeadline} 정지 ${after.resumePending !== undefined}`)
      .toBe(`4. 세대 ${epoch + 1} 마감 undefined 정지 true`);

    // 낡은 세대의 타임아웃은 조용히 버려진다
    expect(await h.playsync.handleAction(victim, h.tableId, { action: ActionType.TIME_OUT } as never, epoch)).toBeNull();
    sweep.mockRestore();
  });

  it('5. n/n — completeSync가 장애 시간만큼 한 번 민다', async () => {
    const before = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    const pausedAt = before.pausedAt!.getTime();
    const callAt = Date.now();
    expect(await h.recovery.completeSync(h.tournamentId)).toBe(true);
    const after = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    expect(`5. 상태 ${after.status}`).toBe('5. 상태 ONGOING');
    expect(`5. Δ ${Math.abs((after.pausedMs - before.pausedMs) - (callAt - pausedAt)) < 1000}`).toBe('5. Δ true');
  });

  it('6. 딜러 재개 → 차례인 사람의 액션이 들어간다', async () => {
    await h.dealer.resumeTable(h.tableId);
    const state = await checkInvariants(h, '6. 재개', chips);
    await h.playsync.handleAction(h.turnId(state)!, h.tableId, { action: ActionType.CALL } as never);
    await checkInvariants(h, '6. 콜', chips);
  });

  it('7. 끊기기 전에 나간 액션이 복구 뒤에 도착하면 거절된다 (세대 가드)', async () => {
    const state = await h.snapshot();
    const actor = h.turnId(state)!;
    h.redis.options.retryStrategy = () => HOLD_MS;
    // 가드가 락 밖에서 세대를 잡은 뒤 끊기게 만든다: 요청을 먼저 띄우고 곧바로 끊는다.
    const pending = h.playsync.handleAction(actor, h.tableId, { action: ActionType.CALL } as never);
    h.redis.disconnect(true);
    await expect(pending).rejects.toThrow();
    await until(() => h.redisService.outage.isUp(), 8000);
    const after = await checkInvariants(h, '7. 복구 뒤', chips);
    expect(`7. ${actor} 베팅 그대로 ${after.players[h.seatOf(after, actor)]!.bet === state.players[h.seatOf(state, actor)]!.bet}`)
      .toBe(`7. ${actor} 베팅 그대로 true`);
  });
});

/** 차례가 없는 테이블에는 정지 표시가 안 붙는다 — 없으면 "전부 멈춘다"도 위를 통과한다. */
describe('시나리오 — Redis만 죽는다 (차례 없음)', () => {
  let h: Harness;
  afterAll(async () => { await h.close(); });

  it('WAITING 테이블은 복구 뒤에도 resumePending이 없다', async () => {
    h = await setupTournament(['p0', 'p1']);
    h.redis.options.retryStrategy = () => 500;
    h.redis.disconnect(true);
    const start = Date.now();
    while (!h.redisService.outage.isUp() || h.redisService.outage.generation === 0) {
      if (Date.now() - start > 8000) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await h.snapshot()).resumePending).toBeUndefined();
  });
});
```

단계 7이 타이밍에 기대는지 확인한다 — `pending`이 끊기기 전에 락 안까지 들어가 커밋해 버리면 초록이 무의미하다. 그러면 `jest.spyOn(h.redisService, 'getUserContext')`로 락 안에서 붙잡아 두고 끊은 뒤 놓는 방식으로 바꾼다(CLAUDE.md 「순서를 강제하려면 조회를 조종한다」).

- [ ] **Step 10: 실패 확인** — `npm run test:int -w backend -- redis-outage` → 1~4에서 FAIL(`recoverFromOutage` 없음 / 폴드됨)

- [ ] **Step 11: 가드 구현**

`PlaysyncService.handleAction` 맨 앞(첫 `mutateSnapshot` 앞)에:

```ts
    // **Redis 장애 중에는 받지 않는다**(T97). 끊긴 동안은 어차피 못 쓰고,
    // 돌아온 직후 복구 스윕 전에는 **이미 지난 마감**으로 사람이 폴드된다.
    const outage = this.redis.outage;
    const generation = outage.generation;
    if (!outage.isUp()) throw new Error(SERVER_RECOVERING_MESSAGE);
```

`mutateSnapshot` 콜백 맨 앞(`if (!state) throw` 다음)에:

```ts
      // 락을 기다리는 사이 끊겼다 돌아왔을 수 있다. 끊기기 전에 나가 ioredis가
      // 들고 있던 명령이 복구 뒤 여기 닿으면, 그 사람의 판단은 장애 전 화면을
      // 보고 한 것이다 — 반영하지 않는다.
      if (outage.generation !== generation || !outage.isUp()) {
        throw new Error(SERVER_RECOVERING_MESSAGE);
      }
```

`SERVER_RECOVERING_MESSAGE`는 `@playsync/contract`에서 import.

- [ ] **Step 12: 복구 구현**

`RecoveryService`:

1. 생성자에서 구독한다(테스트가 `new`로 세우므로 `onModuleInit`은 안 된다):

```ts
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    // T97. 백엔드가 살아 있는 채 Redis만 끊겼다 돌아오는 경로다.
    // 핸들러는 인스턴스 메서드를 호출 시점에 찾는다 — 스펙이 스파이를 걸 수 있게.
    this.redis.outage.on('down', (downSince: number) => { void this.onRedisDown(downSince); });
    this.redis.outage.on('up', () => { void this.recoverFromOutage(); });
  }
```

2. 감지 순간 — DB만:

```ts
  /**
   * Redis가 끊겼다(T97). **DB는 살아 있으므로** 복귀를 기다리지 않고 대회를 켠다 —
   * DB만 읽는 화면(참가자 `/me`)이 장애 중에 곧바로 「복구 중」을 띄운다.
   * 실패하면 `recoverFromOutage`가 같은 조건부 update를 한 번 더 한다.
   */
  async onRedisDown(downSince: number): Promise<void> {
    try {
      await this.markSyncing(new Date(downSince));
    } catch (e) {
      this.logger.error('Redis 장애 — 대회를 SYNCING으로 켜지 못했다. 복귀 때 다시 한다', e as Error);
    }
  }

  /** 진행 중 대회를 켠다. 이미 SYNCING이면 pausedAt을 덮지 않는다(부팅 1단계와 같은 조건). */
  private async markSyncing(pausedAt: Date) {
    await this.prisma.tournament.updateMany({
      where: { status: TournamentStatus.ONGOING },
      data: { status: TournamentStatus.SYNCING, pausedAt },
    });
  }
```

3. 복귀 순간:

```ts
  /**
   * Redis가 돌아왔다(T97). 부팅과 같은 순서로 멈춰 세운다 — 다른 점은 둘이다.
   * 스냅샷을 잃은 테이블을 재구성하지 않고(런타임에 락 없이 돌면 착석과
   * 경합한다), 멈춰 세우기가 락을 탄다.
   *
   * 끝나면 `markRecovered` — 게이트웨이가 그 이벤트로 화면에 알리고 n/n을 센다.
   * **대회 하나가 실패해도 끝낸다.** 게이트를 영영 닫아 두면 모든 테이블이 선다.
   */
  async recoverFromOutage(): Promise<void> {
    const outage = this.redis.outage;
    const generation = outage.generation;
    const downSince = outage.downSince ?? Date.now();
    try {
      await this.markSyncing(new Date(downSince));
      const tournaments = await this.prisma.tournament.findMany({
        where: { status: TournamentStatus.SYNCING },
        select: { id: true },
      });
      for (const t of tournaments) {
        try {
          await this.freezeTournament(t.id, Date.now() - downSince);
        } catch (e) {
          this.logger.error(`Redis 장애 복구 실패 (tournament=${t.id})`, e as Error);
        }
      }
    } catch (e) {
      this.logger.error('Redis 장애 복구 자체가 실패했다', e as Error);
    }
    // 스윕 중에 또 끊겼으면 끝내지 않는다 — 다음 `up`이 처음부터 다시 한다.
    if (outage.generation === generation) outage.markRecovered();
  }
```

4. `recoverTournament`의 2단계(블라인드 대입)와 3단계의 「스냅샷이 있는 테이블」 처리를 `freezeTournament`로 뽑아 **부팅과 런타임이 같이 쓴다.** 부팅 쪽은 `freezeTournament` 뒤에 기존의 비트맵·빈 스냅샷·`rebuildTable` 처리를 그대로 이어 간다. 뽑는 모양:

```ts
  /**
   * 대회 하나의 시계를 멈춰 세운다 — 블라인드 기준점을 DB에서 대입하고, 차례가
   * 있던 테이블의 턴 시계를 멈춘다. **부팅과 Redis 복귀가 같이 쓴다**(T97).
   * 스냅샷이 없는 테이블은 건드리지 않는다 — 재구성은 부팅 전용이다.
   */
  private async freezeTournament(tournamentId: string, downMs: number) { /* 기존 2단계 + 테이블 루프의 pauseTable */ }
```

`pauseTurnClock`은 `pauseTable`로 이름을 바꾸고 `saveSnapshotUnlocked` 대신 `mutateSnapshot`을 탄다. **이미 `resumePending`이면 건너뛴다**(복구 중 재단절에서 세대를 두 번 올리지 않는다):

```ts
  private async pauseTable(tableId: string, downMs: number): Promise<void> {
    try {
      const next = await this.redis.mutateSnapshot(tableId, async (state) => {
        if (!state || state.resumePending) return null;
        const plan = planPause(state);
        if (!plan) return null;
        state.timerEpoch = plan.epoch;
        state.actionDeadline = undefined;
        state.resumePending = { downMs };
        return state;
      });
      if (next?.resumePending) {
        this.logger.log(`턴 시계를 멈췄다 — 딜러의 재개를 기다린다 (table=${tableId}, 세대 ${next.timerEpoch}, 정지 ${downMs}ms)`);
      }
    } catch (e) {
      this.logger.error(`턴 시계 정지 실패 (table=${tableId})`, e as Error);
    }
  }
```

**부팅 경로의 기존 동작을 바꾸지 않는다.** 부팅은 스냅샷이 이미 `resumePending`인 테이블(복구 중 재시작)도 `downMs`를 새로 써 왔다 — `recovery.service.int-spec.ts`의 재시작 검사(`firstDownMs`/`secondDownMs`)와 `syncing.int-spec.ts` 3단계가 그것을 본다. `pauseTable`에 `{ overwrite: boolean }`을 받아 부팅은 `true`, 런타임은 `false`로 부른다. 그 검사들이 여전히 초록인지 Step 14에서 확인한다.

`domain.md`가 적은 `boot-recovery` 사용처(`recoverTournament`의 빈 테이블 · `rebuildTable`)는 그대로다 — 줄어드는 것은 `pauseTurnClock` 한 곳뿐이다. 그 사실을 `saveSnapshotUnlocked`의 docblock에서 확인하고 필요하면 주석을 맞춘다.

- [ ] **Step 13: 통과 확인** — `npm run test:int -w backend -- redis-outage` PASS

- [ ] **Step 14: 회귀** — `npm run test:int -w backend -- recovery syncing pause-resume` PASS, `npm run test -w backend` PASS

- [ ] **Step 15: 실패를 먼저 본다(사후 확인)**
  - `RecoveryService` 생성자의 `'up'` 구독 줄을 주석 처리 → 시나리오 1~4가 빨개지는지 확인 → 복원
  - `handleAction`의 락 안 세대 검사를 지움 → 7이 빨개지는지 확인 → 복원. **안 빨개지면** 7이 타이밍에 기대고 있다는 뜻이다 — Step 9의 스파이 방식으로 고친다

- [ ] **Step 16: Commit**

```bash
git add packages/contract/src backend/src/redis backend/src/playsync/playsync.service.ts backend/src/recovery/recovery.service.ts backend/src/scenario/redis-outage.int-spec.ts
git commit -m "fix(T97): Redis만 죽었다 돌아와도 차례였던 사람을 폴드시키지 않는다"
```

---

### Task 2: 게이트웨이와 503 필터

**Files:**
- Modify: `backend/src/ws/ws.gateway.ts`
- Modify: `backend/src/ws/ws.gateway.int-spec.ts` (새 `describe('Redis 장애 (T97)')`, 파일 맨 끝)
- Create: `backend/src/common/redis-outage.filter.ts`, `backend/src/common/redis-outage.filter.spec.ts`
- Modify: `backend/src/app.module.ts`, `backend/src/app.module.filter.spec.ts`

**Interfaces:**
- Consumes: `RedisService.outage` (`isUp()`, 이벤트 `'down'` · `'recovered'`), `SERVER_OUTAGE_EVENT`, `ServerOutageSchema`, `SERVER_RECOVERING_MESSAGE`, `SERVER_RECOVERING_STATUS` (Task 1)
- Produces: 소켓 이벤트 `serverOutage { down }` — Task 3의 화면이 받는다. REST 503 본문 `{ statusCode: 503, message: SERVER_RECOVERING_MESSAGE, error: 'Service Unavailable' }`

- [ ] **Step 1: 게이트웨이 — 실패하는 통합 스펙**

`ws.gateway.int-spec.ts` 맨 끝에 추가한다. 이 파일의 `gateway`는 `beforeAll`의 `RedisService`를 쓴다 — 그 인스턴스의 `outage`를 직접 조종하려면 `(gateway as any).redis.outage`를 잡는다. 전이는 Task 1이 실제 클라이언트로 검증했으므로, 여기서는 **게이트웨이가 상태를 읽고 이벤트에 반응하는가**만 본다 — 상태를 바꾸는 방법은 `outage`에 `emit`하고 `phase`를 대입한다(게이트웨이 계층의 단위 관심사다).

```ts
  describe('Redis 장애 (T97)', () => {
    function outage() {
      return (gateway as any).redis.outage as import('src/redis/outage').RedisOutage;
    }
    function events(client: { send: jest.Mock }, name: string) {
      return client.send.mock.calls.map(([raw]: [string]) => JSON.parse(raw)).filter((m: any) => m.event === name);
    }

    beforeEach(async () => {
      (gateway as any).tableSessions.clear();
      await redis.set(`table:state:${TABLE}`, JSON.stringify(makeState()));
    });
    afterEach(() => { outage().phase = 'up'; });

    it('down이면 좌석 액션을 즉시 한국어로 거절한다', async () => {
      const seat = await connect(await seatTicket('alice'));
      outage().phase = 'down';
      const res = await gateway.handlePlayerAction(seat, { action: 'CALL' });
      expect(res).toEqual({ event: 'error', data: SERVER_RECOVERING_MESSAGE });
    });

    it('recovering이어도 딜러 명령을 거절한다', async () => {
      const d = await connect(await dealerTicket(TABLE));
      outage().phase = 'recovering';
      const res = await gateway.handleDealerAction(d, { action: 'START_PRE_FLOP' });
      expect(res).toEqual({ event: 'error', data: SERVER_RECOVERING_MESSAGE });
      expect(dealer.startPreFlop).not.toHaveBeenCalled();
    });

    it('up이면 거절하지 않는다 (반대 입력)', async () => {
      const seat = await connect(await seatTicket('alice'));
      const res = await gateway.handlePlayerAction(seat, { action: 'CALL' });
      expect(res?.data).not.toBe(SERVER_RECOVERING_MESSAGE);
    });

    it('down 이벤트에 테이블 소켓 전원이 down:true를 받는다', async () => {
      const seat = await connect(await seatTicket('alice'));
      const d = await connect(await dealerTicket(TABLE));
      outage().emit('down', Date.now());
      expect(events(seat, SERVER_OUTAGE_EVENT).at(-1)?.data).toEqual({ down: true });
      expect(events(d, SERVER_OUTAGE_EVENT).at(-1)?.data).toEqual({ down: true });
    });

    it('recovered 이벤트에 down:false와 renderGame을 받는다', async () => {
      const seat = await connect(await seatTicket('alice'));
      seat.send.mockClear();
      outage().emit('recovered');
      await new Promise((r) => setTimeout(r, 50));
      expect(events(seat, SERVER_OUTAGE_EVENT).at(-1)?.data).toEqual({ down: false });
      expect(events(seat, 'renderGame').length).toBeGreaterThan(0);
    });

    it('recovering 중에 붙은 소켓은 붙자마자 down:true를 받는다', async () => {
      outage().phase = 'recovering';
      const seat = await connect(await seatTicket('alice'));
      expect(events(seat, SERVER_OUTAGE_EVENT).at(-1)?.data).toEqual({ down: true });
    });

    it('up일 때 붙은 소켓에는 serverOutage를 보내지 않는다 (반대 입력)', async () => {
      const seat = await connect(await seatTicket('alice'));
      expect(events(seat, SERVER_OUTAGE_EVENT)).toHaveLength(0);
    });
  });
```

`recovered` 뒤의 n/n 재집계는 기존 `SYNCING (T96)` describe의 헬퍼(`seedSyncingTournament` · `seedSeats` · `lastSyncingPayload`)를 써서 한 건 더 넣는다 — `SYNCING` 대회에 딜러 둘이 이미 붙어 있는 상태에서 `outage().emit('recovered')`를 쏘면 `recovery.completeSync`가 불린다. 그 describe 안에 넣는다(헬퍼가 그 스코프에 있다).

import 추가: `SERVER_OUTAGE_EVENT`, `SERVER_RECOVERING_MESSAGE` from `@playsync/contract`.

- [ ] **Step 2: 실패 확인** — `npm run test:int -w backend -- ws.gateway` → 새 describe FAIL

- [ ] **Step 3: 게이트웨이 구현**

1. 생성자 본문에서 구독(테스트가 `new`로 세운다):

```ts
  ) {
    // T97. 끊긴 순간과 복구가 끝난 순간을 화면에 알린다. 복구 뒤 n/n은
    // 부팅 뒤와 같은 재집계로 센다 — 소켓이 안 끊겼으므로 보통 곧바로 찬다.
    this.redis.outage.on('down', () => this.broadcastOutage(true));
    this.redis.outage.on('recovered', () => { void this.afterOutage(); });
  }
```

2. 방송과 복구 뒤 처리:

```ts
  /** 테이블 방의 소켓 전원에게. 소켓 화면은 좌석·딜러 둘뿐이다. */
  private broadcastOutage(down: boolean) {
    const data = ServerOutageSchema.parse({ down });
    for (const tableId of [...this.tableSessions.keys()]) {
      this.broadcastToTable(tableId, SERVER_OUTAGE_EVENT, data);
    }
  }

  /**
   * 복구가 끝났다(T97). 멈춘 테이블의 새 스냅샷을 다시 그리게 하고, 대회마다
   * n/n을 센다. **Redis를 다시 읽는다** — 스윕이 쓴 `resumePending`이 거기 있다.
   */
  private async afterOutage() {
    this.broadcastOutage(false);
    for (const tableId of [...this.tableSessions.keys()]) {
      try {
        this.broadcastRenderGame(tableId, await this.redis.getSnapShot(tableId));
      } catch (e) {
        this.logger.error(`복구 뒤 renderGame 실패 (table=${tableId})`, e as Error);
      }
    }
    const live = await this.prisma.tournament
      .findMany({ where: { status: TournamentStatus.SYNCING }, select: { id: true } })
      .catch((e) => { this.logger.error('복구 뒤 대회 조회 실패', e); return []; });
    for (const t of live) {
      await this.reportSync(t.id).catch(() => { /* reportSync가 이미 로그로 남긴다 */ });
    }
  }
```

3. 게이트 — `handlePlayerAction`과 `handleDealerAction`의 역할 검사 **앞**에:

```ts
    if (!this.redis.outage.isUp()) return { event: 'error', data: SERVER_RECOVERING_MESSAGE };
```

4. 붙는 쪽 확인 — `handleConnection`의 테이블 경로에서 `renderGame`을 보낸 직후:

```ts
        // 복구 중에 붙었다(T97). 서버가 새 이벤트를 보장할 수 없는 자리라 붙는
        // 쪽이 매번 확인한다 — T96 `recount`의 joiner와 같은 이유다.
        if (!this.redis.outage.isUp()) {
          client.send(JSON.stringify({ event: SERVER_OUTAGE_EVENT, data: ServerOutageSchema.parse({ down: true }) }));
        }
```

- [ ] **Step 4: 통과 확인** — `npm run test:int -w backend -- ws.gateway` PASS

- [ ] **Step 5: 503 필터 — 실패하는 스펙**

`backend/src/common/redis-outage.filter.spec.ts`. `prisma-exception.filter.spec.ts`가 진짜 컨트롤러를 띄우는 방식을 그대로 따른다. 필터는 `RedisService`를 주입받으므로 테스트 모듈에 `{ provide: RedisService, useValue: { outage: { isUp: () => up } } }`를 준다.

검사 넷:
- Redis down 중 컨트롤러가 `new Error('Connection is closed.')`를 던지면 → 503, 본문 `{ statusCode: 503, message: SERVER_RECOVERING_MESSAGE, error: 'Service Unavailable' }`
- **Redis up일 때 같은 에러 → 500** (반대 입력 — 진짜 결함을 장애로 가리지 않는다)
- down 중 `NotFoundException` → 404 그대로 (HTTP 예외는 장애가 아니다)
- down 중 Prisma `P2002` → 409 그대로 (`PrismaExceptionFilter`가 여전히 이긴다). **이 검사는 두 필터를 `app.module.ts`와 같은 순서로 등록한 모듈에서 돌린다** — Nest의 전역 필터 선택 순서를 추측하지 말고 이 테스트로 확인한다

- [ ] **Step 6: 실패 확인** — `npm run test -w backend -- redis-outage.filter` FAIL

- [ ] **Step 7: 필터 구현**

```ts
import { ArgumentsHost, Catch, HttpException, Injectable } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { SERVER_RECOVERING_MESSAGE, SERVER_RECOVERING_STATUS } from '@playsync/contract';
import type { Response } from 'express';
import { RedisService } from 'src/redis/redis.service';
import { PrismaExceptionFilter } from './prisma-exception.filter';

/**
 * Redis 장애 중에 난 오류를 503으로 내린다(T97).
 *
 * 장애 중 REST는 ioredis가 재시도를 다 쓴 뒤 500 `Internal server error`를
 * 냈다(실측 약 5초). 화면은 그것을 원인 없는 실패로 그리거나, 대회 상세처럼
 * 「대회를 찾을 수 없습니다」라는 **틀린 말**을 했다.
 *
 * **장애 중일 때만 바꾼다.** Redis가 멀쩡할 때의 오류를 503으로 내리면 진짜
 * 결함이 「복구 중」으로 가려진다. HTTP 예외와 Prisma 오류도 장애가 아니므로
 * 원래 처리로 넘긴다.
 */
@Catch()
@Injectable()
export class RedisOutageFilter extends BaseExceptionFilter {
  private readonly prismaFilter = new PrismaExceptionFilter();

  constructor(private readonly redis: RedisService) {
    super();
  }

  catch(exception: unknown, host: ArgumentsHost) {
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.prismaFilter.catch(exception, host);
    }
    if (this.redis.outage.isUp() || exception instanceof HttpException) {
      return super.catch(exception, host);
    }
    host.switchToHttp().getResponse<Response>().status(SERVER_RECOVERING_STATUS).json({
      statusCode: SERVER_RECOVERING_STATUS,
      message: SERVER_RECOVERING_MESSAGE,
      error: 'Service Unavailable',
    });
  }
}
```

`BaseExceptionFilter`는 `APP_FILTER`로 등록할 때 HTTP 어댑터를 받아야 한다 — Step 5의 스펙이 실제 앱에서 500·404를 내는지로 확인한다. 안 되면 생성자에 `HttpAdapterHost`를 받아 `super(adapterHost.httpAdapter)`로 넘긴다.

`app.module.ts` providers에 `{ provide: APP_FILTER, useClass: RedisOutageFilter }`를 **`PrismaExceptionFilter` 줄 아래에** 추가하고, 이유를 한 줄 주석으로. `app.module.filter.spec.ts`에 등록 검사를 하나 추가한다.

필터가 `Prisma` 오류를 스스로 넘기므로 `PrismaExceptionFilter`의 `APP_FILTER` 등록이 여전히 필요한지 Step 5의 네 번째 검사로 판단한다 — 둘 다 걸린 채 초록이면 그대로 둔다. **지우는 결정은 하지 않는다**(`app.module.filter.spec.ts`가 그 등록을 지키고 있다).

- [ ] **Step 8: 통과 확인** — `npm run test -w backend` PASS, `npm run typecheck` 에러 0

- [ ] **Step 9: 실패를 먼저 본다(사후 확인)** — `handlePlayerAction`의 게이트 줄을 지우고 첫 검사가 빨개지는지, 필터의 `isUp()` 분기를 지우고 "up일 때 500" 검사가 빨개지는지 확인 → 복원

- [ ] **Step 10: Commit**

```bash
git add backend/src/ws backend/src/common backend/src/app.module.ts backend/src/app.module.filter.spec.ts
git commit -m "fix(T97): 장애를 좌석·딜러에 알리고 REST는 503으로 내린다"
```

---

### Task 3: 화면 — 모든 화면이 장애를 안다

**Files:**
- Create: `frontend/src/lib/server-outage.ts`, `frontend/src/lib/server-outage.test.ts`
- Modify: `frontend/src/lib/use-table-socket.ts` (+ `use-table-socket.test.ts`)
- Modify: `frontend/src/app/(terminal)/table/[tableId]/SeatGameClient.tsx` (+ test)
- Modify: `frontend/src/app/(terminal)/dealer/table/[tableId]/DealerGameClient.tsx` (+ test)
- Modify: `frontend/src/app/(terminal)/table/WaitingClient.tsx`, `frontend/src/app/(terminal)/dealer/DealerWaitingClient.tsx` (+ tests)
- Modify: `frontend/src/app/(terminal)/table/[tableId]/page.tsx`, `frontend/src/app/(terminal)/dealer/table/[tableId]/page.tsx`
- Modify: `frontend/src/app/(terminal)/table/page.tsx`, `frontend/src/app/(terminal)/dealer/page.tsx`
- Modify: `frontend/src/app/(board)/stores/[storeId]/tournaments/[tournamentId]/display/DisplayClient.tsx` (+ test)
- Modify: `frontend/src/app/(player)/tournaments/[id]/page.tsx`, `frontend/src/app/(player)/tournaments/page.tsx`, `frontend/src/app/(player)/me/page.tsx`
- Modify: `frontend/src/app/(console)/stores/[storeId]/tournaments/[tournamentId]/page.tsx`

**Interfaces:**
- Consumes: `SERVER_OUTAGE_EVENT`, `ServerOutageSchema`, `SERVER_RECOVERING_STATUS`, `SERVER_RECOVERING_MESSAGE` (Task 1). 백엔드는 장애 중 소켓에 `serverOutage {down}`을, REST에 503을 낸다(Task 2)
- Produces: `isServerRecovering(res: { status: number }): boolean`, `SERVER_RECOVERING_MESSAGE` 재수출 없음(계약에서 직접 import), `useTableSocket(...)`의 반환에 `outage: boolean`

**원칙.** 판정은 `isServerRecovering` 하나, 문구는 계약의 `SERVER_RECOVERING_MESSAGE` 하나다. 화면에 문자열을 다시 적지 않는다. **404·500·네트워크 실패는 기존 처리를 바꾸지 않는다** — 테스트마다 그 반대 입력을 넣는다.

- [ ] **Step 1: 판정 함수 — 실패하는 테스트**

```ts
// frontend/src/lib/server-outage.test.ts
import { describe, expect, it } from 'vitest';
import { isServerRecovering } from './server-outage';

describe('isServerRecovering', () => {
  it('503이면 참', () => expect(isServerRecovering({ status: 503 })).toBe(true));
  it.each([200, 404, 429, 500, 502])('%i는 거짓', (status) => expect(isServerRecovering({ status })).toBe(false));
});
```

- [ ] **Step 2: 실패 확인 → 구현 → 통과**

```ts
// frontend/src/lib/server-outage.ts
import { SERVER_RECOVERING_STATUS } from '@playsync/contract';

/**
 * 백엔드가 Redis 장애를 복구하는 중인가(T97). **판정은 여기 하나다** —
 * 화면마다 `status === 503`을 적으면 한쪽만 고쳐지는 날이 온다. 문구는
 * 계약의 `SERVER_RECOVERING_MESSAGE`를 쓴다.
 */
export function isServerRecovering(res: { status: number }): boolean {
  return res.status === SERVER_RECOVERING_STATUS;
}
```

`npm run test -w frontend -- server-outage` PASS

- [ ] **Step 3: `useTableSocket` — 실패하는 테스트**

`use-table-socket.test.ts`의 기존 가짜 소켓 헬퍼로:
- `serverOutage {down:true}` 수신 → `result.current.outage === true`
- 이어서 `{down:false}` → `false`
- 계약에 안 맞는 페이로드(`{}`) → 바뀌지 않음, `console.error`
- `serverOutage`는 `onMessage`로 넘기지 않는다(`keepalive`와 같은 취급) — `onMessage` 호출 0
- 티켓 요청이 503이면 **재시도를 예약한다**(기존 비-429 경로와 같다) — 그리고 `connectionError`는 `SERVER_RECOVERING_MESSAGE`(백엔드 본문 문구가 `api/ws-ticket` 라우트를 거쳐 그대로 온다)

- [ ] **Step 4: 구현**

`onmessage`에서 `KEEPALIVE_EVENT` 분기 옆에:

```ts
        // 서버 장애(T97). 화면이 그릴 것은 이 값 하나라 훅이 들고 돌려준다 —
        // 좌석·딜러가 각자 받으면 두 벌이 된다.
        if (parsed.event === SERVER_OUTAGE_EVENT) {
          const outage = ServerOutageSchema.safeParse(parsed.data);
          if (outage.success) setOutage(outage.data.down);
          else console.error('serverOutage 계약 위반 — 무시한다.', outage.error);
          return;
        }
```

`const [outage, setOutage] = useState(false);`, 반환에 `outage` 추가. 503 티켓은 기존 `!res.ok` 경로가 이미 재시도하고 본문 문구를 띄운다 — 테스트가 그것을 확인만 한다. **소켓이 끊겨 재접속 중이면 `outage`를 그대로 둔다**(끊긴 동안은 서버가 알릴 수 없다; 다시 붙으면 게이트웨이가 복구 중이면 `down:true`를 보내고, up이면 아무것도 안 보내므로 **첫 `renderGame`을 받을 때 `outage`를 false로 되돌린다** — 이 규칙도 테스트한다: `down:true` 뒤 재접속해 `renderGame`만 오면 false).

- [ ] **Step 5: 좌석·딜러 — 실패하는 테스트 → 구현 → 통과**

`SeatGameClient.test.tsx`에 기존 `socket.emitServerEvent` 헬퍼로:
- `serverOutage {down:true}` → `SERVER_RECOVERING_MESSAGE`를 담은 배너(`role="status"` 또는 기존 `connectionError` 배너와 같은 모양)가 보이고, 액션 버튼(콜·체크·폴드·레이즈)이 `disabled`, 턴 게이지(`ActionTimer`)가 안 보인다
- `{down:false}` → 배너가 사라지고 버튼이 다시 판단대로(차례면 활성)
- `resumePending` 배너와 동시에 오면 둘 다 보인다 — 서로 가리지 않는다

`DealerGameClient.test.tsx`:
- `down:true` → 같은 배너, 딜러 버튼(핸드 시작 · 승자 입력 · 이어서 진행 · 킥 · 폴드 · 저장 재시도)이 전부 `disabled`
- `down:false` → 복원

구현: `const { socketRef, connectionError, reconnecting, outage } = useTableSocket(...)`, 배너는 `connectionError` 배너 옆에 같은 스타일로, 버튼의 `disabled` 조건에 `|| outage`. 턴 게이지는 `outage`면 렌더하지 않는다.

- [ ] **Step 6: REST 화면 — 실패하는 테스트 → 구현 → 통과**

각 파일에서 백엔드 응답을 받는 자리에 `isServerRecovering(res)` 분기를 **기존 `!res.ok` 분기보다 앞에** 둔다. 화면별 기대 — 테스트가 있는 파일은 테스트를 먼저, 서버 컴포넌트(테스트가 없는 `page.tsx`)는 fetch 함수의 반환을 `{ kind: 'recovering' } | ...`로 넓혀 렌더에서 문구를 그린다.

| 파일 | 503일 때 | 반대 입력 |
|---|---|---|
| `DisplayClient.tsx` | 「서버 장애 복구 중」 전용 화면. 기존 `pausedAt` 화면과 같은 레이아웃, 시계 없이 `SERVER_RECOVERING_MESSAGE` 한 줄. 다음 200이 오면 원래 화면 | 500이면 지금처럼 직전 화면에 머문다 |
| `WaitingClient.tsx` · `DealerWaitingClient.tsx` | 폴링 실패 문구 자리에 `SERVER_RECOVERING_MESSAGE` | 네트워크 실패는 기존 처리 |
| `(terminal)/table/page.tsx` · `(terminal)/dealer/page.tsx` · 두 `[tableId]/page.tsx` | SSR fetch가 503이면 페이지가 문구를 그린다 | 404는 기존 문구 |
| `(player)/tournaments/[id]/page.tsx` | `fetchTournament`가 503이면 「대회를 찾을 수 없습니다」 대신 `SERVER_RECOVERING_MESSAGE` + 새로고침 안내 | 404면 기존 「대회를 찾을 수 없습니다」 |
| `(player)/tournaments/page.tsx` | 목록 fetch 503 → 문구 | 기존 |
| `(player)/me/page.tsx` | `fetchParticipations`가 503이면 「내 참가를 불러오지 못했습니다」 대신 문구. (정상이면 DB만 읽어 `SYNCING` 라벨 「복구 중」이 이미 뜬다) | 401·500은 기존 |
| `(console)/.../page.tsx` | `fetchSeatOccupants`가 503이면 `seatError`에 `SERVER_RECOVERING_MESSAGE`가 들어간다(본문 문구가 그대로 온다 — `failureMessage`). 다른 셋(`fetchTournament` · `fetchDashboard` · `fetchTables`)은 503이면 `null`/`[]` 그대로 | 소유권 거절(403)은 기존 |

**콘솔은 `seatError`가 페이지 문지기다**(T66). 503이면 소유권 확인이 안 된 것이라 문지기가 닫히는 것이 맞고, 그 문구가 장애 문구라 사람이 원인을 안다. `ConsoleClient`가 `seatError`를 어떻게 그리는지 읽고, 장애 문구가 「권한이 없습니다」류의 틀 안에 갇혀 오해되면 그 틀만 고친다.

- [ ] **Step 7: 전체 확인** — `npm run test -w frontend` PASS, `npm run typecheck` 에러 0

- [ ] **Step 8: 실패를 먼저 본다(사후 확인)** — `useTableSocket`의 `SERVER_OUTAGE_EVENT` 분기를 지우고 좌석·딜러 검사가, `isServerRecovering`을 `false` 고정으로 바꾸고 전광판·대회 상세 검사가 빨개지는지 확인 → 복원

- [ ] **Step 9: Commit**

```bash
git add frontend/src
git commit -m "fix(T97): 장애를 좌석·딜러·전광판·참가자·콘솔 화면이 모두 안다"
```

---

### Task 4: 실제 kill 검사 — `npm run test:outage`

**Files:**
- Create: `backend/docker-compose.outage.yml`
- Create: `backend/test/jest-outage.json`, `backend/test/outage/global-setup.ts`, `backend/test/outage/global-teardown.ts`, `backend/test/outage/redis-kill.outage-spec.ts`
- Modify: `backend/package.json` (`test:outage` · `test:outage:down`), 루트 `package.json` (`test:outage`)

**Interfaces:**
- Consumes: 빌드된 백엔드(`backend/dist/src/main.js`), 데모 시드(`backend/prisma/seed.ts`가 쓰는 `.demo-seed.json`), Task 1~2의 동작(`serverOutage` · 한국어 즉시 거절 · `SYNCING` · `resumePending`)
- Produces: 사람이 돌리는 검사 하나. CI에 넣지 않는다

- [ ] **Step 1: 무대**

`backend/docker-compose.outage.yml` — **개발·통합과 포트가 다르다**(5434 / 6381). Redis 영속은 **개발 compose와 같게** 둔다:

```yaml
# 실제 kill 검사(T97) 전용. 개발 DB를 지우지 않으려고 따로 띄운다.
# Redis 영속은 개발 compose와 같다(AOF) — 통합 테스트용 Redis는 영속을 꺼
# 둬서 재시작이 곧 유실이 되어, 다른 장애를 재게 된다.
name: playsync-outage
services:
  db-outage:
    image: postgres:18
    container_name: playsync-db-outage
    environment:
      POSTGRES_USER: root
      POSTGRES_PASSWORD: outage
      POSTGRES_DB: playsync
    ports:
      - "127.0.0.1:5434:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U root -d playsync"]
      interval: 2s
      timeout: 3s
      retries: 30
  redis-outage:
    image: redis:7
    container_name: playsync-redis-outage
    ports:
      - "127.0.0.1:6381:6379"
    command: redis-server --requirepass outage --appendonly yes --save 60 1
    volumes:
      - redis-outage-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "outage", "ping"]
      interval: 1s
      timeout: 3s
      retries: 30
volumes:
  redis-outage-data:
```

- [ ] **Step 2: 기동과 정리**

`global-setup.ts`: `docker compose -f docker-compose.outage.yml up -d --wait` → 환경(`DATABASE_URL=postgresql://root:outage@127.0.0.1:5434/playsync?schema=public`, `REDIS_HOST=127.0.0.1`, `REDIS_PORT=6381`, `REDIS_PASSWORD=outage`)으로 `npx prisma migrate deploy` → `npx prisma db seed` → `backend/dist/src/main.js`가 없으면 `npm run build`(루트에서 contract 먼저) → 백엔드를 `PORT=3201`로 자식 프로세스로 띄우고 `POST /auth/login`이 응답할 때까지 폴링. 자식 pid를 `globalThis`가 아니라 **파일**(`test/outage/.pid`)에 적는다 — jest 전역 셋업과 스펙은 다른 컨텍스트다.

**시드가 리포 루트의 `.demo-seed.json`을 덮어쓴다.** 셋업이 원래 파일을 `test/outage/.demo-seed.backup.json`으로 옮겨 두고 teardown이 되돌린다. 셋업이 매니페스트 경로를 스펙에 넘길 때도 파일로 넘긴다.

`global-teardown.ts`: 자식 프로세스 종료, 매니페스트 복원. 컨테이너는 `KEEP_OUTAGE_CONTAINERS=1`이 아니면 `down -v`.

`jest-outage.json`: `jest-int.json`을 본떠 `testRegex: ".*\\.outage-spec\\.ts$"`, `testTimeout: 180000`, `maxWorkers: 1`, 위 셋업·teardown.

- [ ] **Step 3: 검사**

`redis-kill.outage-spec.ts` — 로직은 2026-09-13 실측 스크립트와 같다. `ws` 패키지(백엔드 의존성에 있다)와 전역 `fetch`로:

1. 매니페스트의 첫 대회 테이블 1에 좌석 넷을 참가 OTP로 앉힌다(`POST /tournaments/:id/enter`), 테이블 2에 셋. `owner`로 로그인해 `PATCH /store/sessions/:id/start`
2. 딜러 인증(`POST /dealer/auth`) · 소켓마다 티켓(`POST /ws/ticket`) · `ws://127.0.0.1:3201/playsync?ticket=…&tableId=…`에 `Origin: http://localhost:3000`으로 붙는다. 모든 수신을 소켓별 배열에 쌓는다
3. 딜러 `START_PRE_FLOP` → 차례인 좌석이 콜 한 번 → **다음 차례인 사람(victim)** 기록
4. `docker kill playsync-redis-outage` — 시각 기록
5. 3초 뒤 victim이 콜 → **1초 안에** `{event:'error', data: SERVER_RECOVERING_MESSAGE}` 수신
6. 좌석·딜러 전원이 `serverOutage {down:true}`를 받았다
7. 장애 중 DB(`pg` 직접 조회 또는 Prisma)에서 대회 `status === 'SYNCING'`
8. 30초 뒤 `docker start playsync-redis-outage`, `redis-cli ping`이 될 때까지 대기
9. 40초 관찰 — victim에게 `hasFolded: true`인 `renderGame`이 **오지 않는다**, `serverOutage {down:false}`를 받는다, 마지막 `renderGame`에 `resumePending`
10. DB에서 대회 `status === 'ONGOING'`(n/n — 딜러가 붙어 있다), `pausedMs`가 **25~40초**
11. 딜러 `RESUME_TABLE` → 핸드를 체크·콜로 쇼다운까지 → `RESOLVE_WINNERS` → 칩 총량이 처음과 같다
12. 모든 소켓을 닫는다

단계마다 실패 메시지에 단계 이름이 남게 값을 문자열로 감싼다(`CLAUDE.md` 테스트 규칙).

- [ ] **Step 4: 스크립트**

`backend/package.json`:

```json
    "test:outage": "jest --config ./test/jest-outage.json",
    "test:outage:down": "docker compose -f docker-compose.outage.yml down -v",
```

루트 `package.json`: `"test:outage": "npm run test:outage -w backend"`

루트 `npm run test`(jest 기본 `testRegex: .*\.spec\.ts$`)와 `test:int`(`.int-spec.ts`)가 `.outage-spec.ts`를 집지 않는지 확인한다.

- [ ] **Step 5: 실행** — Docker가 떠 있어야 한다. `npm run test:outage` PASS. **실패하면 제품 결함인지 검사 결함인지 가른다** — 로그(`test/outage/backend.log`에 자식 stdout을 남긴다)를 읽는다

- [ ] **Step 6: 실패를 먼저 본다** — Task 1의 `RecoveryService` 생성자 `'up'` 구독 줄을 주석 처리하고 빌드 → `npm run test:outage` → 9에서 폴드로 빨개지는지 → 복원·재빌드

- [ ] **Step 7: Commit**

먼저 `.gitignore`에 `backend/test/outage/.pid`, `backend/test/outage/*.log`, `backend/test/outage/.demo-seed.backup.json`을 추가한다.

```bash
git add .gitignore backend/docker-compose.outage.yml backend/test/jest-outage.json backend/test/outage backend/package.json package.json
git commit -m "test(T97): Redis 컨테이너를 실제로 죽였다 살리는 검사"
```

---

## 메인이 할 일 (하위 에이전트 몫이 아니다)

1. 최종 전체 리뷰(opus)
2. 기준선 실측 — contract · 백엔드 단위 · 프론트 단위 · 통합 · `test:outage`
3. SSOT 커밋 — `tickets-recovery.md`(T97·T98·T99 완료, 잔여 목록의 「실제 kill 무대」 닫음 · 조용한 끊김 · 데이터 유실 · 짧은 장애 오프라인 큐 추가), `domain.md` 「서버가 죽어도 대회는 계속된다」(Redis 경로 · 런타임 호출자 · `boot-recovery` 사용처), `backlog.md` B9(가드 이전), `CLAUDE.md`(기준선 · `test:outage` 명령과 테스트 표 한 줄)
4. PR 열고 번호를 상태 열에 반영해 커밋, 머지
