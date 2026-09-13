# T97 인수인계 — 임시 문서

> **이어받은 사람이 읽고 지운다.** 작업을 재개했으면 이 디렉터리(`docs/handoff/t97-redis-outage/`)를
> 통째로 지우고 커밋한다. 기록의 정본은 git 커밋과 스펙·계획서다 — 여기는 그 사이를 잇는 메모다.
> PR을 머지하기 전에 반드시 사라져 있어야 한다(`CLAUDE.md` 「같은 내용을 두 곳에 쓰지 않는다」).

## 한 줄

**Redis만 죽었다 돌아올 때 차례였던 사람이 자동 폴드되던 결함(T97, T98·T99 동반)을 고치는 중이다.**
4태스크 중 Task 1 완료, Task 2는 리뷰 반려 뒤 수정 전, Task 3·4는 시작 전.

## 지금 즉시 할 일 — Task 2 수정

1. `git switch fix/t97-redis-outage` — 원격에 있다
2. **`task-2-review.md`를 연다.** 고칠 것 넷(I1 + M1·M2·M4)과 수정 방법, 돌릴 테스트가 전부 거기 있다
   - 핵심은 I1: 기존 테스트(M4)가 남긴 실제 게이트웨이·`RecoveryService`의 장애 리스너가 새 테스트와 같은
     대회 행을 써서 **새 테스트가 타이밍으로 통과한다.** `onModuleDestroy`에서 리스너를 떼고 M4가 정리한다
3. 요구사항 원문은 계획서의 `### Task 2`, 이미 한 일은 `task-2-report.md`
4. 고친 뒤 수정 범위만 재리뷰한다 — 기준 커밋은 **`45d419d`**. 그 뒤에 이 인수인계 커밋(`docs/handoff`)이
   끼어 있으니 diff에서 뺀다: `git diff 45d419d..HEAD -- . ':!docs/handoff'`
5. Task 2가 통과하면 Task 3 → Task 4 → 메인 몫(최종 리뷰 → 기준선 → SSOT → PR). 넘길 판정은 `progress.md` 맨 위

## 읽는 순서

1. `docs/tickets-recovery.md`의 T97~T99 — 무엇이 깨졌나(2026-09-13 실측)
2. `docs/superpowers/specs/2026-09-13-t97-redis-outage-design.md` — 결정과 기각한 안. **구속력 있는 기준**
3. `docs/superpowers/plans/2026-09-13-t97-redis-outage.md` — 태스크 1~4와 끝의 「메인이 할 일」
4. 이 디렉터리의 `progress.md` 맨 위 「지금 어디인가」 — **다음 한 걸음**
5. 커밋 이력(아래) — 각 커밋 메시지가 그 라운드에서 무엇을 왜 바꿨는지 적는다

## 커밋 이력 (브랜치 `fix/t97-redis-outage`, main 기준 `fbcea95`)

| 커밋 | 무엇 |
|---|---|
| `175123f` | 설계 스펙 |
| `a61d0b3` | 구현 계획, 감지 이벤트를 `reconnecting`으로 |
| `a5eed8e` | Task 1 구현 — 감지 · `handleAction` 세대 가드 · 복구 스윕 · 시나리오 |
| `230d10d` | Task 1 수정 1 — 락 안 세대 가드 증명, 복구 중 재단절, 부팅 중 이벤트는 부팅 뒤로 |
| `af180e0` | Task 1 수정 2 — 한 번도 붙기 전 끊김은 부팅 복구에 맡김 |
| `5589618` | Task 1 수정 3 — 부팅 전 장애 표시는 부팅 복구가 끝나야 내림 (**Task 1 완료**) |
| `45d419d` | Task 2 구현 — 게이트웨이 게이트·방송, 503 필터 (**리뷰 반려, 수정 전**) |
| (이 커밋) | 인수인계 문서 |

## 파일

| 파일 | 무엇 |
|---|---|
| `progress.md` | SDD 진행 기록(ledger). 맨 위 표가 현재 위치, 아래가 판정(Ruling)과 라운드별 결과 |
| `task-2-review.md` | **다음에 할 일의 전문** — Task 2 리뷰 결과와 수정 지시(I1 + M1·M2·M4) |
| `task-1-report.md` · `task-2-report.md` | 구현자 보고서. TDD 증거와 빨간불 확인, 라운드별 수정 보고가 이어 붙어 있다 |

**태스크 요구사항(brief)은 복사하지 않았다** — 계획서의 `### Task N` 절 그대로라서다.

## 경로가 다르다

`progress.md`는 원래 git에 안 들어가는 작업 공간(`.superpowers/sdd/2026-09-13-t97-redis-outage/`)에서
쓰였다. 그 안의 `task-N-brief.md` · `review-<base>..<head>.diff`는 여기 없다:

- brief → 계획서의 해당 Task 절(또는 superpowers `subagent-driven-development` 스킬의 `scripts/task-brief PLAN N`)
- 리뷰 패키지 diff → `git diff <base>..<head>`로 다시 만든다

SDD로 이어서 돌린다면 이 디렉터리의 파일을 작업 공간으로 복사해 두고 시작한다 — 스킬이 그 경로의 `progress.md`로 재개 위치를 판단한다.

## 이어받을 때 주의

- 통합 테스트는 Docker가 필요하다(`npm run test:int`가 5433/6380 컨테이너를 스스로 띄운다)
- 하위 에이전트는 `docs/`·`CLAUDE.md`를 만지지 않는다 — **이 디렉터리 삭제와 SSOT 커밋은 메인 몫**
- 기준선 실측·SSOT 갱신(`tickets-recovery.md` 상태, `domain.md`, `backlog.md` B9, `CLAUDE.md` 기준선과 `test:outage`)은 마지막 PR에 얹는다
