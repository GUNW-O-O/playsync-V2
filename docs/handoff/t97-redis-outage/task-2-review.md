# Task 2 리뷰 결과와 수정 지시 (fix round 1 — 사용자가 중단, 미착수)

리뷰 대상: 5589618..45d419d (`review-5589618..45d419d.diff`)
판정: Spec ✅ · Task quality: Needs fixes

## 운영 위험 점검 — 통과 (다시 볼 필요 없음)

1. 필터 선택 순서: Nest는 `router-exception-filters.js`에서 `filters.reverse()` — 뒤에 등록한 catch-all `RedisOutageFilter`가 항상 먼저 뽑힌다. Prisma 매핑은 필터가 Prisma 오류를 `PrismaExceptionFilter`에 **직접 넘기기 때문에** 산다(P2002 테스트가 그 넘김을 지킨다). HttpException(429 `Retry-After` 포함)은 `super.catch`로 같은 응답 객체를 쓴다. 게이트웨이에는 전역 필터가 안 걸린다.
2. 리스너 수명(운영): `WsGateway`는 `ws.module.ts`에 한 번만 등록된 싱글턴 → 한 번 구독. `RedisService` 둘이어도 방송 중복 없음.
3. `afterOutage` vs 늦게 붙은 소켓: `markRecovered`가 emit 전에 `phase='up'`을 세운다 → down:true에 갇히는 경로 없음.
4. recovered 뒤 `reportSync`: `recoverFromOutage`가 `this.boot`를 기다린 뒤 `markRecovered` → 안전.

## Important — 반드시 고친다

**I1. 새 테스트가 타이밍으로 통과한다(구현자 보고서의 "다른 단언과 값을 공유하지 않는다"는 틀렸다).**

- `ws.gateway.int-spec.ts`의 M4 테스트(`realGateway`를 실제 `RecoveryService`로 만드는 것)가 OPEN 딜러 소켓 둘을 붙인 채 정리하지 않는다.
- `WsGateway`가 이제 생성자에서 공유 `RedisOutage`를 구독하므로, 새 recovered-n/n 테스트의 `emit('recovered')`가 `realGateway`도 깨운다 → 2/2를 세어 **실제** `completeSync(TOURNAMENT)`를 부른다 → 메인 게이트웨이의 `reportSync`가 읽는 바로 그 행(SYNCING→ONGOING)을 쓴다. 메인 리스너가 먼저 등록돼 한 걸음 앞설 뿐이다.
- 두 번째 경로: T97 describe의 `outage().emit('down', Date.now())`가 남은 실제 `RecoveryService.onRedisDown`(booting false, previous undefined)을 깨워 ONGOING 대회 전부를 비동기로 SYNCING으로 쓴다.

수정:
1. `WsGateway`가 outage 핸들러 참조를 들고 `onModuleDestroy`(이미 ping 타이머용으로 있다)에서 `off`한다.
2. `RecoveryService`도 `OnModuleDestroy`를 구현해 `down`/`up` 핸들러를 `off`한다(생성자 시그니처 불변).
3. M4 테스트가 `finally`에서 `realGateway.onModuleDestroy()`와 실제 recovery의 `onModuleDestroy()`를 부른다.
4. 독립성 증명: 메인 게이트웨이의 `afterOutage`가 `reportSync`를 안 부르면 새 recovered-n/n 테스트가 빨개지는지 확인한다(남은 리스너가 대신 채워 줄 수 없음을 보인다).

## Minor — 같은 라운드에서 싸게 고친다

- **M1** `app.module.ts`와 필터 스펙의 주석이 "등록 순서가 필터를 고른다"고 적었다 — 틀렸다(위 1번). `PrismaExceptionFilter`의 `APP_FILTER` 등록은 브리프대로 남기되, HTTP의 Prisma 오류를 그것이 처리한다고 적지 않는다.
- **M2** 503 경로가 로그를 안 남긴다 → 장애 중 Redis와 무관한 진짜 결함이 로그에서 사라진다. 503 응답 전에 `Logger.error`(원본 오류 + 스택) 한 줄.
- **M4** recovered 테스트의 고정 `setTimeout(r, 50)` → 파일의 `waitUntil`로.

## Minor — 미룬다 (최종 리뷰가 분류)

- **M3** body-parser의 400·413(HttpException 아님)도 장애 중엔 503이 된다. 영향 작음.
- **M5** "up이면 거절하지 않는다" 검사가 약하다 — `res`가 undefined여도 통과. 게이트가 항상 닫히면 빨개지므로 제 일은 한다.

## 수정 후 돌릴 것

`npm run test -w backend -- redis-outage.filter app.module.filter` · `npm run test:int -w backend -- ws.gateway` · `npm run test:int -w backend -- recovery redis-outage` · `npm run typecheck`
