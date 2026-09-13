# SDD ledger — plan: docs/superpowers/plans/2026-09-13-t97-redis-outage.md

Spec: docs/superpowers/specs/2026-09-13-t97-redis-outage-design.md
Branch: fix/t97-redis-outage · merge-base main = fbcea95 (최종 리뷰 패키지의 MERGE_BASE)
이 디렉터리는 git에 안 들어간다(.superpowers는 무시됨). 다른 클론에는 없다 — git log가 최후의 기록이다.

## 지금 어디인가 — 다음 에이전트는 여기부터

| | 상태 | 커밋 |
|---|---|---|
| Task 1 백엔드 코어 | **완료** (리뷰 통과, 수정 3라운드) | a61d0b3..5589618 |
| Task 2 게이트웨이·503 필터 | **수정 라운드 1 미착수** — 사용자가 구현자를 중단시켰다. 제품 코드는 45d419d에서 멈췄다(그 뒤 커밋은 `docs/handoff` 인수인계뿐) | 5589618..45d419d |
| Task 3 화면 | 시작 전 | — |
| Task 4 실제 kill 검사 | 시작 전 | — |
| 메인 몫 | 최종 opus 리뷰 → 기준선 실측 → SSOT 커밋 → PR (계획서 끝 「메인이 할 일」) | — |

**다음 한 걸음: Task 2 수정 라운드 1.** 지시 전문은 `task-2-review.md`에 있다(I1 + M1·M2·M4). 새 구현자에게 `task-2-brief.md` · `task-2-report.md` · `task-2-review.md` 세 경로를 준다. 수정 뒤 FIX_BASE=45d419d로 `review-package`를 만들어 재리뷰(re-review-prompt.md)한다.

**Task 3·4를 보낼 때 함께 넘길 판정**: Task 3 ← Ruling 2 (`outage`는 새 소켓의 첫 프레임에서만 false). Task 4 ← Ruling 3 (테이블 2에도 딜러 소켓). Task 3·4는 태스크 리뷰 없음(Ruling 4).

**산출물**: `task-N-brief.md`(요구) · `task-N-report.md`(구현자 보고, 수정 라운드 이어 붙음) · `task-2-review.md`(Task 2 리뷰 전문) · `review-<base>..<head>.diff`(리뷰 패키지). Task 1 리뷰 전문은 파일로 없다 — 결론은 아래 Tasks 줄과 `task-1-report.md`의 fix round 절에 있다.

**중단 전 주의**: 구현자·리뷰어에게 `docs/`·`CLAUDE.md` 금지. Docker 필요(통합 테스트가 5433/6380 컨테이너를 스스로 띄운다).

## Pre-flight scan

| 대상 | 생산 ↔ 소비 | 발견 |
|---|---|---|
| T1 ↔ T2 | `RedisService.outage`(phase·generation·isUp·이벤트 down/up/recovered), 계약 상수 | 일치. 게이트웨이 필드명 `redis`가 RedisService ✓. T2 테스트가 `phase`를 대입 — T1에서 public 필드 ✓ |
| T1 ↔ T3 | 계약 상수 `SERVER_OUTAGE_EVENT`·`ServerOutageSchema`·`SERVER_RECOVERING_*` | 일치 |
| T2 ↔ T3 | 접속 시 renderGame 먼저, 복구 중이면 그 뒤 serverOutage{down:true}; T3 「첫 renderGame에 outage=false」 | **모호**: 모든 renderGame에서 false로 되돌리면 down 중 renderGame이 끼면 배너가 꺼진다 → Ruling 2 |
| T1/T2 ↔ T4 | 즉시 거절 · serverOutage · SYNCING · resumePending · pausedMs | **충돌**: T4는 테이블 2에도 착석시키는데 딜러 소켓은 테이블 1만 붙인다 → n/n이 안 차 10단계(ONGOING) 실패 → Ruling 3 |
| T1 자체 | Step 12 코드의 `pauseTable(tableId, downMs)` vs 본문의 `{ overwrite }` 옵션 | 시그니처 불일치 → Ruling 1 |
| T2 자체 | 필터 `super()` 무인자 vs HttpAdapterHost 필요 가능성 | 계획이 대안을 명시 — 구현자가 스펙 테스트로 판정 |
| T3 자체 | 파일 목록 vs 표 | 일치 |
| T4 자체 | `.outage-spec.ts`가 기본 jest(`.spec.ts$`)·int(`.int-spec.ts$`)에 안 잡힘 | 확인 ✓ |
| 리뷰 규칙 | 스킬: 태스크마다 리뷰 / CLAUDE.md: 동시성 제품 코드만 | → Ruling 4 |

Ruling 1: `pauseTable(tableId: string, downMs: number, opts: { overwrite: boolean })` — 부팅 true(기존 downMs 덮어쓰기 유지), 런타임 false(이미 resumePending이면 건너뜀) — 틀리면 복구 중 재시작 검사(recovery.service.int-spec·syncing 3단계)가 빨개져 바로 드러난다.
Ruling 2: `useTableSocket`은 **새 소켓의 첫 프레임**에서만 `outage`를 false로 되돌린다(이후 renderGame은 건드리지 않는다) — 게이트웨이가 복구 중 접속자에게 renderGame 뒤 down:true를 보내므로 순서가 맞다 — 틀리면 재접속 뒤 배너가 남거나 꺼진다(프론트 테스트가 잡는다).
Ruling 3: T4는 테이블 2에도 딜러 소켓을 붙인다(n = 착석 테이블 2) — 스펙 10단계 「딜러가 붙어 있다」가 전제라서 — 틀리면 test:outage 10단계 실패로 드러난다.
Ruling 4: 태스크 리뷰는 Task 1·2만(동시성 제품 코드), Task 3·4는 구현자 자체 검증 + 최종 opus 리뷰가 덮는다 — CLAUDE.md 「서브에이전트」 규칙이 스킬보다 우선(T29 실측: 태스크 리뷰 16분이 아무것도 못 잡음) — 틀리면 프론트·kill 검사의 결함이 최종 리뷰까지 늦게 잡힌다.

## Tasks

Task 1: dispatched (base a61d0b3, opus implementer)
Task 1: implementer DONE_WITH_CONCERNS (a5eed8e) — outageOf(client) per-client sharing added; gen-half of in-lock guard unproven alone; review dispatched (opus)
Task 1: review → spec ❌ / Needs fixes. Important: (1) gen-half of in-lock guard provable (hold before withTableLock) but untested (2) spec §5 step 6 re-drop during sweep missing (plan-omitted) (3) boot with Redis down: onRedisDown writes pausedAt=now before boot recovery → backend downtime leaks; sweep overlaps boot (4) outageOf comment wrong — DealerModule has its own RedisService, so 2 instances on 1 client in prod; pin with test
Task 1: Ruling: I3 — RecoveryService ignores `down` until boot recovery (`onApplicationBootstrap`) has finished, and `recoverFromOutage` awaits the in-flight boot recovery promise first; with no bootstrap (tests) treat boot as done — boot's heartbeat pausedAt is the truth for process downtime — if wrong, a Redis drop in the first seconds after boot is missed until `up` (sweep still runs, markSyncing uses downSince)
Task 1: Ruling: I2 is plan-omitted but spec-mandated → add scenario step — spec binds
Task 1: fix round 1 includes minors: comment that in-lock guard only covers drops before the check (write after check can replay from offline queue); log snapshot-lost tables at runtime (spec §3)
Task 1: minor (deferred): two sweeps can overlap if Redis re-drops while a sweep is stalled; older sweep may re-pause a table a dealer just resumed (rare)
Task 1: minor (deferred): no-turn opposite-input test has no meaningful red check; hand-rolled until loop
Task 1: fix round 1/5 (5 addressed, 1 open — I3 guard starts at onApplicationBootstrap, but `reconnecting` can fire during DI before it (non-lazy client) → premature pausedAt; commits a5eed8e..230d10d)
Task 1: minor (deferred): step 5 spies private freezeTournament via cast; `overwrite` flag doubles as "runtime" for the warn log
Task 1: Ruling: I3 residual — RedisOutage emits `down` with the previous phase; RecoveryService ignores a `down` whose previous phase was `booting` (Redis never connected since process start → boot recovery owns that downtime), in addition to the existing in-flight-bootstrap flag; test: down from booting (before any bootstrap call) does not touch tournaments, down from up does — keeps harness (no bootstrap) working — if wrong: Redis that connects then drops within DI seconds still leaks (very rare)
Task 1: fix round 2/5 (ruling addressed; 1 open — implementer's extra `outageFromBoot` flag: a 2nd drop during the pre-boot sweep arrives with previous='recovering' → onRedisDown writes premature pausedAt; flag never cleared if that sweep ends with gen mismatch; commits 230d10d..af180e0)
Task 1: Ruling: outageFromBoot residual — once set, `onRedisDown` also ignores while it is still true (not only previous==='booting'), and `onApplicationBootstrap` clears it in `finally` after boot recovery (boot's heartbeat accounts the whole pre-boot window); test: down from booting → up → re-drop (previous 'recovering') before bootstrap → 0 tournament writes; after bootstrap, a runtime drop writes — if wrong: pre-boot outages are fully owned by boot recovery, which is the design intent anyway
Task 1: fix round 3/5 (1 addressed, 0 open; commits af180e0..5589618)
Task 1: complete (commits a61d0b3..5589618, review clean after 3 fix rounds)
Task 2: dispatched (base 5589618, sonnet implementer)
Task 2: implementer DONE (45d419d); review dispatched (opus)
Task 2: minor (deferred): ws.gateway.int-spec M4 realGateway leaves permanent outage listeners on shared RedisOutage
Task 2: review → spec ✅ / Needs fixes. Important I1: leftover M4 realGateway + real RecoveryService listeners on shared RedisOutage write the same tournament row during new recovered/down tests → timing-dependent pass (report claimed otherwise)
Task 2: fix round 1 includes minors M1 (filter-order comments wrong — Nest reverses, RedisOutageFilter always first; Prisma APP_FILTER unreachable over HTTP), M2 (503 path logs nothing), M4 (fixed 50ms sleep → waitUntil)
Task 2: fix round 1 stopped by user before any commit (HEAD 45d419d, tree clean) — awaiting instruction
Task 2: minor (deferred): M3 body-parser 400/413 become 503 during outage; M5 "not rejected while up" test weak (res undefined passes)
