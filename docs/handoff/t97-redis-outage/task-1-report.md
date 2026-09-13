# Task 1 report — 백엔드 코어 (감지 · 가드 · 복구 스윕)

Status: DONE_WITH_CONCERNS
Commit: `a5eed8e fix(T97): Redis만 죽었다 돌아와도 차례였던 사람을 폴드시키지 않는다`

## 구현한 것

- **contract** `server-outage.ts`: `ServerOutageSchema`, `ServerOutage`, `SERVER_OUTAGE_EVENT`,
  `SERVER_RECOVERING_STATUS = 503`, `SERVER_RECOVERING_MESSAGE`. `index.ts`에서 re-export.
  스펙은 jest(계약 패키지가 jest라서 brief의 vitest import를 뺐다).
- **`backend/src/redis/outage.ts`**: `OutagePhase`, `RedisOutage`(brief 그대로), 그리고
  **`outageOf(client)`** — 클라이언트별 WeakMap으로 상태를 하나만 둔다(아래 「벗어난 점」).
- **`RedisService.outage`** (public readonly) = `outageOf(redis)`. 생성자 시그니처 불변.
  `saveSnapshotUnlocked` docblock에 런타임 스윕은 이 예외를 안 쓴다는 한 줄.
- **`PlaysyncService.handleAction`**: 락 밖 `isUp` 가드 + 락 안(`if (!state) throw` 다음)
  세대/`isUp` 가드. 둘 다 `SERVER_RECOVERING_MESSAGE`.
- **`RecoveryService`**:
  - 생성자에서 `outage.on('down')` → `onRedisDown`, `on('up')` → `recoverFromOutage`.
  - `onRedisDown(downSince)`, `private markSyncing(pausedAt)`, `recoverFromOutage()` (brief 그대로).
  - `freezeTournament(tournamentId, downMs, opts)` — 기존 2단계(블라인드 대입) + 테이블 조회 +
    앉은 테이블마다 `pauseTable`. 테이블 목록을 돌려주고 부팅은 이어서 기존 비트맵 · 빈 스냅샷 ·
    `rebuildTable` 루프를 그대로 돈다.
  - `pauseTurnClock` → `pauseTable(tableId, downMs, { overwrite })`. `mutateSnapshot`을 탄다.
    `!state` 또는 (`resumePending` && `!overwrite`) 또는 `planPause` null이면 쓰지 않음.
    부팅은 `{ overwrite: true }`, 런타임은 `{ overwrite: false }` (controller ruling 1).
    "이번에 멈췄다"는 로그용 `epoch` 로컬로 들고 나온다(`acted`와 같은 모양).
- **`backend/src/scenario/redis-outage.int-spec.ts`**: brief의 단계 0~7 + 차례 없음 반대 입력.
  단계 7은 ruling 2대로 바꿨다(아래).

## 벗어난 점 / 판단

1. **`outageOf` WeakMap.** brief 코드대로(`new RedisOutage(redis)`) 두면 통합 스위트에서
   `MaxListenersExceededWarning: 11 reconnecting listeners added to [Commander]`가 났다.
   원인: 여러 int 스펙이 `beforeAll`의 클라이언트 하나에 `beforeEach`마다 `new RedisService(redis)`를
   세운다(session.service.int-spec 18곳 등). 장애는 연결의 성질이라 클라이언트당 상태 하나가 맞고,
   프로덕션(클라이언트 1 : 서비스 1)의 동작은 같다. `setMaxListeners`는 쓰지 않았다.
2. 그 다음 `11 down/up listeners added to [RedisOutage]`가 `recovery.service.int-spec.ts`에서 났다 —
   `beforeEach`마다 `new RecoveryService`. 그 스펙의 두 줄(`redisService`, `recovery` 생성)을
   `beforeAll`로 옮기고 이유를 주석으로 남겼다(스파이 없음, 둘 다 무상태). 이후 전체 통합 실행에서
   경고 0건.
3. **단계 7**: brief 원안(요청 띄우고 곧바로 `disconnect`, `rejects.toThrow()`)은 락 안 가드를 지워도
   빨개지긴 했지만(액션이 커밋됨) 거절 사유를 보지 않고 순서가 타이밍에 달려 있었다. ruling 2대로
   스파이로 락 안에 붙잡았다. 다만 `getUserContext`가 아니라 **`redisService.getSnapShot`**을 붙잡았다 —
   가드가 `if (!state) throw` 바로 다음이라 `getUserContext`에서 붙잡으면 가드를 이미 지난 뒤다.
   `getSnapShot`은 `mutateSnapshot`이 락을 잡은 뒤 부르는 자리다. 순서: 락 안 진입 확인 → 끊기 →
   `phase === 'recovering'` → 놓기 → `rejects.toMatchObject({ message: SERVER_RECOVERING_MESSAGE })`.
4. 테스트 이름 `(세대 가드)` → `(락 안 가드)`. 스윕이 이 요청의 락을 기다리므로 `up` 이후에 놓을 수가
   없어, 여기서 실제로 막는 것은 락 안 가드의 `isUp` 쪽이다. 주석에 적었다.
5. 부팅 경로의 순서가 조금 바뀌었다: 예전엔 테이블마다 (정지 → 비트맵)이었고, 지금은 모든 테이블 정지 →
   비트맵/재구성 루프. 스냅샷 없는 테이블은 `pauseTable`이 no-op이고 재구성 결과는 WAITING이라
   `planPause`가 null이므로 결과는 같다. 기존 recovery/syncing 스펙 전부 초록.
6. 스펙 §3은 "런타임은 스냅샷 잃은 테이블에 로그만"이라 했지만 brief 코드엔 로그가 없어 넣지 않았다
   (`pauseTable`은 부팅과 공유라 거기 로그를 달면 부팅에서 틀린 말이 된다).

## 테스트와 결과

| 명령 | 결과 |
|---|---|
| `npm run test -w @playsync/contract` | 85 passed (8 suites) — 82 → 85 |
| `npm run test -w backend` | 415 passed (39 suites) — 407 → 415 |
| `npm run test:int -w backend` (전체) | 650 passed (41 suites) — 644 → 650, MaxListeners 경고 0 |
| `npm run test:int -w backend -- recovery syncing pause-resume redis-outage` | 61 passed (6 suites) |
| `npm run typecheck` | exit 0 |

## TDD 증거

- **contract RED**: `npm run test -w @playsync/contract` →
  `TS2307: Cannot find module './server-outage'` (1 failed suite, 82 passed). 모듈 없음 — 예상대로.
  GREEN: 85 passed.
- **outage RED**: `npm run test -w backend -- outage.spec` → `Cannot find module './outage'`
  (`Resolver._throwModNotFoundError`). GREEN: 8 passed.
- **시나리오 RED**: `npm run test:int -w backend -- redis-outage` → 5 failed, 1 passed.
  1~4: `TypeError: Cannot read properties of undefined (reading 'bind')` (`recoverFromOutage` 없음),
  나머지는 연쇄(5: `pausedAt` null, 차례 없음: `timeout` — 복구가 안 돌아 `isUp`이 안 됨). 예상대로.
  GREEN: 6 passed.
- **원래 결함 재현**(추가 확인): 가드 둘(락 밖 · 락 안)을 지우고 복구는 둔 채 실행 → 1~4가
  `expect(received).rejects.toThrow() — Received promise resolved instead of rejected` — 복구 창의
  `TIME_OUT`이 적용됐다(폴드). 7도 같은 이유로 빨강. 복원.

## Step 15 사후 red 확인

1. `RecoveryService` 생성자의 `'up'` 구독 줄 주석 처리 → **4 failed**: 1~4 `until timeout`(복구가 안 돌아
   `isUp` 안 됨), 6, 7, 차례 없음. 복원.
2. `handleAction`의 락 안 가드(`if (outage.generation !== generation || !outage.isUp())`) 삭제:
   - brief 원안 단계 7에서: **7만 빨강** — `Received promise resolved instead of rejected`(CALL 커밋).
     원안도 이 경우엔 빨개졌지만 사유 미확인 · 타이밍 의존이라 ruling 2대로 교체.
   - 교체한 단계 7에서: **7만 빨강** — `rejects.toMatchObject() — Received promise resolved instead of rejected`,
     resolve 값의 `timerEpoch`가 오르고 액션이 적용됨. 복원(백업 파일에서 복사, `grep`으로 가드 존재 확인).

## 바뀐 파일

- `packages/contract/src/server-outage.ts` (new), `server-outage.spec.ts` (new), `index.ts`
- `backend/src/redis/outage.ts` (new), `outage.spec.ts` (new), `redis.service.ts`
- `backend/src/playsync/playsync.service.ts`
- `backend/src/recovery/recovery.service.ts`, `recovery.service.int-spec.ts` (생성 위치만 이동)
- `backend/src/scenario/redis-outage.int-spec.ts` (new)

## Self-review

- 이름: `RedisService.outage`, `phase`/`generation`/`downSince`/`isUp()`/`markRecovered()`, 이벤트
  `'down'(downSince)`/`'up'`/`'recovered'`, contract 상수 — brief와 일치. 생성자 시그니처 4개 불변.
- 주석은 이름으로 가리키고 줄 번호 없음. `docs/`·`CLAUDE.md` 손대지 않음.
- 새 파일은 LF로 썼다(git이 정규화한다 — 커밋 시 경고만).

## Concerns

- **락 안 가드의 세대 비교 부분은 단독으로 증명되지 않는다.** `isUp` 쪽만 지우거나 세대 쪽만 지우면
  7은 초록이다(다른 쪽이 잡는다). 스윕이 락을 기다리는 구조상 `up` 뒤에 놓는 입력을 실제 흐름으로 만들 수
  없다. 세대 비교가 단독으로 필요한 순서(스윕이 먼저 락을 잡고 끝난 뒤 들고 있던 요청이 락을 얻는 경우)는
  `resumePending` 가드가 다른 문구로 함께 막는다.
- 차례 없음 반대 입력은 사후 red 확인을 하지 않았다(`planPause` 판정을 지우면 `plan.epoch`에서 던지고
  `pauseTable`의 catch가 삼켜 초록으로 남는다 — 의미 있는 되돌리기가 없다).
- `recovery.service.int-spec.ts`를 건드렸다(brief 파일 목록 밖). 경고 원인 제거용 두 줄 이동.
- 기준선 숫자는 이 브랜치 실측: contract 85 (8), 백엔드 단위 415 (39), 통합 650 (41).

---

# Fix round 1

Commit: `230d10d fix(T97): 세대 가드 · 복구 중 재단절을 증명하고, 부팅 중 장애 이벤트는 부팅 뒤로 미룬다`

## Changes

1. **Proving the generation half of the in-lock guard.** New scenario step `9. 락을 기다리던 액션이 복구가 끝난 뒤 락을 얻으면 거절된다 (락 안 가드 — 세대 검사)`.
   It first reopens the table with `completeSync` and `resumeTable`. Then it holds the request **before the lock**
   (`jest.spyOn(h.redisService, 'withTableLock')`), drops the connection, and waits until the generation is +1 and the phase is up. The lock is free, so the sweep
   pauses the table and calls `markRecovered`. After release, the step checks `rejects.toMatchObject({ message: SERVER_RECOVERING_MESSAGE })` and that the bet is unchanged.
   The earlier step 7 is now step 8. Its comment no longer says "no input can make the generation check go red on its own"; it now says "the generation check is covered by 9".
2. **Spec §5 "drop again during recovery".** New step `5. 복구 중 한 번 더 끊긴다`. The tournament is still SYNCING and the table was already paused in step 4.
   Sweep A is held right after `freezeTournament` (before its end-of-sweep generation check).
   The connection is dropped again, and sweep B is held as soon as it starts. After releasing A, the step asserts `phase=recovering` and `markRecovered` called 0 times.
   After releasing B, it asserts `up`, `markRecovered` called once, epoch unchanged, `resumePending` still set, and DB `pausedAt === firstDown`.
   B has to be held too. Otherwise the phase is already up when A is released, `markRecovered` is a no-op, and the check can't go red.
   n/n (now step 6) checks Δ against `callAt - firstDown`, i.e. from the **first drop**.
3. **Ruling 3: boot and down ordering.** `RecoveryService` gains `boot: Promise<void> | null` and `booting`.
   `onApplicationBootstrap` stores the promise and clears `booting` when it finishes. `onRedisDown` returns immediately while `booting`.
   `recoverFromOutage` does `await this.boot` before sweeping (no wait when null, i.e. when the service was created with `new`). The comment explains why: the heartbeat
   `pausedAt` is the truth for process downtime, and the conditional ONGOING update can't overwrite it.
   New unit spec `backend/src/recovery/recovery.service.spec.ts` (3 tests):
   a `down` during boot doesn't touch tournaments, and one after boot sets pausedAt=that time; an `up` during boot sweeps only after boot;
   creating the service with `new` counts as boot done (opposite input).
4. **`outageOf` comment fixed.** It now states that production has two instances on one client (`RedisModule` and `DealerModule`), and what breaks if they don't share one outage state.
   New unit test in `outage.spec.ts`: `같은 클라이언트의 RedisService 둘은 장애 상태 하나를 같이 본다`. It checks
   `a.outage === b.outage`, phase propagates, and there is one `ready` listener.
5. **Cheap items.** Added a comment in `handleAction` on the limit of the in-lock guard: a drop after the check but before `writeSnapshot`
   can be replayed from the ioredis offline queue. When `pauseTable` finds no snapshot with `!opts.overwrite` (runtime), it logs a `warn`.
   At boot it stays silent because `recoverTournament` rebuilds the table.

## Red checks (restored after each; confirmed with `git diff --stat`)

| Mutation | Result |
|---|---|
| `handleAction`: `outage.generation !== generation \|\| !outage.isUp()` → `!outage.isUp()` | **only step 9 red**. Received `[Error: 서버가 멈췄다 돌아왔습니다. 딜러가 판을 다시 열 때까지 기다려 주세요.]` (fell through to the `resumePending` check) |
| `recoverFromOutage`: `if (outage.generation === generation) outage.markRecovered();` → unconditional | **only step 5 red**. Expected `5. 낡은 스윕 뒤 recovering markRecovered 0` |
| `recoverFromOutage`: `{ overwrite: false }` → `{ overwrite: true }` | **only step 5 red**. Expected `세대 2`, Received `세대 4` (A and B each bumped it) |
| `onRedisDown`: remove `if (this.booting) return;` | recovery.service.spec 1 failed / 12 |
| `recoverFromOutage`: remove `await this.boot;` | recovery.service.spec 1 failed / 3 |
| `RedisService`: `outageOf(redis)` → `new RedisOutage(redis)` | outage.spec 1 failed / 12 (with recovery.service.spec) |

Not covered by a test: the runtime missing-snapshot `warn` (a log line).

## Covering tests

| Command | Output |
|---|---|
| `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- redis-outage` | `Tests: 8 passed, 8 total` |
| `npm run test -w backend -- recovery.service.spec outage.spec` | `Tests: 12 passed, 12 total` |
| `npm run test -w backend` | `Test Suites: 40 passed` · `Tests: 419 passed, 419 total` |
| `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend` (full) | `Test Suites: 41 passed` · `Tests: 652 passed, 652 total`, 0 MaxListeners warnings |
| `npm run typecheck` | exit 0 |

The contract package was untouched this round (still 85).

## Remaining concerns

- Step 5 spies on the private `freezeTournament` (`h.recovery as unknown as Freeze`). It's needed to hold the sweep
  after its pauses and before its final check, and if the name changes the spy fails loudly.
- The runtime missing-snapshot warn reads `overwrite` as "runtime or not", which ties two meanings to one flag. Both are documented in the `pauseTable` docblock.

---

# Fix round 2

Commit: `af180e0` (subject: `fix(T97): 한 번도 붙기 전에 끊긴 Redis 장애는 부팅 복구에 맡긴다`)

## Changes

1. **`RedisOutage.onLost`** now fires `emit('down', downSince, previous)`, where `previous` is the phase right before the drop.
   A listener that reads only the first argument (e.g. the Task 2 gateway) is unaffected. Documented in the docblock.
2. **`RecoveryService.onRedisDown(downSince, previous: OutagePhase)`** ignores a `down` when `booting` **or `previous === 'booting'`**.
   The comment explains that `REDIS_CLIENT` is created during DI, so `reconnecting` can arrive before `onApplicationBootstrap`,
   and why `booting` does not default to true (the harness never calls bootstrap). The existing in-flight-boot guard stays.
3. **Beyond the ruling (same finding, sibling path):** if Redis comes back while DI is still running (before `onApplicationBootstrap`), `boot` is null.
   `recoverFromOutage` would then run immediately and its `markSyncing` would write `pausedAt = downSince` (process start) first,
   and boot step 1 could not correct it. So when `onRedisDown` sees `previous === 'booting'` it sets `outageFromBoot = true`,
   and `recoverFromOutage` skips `markSyncing` while that flag is set. The flag is cleared when `markRecovered` succeeds.
   The table pauses and `markRecovered` still happen; the later boot uses `overwrite: true`, so the result is the same.
   If this goes too far, it is safe to drop the `outageFromBoot` field and its two uses.

## Tests

- `outage.spec.ts`: checks `down` arguments `(5000, 'up')`, `(7, 'booting')`, `(1000, 'recovering')`.
- `recovery.service.spec.ts`:
  - (b) `부팅을 부르지 않았어도 up에서 끊긴 down은 대회를 켠다 (반대 입력)`: no bootstrap call, `down(3000,'up')` → `updateMany` 1 call
  - (a) `한 번도 붙기 전(booting)에 끊긴 down은 부팅이 불리기 전이어도 대회를 건드리지 않는다`: no bootstrap call,
    `down(4000,'booting')` → update 0; then `up` → update 0, markRecovered 1; then `down(5000,'up')` → update 1
  - The existing two tests now emit `'up'` explicitly.

## Red checks (restored after each)

| Mutation | Result |
|---|---|
| `if (this.booting \|\| previous === 'booting') return;` → `if (this.booting) return;` | (a) red — Expected `down update 0`, Received `down update 1` (1 failed / 13) |
| `if (!this.outageFromBoot) await this.markSyncing` → `await this.markSyncing` | (a) red — Expected `up update 0 복구 1`, Received `up update 1 복구 1` (1 failed / 13) |

## Covering tests

| Command | Output |
|---|---|
| `npm run test -w backend -- recovery.service.spec outage.spec` | `Tests: 13 passed, 13 total` |
| `npm run test -w backend` | `Test Suites: 40 passed` · `Tests: 420 passed, 420 total` |
| `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- redis-outage recovery syncing` | `Test Suites: 5 passed` · `Tests: 57 passed, 57 total` |
| `npm run typecheck` | exit 0 |

## Remaining concerns

- Item 3 (`outageFromBoot`) goes beyond the ruling. The ruling only covered `onRedisDown`, but the same bug remained on the `up` path, so I closed it.
- No test drives the path end to end with a real Nest DI boot (Redis down → DI → bootstrap). Both parts are covered by unit tests with an injected fake outage.

---

# Fix round 3

Commit: `5589618 fix(T97): 부팅 전 장애 표시는 부팅 복구가 끝나야 내린다`

## Changes (`backend/src/recovery/recovery.service.ts`)

1. `onRedisDown`: `if (this.booting || previous === 'booting') return;` → `if (this.booting || this.outageFromBoot) return;`
   (the flag is still set first when `previous === 'booting'`). A second drop during the pre-boot sweep (`previous: 'recovering'`) is now ignored too.
2. `onApplicationBootstrap`: `recoverAll().finally(...)` now clears both `booting = false` and `outageFromBoot = false`.
3. **Removed** the `outageFromBoot = false` from `recoverFromOutage`'s `markRecovered` branch. Clearing it when a sweep finishes
   would let a second pre-boot drop write an early `pausedAt` again, which goes against the ruling's premise that
   "boot accounts for the whole pre-boot window". Only boot recovery clears the flag now.
4. Updated the field docblock and the `onRedisDown` comment to match.

## Tests (`backend/src/recovery/recovery.service.spec.ts`)

- **New**: `부팅 전 장애의 스윕 도중 다시 끊겨도(recovering) 대회를 건드리지 않고, 부팅 복구가 끝나야 풀린다`.
  `down(4000,'booting')` → `up` (sweep held on `findMany`) → `generation = 2`, `down(4000,'recovering')` → release sweep
  → `부팅 전 update 0 복구 0`. Then `onApplicationBootstrap` (stubbed `recoverAll` resolves) → `down(9000,'up')` → `부팅 뒤 update 1`.
- Round-2 test (a) now ends at the `up` check. Its old last step (a runtime drop without bootstrap → write) contradicts the ruling
  (the flag is cleared only by boot), so I removed it; the new test covers the post-boot write.

## Red checks (restored after each)

| Mutation | Result |
|---|---|
| `if (this.booting \|\| this.outageFromBoot) return;` → `if (this.booting \|\| previous === 'booting') return;` | new test red — Expected `부팅 전 update 0 복구 0`, Received `부팅 전 update 1 복구 0` (1 failed / 14) |
| remove `this.outageFromBoot = false;` from the `finally` | new test red — Expected `부팅 뒤 update 1`, Received `부팅 뒤 update 0` (1 failed / 14) |

## Covering tests

| Command | Output |
|---|---|
| `npm run test -w backend -- recovery.service.spec outage.spec` | `Tests: 14 passed, 14 total` |
| `npm run test -w backend` | `Test Suites: 40 passed` · `Tests: 421 passed, 421 total` |
| `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- redis-outage recovery syncing` | `Test Suites: 5 passed` · `Tests: 57 passed, 57 total` |
| `npm run typecheck` | exit 0 |

## Remaining concerns

- If Redis is still down when boot recovery ends, the flag is cleared anyway. The next `up` sweep's `markSyncing(downSince = before boot)` is
  a no-op for tournaments boot step 1 already set to SYNCING, but if boot step 1 itself failed (a DB failure) it writes `pausedAt` as the pre-boot drop time.
  That is earlier than the heartbeat, but in the same direction as a process-down window, and it is outside the ruling's scope.
- A process that never calls bootstrap (the harness) and drops before its first `ready` would keep the flag set forever. The harness always drops after `ready`.
