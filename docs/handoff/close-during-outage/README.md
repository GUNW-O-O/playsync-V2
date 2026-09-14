# 인수인계 — Redis 장애 중 대회 닫기

> **읽었으면 이 디렉터리(`docs/handoff/close-during-outage/`)를 지우고 커밋한 뒤 작업을 시작한다.**
> 기록의 정본은 코드 · `docs/tickets-recovery.md` · `docs/domain.md` · git 이력이다. 여기는 그 사이를
> 잇는 메모이고, 남겨 두면 두 벌이 된다(`CLAUDE.md` 「같은 내용을 두 곳에 쓰지 않는다」).
> PR을 머지하기 전에 반드시 사라져 있어야 한다.

## 한 줄

**Redis가 죽은 동안 상점이 대회를 닫으면(종료 · 중단 · 취소) DB는 닫히는데 Redis 정리와 닫힘
알림이 안 돌아, 단말이 끝난 대회를 계속 그리고 Redis 키가 고아로 남는다.** 브랜치
`fix/close-during-outage`(`main` `cb1bc6f`에서 땄다, 푸시 안 함)에서 고친다. 설계는 아래에 있고
**사용자에게 제시만 했다 — 승인은 아직 받지 않았다.** 시작 전에 사용자에게 이 설계로 갈지 확인한다.

## 지금 즉시 할 일

1. `git switch fix/close-during-outage` (로컬에만 있다)
2. `CLAUDE.md`와 `docs/domain.md`의 「서버가 죽어도 대회는 계속된다」 · 「사람을 기다리는 상태가 둘 있다」를 읽는다
3. 이 문서를 끝까지 읽는다
4. `docs/handoff/`를 지우고 커밋한다(`docs(handoff): 인수인계 메모를 지운다 — 작업을 재개했다`)
5. 사용자에게 아래 「설계」로 진행할지 묻는다 → 승인되면 「진행 방법」대로

---

## 무엇이 깨졌나 (코드 추적, 실측 아님 — 2026-09-14)

`docs/tickets-recovery.md` 잔여 목록의 **「Redis 장애 중 대회 닫기」** 행이다. #122(T101·T102)의 최종
리뷰가 찾았다.

닫는 문은 셋이고 모양이 같다. HTTP 입구는 `session.controller.ts`의
`PATCH :id/complete` · `POST :id/abort` · `POST :id/cancel`.

| 메서드 | 닫힌 상태 | 커밋 전에 읽는 것 |
|---|---|---|
| `SessionService.completeSession` | `FINISHED` (상점 몫 정산). `chopSession`도 이것을 부른다 | DB만 |
| `SessionService.abortSession` | `CANCELLED` (시작한 대회, 환불 + 상점 몫) | DB만 |
| `SessionService.cancelSession` | `CANCELLED` (시작 전, 전액 환불) | DB만 |

세 메서드의 끝이 전부 이 두 줄이다.

```ts
await this.redis.deleteTournament(id, tableIds);     // Redis: info · user · seat · table:state:* 삭제 (pipeline)
this.announceClosed(id, tableIds, status);           // emit('TOURNAMENT_CLOSED', { tournamentId, tableIds, status })
```

**Redis가 죽어 있으면:**

1. 커밋 전은 전부 DB라 문지기(`updateMany ... status: NOT_CLOSED_TOURNAMENT_FILTER`)를 통과하고
   **돈 이동 · `Table`/`DealerSession` 삭제가 커밋된다**
2. `deleteTournament`의 pipeline이 ioredis 재시도(운영 클라이언트는 `maxRetriesPerRequest` 기본 20 —
   T97 실측 약 7초, 재접속 간격에 따라 ~10초) 끝에 **던진다**
3. 그래서 `announceClosed`가 **안 불린다**:
   - `WsGateway.handleTournamentClosed`가 안 돌아 **딜러 · 좌석 소켓이 안 닫힌다** — 끝난 대회를 계속 그린다
   - `DealerService.handleTournamentClosed`(T102)가 안 돌아 **장애로 끊긴 리바인 재개 대기가 안 풀린다**
4. Redis 키(`tournament:{id}:info` · `:user` · `:seat` · `table:state:{tableId}`)가 **고아로 남는다** (TTL 없음)
5. 예외가 `RedisOutageFilter`에서 503 「서버 장애를 복구하는 중입니다」가 된다. 상점은 닫혔는지 모르고 다시
   누르고, 이번엔 이미 닫혀서 **409 「이미 닫힌 세션입니다」** — 이 분기는 Redis 정리를 안 하므로
   **정리가 영영 안 돈다**

**닫힘 알림을 받는 쪽은 Redis가 필요 없다.** `WsGateway.closeTable`은 메모리의 `tableSessions`만 닫고,
`DealerService.handleTournamentClosed` → `releaseResumeWaiter`도 메모리만 만진다. 알림은 장애 중에도
보낼 수 있다.

**복구도 이것을 안 치운다.** `RecoveryService.recoverFromOutage`는 `SYNCING` 대회만,
`recoverAll`(부팅)은 `LIVE_TOURNAMENT_STATUSES`만 본다. 닫힌 대회의 키는 누구의 대상도 아니다.

## 설계 (제안 — 사용자 승인 전)

세 메서드 끝의 두 줄을 `SessionService`의 private 함수 하나로 모은다(예: `finishClose(tournamentId,
tableIds, status)`). `announceClosed` 옆에 둔다.

```
커밋이 이겼다 (문지기 통과, 세 메서드 모두 여기까지 온 호출은 하나뿐)
  ├ this.redis.outage.isUp()
  │    → await deleteTournament   (실패하면 logger.error, 던지지 않는다 — DB는 이미 닫혔다)
  │    → announceClosed
  └ !isUp()
       → deleteTournament를 시도하지 않는다 (7~10초 붙잡히지 않게)
       → 곧바로 announceClosed
       → this.redis.outage.whenUp().then(() => deleteTournament).catch(logger.error)   // 복구 뒤 한 번 정리
```

**왜 이 순서인가**

- **up일 때 정리가 먼저, 알림이 나중이다(지금 순서 유지).** 알림이 T102로 리바인 고리를 풀면 고리는
  `stillBroke`에서 스냅샷을 다시 읽는다 — 스냅샷이 아직 있으면 **닫힌 대회에 다시 묻는다.** 먼저 지워야
  고리가 「스냅샷 없음」으로 끝난다
- **down일 때 알림을 먼저 보내도 안전하다.** 풀린 고리의 스냅샷 읽기는 장애라 던지고, `askRebuys`의
  `finally`가 메모리 표시(`rebuyInFlight` · `resumeWaiters`)를 먼저 지운 뒤 `markRebuyPending(null)`에서
  던진다 — 고리는 끝난다
- **정리 실패로 요청을 실패시키지 않는다.** 닫힘은 커밋됐다. 503을 돌려주면 상점이 다시 누르고 409를 받는다 —
  「닫혔다」가 사실인데 화면은 실패를 말한다. (`announceClosed` 주석의 「문지기를 지난 뒤에만 부른다」는
  그대로 지켜진다 — 이 함수는 커밋이 이긴 뒤에만 불린다)
- **`whenUp()`은 `markRecovered()`에서만 풀린다**(`backend/src/redis/outage.ts`). 부팅 중(`booting`)에는
  안 풀리지만, 닫기는 앱이 떠서 요청을 받은 뒤라 해당 없다

**응답은 지금과 같게 둔다.** `completeSession`은 반환 없음, `abortSession`은 `settled`를 반환, `cancelSession`은
반환 없음 — 공용 함수는 반환값을 건드리지 않는다.

**남기는 것(잔여 목록에 새로 적는다):** 정리를 `whenUp`에 걸어 둔 채 프로세스가 재시작되면 키가 고아로
남는다(부팅 복구가 닫힌 대회를 안 본다). 테이블 행이 이미 지워져 게이트웨이 접속은 거절되므로 기능 영향은
없고 메모리만 남는다. 필요해지면 부팅에서 닫힌 대회 키를 SCAN으로 치운다.

## 테스트 (실패를 먼저 본다)

자리: `backend/src/store/session/session.service.int-spec.ts`의 기존 describe에 붙인다.

| describe | 이미 있는 닫힘 알림 검사 |
|---|---|
| `SessionService.completeSession — 상점 몫` | 「대회를 닫으면 TOURNAMENT_CLOSED를 낸다」 |
| `SessionService.abortSession` | 「대회를 중단하면 CANCELLED로 TOURNAMENT_CLOSED를 낸다」 |
| `SessionService.cancelSession` | 「취소하면 CANCELLED로 TOURNAMENT_CLOSED를 낸다」 |

각 describe가 `new RedisService(redis)`와 `emitter`를 세운다. 알림 검사 옆에 **세 경로 각각** 둘씩:

1. **장애 중 닫기** — `redisService.outage.phase = 'down'`(모양은 `ws.gateway.int-spec.ts`의
   `describe('Redis 장애 (T97)')`) → 닫기가 **던지지 않는다** · `TOURNAMENT_CLOSED`가 **곧바로** 나간다 ·
   `jest.spyOn(redisService, 'deleteTournament')`가 **아직 안 불렸다** · DB 상태는 닫힘 → `phase = 'recovering'`
   후 `redisService.outage.markRecovered()` → 스파이가 불리고 키(`tournament:{id}:info`, `table:state:{tableId}`)가
   없어진다(`until`로 폴링하지 말고 스파이의 반환 promise나 `whenUp`을 기다린다)
2. **반대 입력 — up이면 정리가 알림보다 먼저다** — `deleteTournament` 스파이 안에서 `heard`가 아직 비어 있음을
   기록하고, 끝나면 알림이 한 번 나갔는지 본다

**공유 상태 주의(이번 세션에서 여러 번 물렸다):**
- 통합 스펙 파일은 **클라이언트 하나에 `RedisOutage` 하나**다(`outageOf`의 WeakMap). `phase` · `downSince`를
  바꿨으면 `afterEach`/`finally`에서 `phase = 'up'`, `downSince = null`로 되돌린다
- **대기 중인 `whenUp`을 남기지 않는다** — 테스트를 끝내기 전에 `markRecovered()`로 풀어 준다
- 사후 빨간불 확인은 **임시 편집 후 복원**으로 한다. 작업 트리에 문서 편집이 있으면 `git stash`는 그것까지 쓸어 간다
- 사후 확인: 공용 함수에서 `!isUp()` 분기를 지워 늘 `deleteTournament`부터 부르게 하면 1이, 순서를 뒤집어
  알림을 먼저 보내면 2가 빨개지는지

## 진행 방법 (이번 세션의 흐름 — 사용자가 이 방식으로 세 PR을 머지했다)

1. 사용자 승인 → 태스크 **하나**(제품 코드 + 테스트). 구현은 하위 에이전트(sonnet)에게 **요구사항 파일**
   (이 문서의 「설계」·「테스트」)을 넘기고, 동시성 제품 코드라 **opus 태스크 리뷰**를 받는다
   (`CLAUDE.md` 「서브에이전트」)
2. 지적은 같은 구현자에게 돌려보내고, 수정 커밋만 **범위 재리뷰**
3. 브랜치 전체 **opus 최종 리뷰** → 수정은 한 번에 모아 한 번, 재리뷰 한 번
4. **기준선 실측** — 아래 명령을 실제로 돌려 숫자를 적는다(합산하지 않는다)
5. **SSOT 커밋은 메인이 마지막에 한다**(하위 에이전트는 `docs/`·`CLAUDE.md`를 안 만진다):
   - `docs/tickets-recovery.md` — 표에 **T103** 행(「Redis 장애 중 대회를 닫으면 알림과 정리가 안 돈다」),
     완료 절 한 단락, 잔여 목록의 「Redis 장애 중 대회 닫기」 행 삭제, 위 「남기는 것」 한 행 추가
   - `docs/domain.md` — 「사람을 기다리는 상태가 둘 있다」의 T102 항목에 붙은 **「단, Redis가 죽은 동안 닫으면
     이 이벤트가 나가지 않는다」 문장을 고친다**(이제 나간다). 「닫힌 대회에는 아무것도 쓰지 않는다」 근처에
     닫기의 정리 순서 한 줄
   - `CLAUDE.md` — 기준선 블록과 한 단락
6. **푸시 · PR은 사용자에게 먼저 묻는다.** PR을 연 뒤 상태 열에 `완료 (#번호)`, 기준선 제목에 `(#번호 시점)`을
   적어 한 번 더 커밋 · 푸시. **머지는 사용자가 「CI 통과하면 머지」라고 했을 때만** 하고, 머지 뒤
   `git fetch --prune` · 로컬 브랜치 삭제까지 한다

## 기준선 (#122 머지 시점, `main` `cb1bc6f`의 바로 앞 브랜치에서 실측)

```
contract       85  (8 suites)
백엔드 단위   431  (41 suites)
프론트 단위   326  (39 files)
통합          695  (42 suites)
부하 하네스    39
타입 에러       0
```

명령: `npm run typecheck` · `npm run test -w @playsync/contract` · `npm run test -w backend` ·
`npm run test -w frontend` · `cd load && npm test` · `npm run test:int -w backend`(Docker, 컨테이너를 스스로 띄운다.
반복 실행은 `KEEP_TEST_CONTAINERS=1`). `test:outage` · e2e · 촬영은 이 변경과 무관하다.

**프론트 전체 실행은 부하에 민감했던 적이 있다**(#121에서 `use-table-socket.test.ts`를 고쳤다). 다른 작업이
함께 도는 중에 빨개지면 단독 · 순차(`--no-file-parallelism`) 실행으로 먼저 가른다.

## 참고 — 이번 세션에서 머지된 것 (맥락)

| PR | 무엇 |
|---|---|
| #120 | T97~T99 — Redis만 죽었다 돌아와도 차례였던 사람을 폴드시키지 않는다 · `test:outage` |
| #121 | T100 — 리바인 창에 장애가 끼면 쓰는 순서(스냅샷 → DB → 전광판)와 딜러 재개 뒤 다시 묻기 |
| #122 | T101 · T102 — 재접속 좌석에 리바인 팝업 재전송 · 닫힘이 리바인 재개 대기를 푼다 |

잔여 목록의 다른 「대기」 항목(백엔드 프로세스 kill 무대 · 조용한 끊김 · Redis 데이터 유실 · 닫힘과 겹친 스냅샷
쓰기 등)은 이 작업의 범위가 아니다.
