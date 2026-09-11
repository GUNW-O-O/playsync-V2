# T96 PR 1 — 좀비 소켓 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 말없이 사라진 소켓을 서버가 치우고, 태블릿도 자기가 끊긴 것을 스스로 알아 다시 붙게 한다.

**Architecture:** 서버는 `SOCKET_PING_MS`마다 모든 소켓에 프로토콜 ping을 보내고 직전 틱 뒤 pong이 없던 소켓을 `terminate()`한다. 같은 틱에 앱 레벨 `keepalive` 이벤트를 보낸다. 태블릿 훅(`useTableSocket`)은 마지막 수신 뒤 `SOCKET_SILENCE_MS`가 지나면 그 소켓을 버리고 T93 재접속 경로를 탄다. 판정 로직은 순수 모듈(`ws/keepalive.ts`)로 빼 인프라 없이 검증한다.

**Tech Stack:** NestJS `@nestjs/platform-ws`(`ws` 8.x) · Next.js 클라이언트 훅 · jest(백엔드) · vitest + Testing Library(프론트) · zod contract

**Spec:** `docs/superpowers/specs/2026-09-11-t96-syncing-design.md` 1부

## Global Constraints

- `SOCKET_PING_MS = 10_000`, `SOCKET_SILENCE_MS = 25_000`. 테스트용 덮어쓰기는 환경 변수 `WS_PING_INTERVAL_MS`(백엔드)와 훅 인자 `silenceMs`(프론트)만 둔다.
- 이벤트 이름은 contract의 `KEEPALIVE_EVENT = 'keepalive'` 한 곳. 페이로드는 없다(`data`는 보내지 않는다).
- 문서(`docs/`, `CLAUDE.md`)는 건드리지 않는다. 주석은 코드라 함께 간다. 코드를 가리킬 때 줄 번호 대신 이름을 쓴다.
- 커밋 메시지·주석은 한국어(기존 파일을 따른다).
- 새 테스트는 **실패를 먼저 본다.**

---

### Task 1: 서버 — ping/pong 청소와 keepalive

**Files:**
- Create: `packages/contract/src/keepalive.ts`
- Modify: `packages/contract/src/index.ts` (export 한 줄)
- Create: `backend/src/ws/keepalive.ts`
- Create: `backend/src/ws/keepalive.spec.ts`
- Modify: `backend/src/ws/ws.gateway.ts` (`OnModuleInit`/`OnModuleDestroy`, `handleConnection`에 pong 배선, `sweepSockets` 호출)
- Modify: `backend/src/ws/ws.gateway.int-spec.ts` (배선 검사 한 `describe`)

**Interfaces:**
- Produces: contract `KEEPALIVE_EVENT: 'keepalive'`. 백엔드 `SOCKET_PING_MS`, `socketPingMs(raw?: string): number`, `markAlive(s)`, `sweep(sockets, message): KeepaliveSocket[]`(끊은 소켓 목록).

- [ ] **Step 1: contract에 이벤트 이름을 둔다**

`packages/contract/src/keepalive.ts`:

```ts
/**
 * 서버가 주기마다 모든 소켓에 보내는 앱 레벨 신호(T96).
 *
 * **프로토콜 ping만으로는 태블릿이 자기가 끊긴 줄 모른다.** 브라우저 JS는
 * ping 프레임을 볼 수 없고, 태블릿은 사람이 누를 때만 보낸다 — 서버가 좀비를
 * 치워도 `onclose`가 안 떠서 T93의 재접속이 영영 시작되지 않는다. 이 이벤트가
 * 태블릿이 "아직 붙어 있다"를 확인하는 유일한 근거다(`useTableSocket`).
 *
 * 페이로드가 없다. 이름만 두 쪽이 공유한다 — 문자열을 두 곳에 적으면 한쪽만
 * 고쳐지는 날이 온다.
 */
export const KEEPALIVE_EVENT = "keepalive" as const;
```

`packages/contract/src/index.ts` 끝에 `export * from "./keepalive";` 추가.

- [ ] **Step 2: 순수 모듈의 실패하는 테스트**

`backend/src/ws/keepalive.spec.ts`:

```ts
import { markAlive, socketPingMs, sweep, SOCKET_PING_MS, KeepaliveSocket } from './keepalive';

function fake(): KeepaliveSocket & { pings: number; terminated: boolean; sent: string[] } {
  const s: any = {
    readyState: 1,
    pings: 0,
    terminated: false,
    sent: [] as string[],
    ping() { s.pings += 1; },
    terminate() { s.terminated = true; },
    send(m: string) { s.sent.push(m); },
  };
  markAlive(s);
  return s;
}

describe('keepalive sweep', () => {
  it('pong이 없던 소켓은 다음 틱에 끊는다', () => {
    const s = fake();
    sweep([s], 'm'); // 첫 틱: ping을 보내고 "답을 기다린다"로 표시
    const dead = sweep([s], 'm'); // 두 번째 틱: 답이 없었다
    expect(dead).toEqual([s]);
    expect(s.terminated).toBe(true);
  });

  /**
   * **반대 입력.** 이것이 없으면 "매 틱 전부 끊는다"도 위 검사를 통과한다.
   */
  it('틱 사이에 pong을 받은 소켓은 살려 두고 신호를 보낸다', () => {
    const s = fake();
    sweep([s], 'm');
    markAlive(s); // pong 도착
    const dead = sweep([s], 'm');
    expect(dead).toEqual([]);
    expect(s.terminated).toBe(false);
    expect(s.pings).toBe(2);
    expect(s.sent).toEqual(['m', 'm']);
  });

  it('이미 닫힌 소켓에는 보내지 않고 끊은 목록에 넣는다', () => {
    const s = fake();
    s.readyState = 3;
    expect(sweep([s], 'm')).toEqual([s]);
    expect(s.sent).toEqual([]);
  });

  it('ping이 던져도 나머지 소켓을 계속 돈다', () => {
    const bad = fake();
    bad.ping = () => { throw new Error('boom'); };
    const good = fake();
    const dead = sweep([bad, good], 'm');
    expect(dead).toEqual([bad]);
    expect(good.pings).toBe(1);
  });

  it('주기는 기본 10초, 환경 변수로 덮고, 잘못된 값이면 기본으로 돌아간다', () => {
    expect(SOCKET_PING_MS).toBe(10_000);
    expect(socketPingMs(undefined)).toBe(10_000);
    expect(socketPingMs('50')).toBe(50);
    expect(socketPingMs('abc')).toBe(10_000);
    expect(socketPingMs('0')).toBe(10_000);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npm test -w backend -- keepalive.spec`
Expected: FAIL — `Cannot find module './keepalive'`

- [ ] **Step 4: 순수 모듈 구현**

`backend/src/ws/keepalive.ts`:

```ts
/**
 * 좀비 소켓 청소(T96).
 *
 * 서버가 연결의 끝을 아는 길은 둘뿐이다 — 상대가 FIN/RST를 보내거나, 보낸
 * 데이터의 재전송이 끝내 실패하거나(리눅스 기본 15~30분). **말없이 사라지는**
 * 경로(와이파이 이탈 · 전원 차단 · 절전 · 공유기 재부팅 · 망 전환)에서는 앞의
 * 것이 안 오고, 보낼 것이 없으면 뒤의 것도 시작되지 않는다. 그 소켓은
 * `readyState === OPEN`인 채로 방에 남는다.
 *
 * 그래서 주기마다 ping을 보내고 **직전 틱 뒤로 pong이 없던 소켓을 끊는다.**
 * 브라우저는 ping에 pong을 자동으로 답한다 — 프론트가 할 일이 없다.
 *
 * 순수 모듈이다. 타이머도 게이트웨이도 모른다 — 그래야 "두 틱 뒤에 끊긴다"를
 * 실제로 기다리지 않고 잰다(`reconnect-policy.ts`·`turn-clock.ts`와 같은 이유).
 */

/** ping 주기. 서버의 판정 폭이 이 값의 1~2배다. */
export const SOCKET_PING_MS = 10_000;

export interface KeepaliveSocket {
  readyState: number;
  /** 직전 ping 뒤로 pong을 받았나. `markAlive`와 `sweep`만 쓴다. */
  isAlive?: boolean;
  ping(): void;
  terminate(): void;
  send(message: string): void;
}

const OPEN = 1;

/** 테스트가 주기를 줄일 수 있게 한다. 양의 정수가 아니면 기본값이다. */
export function socketPingMs(raw: string | undefined = process.env.WS_PING_INTERVAL_MS): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : SOCKET_PING_MS;
}

/** 접속 직후와 pong을 받을 때 부른다. */
export function markAlive(socket: KeepaliveSocket) {
  socket.isAlive = true;
}

/**
 * 한 틱. 답이 없던 소켓은 끊고, 나머지에는 ping과 앱 레벨 신호를 보낸다.
 *
 * **하나가 던져도 나머지를 돈다.** `WsGateway.broadcast`가 죽은 소켓 하나에
 * 루프를 멈추지 않는 것과 같은 이유다.
 *
 * @returns 끊은 소켓. 부르는 쪽이 방에서 뺀다.
 */
export function sweep(sockets: Iterable<KeepaliveSocket>, message: string): KeepaliveSocket[] {
  const dead: KeepaliveSocket[] = [];
  for (const s of sockets) {
    if (s.readyState !== OPEN || s.isAlive === false) {
      try { s.terminate(); } catch { /* 이미 닫혔다 */ }
      dead.push(s);
      continue;
    }
    try {
      s.isAlive = false;
      s.ping();
      s.send(message);
    } catch {
      try { s.terminate(); } catch { /* 이미 닫혔다 */ }
      dead.push(s);
    }
  }
  return dead;
}
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -w backend -- keepalive.spec`
Expected: PASS (5)

- [ ] **Step 6: 게이트웨이 배선의 실패하는 테스트**

`backend/src/ws/ws.gateway.int-spec.ts`의 최상위 `describe` 안 끝부분에 추가. 기존 `makeClient`는 `ping`·`terminate`·`on`이 없으므로 이 블록에서만 확장한다. 이 파일의 좌석 티켓·스냅샷 준비 방식(`seatTicket`, `redis.saveSnapshotUnlocked` 또는 파일이 쓰는 헬퍼, `makeState`)을 그대로 따른다 — 아래의 `seedTableSnapshot`은 **이 파일에서 테이블 접속 테스트가 이미 쓰는 준비 코드로 바꿔 넣는다.**

```ts
  describe('좀비 소켓 청소 (T96)', () => {
    function makeLiveClient() {
      const handlers: Record<string, () => void> = {};
      const client: any = makeClient();
      client.ping = jest.fn();
      client.terminate = jest.fn(() => { client.readyState = 3; });
      client.on = jest.fn((ev: string, fn: () => void) => { handlers[ev] = fn; });
      client.pong = () => handlers.pong?.();
      return client;
    }

    it('pong을 안 한 테이블 소켓은 두 틱 뒤 끊고 방에서 뺀다. pong한 소켓은 살아서 keepalive를 받는다', async () => {
      await seedTableSnapshot(); // ← 이 파일의 기존 준비 코드
      const zombie = makeLiveClient();
      const alive = makeLiveClient();
      await gateway.handleConnection(zombie, makeRequest(`tableId=${TABLE}&ticket=${await seatTicket('alice')}`, ORIGIN));
      await gateway.handleConnection(alive, makeRequest(`tableId=${TABLE}&ticket=${await seatTicket('bob')}`, ORIGIN));

      gateway.sweepSockets();
      alive.pong();
      gateway.sweepSockets();

      expect(zombie.terminate).toHaveBeenCalled();
      expect(alive.terminate).not.toHaveBeenCalled();
      expect(alive.send).toHaveBeenCalledWith(JSON.stringify({ event: 'keepalive' }));
      expect((gateway as any).tableSessions.get(TABLE)?.has(zombie)).toBe(false);
      expect((gateway as any).tableSessions.get(TABLE)?.has(alive)).toBe(true);
    });
  });
```

`ORIGIN`은 이 파일이 쓰는 허용 출처 상수 이름으로 맞춘다.

- [ ] **Step 7: 실패 확인**

Run: `npm run test:int -w backend -- ws.gateway.int-spec -t "좀비"`
Expected: FAIL — `gateway.sweepSockets is not a function`

- [ ] **Step 8: 게이트웨이 배선**

`backend/src/ws/ws.gateway.ts`:

1. import 추가:
```ts
import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { KEEPALIVE_EVENT } from '@playsync/contract';
import { markAlive, socketPingMs, sweep } from './keepalive';
```
2. 클래스 선언을 `implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy`로.
3. 필드와 수명 주기:
```ts
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 좀비 소켓 청소를 시작한다(T96). 게이트웨이에 하트비트가 없던 동안 반만
   * 닫힌 TCP가 방에 `OPEN`으로 남았다 — 딜러 복귀를 소켓으로 세려면
   * (`SYNCING`의 n/n) 그 수가 사실이어야 한다.
   *
   * 테스트는 게이트웨이를 `new`로 세우므로 이 훅이 돌지 않는다. 틱은
   * `sweepSockets`를 직접 불러 잰다.
   */
  onModuleInit() {
    this.pingTimer = setInterval(() => this.sweepSockets(), socketPingMs());
  }

  onModuleDestroy() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** 한 틱. 두 방(대회 · 테이블)의 소켓 전부. */
  sweepSockets() {
    const message = JSON.stringify({ event: KEEPALIVE_EVENT });
    const all = new Set<any>();
    for (const set of this.tableSessions.values()) for (const s of set) all.add(s);
    for (const set of this.tournamentSessions.values()) for (const s of set) all.add(s);
    // `terminate()`는 `ws`가 `close`를 내게 해 `handleDisconnect`가 따로 불리지만,
    // 여기서 먼저 빼 둔다 — 두 번 불려도 같다(Set.delete).
    for (const dead of sweep(all, message)) this.handleDisconnect(dead);
  }
```
4. `handleConnection`에서 `(client as any).role = payload.role;` 바로 아래:
```ts
      // 좀비 판정의 근거(T96). 브라우저는 ping에 자동으로 pong한다.
      markAlive(client as any);
      (client as any).on?.('pong', () => markAlive(client as any));
```

- [ ] **Step 9: 통과 확인**

Run: `npm test -w backend -- keepalive.spec && npm run test:int -w backend -- ws.gateway.int-spec`
Expected: PASS (기존 게이트웨이 통합 전부 + 새 1)

- [ ] **Step 10: 실패를 먼저 봤는지 되돌려 확인**

`handleConnection`의 `(client as any).on?.('pong', …)` 줄을 임시로 주석 처리 → 새 통합 검사가 빨갛게(`alive.terminate`가 불림) 되는지 본다 → 복원.

- [ ] **Step 11: 커밋**

```bash
git add packages/contract/src/keepalive.ts packages/contract/src/index.ts backend/src/ws/keepalive.ts backend/src/ws/keepalive.spec.ts backend/src/ws/ws.gateway.ts backend/src/ws/ws.gateway.int-spec.ts
git commit -m "feat(T96): 게이트웨이가 pong 없는 소켓을 끊고 keepalive를 보낸다"
```

---

### Task 2: 태블릿 — 침묵 감시

**Files:**
- Modify: `frontend/src/lib/use-table-socket.ts`
- Create: `frontend/src/lib/use-table-socket.test.ts`

**Interfaces:**
- Consumes: contract `KEEPALIVE_EVENT`.
- Produces: `SOCKET_SILENCE_MS = 25_000` (export), 훅 인자 `silenceMs?: number`.

- [ ] **Step 1: 실패하는 테스트**

`frontend/src/lib/use-table-socket.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';
import { KEEPALIVE_EVENT } from '@playsync/contract';
import { SOCKET_SILENCE_MS, useTableSocket } from './use-table-socket';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send() {}
  // 죽은 연결에서는 브라우저가 onclose를 늦게(또는 영영) 부른다. 그래서 가짜도
  // close()에서 onclose를 부르지 않는다 — 훅이 그것에 기대면 이 테스트가 잡는다.
  close() { this.closed = true; }
  emit(event: string, data?: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify({ event, data }) }));
  }
}

const SILENCE = 60;

beforeEach(() => {
  FakeSocket.instances.length = 0;
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  vi.spyOn(Math, 'random').mockReturnValue(0); // 좌석 재접속 지연 0
  server.use(http.post('*/api/ws-ticket', () => HttpResponse.json({ ticket: 't' })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mount(onMessage = vi.fn()) {
  return renderHook(() =>
    useTableSocket({ tableId: 'tbl', role: 'seat', onMessage, defaultError: 'x', silenceMs: SILENCE }),
  );
}

describe('useTableSocket 침묵 감시 (T96)', () => {
  it('기본값은 25초다', () => {
    expect(SOCKET_SILENCE_MS).toBe(25_000);
  });

  it('침묵이 길어지면 그 소켓을 버리고 새 소켓을 연다', async () => {
    mount();
    await waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 1000 });
    expect(FakeSocket.instances[0].closed).toBe(true);
  });

  /**
   * **반대 입력.** 이것이 없으면 "일정 시간마다 무조건 다시 연다"도 위를 통과한다.
   */
  it('keepalive가 계속 오면 다시 열지 않는다', async () => {
    mount();
    await waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    const s = FakeSocket.instances[0];
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, SILENCE / 2));
      s.emit(KEEPALIVE_EVENT);
    }
    expect(FakeSocket.instances.length).toBe(1);
  });

  it('keepalive는 화면 콜백으로 넘기지 않는다', async () => {
    const onMessage = vi.fn();
    mount(onMessage);
    await waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    FakeSocket.instances[0].emit(KEEPALIVE_EVENT);
    FakeSocket.instances[0].emit('renderGame', { x: 1 });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith('renderGame', { x: 1 });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w frontend -- use-table-socket`
Expected: FAIL — `SOCKET_SILENCE_MS`가 export되지 않음 / 두 번째 소켓이 안 열림

- [ ] **Step 3: 구현**

`frontend/src/lib/use-table-socket.ts`:

1. import에 `import { KEEPALIVE_EVENT } from '@playsync/contract';`
2. 상수(훅 위):
```ts
/**
 * 이만큼 아무것도 못 받으면 연결이 죽은 것으로 본다(T96).
 *
 * 서버가 10초마다 `keepalive`를 보낸다(`WsGateway.sweepSockets`). **두 틱을
 * 놓치고도 남는 값**이라 GC나 망 흔들림 한 번으로 끊지 않는다.
 *
 * 필요한 이유: 서버가 좀비를 치워도 태블릿은 모른다. 브라우저 JS는 프로토콜
 * ping을 볼 수 없고 태블릿은 사람이 누를 때만 보내므로 `onclose`가 안 뜬다 —
 * 그러면 아래 재접속이 영영 시작되지 않는다.
 */
export const SOCKET_SILENCE_MS = 25_000;
```
3. 인자에 `silenceMs = SOCKET_SILENCE_MS` 추가(타입: `silenceMs?: number` — 주석 "테스트가 줄인다"). effect 의존성 배열에 `silenceMs` 추가.
4. effect 안 `let attempt = 0;` 아래에 감시 타이머:
```ts
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    /**
     * 수신이 있을 때마다 다시 건다. 울리면 그 소켓을 **버리고** 재접속한다.
     *
     * `close()`만 부르고 `onclose`를 기다리지 않는다 — 죽은 연결에서는 닫는
     * 핸드셰이크가 오지 않아 브라우저가 그 이벤트를 한참 뒤에야(또는 영영)
     * 낸다. 핸들러를 먼저 떼어 늦게 오는 `onclose`가 두 번째 예약을 걸지 않게
     * 한다.
     */
    function armWatchdog(target: WebSocket) {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (cancelled || socket !== target) return;
        target.onmessage = null;
        target.onclose = null;
        target.onerror = null;
        target.close();
        setConnectionError(defaultError);
        scheduleRetry(null);
      }, silenceMs);
    }
```
5. `socketRef.current = socket;` 다음 줄에 `armWatchdog(socket);`
6. `onmessage` 안 JSON 파싱 성공 직후(`attempt = 0;` 앞)에 `armWatchdog(socket!);` 그리고 `if (parsed.event) onMessageRef.current(...)`를 다음으로 바꾼다:
```ts
        // keepalive는 연결 확인일 뿐 화면이 그릴 것이 없다.
        if (parsed.event && parsed.event !== KEEPALIVE_EVENT) {
          onMessageRef.current(parsed.event, parsed.data);
        }
```
   (keepalive도 "등록된 소켓만 받는다"는 점에서 첫 프레임 증거와 같으므로 `attempt = 0` 등은 그대로 둔다.)
7. `onclose` 핸들러 맨 앞(`if (cancelled) return;` 다음)에 `if (watchdog) clearTimeout(watchdog);`
8. cleanup에 `if (watchdog) clearTimeout(watchdog);`

- [ ] **Step 4: 통과 확인 + 기존 화면 테스트**

Run: `npm test -w frontend`
Expected: PASS 전부. `SeatGameClient.test.tsx`·`DealerGameClient.test.tsx`의 기존 재접속 검사가 그대로 초록이어야 한다(가짜 소켓이 keepalive를 안 보내도 25초 안에 끝나므로 감시가 울리지 않는다).

- [ ] **Step 5: 실패를 먼저 봤는지 되돌려 확인**

`armWatchdog(socket);`(연결 직후 한 줄)과 `onmessage` 안 `armWatchdog` 호출을 임시로 지워 "침묵이 길어지면" 검사가 빨갛게 되는지 확인 → 복원. `KEEPALIVE_EVENT` 거르기를 지워 세 번째 검사가 빨갛게 되는지 확인 → 복원.

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/lib/use-table-socket.ts frontend/src/lib/use-table-socket.test.ts
git commit -m "feat(T96): 태블릿이 침묵을 보고 스스로 다시 붙는다"
```

---

### Task 3 (메인): 검증과 부하 스모크

하위 에이전트 몫이 아니다.

- [ ] `npm run typecheck && npm run test && npm run test:int` — 전부 초록, 건수 기록
- [ ] 부하 스모크: k6 봇 소켓이 ping에 pong하는지 확인. `load/README.md`의 스모크 명령으로 무대를 띄우고 `WS_PING_INTERVAL_MS=2000`으로 백엔드를 올린 뒤 1분 돌려, 봇 소켓이 끊기지 않는지(`reconnect` 계열 지표 0, 백엔드 로그에 대량 종료 없음) 본다. 끊기면 `load/lib/table.js`에 pong 응답을 붙이는 작업을 이 PR에 더한다.
- [ ] PR 생성(한국어). 본문에 SSOT는 PR 2에 얹는다고 적는다.
