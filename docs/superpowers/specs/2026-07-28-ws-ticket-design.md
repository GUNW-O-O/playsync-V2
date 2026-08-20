# WS 토큰 전달 설계 (계획 C)

B1의 남은 두 갈래 중 하나다. T23이 딜러 인증의 **앞문**(OTP 추측)을 막았고,
이 문서는 **이미 발급된 토큰이 새는 경로**를 막는다.

닫는 것은 `docs/threat-model.md`의 관찰 1·2·10과 질문 Q1이다.

## 지금 토큰이 흐르는 길

```
[로그인]  auth/action.ts:50            accessToken 쿠키, httpOnly: true
[딜러]    dealer/[id]/page.tsx:64      Cookies.set('dealerToken', ...)   ← js-cookie
[테이블]  table/[tableId]/page.tsx:24  서버 컴포넌트가 쿠키를 읽어
                                       <GameClient token={token} />      ← prop
[연결]    GameClient.tsx:16            ws://.../playsync?tableId=X&token=<JWT>
[서버]    ws.gateway.ts:99             assertAllowedOrigin(headers['origin'])
          ws.gateway.ts:103            jwtService.verifyAsync(token)
```

### 관찰 10 — httpOnly가 무효화되는 지점

`accessToken`에 `httpOnly`를 건 목적은 "XSS가 나도 토큰은 못 읽는다"이다.
그런데 서버 컴포넌트가 쿠키를 읽어 `token` prop으로 클라이언트 컴포넌트에
넘긴다. Next.js App Router에서 서버 → 클라이언트 prop은 **RSC 페이로드로
직렬화되어 페이지 HTML 안에 실린다.** `view-source`로 보이고, XSS든 확장
프로그램이든 DOM만 읽으면 JWT가 손에 들어온다. httpOnly가 산 것이 없다.

비난할 코드가 아니라 **구조가 그렇게 몰고 간 것이다.** httpOnly를 걸면 클라
JS가 못 읽으니 서버에서 읽어 내려보내는 것이 자연스러운 수순이다. 그래서
"규율로 조심하자"가 답이 될 수 없고, 전달 방식 자체를 바꾼다.

`dealerToken`은 한 단계 더 나쁘다. `js-cookie`는 httpOnly를 설정할 수 없으므로
애초에 `document.cookie`로 읽힌다. 그리고 이 토큰이 승자 지정 권한을 가진
토큰이다 — 이 시스템에서 승자는 계산되는 값이 아니라 딜러가 입력하는 값이라,
딜러 토큰은 곧 돈이다.

### 관찰 1 — 쿼리스트링

같은 JWT가 URL에 실린다. TLS가 전송 구간을 덮지만 URL은 **종단에서 텍스트로
남는다** — 리버스 프록시 액세스 로그, WS를 중계하는 인프라, 애플리케이션 로그.
수명이 1시간이라 로그를 한 번 본 사람이 그 시간 동안 그대로 쓸 수 있다.

### 관찰 2 — Origin 검사

```ts
private assertAllowedOrigin(origin?: string) {
  if (!origin) return;          // 헤더가 없으면 통과
  ...
}
```

브라우저는 WS 핸드셰이크에 Origin을 항상 보낸다. 안 보내는 것은 브라우저가
아닌 클라이언트뿐이다. 그러니 이 검사는 CSWSH(다른 사이트가 피해자 브라우저를
시켜 이 소켓을 열게 하는 것)는 실제로 막지만, 행사장 WiFi에서 `wscat`을 직접
부는 공격자에게는 아무 제약이 아니다. 헤더를 빼면 된다.

기존 주석은 "좌석 태블릿처럼 브라우저가 아닌 클라이언트"를 전제로 통과를
정당화했다. 프론트 화면 명세(`2026-07-27-frontend-screens-design.md`)를 보면
좌석·딜러 태블릿 모두 `(terminal)` 라우트 그룹의 Next 화면이다 — 전부
브라우저다. **전제가 실제와 다르다.**

### 셋이 한 경로인 이유

토큰이 RSC 페이로드나 프록시 로그에 남고(1·10), 그걸 주운 사람이 같은 망에서
Origin 없이 직접 연결한다(2). 하나만 고치면 나머지가 경로를 유지한다.

**이미 막혀 있는 것**도 짚어둔다. `assertTableAccess`가 딜러는 토큰에 서명된
`tableId`와, 플레이어는 Redis 스냅샷의 좌석과 대조한다. 훔친 토큰으로 아무
테이블이나 잡지는 못한다. 다만 훔친 딜러 토큰으로 **그 딜러의 테이블**은 잡는다.

## 결정

### Q1 — WS 토큰을 어떻게 전달하나: **단명 티켓 교환**

Next route handler가 httpOnly 쿠키로 백엔드에 티켓을 요청하고, 브라우저 JS에는
**1회용 30초 티켓만** 내려간다.

| 방식 | 관찰 1 | 관찰 10 |
|---|---|---|
| 단명 티켓 | 닫힘 — 로그에 남는 건 이미 쓴 1회용 티켓 | **닫힘** — 액세스 토큰이 JS·RSC에 안 들어감 |
| 첫 메시지 인증 | 닫힘 | 안 닫힘 — JS가 토큰을 들고 있어야 보낸다 |
| `Sec-WebSocket-Protocol` | 닫힘 | 안 닫힘 — 같은 이유 |

관찰 10은 "토큰이 브라우저 JS에 존재하는가"의 문제라, **JS가 토큰을 들고 있는
방식은 무엇이든 닫지 못한다.** 위협 모델이 Q1에 붙여둔 조건("10번을 함께
닫으려면 액세스 토큰이 브라우저 JS에 들어가지 않는 방식이어야 한다")이 곧
선택지를 하나로 좁힌다.

**티켓이 못 막는 것도 적어둔다.** XSS가 있으면 공격자는 피해자 브라우저에서
`/api/ws-ticket`을 그냥 호출할 수 있다. 티켓이 XSS를 무해하게 만들지는 않는다.
바꾸는 것은 **무엇을 훔칠 수 있느냐**다 — 1시간짜리 재사용 가능한 토큰 대신
30초짜리 1회용 티켓이라, 밖으로 빼돌려 나중에 다른 기기에서 쓰는 것이 안 된다.
지속적 탈취가 일회성으로 내려간다.

### Origin: **필수. 없으면 거부**

실사용 클라이언트가 전부 브라우저이므로 깨지는 것이 없다. 통합 테스트가
Origin을 붙이도록 고친다. 상수로 위장할 수는 있지만, 그러려면 허용된 출처
목록을 알아야 한다.

환경변수 탈출구(`WS_ALLOW_NO_ORIGIN`)는 두지 않는다. 꺼진 보안 스위치가 하나
늘고, 실수로 켜진 채 가는 상황이 생긴다.

### 즉시 소켓 끊기: **이 계획에서 뺀다 — 계획 B로**

T23의 "내보내기"는 `tokenVersion`을 올려 갱신을 막지만, 살아 있는 소켓은 최대
1시간 그대로다. 즉시 끊으려면 폐기 시점에 소켓을 닫아야 한다.

**빼는 이유는 폭발 반경이다.** `DealerSession`은 대회 단위다(관찰 7 — 딜러
`sub`가 단말을 구분하지 못하는 그 이유). 그래서 딜러 한 명을 내보내면 실제로
폐기되는 것은 **그 대회 딜러 전원의 세션**이다. 지금은 효과가 "다음 갱신 거부"
뿐이라 이게 보이지 않는다. 즉시 끊기를 넣으면 보인다 — 테이블 다섯 개가 도는
대회에서 딜러 하나를 내보내려고 누른 버튼이 다섯 테이블의 딜러 화면을 핸드
진행 중에 동시에 끊는다.

즉시 끊기의 실제 용도는 "이 단말 하나를 회수한다"인데, 지금 자료구조로는 그
조작이 표현되지 않는다. 대회 전원을 끊는 것으로 그 요구를 대신하면 실무에서
안 눌리는 버튼이 되고, 안 눌리는 보안 기능은 없는 것과 같다. 계획 B가 `sub`를
단말 단위로 내리면 그때 정확히 한 단말을 끊을 수 있다.

**그때까지 남는 구멍은 크지 않다.** 티켓 발급이 `tokenVersion`을 대조하므로
**새 연결과 모든 재연결이 즉시 막힌다.** 태블릿을 회수하거나 앱을 껐다 켜면 그
시점에 끊긴다. 남는 것은 "화면이 켜진 채 연결이 유지된 태블릿" 하나뿐이고,
그건 물리적으로 눈앞에 있는 상황이다.

### 다중 인스턴스: 고려하지 않는다

인스턴스를 늘릴 계획이 없다. 프로세스 간 이벤트 전달(Redis pub/sub)이 필요한
설계 요소를 넣지 않는다.

## 구조

### 부품

| 파일 | 책임 |
|---|---|
| `backend/src/ws/ws-ticket.service.ts` (신규) | 티켓 발급·소비. Redis 키 하나 |
| `backend/src/ws/ws-ticket.controller.ts` (신규) | `POST /ws/ticket`. `JwtAuthGuard` |
| `backend/src/ws/ws.gateway.ts` | 핸드셰이크가 `?token=` 대신 `?ticket=`. Origin 필수 |
| `backend/src/dealer/dealer.service.ts` | `assertDealerSessionValid` 추출 |
| `packages/contract/src/ws-ticket.ts` (신규) | 티켓 응답 아웃바운드 스키마 — `{ ticket: string }` 하나 |
| `frontend/src/app/api/ws-ticket/route.ts` (신규) | httpOnly 쿠키를 읽어 백엔드에 중계. **티켓만** 반환 |
| `frontend/src/app/(terminal)/table/[tableId]/GameClient.tsx` | 연결 전 티켓을 받아온다. `token` prop 제거 |
| `frontend/src/app/(terminal)/table/[tableId]/page.tsx` | prop 전달 중단 |
| `frontend/src/app/(terminal)/dealer/[id]/action.ts` (신규) | 딜러 인증을 서버 액션으로. `dealerToken`을 httpOnly로 |
| `frontend/src/app/(terminal)/dealer/[id]/page.tsx` | `js-cookie` 제거, 서버 액션 호출 |

### 흐름

```
브라우저 ──POST /api/ws-ticket──▶ Next route handler
                                  (쿠키 자동 첨부. JS는 쿠키를 못 읽는다)
                                       │
                                       ├─ Authorization: Bearer <쿠키에서 꺼낸 토큰>
                                       ▼
                                  POST /ws/ticket   (JwtAuthGuard)
                                       │ 딜러면 assertDealerSessionValid
                                       │ Redis SET ws:ticket:<uuid> <신원> EX 30
                                       ▼
브라우저 ◀────────── { ticket } ────────  (액세스 토큰은 나가지 않는다)
   │
   └─▶ ws://.../playsync?tableId=X&ticket=<uuid>
              게이트웨이: Origin 검사(필수) → GETDEL → 신원 확보 → assertTableAccess
```

`GET /playsync/:tableId`(초기 상태)는 지금처럼 서버 컴포넌트가 쿠키로 부른다.
그 경로에는 토큰이 브라우저로 내려가지 않으므로 바꿀 것이 없다.

### 티켓 규격

| | |
|---|---|
| 키 | `ws:ticket:<uuid>` — `node:crypto`의 `randomUUID()` |
| 값 | `JSON.stringify({ sub, role, tournamentId, tableId })` — 지금 게이트웨이가 쓰는 값 그대로 |
| TTL | 30초 (`SET ... EX 30`) |
| 소비 | `GETDEL` — redis:7이라 쓸 수 있다 |

**1회용의 근거가 `GETDEL`이다.** 같은 티켓으로 둘이 동시에 붙으면 하나만
값을 받고 나머지는 `null`을 받아 거부된다. 읽고-지우는 두 명령으로 나누면 그
사이에 창이 생긴다.

**게이트웨이는 JWT를 검증하지 않는다.** 신뢰의 출처가 티켓 소비로 옮겨간다.
`jwtService` 의존이 게이트웨이에서 빠진다.

**발급에 파라미터를 받지 않는다.** 테이블 대조는 `assertTableAccess`가 이미
하고, 딜러가 테이블을 옮겨도 같은 경로가 돈다. 발급 시점에 `tableId`를 묶으면
검사가 두 곳이 되고 한쪽만 고쳐지는 날이 온다.

### 딜러 세션 대조는 기존 검사를 재사용한다

`dealer.service.ts:128-163`의 `refreshToken`이 이미 다섯 가지를 본다 — 세션
존재, `tournamentId` 일치, `FINISHED` 아님, `tokenVersion` 일치, `tableId` 소속.
티켓 발급에 필요한 것과 같다.

`assertDealerSessionValid(payload)`로 뽑아내고 `refreshToken`과 티켓 발급이 함께
부른다. 검사가 두 벌이 되면 한쪽만 고쳐지는 날이 온다.

## 에러 처리

| 지점 | 상황 | 결과 |
|---|---|---|
| 게이트웨이 | 티켓 없음 · 만료 · 이미 소비 | `close(1008, '인증 실패')` — 셋을 구분해 알려주지 않는다 |
| 게이트웨이 | Origin 없음 · 미허용 | `close(1008, '인증 실패')`, `logger.warn`으로 남긴다 |
| `POST /ws/ticket` | 토큰 없음 · 무효 | 401 (`JwtAuthGuard`) |
| `POST /ws/ticket` | 폐기된 딜러 세션 · `FINISHED` 대회 | 403, 문구는 `refreshToken`과 동일 |
| `POST /ws/ticket` | 성공 | 201 `{ ticket }`(NestJS `@Post` 기본값). route handler가 이 응답을 `WsTicketResponseSchema.parse`에 태워 반환하므로, 그 외의 키는 route handler에서 실제로 스트립된다 |
| route handler | 쿠키 없음 | 401. 백엔드까지 가지 않는다 |
| route handler | 백엔드 실패 | 상태 코드 그대로, 본문은 `message`만 |

거부된 접속을 `logger.warn`으로 남기는 기존 방침은 유지한다 — 잘못된 자격과
허용되지 않은 출처가 한자리에 모이는 것이 보안 신호다.

route handler는 **어떤 경로로도 액세스 토큰을 응답에 싣지 않는다.** 성공이든
실패든 마찬가지다. 이 계획 전체가 그 한 줄에 걸려 있다.

## 테스트

### 통합

`backend/src/ws/ws.gateway.int-spec.ts` 확장, `ws-ticket.int-spec.ts` 신규.

- 유효한 티켓으로 접속 성공
- **같은 티켓 두 번 — 두 번째 거부** (`GETDEL`의 1회용이 실제로 도는지)
- TTL 만료 뒤 거부
- Origin 없음 — 거부
- 허용되지 않은 Origin — 거부
- **`?token=<유효 JWT>`로는 붙지 않는다** — 옛 경로가 살아 있으면 관찰 1·10이
  안 닫힌다
- 폐기된 딜러 토큰(`tokenVersion` 불일치)으로 티켓 발급 거부
- `FINISHED` 대회의 딜러 토큰으로 티켓 발급 거부

### 프론트 단위

- route handler: 쿠키가 없으면 401이고 백엔드를 부르지 않는다
- route handler: 성공 응답 본문에 `accessToken`이 없다
- `page.tsx`가 `GameClient`에 토큰을 넘기지 않는다

### RED 확인

프로젝트 규칙대로 새 테스트는 수정 전에 빨간 것을 본다.

**`?token=` 회귀 테스트만 방향이 반대다** — 지금은 통과하는 것이 정상이라
"먼저 빨간불"이 성립하지 않는다. 대신 **수정 후에 옛 경로를 임시로 되살려**
이 테스트가 빨개지는지 확인한다.

## 범위 밖

명시하고 하지 않는다.

- **즉시 소켓 끊기** — 계획 B. 단말 단위 신원이 생긴 뒤.
- **플레이어 좌석 토큰** (프론트 화면 명세가 B1에 걸어둔 항목) — OTP 발급
  체계가 따로다. 별건.
- **전역 레이트 리밋** — `/ws/ticket`은 인증된 경로다. 무제한 발급이 가능하지만
  이미 토큰을 가진 사람이 자기 티켓을 여러 개 만드는 것뿐이라 얻는 것이 없다.
- **다중 인스턴스** — 확장 계획 없음.
- **B7 화면 재구성** — 이 계획은 기존 연결점만 새 방식으로 옮긴다.

## 설정과 영향

- `WS_ALLOWED_ORIGINS`가 실질적으로 필수 설정이 된다. 미설정 시 기본값
  `http://localhost:3000`은 그대로 두므로 개발은 영향이 없다.
- route handler가 서버에서 백엔드를 부르므로 `BACKEND_URL`이 필요하다.
  `frontend/.env.example`에 있는지 확인한다 — `GUNW-O-O/front-end` 워크트리가
  그 파일을 이미 건드렸으므로 머지 시 겹칠 수 있다.
- `docs/backlog.md`도 그 워크트리가 수정했다. 같은 이유로 겹칠 수 있다.

## 관련 문서

| | |
|---|---|
| [`../../threat-model.md`](../../threat-model.md) | 관찰 1·2·10, 질문 Q1 |
| [`../../backlog.md`](../../backlog.md) | B1의 배경과 남은 범위 |
| [`../../chat-log2.md`](../../chat-log2.md) | T23 — 딜러 인증 강화 |
| `2026-07-27-frontend-screens-design.md` | 좌석·딜러 태블릿이 브라우저라는 근거. **아직 `GUNW-O-O/front-end` 브랜치에만 있다** — main에 머지되면 이 표를 링크로 바꾼다 |
