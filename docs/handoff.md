# 핸드오프 — 복구 빈 스냅샷(T44) → WS 대회 검사(T45)

작성 2026-08-16. 앞 세션은 문서 정리를 끝냈고, 그 과정에서 **제품 결함 둘**을
찾았다. 다음 세션은 그 둘을 티켓으로 처리한다.

> **이 문서는 일회용이다.** 읽고 작업을 시작했다면 **첫 커밋에
> `git rm docs/handoff.md`를 함께 넣어 지운다.** 판단 근거는 여기가 아니라
> `docs/tickets-next.md`에 남는다 — 이 파일이 살아 있으면 다음 세션이 이미
> 끝난 일을 할 일로 읽는다. T41 때도 같은 방식이었다.

## 지금 상태

- `main` = `origin/main` = `52b818a docs: 문서 정리`. 워킹트리 깨끗, 브랜치 `main`뿐
- 컨테이너 0개 (Docker Desktop 꺼져 있을 수 있음 — 통합 테스트 전에 켤 것)
- 기준선 실측 확인됨: contract 62/4 · 백엔드 단위 191/18 · 프론트 100/24.
  통합 343/28과 e2e 13은 이번에 재확인 안 함(컨테이너 필요)

작업 규칙·명령어·테스트 계층은 `CLAUDE.md`, 도메인 규칙과 코드 좌표는
`docs/domain.md`를 읽는다. **둘 다 이번에 새로 정리한 것이라 최신이다.**

## 할 일 — 순서대로

### T44. 복구가 빈 테이블의 스냅샷을 세우지 않는다

**증거** (`backend/src/recovery/recovery.service.ts:176-186`):

```ts
for (const table of tables) {
  if (table.tablePlayers.length === 0) {
    const bitmap = await this.redis.getTableSeatStatus(tournamentId, table.id);
    if (bitmap.length === 0) {
      await this.redis.rebuildSeatBitmap(tournamentId, table.id, []);
    }
    continue;          // ← 스냅샷을 안 세우고 넘어간다
  }
  ...
```

T38이 **생성 경로**(`createTable` / `createSession`)만 닫았다. 복구 경로가 열려
있어서, Redis를 잃고 재기동하면 아무도 안 앉은 테이블에 스냅샷이 없다. 그
테이블에 딜러가 붙으면 `PlaysyncService.joinTable`
(`backend/src/playsync/playsync.service.ts:39-41`)이 맨 `Error`를 던져 **500**이
난다. T38이 고친 그 버그가 재기동으로 되살아나는 것이다.

**이게 문서와 모순이다.** `docs/domain.md` 「동시성 규약」 마지막 문단이
"빈 스냅샷의 뜻이 하나다 — 유실"이라고 단언했는데 복구 뒤에는 거짓이다.
고치면서 그 문단이 참이 되게 하거나, 참이 아니면 문서를 고친다.

**재현 → 고침 순서**
1. 통합 테스트로 RED를 먼저 본다. 시나리오: 대회 진행 중 빈 테이블 하나 →
   Redis 스냅샷 삭제 → `recoverAll()` → `getSnapShot(tableId)`가 여전히 `null`
2. 고침은 `continue` 앞에 `saveSnapShot(table.id, createEmptyTableState(tournamentId))`
   한 줄 수준. `createEmptyTableState`는 `src/game-engine/types.ts:112`
3. 대칭 확인: 생성 쪽이 이미 `session.service.ts:187`(createSession)과
   `:244`(createTable)에서 같은 일을 한다. **같은 모양으로 맞춘다**

**주의 둘**
- `shouldBlockEmptySnapshot`(`entry.service.ts:387`)을 건드리지 않는다. 그건 입장이
  복구와 겹칠 때의 가드고 이 티켓과 층이 다르다
- 복구는 `app.listen()` 이전이라 락을 잡지 않는다. **이 티켓에서 락을 추가하지
  않는다** — 근거는 `docs/domain.md` 「동시성 규약」 예외 표

### T45. WS 대회 단위 접속이 토큰의 tournamentId를 대조하지 않는다

**증거** (`backend/src/ws/ws.gateway.ts:110-119`):

```ts
if (payload.tournamentId) {
  (client as any).tournamentId = payload.tournamentId;   // 티켓이 준 값
}
...
if (tournamentId && !tableId) {
  (client as any).tournamentId = tournamentId;           // ← 쿼리 값으로 덮어쓴다
  this.addToMap(this.tournamentSessions, tournamentId, client);
  return;
}
```

A 대회 티켓으로 붙으면서 쿼리에 B 대회를 주면 B의 `SEAT_LIST_UPDATED`
브로드캐스트를 구독하게 된다. **테이블 경로는 바로 아래에서
`assertTableAccess(payload, tableId)`가 막는데 대회 경로만 뚫려 있다** — 이
비대칭 자체가 실수의 증거다.

**고치기 전에 확인할 것**: 모든 티켓이 `tournamentId`를 갖는가.
`if (payload.tournamentId)` 조건이 붙어 있으니 없는 티켓이 존재할 수 있다
(딜러 티켓 등). 없는 경우를 거절할지 통과시킬지 정하고 **근거를 주석에
남긴다.** 티켓 발급 경로부터 훑을 것.

축은 `docs/threat-model.md`의 "권한은 화면이 아니라 게이트웨이에서 본다"다.

## 하지 말 것

- **T42 조사편을 새로 돌리지 않는다.** 산출물 절반이 `docs/domain.md`
  「동시성 규약」으로 이미 나왔고(쓰기 13곳 · 락 10곳 · 락 밖 3곳 · 트랜잭션
  경계 규칙), 남은 건 발견 확률이 낮은 확인 작업이다. T42는 **이행편
  (`RedisService.mutateSnapshot`)만** 티켓으로 남긴다 — 범위는
  `docs/backlog.md` T42 절에 그대로 있다
- **결제 500(Prisma 트랜잭션 만료)은 지금 하지 않는다.** 원인이 CPU 포화라
  고칠 자리가 `payment`가 아니라 도착 비용(로그인 bcrypt)이다. 티켓이 크고
  실배포가 없어 값이 낮다. 근거 수치는 `docs/results/2026-08-15-load-ramp.md`
- **도메인 흐름을 손대지 않는다.** 이 리포가 고치는 것은 동시성 · 트랜잭션 ·
  락이다

## 작업 절차

브랜치는 티켓 단위(`fix/t44-recovery-empty-snapshot` 등). `main`에서 직접
작업하지 않는다. **버그 수정은 실패하는 테스트를 먼저 만들어 재현한 뒤 고친다.**

통합 테스트 반복 실행:

```bash
cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json \
  --testPathPatterns recovery
```

끝나면 `npm run test:int:down -w backend`.

**Bash 툴의 작업 디렉터리는 호출 사이에 유지된다.** 절대경로를 쓰거나 같은
호출 안에서 `cd`한다 (앞 세션이 여기 걸려 파일 존재 검사가 전부 빗나갔다).

기록은 `docs/tickets-next.md`에 T44 · T45 절로 남기고, `docs/backlog.md` B2
(서버 장애 복구) · B11 쪽 상태를 갱신한다. 기준선 숫자가 바뀌면 `CLAUDE.md`
「베이스라인」과 `README.md` 헤더 · §2 비교표 **세 곳 전부** 고친다 (앞 세션이
헤더와 비교표를 빠뜨려 178/336으로 낡아 있었다).

## 문서 규칙 두 가지 (앞 세션에서 정해짐)

- **README에 독자를 지목하는 문장을 넣지 않는다.** "평가하러 온 사람",
  "포트폴리오" 같은 말을 쓰지 않고 그냥 프로젝트를 설명한다
- **작업 규율의 출처를 사람으로 적지 않는다.** 빨간불 먼저 · 적용 전 재검증 ·
  완료 주장 전 실행은 에이전트 스킬이 갖고 온 것이다. 사람 몫은 그것을 켜
  두기로 정한 것과 도메인 판단이다

## Suggested skills

- `superpowers:test-driven-development` — T44 · T45 둘 다 버그 수정이라 RED
  먼저다. 특히 T44는 "복구 후에도 스냅샷이 없다"를 통합 테스트로 재현하는
  것이 티켓의 절반이다
- `superpowers:systematic-debugging` — T45에서 "티켓에 `tournamentId`가 없는
  경우가 실제로 있는가"를 발급 경로부터 따라갈 때
- `superpowers:verification-before-completion` — 완료 주장 전에 통합 스위트
  실제 실행. 앞 세션들이 가짜 초록에 네 번 데인 리포다
- `superpowers:requesting-code-review` — T45는 권한 경계를 만지므로 최종 리뷰를
  받는다. 예산 규칙은 `docs/review-budget.md`
- `pr-quiz` — 커밋 · PR 직전. 사용자가 이 diff로 공부하는 것을 목적에 두고 있다

`superpowers:brainstorming`은 건너뛰어도 된다. 두 티켓 다 결함 · 재현 경로 ·
고칠 자리가 이 문서에 이미 확정돼 있다.
