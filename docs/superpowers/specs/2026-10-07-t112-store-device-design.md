# 매장 태블릿 기기 토큰 설계 (T112)

**항목**: [`docs/tickets-audit.md`](../../tickets-audit.md)의 T112. 결정은 같은 문서
「착수 전에 사람이 정한 것」의 「입장 상한을 무엇으로 가르나」(2026-10-07).
**범위**: `backend/prisma`(+마이그레이션), `backend/src/device/`(신설),
`backend/src/entry/entry.controller.ts`, `backend/src/dealer/dealer.controller.ts`, `backend/src/auth/strategies/`,
`backend/src/app.module.ts`, `packages/contract`, `frontend/src/app/(terminal)/`,
`frontend/src/app/api/ws-ticket/`, 상점 콘솔 대회 화면, 그리고 이 두 라우트를
직접 부르는 하네스(`load/`, `frontend/e2e/`, `backend/test/outage/`).

---

## 왜

입장(`POST /tournaments/:id/enter`)과 딜러 인증(`POST /dealer/auth`)의 정상
발신자는 **매장 태블릿뿐**이다. 그런데 서버는 태블릿을 IP로만 알고, 브라우저
요청은 전부 Next 프로세스 하나의 주소로 도착한다(`auth/throttle.ts`).

- 대기 화면에서 틀린 OTP 600개를 보내면 Next 주소의 `enter` 버킷이 30초 막혀
  **모든 대회의 모든 태블릿이 재입장에서 429**를 받는다. 참가 OTP에 시도 제한을
  두지 않은 이유(대회가 멈춘다)가 상한을 통해 되살아난다.
- 딜러 쪽은 대회 단위 잠금(`OtpAttempts`, 10회 / 5분)을 아무나 일부러 걸 수 있다.
- 자격 없이 대입을 계속할 수 있다. 맞히면 좌석 탈취(T110)이고, 딜러면 상금이다.

IP로 가르는 안(T111)은 버렸다 — Next가 클라이언트가 보낸 `X-Forwarded-For`를
덮지 않아(`base-server.js`의 `??=`) 위조된다. **IP가 아니라 기기로 가른다.**

## 결정

### 기기 토큰

매장이 태블릿을 등록하면 그 태블릿에 **기기 토큰**이 심긴다. JWT다.

```ts
{ sub: <deviceId: randomUUID>, storeId, role: 'STORE_DEVICE', ver: <Store.deviceTokenVersion>, exp: 365일 }
```

- **역할은 Prisma `Role` 밖의 상수다**(`DEVICE_ROLE`). `SEAT_ROLE`과 같은 이유 —
  어떤 `@Roles(...)`와도 맞지 않는다. 그리고 `JwtStrategy.validate`가 이 역할을
  **거절한다.** 기기 토큰은 Bearer가 아니고, `JwtAuthGuard`만 거는 라우트
  (`/ws/ticket` · `/playsync/*`)에 들어가 엉뚱한 `userId`로 돌면 안 된다.
- **DB 행을 만들지 않는다.** `deviceId`는 서명 안의 난수일 뿐이고, 버킷을 가르는
  열쇠로만 쓴다. 폐기는 상점 단위다 — `Store.deviceTokenVersion`을 올리면 그
  상점의 모든 기기 토큰이 죽는다. 분실 대응은 「전체 해제 → 남은 태블릿 재등록」
  이고, 태블릿이 5~10대라 감당할 수 있다. 기기별 목록·개별 폐기는 하지 않는다
  (`ponytail:` 주석으로 상한을 적는다).
- 수명 365일. 매장 비품이라 대회가 아니라 기기에 묶인다.

### 실어 나르기

태블릿 브라우저의 httpOnly 쿠키 `deviceToken`(경로 `/`). 백엔드는 둘 중 하나로
읽는다(`deviceTokenFrom`).

1. `X-Device-Token` 헤더 — **Next 서버 쪽 fetch가 싣는다.** 서버 액션
   (`enterSeat` · `authenticateDealer`)과 `api/ws-ticket` 라우트.
2. `Cookie`의 `deviceToken` — Next rewrite(`/api/*`)를 탄 클라이언트 fetch는
   브라우저 쿠키를 그대로 들고 온다. 헤더를 따로 안 실어도 버킷이 갈린다.

### 문 (`DeviceGuard`)

`/enter`와 `/dealer/auth`에만 건다.

1. 토큰을 서명 검증한다. 실패 → 401 `DEVICE_UNREGISTERED_MESSAGE`.
2. 요청이 가리키는 대회를 읽는다 — `/enter`는 경로의 `:id`, `/dealer/auth`는
   본문의 `tournamentId`. 대회의 `storeId`와 그 상점의 `deviceTokenVersion`을
   한 번에 읽는다.
3. 대회가 없거나, 토큰의 `storeId`와 다르거나, `ver`가 다르면 → 같은 401.

**상점 대조를 서비스가 아니라 문에서 한다.** 문이 핸들러보다 먼저 서므로 두
순서가 구조로 보장된다.

- **OTP 조회보다 먼저.** 뒤면 다른 상점 기기가 「그 OTP가 유효하다」를 응답
  차이로 읽는다. 없는 대회와 남의 상점 대회가 같은 응답이라 대회 id도 훑을 수 없다.
- **`OtpAttempts.reserveAttempt`보다 먼저.** 뒤면 다른 상점 기기가 그 대회의
  딜러 잠금 슬롯을 태운다.

서비스(`EntryService.enterSeat` · `DealerService.loginDealer`)는 손대지 않는다 —
호출부가 시나리오 하네스까지 96곳이고, 서비스에 선택 인자로 넣으면 빠뜨린
호출이 조용히 검사를 건너뛴다.

`/dealer/auth`의 본문은 문이 도는 시점에 아직 `ValidationPipe`를 안 지났다.
`tournamentId`가 문자열이 아니면 대회가 없는 것과 같게 401로 막는다.

### 상한 (`DeviceThrottlerGuard`)

`APP_GUARD`의 `ThrottlerGuard`를 이것으로 바꾼다. `getTracker`만 덮는다.

```ts
서명이 검증된 기기 토큰이 있다 → `device:${deviceId}`
그 외(없음 · 위조 · 깨짐)        → req.ip
```

**검증 전에 가르지 않는다.** 토큰 문자열로 가르면 아무 문자열이나 보내는 쪽이
요청마다 새 버킷을 얻는다. 버전 대조(DB)는 여기서 하지 않는다 — 폐기된 기기는
자기 버킷을 쓰다가 문에서 막히고, 그 버킷은 아무에게도 피해가 없다.

전역 가드라 모든 라우트에 걸린다. 태블릿이 쿠키나 헤더를 싣는 모든 요청이 Next
주소 버킷에서 빠진다.

### 등록과 해제

- `POST /store/:storeId/devices` — `STORE_ADMIN`, 소유자만. `{ deviceToken }`.
- `POST /store/:storeId/devices/revoke` — 같은 문. `deviceTokenVersion += 1`.

**등록은 태블릿 대기 화면에서 한다.** `/table?store=` · `/dealer?store=`가 이
상점의 기기 토큰 쿠키가 없으면(또는 쿠키의 `storeId`가 `?store=`와 다르면)
「매장 태블릿 등록」 폼을 그린다 — 점주 닉네임·비밀번호. 서버 액션
`registerDevice`가 `POST /auth/login` → `POST /store/:storeId/devices`를 부르고
**`deviceToken`만 심는다.** 점주 토큰은 쿠키에 남기지 않는다 — 태블릿이 점주로
로그인된 채 손님 앞에 놓이면 안 된다.

입장이나 딜러 인증이 `DEVICE_UNREGISTERED_MESSAGE`로 거절되면 액션이
`deviceToken` 쿠키를 지운다. 다시 그리면 등록 폼이 뜬다.

**해제는 상점 콘솔 대회 화면의 버튼 하나다**(「매장 태블릿 전체 등록 해제」).
상점 단위 화면이 아직 없어서 대회 화면에 둔다.

## 범위 밖

- **T111** — 폰 라우트(`/auth/login` · `/auth/signup`)의 Next 주소 버킷. 배포 구성 대기.
- **T110** — 좌석·딜러 토큰 폐기와 소켓 종료.
- 태블릿 대기 화면의 SSR GET(`/tournaments/stores/:id`, `/dealer/:id`,
  `/tournaments/:id/seats`)에 헤더 싣기. 이 화면들은 쿠키도 헤더도 안 실어
  Next 주소 버킷에 남는다. 막혀도 화면이 낡을 뿐 입장·재접속은 산다.
- 기기별 목록 · 개별 폐기 · 기기 이름.

## 테스트

| 파일 | 계층 | 무엇 |
|---|---|---|
| `device/device-token.spec.ts` | 단위 | 서명·검증 왕복, 헤더 우선·쿠키 대체, 깨진 문자열·다른 역할(좌석·사용자 토큰)은 null |
| `device/device-throttler.guard.spec.ts` | 단위(Nest 테스트 모듈) | 토큰 없는 요청이 상한을 채운 뒤에도 **기기 토큰 요청은 통과**, **위조 토큰은 429**(새 버킷을 못 얻는다) |
| `device/device.int-spec.ts` | 통합 | 등록은 소유자만(남의 점주 403), 문의 판정 — 없는 대회 · 남의 상점 · 해제된 버전 · 정상, 대회 id가 문자열이 아닌 본문 |
| `device/device-gate.spec.ts` | 단위(Nest 테스트 모듈) | 진짜 `EntryController` · `DealerController` 앞에 문이 서는가 — 토큰 없으면 401이고 **서비스가 한 번도 불리지 않는다**(잠금 슬롯을 안 쓴다는 것의 근거) |
| `auth/strategies/jwt.strategy.spec.ts` | 단위 | 기기 토큰 페이로드를 `validate`가 거절한다 |
| `frontend (terminal)/*` | vitest | 액션이 헤더를 싣는다, 기기 거절이면 쿠키를 지운다, 등록이 `accessToken`을 안 심는다, 페이지가 쿠키 없거나 상점이 다르면 폼을 그린다 |

하네스(부하 · e2e · 실제 kill)는 점주로 로그인해 기기 토큰을 받아 싣도록 고친다.
**CI가 돌리지 않으므로 마무리에서 사람이 돌려 기준선을 잰다.**
