# Task 2 보고서 — 게이트웨이와 503 필터 (T97)

## 구현 요약

브리프 Step 1~10을 순서대로 따랐다. 코드는 브리프가 제시한 스니펫을 거의
그대로 옮겼다(이름·주석 포함) — 설계가 이미 확정돼 있었고 재량이 필요한
지점은 게이트웨이 테스트의 describe 배치와 필터의 `BaseExceptionFilter` 등록
방식(HttpAdapterHost 필요 여부) 둘뿐이었다.

### 1. `backend/src/ws/ws.gateway.ts`

- 생성자에서 `this.redis.outage.on('down', ...)` · `.on('recovered', ...)` 구독.
- `broadcastOutage(down)` — 테이블 방 전원에게 `serverOutage` 방송.
- `afterOutage()` — `down:false` 방송 → 테이블마다 Redis 재조회 후
  `renderGame` → `SYNCING`인 대회마다 `reportSync`(n/n 재집계, 기존 T96
  체인을 그대로 탄다).
- `handlePlayerAction` · `handleDealerAction` 맨 앞에 `!this.redis.outage.isUp()`
  가드 — `SERVER_RECOVERING_MESSAGE`로 즉시 거절.
- `handleConnection`의 테이블 경로에서 `renderGame` 직후, `isUp()`이 아니면
  붙는 소켓에게 `serverOutage{down:true}`를 한 번 보낸다.
- 생성자 시그니처는 바꾸지 않았다(요건대로).

### 2. `backend/src/common/redis-outage.filter.ts` (신규)

브리프의 스니펫 그대로. `@Catch() @Injectable()`, `RedisService`를 주입받아
`super()`만 호출(인자 없음) — Step 5 스펙이 실제 앱에서 500·404·409를 정확히
내는 것으로 확인됐으므로 `HttpAdapterHost`는 필요 없었다. Prisma 오류는
자체 `PrismaExceptionFilter` 인스턴스에 위임하고, `isUp()`이거나 `HttpException`이면
Nest 기본 처리(`super.catch`)로 넘긴다. 그 외(장애 중의 알 수 없는 오류)만
503 `{ statusCode, message: SERVER_RECOVERING_MESSAGE, error: 'Service Unavailable' }`.

### 3. `backend/src/app.module.ts`

`PrismaExceptionFilter` 아래에 `{ provide: APP_FILTER, useClass: RedisOutageFilter }`
추가, 이유를 한 줄 주석으로. **`PrismaExceptionFilter`의 등록은 그대로 뒀다**
— Step 5의 네 번째 검사(down 중 Prisma P2002 → 409)가 이미 걸린 채로 초록이라
지우는 결정을 하지 않았다(브리프 지시대로).

### 4. 테스트

- `backend/src/ws/ws.gateway.int-spec.ts`: 브리프 Step 1 스니펫을 그대로
  `describe('Redis 장애 (T97)')`로 파일 맨 끝에 추가(6개). `SYNCING (T96)`
  describe 안에는 "recovered 뒤 딜러가 이미 n/n이면 completeSync를
  부른다(T97)" 한 건을 I1 테스트 뒤에 추가 — 기존 헬퍼(`seedSyncingTournament`
  · `seedSeats` · `lastSyncingPayload` · `waitUntil`)를 그대로 썼다.
- `backend/src/common/redis-outage.filter.spec.ts` (신규): `prisma-exception.filter.spec.ts`와
  같은 방식으로 진짜 `BoomController`를 띄우고 두 필터를 `app.module.ts`와
  같은 순서로 등록한 두 개의 앱(`downApp`/`upApp`, `RedisService`를
  `{ outage: { isUp: () => up } }`로 대역)에서 검사 4건.
- `backend/src/app.module.filter.spec.ts`: `RedisOutageFilter`가
  `APP_FILTER`로 걸려 있는지 검사 1건 추가.

## TDD 증거

### RED 1 — 게이트웨이 (Step 2)

명령: `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- ws.gateway`

결과 (구현 전, 테스트만 추가한 상태): 6건 실패 + 1건 타임아웃(72건 중 6 FAIL,
`recovered 뒤 딜러가 이미 n/n이면...`은 `waitUntil timeout`으로 실패) — 예:

```
● WsGateway 인바운드 경계 › Redis 장애 (T97) › down이면 좌석 액션을 즉시 한국어로 거절한다
  Expected: {"event": "error", "data": "서버 장애를 복구하는 중입니다."}
  Received: undefined
```

원인: 가드·구독이 아직 없어 `handlePlayerAction`이 정상 처리로 흘렀다(alice가
`CALL`을 걸었지만 스펙상 결과가 undefined) — 예상한 이유로 빨갛다.

### GREEN 1 — 게이트웨이 (Step 4)

명령: 위와 동일. 결과: `Tests: 72 passed, 72 total`.

### RED 2 — 필터 (Step 6)

명령: `npm run test -w backend -- redis-outage.filter`

결과: `Cannot find module './redis-outage.filter'` — 파일이 아직 없어 스위트
자체가 실패(예상한 이유).

### GREEN 2 — 필터 (Step 8)

명령: `npm run test -w backend -- redis-outage.filter` → `Tests: 4 passed, 4 total`.
전체: `npm run test -w backend` → `426 passed`(41 suites). `npm run typecheck` →
에러 0(contract → backend → frontend 전부 통과).

## Step 9 — 사후 빨간불 확인

1. `handlePlayerAction`의 게이트 줄(`if (!this.redis.outage.isUp()) return ...`)을
   지우고 `ws.gateway`만 재실행 → "down이면 좌석 액션을 즉시 한국어로
   거절한다" 정확히 그 한 건이 빨개짐(`Received: undefined`). 복원 후 재확인.
2. 필터의 `isUp()` 분기(`this.redis.outage.isUp() || exception instanceof HttpException`
   → `exception instanceof HttpException`만 남김)를 지우고 재실행 →
   "up일 때 같은 오류는 500 그대로다" 정확히 그 한 건이 빨개짐(`Expected: 500,
   Received: 503`). 복원 후 `npm run test -w backend -- redis-outage.filter`
   재확인(4/4 통과).

두 red-check 모두 편집 직후 실행, 확인 즉시 원복했다.

## 파일

- `backend/src/ws/ws.gateway.ts` — 구독·가드·복구 브로드캐스트 (수정)
- `backend/src/ws/ws.gateway.int-spec.ts` — `describe('Redis 장애 (T97)')` +
  `SYNCING (T96)`의 recovered n/n 테스트 (수정)
- `backend/src/common/redis-outage.filter.ts` — 신규
- `backend/src/common/redis-outage.filter.spec.ts` — 신규
- `backend/src/app.module.ts` — `RedisOutageFilter` 등록 (수정)
- `backend/src/app.module.filter.spec.ts` — 등록 검사 추가 (수정)

## RedisOutage 공유 인스턴스에 대한 확인

`ws.gateway.int-spec.ts`는 `redis` 클라이언트 하나로 파일 전체를 돈다.
`RedisOutage`는 클라이언트당 하나(`outageOf`의 WeakMap)라 이 파일 안에서
`new RedisService(redis)`를 몇 번을 부르든 같은 `RedisOutage` 인스턴스를
공유한다. `WsGateway` 생성자가 이제 그 인스턴스에 `on('down')`·`on('recovered')`를
구독하므로, 이 파일이 `new WsGateway(...)`를 두 번째로 부르는 자리(M4 테스트의
`realGateway`)에서 리스너가 하나씩 더 쌓인다 — 파일 전체에서 최대 2세트
(`gateway` beforeAll 1회 + `realGateway` M4 테스트 1회)라 기본 임계치(10) 근처도
가지 않는다. `npm run test:int -w backend -- ws.gateway` 출력에
`MaxListenersExceededWarning` · `possible EventEmitter memory leak`이 없음을
grep으로 확인했다(리포트 상단 "GREEN 1" 실행 로그, 별도 grep 재확인도
`NO_WARNING_FOUND`). `afterEach(() => { outage().phase = 'up'; })`로 각
테스트 뒤 phase를 리셋해 다음 describe에 영향이 새지 않게 했다.

부작용 하나를 인지하고 있다: `realGateway`(M4)의 리스너는 테스트가 끝난 뒤도
같은 공유 `RedisOutage`에 남아 있어, 그 뒤의 `Redis 장애 (T97)` describe가
`outage().emit('down')` / `emit('recovered')`를 쏘면 `realGateway`도 함께
반응한다(자신의 빈 `tableSessions`에 대해 방송하고, 자신의 진짜
`RecoveryService`로 `SYNCING` 대회를 조회한다). `realGateway`의 리스너는 자기
소유의 소켓 맵·재집계 체인(`syncChains`)만 건드리고 두 콜백 모두 에러를 삼키므로
(`.catch`), 이 파일의 다른 어떤 assertion과도 값을 공유하지 않는다 — 72개
전부가 반복 실행에서도 안정적으로 통과했다(그린 확인을 세 번 반복, 매번
72/72). 이 잔여 리스너를 정리하려면 M4 테스트에 `onModuleDestroy`를 호출하는
정리 코드가 필요한데, 그 테스트는 이번 태스크가 만든 것이 아니고 브리프도
이 정리를 요구하지 않아 손대지 않았다.

## 자체 리뷰

- **브리프 대비 완전성**: Step 1~10 전부 수행. 인터페이스(소비/생산) 전부
  브리프대로: `RedisService.outage`(`isUp`/`down`/`recovered`), `SERVER_OUTAGE_EVENT`,
  `ServerOutageSchema`, `SERVER_RECOVERING_MESSAGE`, `SERVER_RECOVERING_STATUS` 소비;
  소켓 `serverOutage{down}`, REST 503 본문 생산.
- **이름**: 브리프가 지정한 이름(`broadcastOutage`, `afterOutage`,
  `RedisOutageFilter`) 그대로 썼다. 주석은 함수/메서드 이름으로 참조했고
  줄 번호를 쓰지 않았다.
- **YAGNI**: 브리프 스니펫 이상으로 추가한 코드 없음. 필터에
  `HttpAdapterHost`를 넣지 않은 것도 YAGNI 판단 — 스펙이 이미 증명했다.
- **기존 패턴 재사용**: 필터 테스트는 `prisma-exception.filter.spec.ts`의
  "진짜 컨트롤러 + APP_FILTER" 패턴을 그대로 따랐다. 게이트웨이 테스트는
  기존 `connect`/`seatTicket`/`dealerTicket`/`makeState` 헬퍼를 재사용했다.
- **테스트가 동작을 검증하는가**: 각 테스트가 반대 입력(up일 때 안 막힘,
  up일 때 500 유지, HTTP·Prisma 예외는 그대로)을 갖고 있어 "전부 다 503으로
  덮는" 구현이나 "가드가 없는" 구현이 통과하지 못하게 했다. Step 9로 실제
  빨간불도 확인했다.
- **출력 청결**: 커밋에는 요청된 파일만 포함(`git add`로 명시 경로만 스테이징).
  임시 편집(Step 9)은 확인 직후 정확히 원복했고 `git diff`로 잔여 변경이
  없음을 최종 커밋 전 다시 훑었다.

## 우려 사항

- 위 "RedisOutage 공유 인스턴스" 절에 적은 `realGateway`(M4) 리스너 잔존은
  기능적 문제를 일으키지 않았지만, 다음에 이 파일에 `new WsGateway(...)`를
  세 번째로 추가하는 사람은 같은 패턴(리스너 누적)을 또 밟는다 — 이번
  태스크 범위 밖이라 손대지 않았다.
- `RedisOutageFilter`가 Prisma 오류를 자체적으로
  `PrismaExceptionFilter`에 위임하기 때문에, Step 5의 네 번째 검사만으로는
  Nest가 실제로 어느 필터를 먼저 골랐는지 구분할 수 없다(브리프도 이를
  알고 "지우는 결정은 하지 않는다"고 명시) — 의도된 모호함이며 브리프 지시를
  그대로 따랐다.
