# Playsync V2 작업 보드 — 2단계 (T22~)

> 브랜치 하나 = 티켓 하나 = PR 하나.
>
> 할 일의 목록과 우선순위는 [`backlog.md`](./backlog.md)에 있다. 이 문서에는
> **착수한 것만** 적는다 — 무엇을 왜 그렇게 결정했는지, 그리고 작업 중 새로
> 발견한 것.
>
> 1단계(T1~T21) 기록은 [`tickets.md`](./tickets.md)에 있다. 티켓 번호는
> 이어서 쓴다.

## 이 문서를 쓰는 방식

1단계에서 이 형식이 실제로 도움이 됐던 부분만 남긴다.

- **결정과 근거를 함께 적는다.** 무엇을 했는지는 커밋에 남는다. 여기 남길 것은
  **왜 다른 선택지를 버렸는가**다. 나중에 같은 자리를 다시 볼 때 그게 없으면
  판단을 처음부터 다시 한다.
- **"작업 중 추가로 나온 것"을 따로 적는다.** 티켓의 원래 범위 밖에서 발견한
  버그가 실제로 매번 나왔다. T18의 블라인드 음수 스택, T19의 상금 미지급이
  그렇게 나왔다.
- **잘못 짚은 것도 남긴다.** 되돌린 판단이 다음 사람에게는 지뢰밭 표시다.

## 테스트 방침

1단계와 같다. 세 계층(단위 / 통합 / 시나리오)을 유지하고,
**버그 수정은 실패하는 테스트로 재현한 뒤 고친다.**

여기에 1단계에서 반복해 데인 것 하나를 규칙으로 굳힌다.

> **새 테스트가 처음부터 통과하면 의심한다.**
>
> 실제로 세 번 겪었다. 기존 상수와 같은 값을 입력으로 골라서 수정 전에도
> 통과한 경우, 다른 계층이 이미 막고 있어 검증 대상에 닿지 못한 경우,
> 참가자 테이블만 봐서 돈이 안 나가는데도 초록이던 경우.
>
> 사후에 추가한 검사는 **제품 코드를 일부러 되돌려 빨간불을 확인**한다.

---

## 진행 현황

| # | 티켓 | 백로그 | 상태 |
|---|---|---|---|
| T22 | 프론트 앱 셸 | B5 일부 + B7 토대 | 완료 (PR #21) |
| T23 | 딜러 인증 강화 | B1 (딜러 절반) | 완료 (#22) |
| T24 | WS 단명 티켓 | B1 (계획 C) | 완료 (PR #없음 — 채운다) |
| T25 | 테이블 생성 상점 수동화 | B1 (계획 B 일부) | 완료 (PR #없음 — 채운다) |

---

## T22 — 프론트 앱 셸

**항목**: B5(기능 명세) 일부 + B7(프론트 재구성)의 토대
**범위**: `frontend/` 전체 구조, `docs/superpowers/specs/`, `docs/superpowers/plans/`
**프론트 영향**: 있음 (이 티켓이 프론트다)

### 문제

프론트에 **테스트 러너가 아예 없었다.** 초록도 빨강도 없으니 회귀를 잡을
수단이 0이었다. 그 위에 MVP 화면들이 목적 없이 쌓여 있었다 — 개발용 랜딩,
백엔드가 읽지도 않는 `x-temp-user-id` 헤더를 붙이는 axios 인스턴스, 면 구분
없는 평평한 라우트.

### 결정

**명세를 먼저 쓰고 백엔드가 따라오게 한다.** 백엔드는 MVP 기준선에 도달했지만
프론트가 요구할 것(테이블 단위 선점, 대회 단위 OTP, 포인트 충전)이 아직 없다.
API를 확정한 뒤 프론트를 짜면 명세가 백엔드 현재형에 갇힌다.

명세는 `docs/superpowers/specs/2026-07-19-frontend-structure-design.md`.
핵심은 **상점 = 테넌트**, 네 개의 면, 그리고 폰과 태블릿을 잇는 OTP다.
딜러는 계정이 아니라 역할이다. 테이블은 유저가 고르고, 좌석은 딜러가 정리한다.

이 티켓은 명세 전체가 아니라 **셸만** 만든다 — 테스트 기반, 목업 API 계층,
역할 가드 미들웨어, 라우트 그룹. 화면 내용은 후속 계획 2~6이 채운다.

**버린 선택지**: 기존 MVP 화면을 고쳐 쓰는 것. 실제 로직이 든 셋
(`playsync/[tableId]`, `dealer/[id]`, `dashboard/[id]`)만 옮기고 나머지는
지웠다. 후속 계획이 어차피 새로 쓸 화면을 끌고 가면 죽은 코드와 깨지는
import만 남는다.

**마크업은 디자인하지 않았다.** 스타일 클래스 0건. 관심사는 서버 액션·가드·
데이터 흐름이다.

### 작업 중 추가로 나온 것

리뷰가 잡은 것 중 실제 회귀 넷.

- **미들웨어 matcher가 `/api/*`를 삼켰다.** `next.config.ts`가 `/api/:path*`를
  백엔드로 rewrite하는데 미들웨어는 rewrite보다 먼저 돈다. 미인증
  `POST /api/auth/login`이 `/login`으로 307되고, 307은 메서드를 보존하므로
  클라이언트가 로그인 페이지 HTML을 받아 JSON 파싱에서 죽는다. **브라우저에서
  로그인 자체가 성립하지 않았다.**
- **고친 matcher가 이번엔 점 하나로 뚫렸다.** 정적 파일 제외를 `.*\.`로 썼더니
  "경로 아무 데나 점"이 되어 `/stores/my.store`, `/admin/users/a.b`가 가드를
  통째로 건너뛰었다. 지금은 id가 cuid라 실피해가 없지만 slug나 닉네임이 URL에
  들어오는 순간 열린다. 확장자 판정을 경로 끝에 앵커링해 고쳤다.
- **면 재편이 전광판을 죽였다.** `dashboard/[id]`를
  `stores/[storeId]/tournaments/[tournamentId]/display`로 옮겼는데 페이지가
  옛 파라미터명 `id`를 그대로 읽어 fetch가 `/dashboard/undefined`로 나갔다.
  **타입 체크가 못 잡는다** — Next 16이 생성하는 페이지 검증기가 params를
  `& any`로 뭉개서 prop 타입 전체가 무너진다. 라우트를 옮길 때 초록 타입 체크는
  아무것도 보증하지 않는다.
- **삭제한 `/playsync`로 가는 `router.push` 둘.** 딜러가 테이블을 고르면
  빈 화면이 떴다.

그리고 **테스트가 거짓말한 방식 둘.** 1단계에서 세 번 데인 것과 같은 종류다.

- 미들웨어 통과 단언 7개가 `status === 200`만 봤다. `NextResponse.next()`도
  `new NextResponse(null, {status:200})`(= 실제로는 빈 본문 차단)도 둘 다 200이다.
  미들웨어가 차단으로 바뀌어도 전부 초록이었다. `x-middleware-next` 헤더를
  함께 본다.
- 콘솔·플레이어 레이아웃 테스트의 단언이 완전히 동일했다. 두 구현을
  맞바꿔도 둘 다 통과했다. `aria-label`, nav/main 순서, 링크 대상으로 고정했다.

### 테스트

| 파일 | 계층 | 무엇 |
|---|---|---|
| `frontend/src/lib/session.test.ts` | 단위 | JWT 디코딩. 미들웨어가 Edge에서 도니 `Buffer` 없이 `atob`으로 푼다 |
| `frontend/src/lib/api.test.ts` | 단위 | MSW 경유. 핸들러 없는 요청은 에러가 나야 한다 |
| `frontend/src/middleware.test.ts` | 단위 | 역할 가드, 리다이렉트, matcher 정규식 |
| `frontend/src/app/**/layout.test.tsx` | 단위 | 면별 레이아웃 구분 |
| `frontend/src/app/**/page.test.tsx` | 단위 | 라우트 파라미터, 네비게이션 목적지 |

프론트 35개. 백엔드는 건드리지 않아 통합 테스트는 돌리지 않았다.

---

## T23 — 딜러 인증 강화

**항목**: B1(인증 정책 결정)의 딜러 절반. 선행 문서 [`threat-model.md`](./threat-model.md)
**범위**: `backend/src/dealer/`, `backend/src/store/session/`,
`jwt.strategy.ts`, `prisma/`, `shared/dto/dealer.dto.ts`, 딜러 인증 화면
**프론트 영향**: 있음 (OTP 입력 한 화면)

### 문제

딜러 OTP가 4자리 `Int`였다. `Math.random()`으로 뽑아 **평문으로 저장**하고
`!==`로 대조했으며, 시도 제한이 없었다.

- `Int`라 앞자리 0을 담지 못한다. 명목 4자리인데 실제 후보는 1000~9999의
  9000가지다.
- 원격에서 무제한으로 넣어볼 수 있다. 레이트 리밋이 백엔드 어디에도 없다.
- 뚫리면 곧바로 `resolveWinners`다. 승자는 계산되지 않고 **입력되므로** 시스템이
  판정할 정답이 없고, 나간 상금은 되돌릴 경로가 없다.
- 그리고 이 경로만 **현장 직원의 시야 밖이다.** 이 시스템의 유일한 비-소프트웨어
  통제인 오프라인 감지 루프가 닿지 않는다.

토큰 쪽도 같은 모양이었다. 딜러 JWT는 1시간 만료뿐이고 폐기 경로가 없다. 대회가
끝나도, 상점이 딜러를 내보내도 이미 나간 토큰을 무효화할 방법이 없었다.

### 결정

**OTP는 6자리 문자열이고 bcrypt 해시로만 저장한다.** `randomInt`로 뽑고
`padStart`로 앞자리 0을 지킨다 — 숫자로 다루는 한 자릿수를 늘려도 후보 공간이
명목값에 못 미친다. 대조는 `bcrypt.compare`라 상수 시간이다.

> **버린 선택지**: 자릿수만 늘리기. 평문 저장이 남아 있으면 DB 덤프나 응답 한 번
> 새는 것으로 자릿수가 통째로 무의미해진다. 실제로 이 티켓 중에 응답 누출이 두 번
> 나왔다(아래).

**잠금은 대회 단위, 5회 실패에 5분.** Redis 카운터(`dealer:otp:fail:{tournamentId}`)
하나다. **게이트는 읽기가 아니라 증가 자체다** — `INCR`을 먼저 하고 그 반환값으로
판단한다. 읽고-검사하고-나중에-증가하면 그 사이가 `bcrypt.compare` 한 라운드(~80ms)만큼
벌어지고, 그 창에 동시에 들어온 요청은 전부 같은 값을 읽어 아무도 걸리지 않는다.
실제로 리뷰 시점 코드에 50개를 동시에 던지면 **50개가 전부 통과했다**(회귀 테스트가
이 숫자를 못 박는다). 대가는 성공한 로그인도 `clear`가 돌기 전까지 슬롯을 하나 쓴다는
것이고, 성공 경로가 곧바로 `clear`를 부르므로 정상 딜러에게는 보이지 않는다.

> **버린 선택지**: IP 단위 — 주소를 바꿔가며 빠져나간다. 계정 단위 — 걸 수 없다.
> 딜러는 계정이 아니라 **역할**이고, OTP를 넣기 전에는 신원 자체가 없다.
>
> **대가는 사고가 아니라 공격이다.** 정상 딜러가 남의 오타로 5분 막히는 쪽은 가볍다 —
> 대회당 한 번 넣는 값이라 반복되지 않고 재발급이 탈출구다. 무거운 쪽은 **이 잠금이
> 그대로 DoS 원시함수**라는 것이다. `POST /dealer/auth`에 인증이 없으므로 같은 망의
> 누구나 5분에 틀린 OTP 다섯 개, 즉 **분당 한 요청**으로 모든 대회의 신규 딜러 로그인을
> 무기한 막을 수 있다. 재발급이 카운터를 지워도 다섯 번 더 보내면 다시 잠긴다. 영향이
> 한정적이라 받아들였다 — 이미 인증된 딜러는 계속 플레이하고 막히는 것은 *새* 단말의
> 로그인뿐이다. 닫으려면 IP 차원을 더하거나 전역 Throttler가 필요하고, 둘 다 이 티켓
> 밖이라 백로그로 넘겼다.

**토큰 수명은 1시간 그대로 두고, 대회에 묶는 일은 갱신이 한다.**
`POST /dealer/refresh`가 대회 상태(`FINISHED`면 거부)와 `DealerSession.tokenVersion`을
확인하고 새 토큰을 서명한다.

> **버린 선택지 1 — 딜러 토큰 수명을 대회 길이로 늘린다.** 편하지만 유출된 토큰이
> 대회 내내 산다. 그걸 끊으려면 결국 폐기 목록이 필요하고, 폐기 목록은 **매 요청
> 조회**를 뜻한다. 매 요청 DB를 볼 거면 JWT를 쓰는 이유가 없다.
>
> **버린 선택지 2 — 리프레시 토큰을 따로 둔다.** 교과서 답이지만 회전·저장·재사용
> 탐지·폐기 기계가 통째로 붙는다. 대회는 몇 시간짜리고 액세스 토큰은 1시간이라 그
> 기계를 유지할 만큼의 실익이 없다. 대신 **액세스 토큰 자신이 갱신 자격**이 된다.

**폐기는 목록이 아니라 버전 대조다.** 상점이 "내보내기"를 누르면 `tokenVersion`이
1 오르고, 다음 갱신이 버전 불일치로 거부된다. 조회가 갱신 시점에만 일어나 매 요청
비용이 없다.

> **대가를 정확히 적는다.** 내보내기는 **갱신만 막는다.** 그 순간 살아 있는 액세스
> 토큰은 만료까지 최대 1시간 그대로 유효하다. 즉시 끊으려면 WS 연결마다 버전을
> 대조해야 하는데, 그건 토큰을 어떻게 전달하느냐(위협 모델 Q1)가 정해진 뒤의
> 일이라 이 티켓 밖이다.

**재발급이 짝으로 필요하다.** 해시로만 저장하니 잃어버린 OTP를 다시 보여줄 방법이
없다. 재발급은 잠금도 함께 푼다 — 잠긴 원인이 남의 오타면 상점이 여기서 풀어야
하고, 공격자였다면 값이 이미 바뀌어 카운터가 의미 없다.

### 작업 중 추가로 나온 것

리뷰 세 라운드가 Important 여덟 건을 잡았다. **여덟 건 전부 테스트가 초록인 채로
살아 있었다.**

- **마이그레이션이 상금 원장을 지웠다.** 평문 OTP를 해시로 옮길 방법이 없어
  `TRUNCATE TABLE "Tournament" CASCADE`로 시작했는데, 이게 `TournamentParticipation`
  (참가비·상금 원장)까지 데려간다. `PointTransaction.tournamentId`는 FK가 아니라
  `String?`이라 그 행들은 지워진 대회를 가리킨 채 남고 `User.points`는 그대로다 —
  포인트 원장이 내부적으로 어긋난다. 게다가 마이그레이션은 **이 리포에서 만들어지는
  모든 DB에 순서대로 재생된다.** 지금 대상이 비어 있어 무해할 뿐 무조건 실행된다.
  `DEFAULT`로 채웠다가 `DROP DEFAULT` 하는 컬럼 교체로 다시 썼다. 채우는 값은
  대응하는 평문이 없는 더미 해시라 아무 OTP도 통과하지 못한다.

  **처음 쓴 더미 해시에는 원문이 있었고, 그 원문이 주석에 적혀 있었다.** 리뷰가
  확인했다 — `bcrypt.compare('000000-legacy-unusable', '$2b$10$dxw3JK…')`가 `true`다.
  닿지 못하는 근거가 `DealerDto`의 `^[0-9]{6}$`와 전역 `ValidationPipe`뿐이라, OTP
  형식을 완화하거나 파이프를 지나지 않는 `loginDealer` 호출자가 하나 생기면 그
  순간 모든 레거시 행이 **리포에 인쇄된 비밀번호**로 열린다. 원문이 애초에 없는
  값으로 바꿨다: `('$2b$10$' || replace(gen_random_uuid()::text,'-',''))`. salt 자리가
  base64가 아니라 hex 32자라 형식 자체가 무효이고, `bcrypt.compare`는 이런 값에
  예외 없이 `false`로 resolve한다(확인함). 볼러타일 default라 행마다 값이 다른 것도
  덤이다.

  **그래서 운영 절차가 하나 생긴다.** 이 마이그레이션을 지난 DB의 기존 대회는 전부
  **아무도 모르는 해시**를 갖는다. 즉 그 대회들의 딜러 로그인은 재발급 없이는
  불가능하다. `FINISHED`가 아닌 **모든 대회에 대해 OTP 재발급을 돌려야 한다.**
  지금은 그 재발급을 부를 화면이 없다(백로그 B5/B7 이월 항목). 그리고 이 파일을
  고치면서 체크섬이 바뀌었으므로, 이미 적용한 로컬 dev DB는 `prisma migrate reset`이
  필요하다 — 아직 어디에도 배포된 적이 없는 리포라 파일을 고치는 쪽이 맞다.
- **쓰기 경로 두 곳에서 해시가 샜다.** 조회 경로에는 `omit`을 걸었는데
  `startSession`·`updateSession`이 `update` 결과를 그대로 반환하고 컨트롤러가 그걸
  응답으로 내보냈다. 6자리의 bcrypt 해시라 오프라인 대입 공간이 10^6뿐이다.

  이게 **"평문은 구조로 옮겼고 해시는 아직 규율로 지운다"의 증거**다. 평문은 DB에
  없으니 어떤 쿼리도 흘릴 수 없지만, 해시는 쿼리마다 손으로 `omit`을 붙여야 하고 그런
  자리가 이제 **일곱 곳**이다(`session.service.ts:67, 87, 100, 187, 255, 527`,
  `payment.service.ts:37`). 구조분해 세 곳이 omit 일곱 곳이 됐을 뿐 성격은 같다 —
  빠뜨리면 조용히 샌다. 구조로 옮기는 후속(Prisma 클라이언트 수준 `omit`)은
  `backlog.md`의 B1 이월 항목으로 팠다.
- **프론트는 여전히 숫자를 보냈다.** `otp: Number(otp)`에 `type="number"`. 새 DTO가
  `@Matches(/^[0-9]{6}$/)`라 문자열이 아닌 값은 무조건 실패한다 — **브라우저에서
  딜러 인증이 400으로 죽어 있었다.** grep이 `dealerOtp`만 찾아서 필드명이 `otp`인
  이 자리를 놓쳤다. 게다가 `type="number"`는 앞자리 0을 잃는 입력 형식이다. 문자열
  DTO를 도입한 바로 그 이유가 화면에서 되돌려지고 있었다.
- **계획의 독블록이 자기 코드와 반대말을 했다.** `refreshToken` 주석은 "클라이언트가
  보낸 값을 하나라도 받으면 갱신이 '아무 테이블 딜러가 되는 경로'가 된다"인데, 바로
  아래에서 `payload.tableId`를 검증 없이 그대로 서명했다. `loginDealer`도 마찬가지로
  `ONGOING`일 때만 소속을 조회하고 그 결과를 `if (table)`로 옵셔널하게 다뤄서,
  `PENDING`·`SYNCING` 상태에서는 남의 대회 테이블 id가 그대로 서명됐다(위협 모델
  관찰 5). 이제 양쪽 다 소속을 확인한 뒤에만 서명한다.
- **그 상승 경로를 덮고 있던 테스트가 항등식이었다.** "갱신된 토큰은 원래 토큰과
  같은 테이블을 가리킨다"가 입력 `tableId`가 출력에 그대로 오는지만 봤다. 서명이
  입력을 그대로 옮기는 것이 바로 결함인데, 그걸 정답으로 단언하고 있었다. 다른
  대회의 `tableId`를 거부하는지 보도록 바꿨다.
- **`PLATFORM_ADMIN`이 죽은 권한이었다.** 클래스 수준 `@Roles`가 들여보내는데
  소유자 동일성 검사가 무조건 403을 냈다. 두 라우트를 `STORE_ADMIN` 전용으로
  좁혔다 — 평문 OTP가 나가는 자리라 우회 길을 늘리지 않는 쪽을 골랐다.

나머지 둘은 **테스트가 거짓말한 방식**이다. 1단계에서 세 번, T22에서 두 번 데인 것과
같은 종류인데 모양이 다르다.

- **`jwt.strategy.ts`의 `tokenVersion` 한 줄을 지워도 통합 211개가 전부 초록이었다.**
  갱신 테스트 넷이 전부 `jwtService.verify(...)`가 돌려주는 **원본 JWT 페이로드**를
  `refreshToken`에 직접 넣는다. 그 객체는 이미 `sub`와 `tokenVersion`을 갖고 있어서
  `JwtStrategy.validate`(딜러 분기가 `sub`를 `id`로 개명하고 `tokenVersion`을 옮긴다)를
  **지나지 않는다.** 그동안 실제 `POST /dealer/refresh`는 `undefined !== 0`으로 모든
  갱신을 **영구 403**으로 돌려주고 있었다. 서비스를 직접 부르는 통합 테스트는 가드와
  전략 사이의 배선을 보지 못한다.
- **상점 소유권 검사를 지워도 12개가 전부 초록이었다.** 검사가 테스트되지 않는
  컨트롤러 계층에 있었고, 테스트는 헬퍼를 직접 부를 뿐 라우트가 그걸 부르는지 단언하지
  않았다. 그 한 줄이면 아무 상점 관리자나 남의 대회 평문 OTP를 발급받는다. 검사를
  서비스 메서드의 첫 문장으로 옮겨 우회 불가능하게 만들었다 — `store.service.ts`의
  관행도 그쪽이다.

둘 다 **테스트가 아니라 리뷰가 잡았다.** 고친 뒤에는 제품 코드를 실제로 되돌려
빨간불을 확인했다.

**이 리포 첫 컨트롤러 수준 단위 테스트**가 여기서 나왔다. HTTP 앱을 띄우지 않고,
진짜 `RolesGuard(new Reflector())`에 데코레이터가 붙은 실제 메서드 참조를 넘겨
`canActivate`를 직접 부른다. `roles.guard.ts:11-14`가 `getAllAndOverride`라 메서드
수준 `@Roles`가 클래스 수준을 병합이 아니라 **덮어쓴다** — 추정하지 않고 확인했다.

### 잘못 짚은 것

- 계획이 `TournamentStatus.COMPLETED`를 썼다. 그런 값은 없다. 실제 종료 상태는
  `FINISHED`다.
- 갱신 구현의 최초 기록이 "`tableId`를 DB에서 다시 뽑는다"였는데, `DealerSession`에는
  `tableId` 단일 값이 없다. `tables: Table[]`(1:N)이라 "소속인지 확인한다"가 맞는
  표현이고, 코드도 그렇게 고쳤다.
- `SessionModule`이 `DealerModule`에서 `OtpAttempts`를 import하려 했으나
  `DealerModule`이 이미 `SessionModule`을 import하고 있어 순환이 된다. 자체 provider로
  다시 올렸다 — 잠금 카운터의 상태는 인스턴스 필드가 아니라 Redis 키에 있어 인스턴스가
  둘이어도 같은 것을 본다.

### 테스트

| 파일 | 계층 | 무엇 |
|---|---|---|
| `dealer/dealer-otp.spec.ts` | 단위 | 4개. 길이·앞자리 0(500회), 같은 값의 해시가 매번 다름, 해시에 평문이 없음, 오답 거부 |
| `auth/strategies/jwt.strategy.spec.ts` | 단위 | 1개. 딜러 페이로드가 `req.user`로 나가는 **모양 전체**를 단언한다. `tokenVersion`만 보면 바로 옆의 `sub` → `id` 개명이 무방비로 남아 같은 회귀가 키만 바꿔 재발한다 |
| `store/session/session.controller.spec.ts` | 단위 | 7개. 진짜 `RolesGuard`로 재발급·내보내기의 `STORE_ADMIN` 전용을 확인하고, 손대지 않은 `create`가 여전히 `PLATFORM_ADMIN`을 받는지도 본다 |
| `dealer/dealer.int-spec.ts` | 통합 | 11개. 로그인 7(정답/오답, 5회 잠금, 잠금이 대회 단위, 성공 시 카운터 소거, 다른 대회 테이블 거부, **동시 버스트 50개 중 5개만 자격 검사 도달**, **카운터 TTL**), 갱신 4(진행 중/종료/버전 불일치/다른 대회 테이블) |
| `store/session/session.service.int-spec.ts` | 통합 | 16개. 생성 응답의 1회성 평문, 조회·쓰기 경로에 해시 없음, 재발급·내보내기, **서비스 직접 호출로 소유권 우회 불가**, 딜러 세션이 없을 때의 no-op |
| `frontend/.../dealer/[id]/page.test.tsx` | 단위 | 4개. 전송 바디를 MSW로 잡아 `otp`가 문자열 `'012345'`로 가는지(`Number(otp)`로 되돌리면 앞자리 0이 사라진다), 그리고 **403 잠금 안내가 "OTP를 확인하세요"로 뭉개지지 않고** 백엔드 문구 그대로 뜨는지 |

`dealer.int-spec.ts`는 로그인 → 갱신을 **실제 Redis·PostgreSQL 위에서** 이어 돈다.
잠금은 Redis 키의 TTL과 원자적 증가가 검증 대상이라 mock으로는 검증 대상 자체가
사라진다.

기준선: contract 44 / 백엔드 단위 134 / 프론트 38 / 통합 226 / 타입 에러 0.

### 남긴 것

- **관찰 5의 나머지 절반.** 딜러는 여전히 그 대회의 아무 테이블이나 고를 수 있고,
  선점이 없어 두 딜러가 같은 테이블을 잡을 수 있다(관찰 6). 누가 배정하는가는 계획 B.
- **관찰 7.** `sub`가 대회 단위 `DealerSession.id`라 한 대회에 딜러가 셋이면 로그에서
  셋이 구분되지 않는다. 돈이 나가는 입력인데 입력자를 못 가린다.
- **관찰 9의 플레이어 쪽.** 폐기 경로는 딜러 토큰에만 생겼다.
- **전역 레이트 리밋.** `/auth/login`은 여전히 무제한이다. 딜러 OTP만 닫았다.
- **대회 단위 잠금이 그대로 DoS 원시함수다.** `GET /dealer/:id`도 `POST /dealer/auth`도
  인증이 없다. 같은 망의 누구나 **5분에 틀린 OTP 다섯 개 — 분당 한 요청**으로 모든
  대회의 신규 딜러 로그인을 무기한 막을 수 있고, 재발급으로 풀어도 다섯 번 더 보내면
  다시 잠긴다. 받아들인 잔여 위험이다 — 이미 인증된 딜러는 계속 플레이하므로 진행 중인
  대회가 멈추지는 않는다. 닫으려면 IP 차원이나 전역 Throttler가 필요하다(백로그).
- **해시 제거가 아직 규율이다.** 위 "작업 중 추가로 나온 것" 참고. `omit` 일곱 곳을
  Prisma 클라이언트 수준으로 옮기면 빠뜨림이 컴파일 에러가 된다. 백로그 항목.
- **평문 OTP와 새 엔드포인트에 닿는 화면이 없다.** 생성·재발급이 돌려주는 평문을 보여줄
  상점 콘솔이 없어서, 재발급·내보내기 두 엔드포인트와 잠금의 탈출구가 실무상 도달
  불가다. `POST /dealer/refresh`도 마찬가지로 호출자가 없다 — 단말이 `dealerToken`을
  하루짜리 쿠키에 넣는데 JWT는 한 시간이라, **전달된 동작은 브랜치 이전과 같다**
  (한 시간 뒤 딜러가 대회 도중 OTP를 다시 넣는다). 회귀는 아니고 프론트 호출자가 이
  티켓 범위에 없었지만, "딜러 토큰의 수명을 대회에 묶는다"는 목표가 끝단까지
  간 것은 아니다. 백로그 B5/B7의 명시 항목으로 팠다.
- **WS 토큰 전달**(관찰 1·2·10). 계획 C. 내보내기의 즉시성도 여기에 걸려 있다.
- **`assertDealerSessionValid`를 공유하면서 문구도 함께 넘어왔다.** 세션 없음·대회
  불일치일 때 던지는 "갱신할 수 없는 세션입니다."는 원래 `POST /dealer/refresh`
  용으로 쓴 문구인데, 이제 `POST /ws/ticket` 실패 시에도 그대로 나간다 — 딜러
  화면에 "갱신"이라는 단어가 뜬다. 설계가 검사 함수와 함께 문구도 재사용하도록
  명시했으니 의도된 것이지만, 문구가 발급 경로 문맥과 어긋난다는 것은 알고
  넘어간다.
- **대회 존재 여부의 타이밍 차이.** 대회 없음과 OTP 오류를 같은 예외로 묶어 응답을
  가르지 않지만, 대회가 없으면 bcrypt 대조 자체를 건너뛰어 수십 ms 빨리 돌아온다.
  코드 주석이 주장하는 "구분 불가"는 아직 완전하지 않다.

---

## T24 — WS 단명 티켓

**항목**: B1(계획 C — WS 토큰 전달). 선행 문서
[`docs/superpowers/specs/2026-07-28-ws-ticket-design.md`](./superpowers/specs/2026-07-28-ws-ticket-design.md)
**범위**: `backend/src/ws/`, `backend/src/dealer/dealer.service.ts`,
`packages/contract/src/ws-ticket.ts`, `frontend/src/app/api/ws-ticket/`,
`frontend/src/app/(terminal)/table/[tableId]/`, `frontend/src/app/(terminal)/dealer/[id]/`
**프론트 영향**: 있음 (게임 화면 연결 경로, 딜러 인증 경로 둘 다)

### 문제

위협 모델 관찰 1·2·10이 한 경로였다. WS 토큰이 JWT 그대로 쿼리스트링에
실려(`?token=<JWT>`) 서버·프록시 로그와 브라우저 히스토리에 남고, Origin 검사는
헤더가 없으면 통과해 브라우저를 거치지 않는 접속을 걸러내지 못했다. 그리고
서버 컴포넌트가 httpOnly `accessToken` 쿠키를 읽어 `GameClient`에 `token` prop으로
넘기고 있었는데, Next App Router에서 서버 → 클라이언트 prop은 RSC 페이로드로
직렬화되어 페이지 HTML 안에 그대로 실린다. `view-source`로 보이는 값이라
httpOnly를 건 이유가 정면으로 무효화됐다. `dealerToken`은 한 단계 더 나빴다 —
`js-cookie`는 httpOnly를 설정할 수 없어 애초에 `document.cookie`로 읽혔고, 이
토큰이 곧 `resolveWinners` 호출 권한, 즉 돈이었다.

### 결정

**단명 티켓 교환.** Next route handler(`/api/ws-ticket`)가 httpOnly 쿠키를
서버에서 읽어 백엔드 `POST /ws/ticket`을 부르고, 브라우저에는 1회용 30초
티켓만 내려간다. 게이트웨이는 그 티켓을 Redis `GETDEL`로 소비하고, 신뢰의
출처가 거기로 옮겨간다 — 게이트웨이가 더 이상 JWT를 검증하지 않고
`JwtService` 의존이 빠졌다. **1회용의 근거가 `GETDEL`의 원자성이다.** 같은
티켓으로 둘이 동시에 붙으면 하나만 값을 받고 나머지는 `null`을 받아 거부된다.
읽고-지우는 두 명령으로 나누면 그 사이에 창이 생긴다.

> **버린 선택지 — 첫 메시지 인증, `Sec-WebSocket-Protocol` 헤더.** 둘 다
> 쿼리스트링(관찰 1)은 비우지만, 액세스 토큰이 여전히 브라우저 JS에 있어야
> 보낼 수 있어서 관찰 10(RSC 페이로드 노출)을 닫지 못한다. 관찰 10은 "토큰이
> 브라우저 JS에 존재하는가"의 문제라, JS가 토큰을 들고 있는 방식은 무엇이든
> 이 문제를 닫지 못한다 — 위협 모델이 Q1에 붙여둔 조건("10번을 함께 닫으려면
> 액세스 토큰이 브라우저 JS에 들어가지 않는 방식이어야 한다")이 선택지를 하나로
> 좁힌다.

**Origin은 필수로 바꿨다.** 예전 통과 근거는 "좌석 태블릿처럼 브라우저가 아닌
클라이언트는 이 헤더를 보내지 않는다"였는데, 사실이 아니었다 — 좌석·딜러
태블릿 모두 `(terminal)` 라우트 그룹의 Next 화면이라 전부 브라우저다. 실사용
클라이언트가 전부 브라우저이므로 필수로 바꿔도 깨지는 것이 없다.

**딜러 인증도 서버 액션으로 옮겼다.** `js-cookie` 의존 자체를 제거하고,
`dealerToken`을 서버 액션에서 httpOnly로 심는다. 클라이언트 JS가 더 이상
이 토큰을 읽지 못한다.

**티켓 발급이 `tokenVersion`을 대조한다.** `dealer.service.ts`의
`assertDealerSessionValid`(T23의 `refreshToken`에서 뽑아냄)를 재사용해, 상점이
내보낸 딜러는 새 연결과 모든 재연결이 즉시 막힌다. 검사가 두 벌이면 한쪽만
고쳐지는 날이 오기 때문에 갱신 경로와 발급 경로가 같은 함수를 부른다.

> **즉시 소켓 끊기는 뺐다.** `DealerSession`이 대회 단위라(위협 모델 관찰 7 —
> 딜러 `sub`가 단말을 구분하지 못하는 그 이유), 딜러 한 명을 내보내는 조작이
> 실제로 폐기하는 것은 **그 대회 딜러 전원의 세션**이다. 지금은 효과가 "다음
> 갱신 거부"뿐이라 이게 보이지 않는다. 즉시 끊기를 넣으면 테이블 다섯 개가
> 도는 대회에서 딜러 하나를 내보내려고 누른 버튼이 다섯 테이블의 딜러 화면을
> 핸드 진행 중에 동시에 끊는 것으로 보인다 — 안 눌리는 버튼이 되고, 안 눌리는
> 보안 기능은 없는 것과 같다. 계획 B가 `sub`를 단말 단위로 내리면 그때 정확히
> 한 단말을 끊을 수 있고, 그전까지는 `docs/backlog.md`의 계획 B 문단으로 넘겼다.
>
> 그때까지 남는 구멍은 "화면이 켜진 채 연결이 유지된 태블릿" 하나뿐이고, 그건
> 물리적으로 눈앞에 있는 상황이다.

**티켓이 못 막는 것도 정직하게 적는다.** XSS가 있으면 공격자는 피해자
브라우저에서 `/api/ws-ticket`을 그냥 호출할 수 있다. 티켓이 XSS를 무해하게
만들지는 않는다. 바뀌는 것은 **무엇을 훔칠 수 있느냐**다 — 1시간짜리 재사용
가능한 토큰 대신 30초짜리 1회용 티켓이라, 빼돌려 다른 기기에서 나중에 쓰는
것이 안 된다. 지속적 탈취가 일회성으로 내려간다.

### RED 확인 방법

`?token=` 회귀 테스트는 "먼저 빨간불"이 성립하지 않는다 — 수정 전에는 이
경로가 아직 없어 통과하는 것이 정상이기 때문이다. 대신 **수정 후에** 제품
코드(`backend/src/ws/ws.gateway.ts`)에 옛 `?token=` 분기를 임시로 되살려
(티켓 검사 앞에서 `token` 쿼리를 읽어 신원을 세팅하고 접속시키는 코드) 회귀
테스트가 실제로 빨개지는지 확인했다.

- `유효한 JWT를 token 쿼리로 넘겨도 붙을 수 없다` — FAIL
  (`expect(client.close).toHaveBeenCalledWith(1008, ...)`, `Number of calls: 0`)
- `Origin이 없는 접속을 거부한다` — `assertAllowedOrigin`의 첫 줄을
  `if (!origin) return;`로 임시 복원하자 같은 방식으로 FAIL
  (`Number of calls: 0`)

두 건 모두 확인 뒤 `git checkout backend/src/ws/ws.gateway.ts`로 되돌리고,
`git diff`로 제품 코드가 원상태인 것을 확인한 다음 다시 돌려 PASS를 재확인했다.
임시 코드는 커밋되지 않았다.

### 작업 중 추가로 나온 것

리뷰가 잡았고 테스트가 놓친 것 넷.

- **`ws.module.ts`에 `imports: [DealerModule]`만으로는 앱 부팅이 깨졌다.**
  `WsGateway`가 `PlaysyncService`를 주입받는데 `PlaysyncModule`이 전역이 아니고
  `DealerModule`이 그걸 재수출하지 않는다. 타입 체크와 기존 테스트 어느 쪽도
  이걸 잡지 못했다 — 실제로 앱을 부팅해봐야 나오는 에러였다. `WsModule`이
  `PlaysyncModule`도 직접 import하도록 고쳤다.
- **`?token=` 회귀 테스트가 "중복"이라는 지적을 리뷰가 냈다.** 지금 코드에서는
  이 테스트가 '티켓이 없으면 거부한다'와 같은 경로(ticket 부재)를 타서,
  `token` 파라미터를 게이트웨이 어디서도 읽지 않는다는 점만 보면 맞는
  관찰이다. 하지만 계획 본문이 이 테스트를 명시적으로 요구했으므로
  **증거로 판정했다** — 위 RED 확인처럼 옛 분기를 되살려 보니 이 테스트만
  유일하게 빨개졌다(`Number of calls: 0`). 코드 경로 관찰 자체는 맞지만, 이
  테스트는 지키려는 특정 회귀(token 경로 부활)를 실제로 잡는다. 주석을 그
  사실대로 정정했다.
- **RED로 지목된 두 테스트가 수정 전에 이미 GREEN이었다.** 옛 코드가 다른
  이유로 우연히 `close(1008)`을 호출하고 있어서, "먼저 빨간불"이 그대로는
  성립하지 않았다. 제품 코드를 실제로 되돌려 진짜 RED를 보는 절차(위 "RED
  확인 방법")를 추가로 밟아 확인했다.
- **티켓 `fetch`에 `try/catch`가 없었다.** 계획 본문이 준 코드 형태가 그대로
  였고, 네트워크 실패가 처리되지 않은 프라미스 거부로 샜다. 리뷰가 잡았고,
  `GameClient.test.tsx`를 새로 만들어 fetch 실패 시의 동작을 덮었다.

### 테스트

| 파일 | 계층 | 무엇 |
|---|---|---|
| `backend/src/ws/ws-ticket.controller.spec.ts` | 단위 | `POST /ws/ticket`의 성공·인증 실패·딜러 세션 무효 분기, **`issue`에 `JwtAuthGuard`가 실제로 붙어 있는지**(리뷰 지적) |
| `backend/src/ws/ws-ticket.int-spec.ts` | 통합 | 발급·소비, **같은 티켓 두 번째는 거부**(`GETDEL`의 1회성), TTL 만료 |
| `backend/src/ws/ws.gateway.int-spec.ts` | 통합 | 티켓 경로 접속, Origin 필수(없음·미허용 모두 거부), **`?token=` 회귀**(옛 경로 부활 여부를 잡는다) |
| `backend/src/dealer/dealer.int-spec.ts` | 통합 | 폐기된 세션·`FINISHED` 대회의 티켓 발급 거부(`assertDealerSessionValid` 재사용 경로) |
| `frontend/src/app/api/ws-ticket/route.test.ts` | 단위 | 쿠키 없으면 401(백엔드 미호출), 성공 응답 본문에 액세스 토큰 없음, 백엔드 실패 시 상태 코드 전달, **`WsTicketResponseSchema.parse`가 형식이 다른 응답을 502로 막는지**(리뷰 지적) |
| `frontend/src/app/(terminal)/dealer/[id]/action.test.ts` | 단위 | 서버 액션이 `dealerToken`을 httpOnly로 심는지, 실패 시 쿠키를 심지 않는지 |
| `frontend/src/app/(terminal)/dealer/[id]/page.test.tsx` | 단위 | 인증 성공 시 그 테이블 게임 화면으로 이동 |
| `frontend/src/app/(terminal)/table/[tableId]/GameClient.test.tsx` | 단위 | 티켓 `fetch` 실패가 처리되지 않은 거부로 새지 않는지, **티켓 발급 403 시 배너가 뜨고 서버 문구가 그대로 보이는지**(리뷰 지적) |
| `frontend/src/app/(terminal)/table/[tableId]/page.test.tsx` | 단위 | **이 브랜치의 핵심 불변식**: 쿠키의 토큰 문자열이 `GameClient`로 넘어가는 어떤 prop에도 없다(리뷰 지적, 아래 "머지 직전 마지막 손질" 참고) |

기준선: contract 44 / 백엔드 단위 140 (10 스위트) / 프론트 52 (14 파일) /
통합 237 / 타입 에러 0.

### 머지 직전 마지막 손질

전체 브랜치 리뷰(머지 판정: 가능)가 낸 지적 여섯 개를 마지막으로 처리했다.
Important 둘, Minor 넷.

- **`page.tsx`에 토큰 미전달을 지키는 테스트가 없었다.** 설계 문서가 프론트
  단위 테스트로 명시한 셋 중 이것만 구현이 빠져 있었다 — `GameClient`의 props
  타입에 `token`이 없어 tsc가 우연히 막고 있었을 뿐, 누가 prop을 추가하면
  타입도 통과하고 285개 테스트도 초록인 채로 JWT가 `view-source`에 돌아왔을
  것이다. `page.test.tsx`를 새로 만들어, `GamePage`가 반환한 React 엘리먼트
  트리를 직렬화해 쿠키 값 문자열이 어디에도 없는지 단언한다. 특정 prop 이름을
  보지 않는다 — RED 확인에서 `token`이 아니라 `authCredential`이라는 새 이름의
  prop으로 같은 값을 실었는데도 두 테스트 모두 빨개졌다(`expected ... not to
  contain 'leaked-jwt-value'`, `'leaked-dealer-jwt-value'`). 확인 뒤 임시
  변경은 되돌렸고 `git diff`로 `page.tsx`가 원상태인 것을 확인했다.
- **티켓 발급 실패·소켓 이상 종료가 화면에 안 보였다.** `GameClient.tsx`에
  `connectionError` state 하나를 추가했다 — 티켓 발급이 `!res.ok`거나 fetch
  자체가 거부되면, 그리고 소켓이 `onerror`나 정상 종료(1000)가 아닌
  `onclose`를 받으면 채운다. 서버가 문구를 주면 그 문구를, 없으면 "연결이
  끊어졌습니다. 화면을 새로고침하거나 운영자에게 알려주세요."를 배너로
  보여준다. 언마운트로 인한 `onclose`는 기존 `cancelled` 플래그로 걸러 에러로
  보지 않는다. 화면 디자인은 하지 않았다 — B7의 몫이다. RED 확인은
  `GameClient.tsx`만 stash로 되돌리고(테스트 파일은 새 버전 유지) 새 테스트
  둘을 돌려 실제로 실패하는 것을 봤다("Unable to find an element with the
  text: 만료된 딜러 세션입니다." / 기본 문구도 동일하게 실패). 확인 뒤
  `git stash pop`으로 구현을 되돌렸다.
- **contract 스키마 주석이 "마지막 그물"이라 적어놓고 아무도 parse하지
  않았다.** `frontend/src/app/api/ws-ticket/route.ts`가 백엔드 응답을
  `WsTicketResponseSchema.parse`에 태우도록 고쳤다 — 이제 스키마에 없는 키가
  실제로 스트립되고, 백엔드가 `ticket`을 안 주면 502(액세스 토큰이 새지 않는
  응답)로 막는다. `route.test.ts`에 이 실패 경로 테스트를 더했다.
- **`@UseGuards(JwtAuthGuard)`를 지나는 테스트가 없었다.** `session.controller
  .spec.ts`의 `RolesGuard(new Reflector())` 직접 실행 패턴을 그대로 옮기지는
  못했다 — `JwtAuthGuard`는 `AuthGuard('jwt')`(passport)를 상속해 `canActivate`를
  직접 부르려면 passport 전략 등록이 필요하기 때문이다. 대신 Nest의
  `@UseGuards`가 실제로 남기는 리플렉션 메타데이터(`GUARDS_METADATA` =
  `'__guards__'`)를 `ws-ticket.controller.spec.ts`에서 읽어 `issue`에
  `JwtAuthGuard`가 붙어 있는지 확인한다. RED 확인: 데코레이터 줄을 지우자
  `Matcher error: received value must not be null nor undefined`로 실패했고,
  되돌리자 6개 전부 다시 통과했다.
- **안 쓰는 `ForbiddenException` import.** `ws-ticket.int-spec.ts`에서 지웠다.
- **설계 문서의 성공 상태 코드가 200으로 적혀 있었다.** NestJS `@Post`
  기본값은 201이다(리뷰어 실측). 정정했고, 스트립이 route handler에서
  일어난다는 사실도 함께 적었다.

### 남긴 것

- **즉시 소켓 끊기**(위협 모델 Q1의 나머지 절반). `DealerSession`이 단말이
  아니라 대회 단위인 한 표현할 수 없다. 계획 B(`docs/backlog.md`)로 넘겼다 —
  단말 단위 신원이 생겨야 정확히 한 단말만 끊을 수 있다.
- **XSS가 여전히 `/api/ws-ticket`을 호출할 수 있다.** 티켓은 탈취의 지속성을
  낮췄을 뿐 XSS 자체를 막지 않는다. 별건이다.
- T23이 남긴 이월 항목(대회 단위 잠금의 DoS 원시함수, `omit`의 Prisma 클라이언트
  수준화, 상점 소유권 검사 누락 등)은 T24가 건드리지 않았다 — 위 `backlog.md`
  참고.

---

## T25 — 테이블 생성을 상점 수동으로

**항목**: `docs/backlog.md`의 B1 계획 B 일부. 선행 문서
[`docs/superpowers/specs/2026-07-28-table-creation-design.md`](./superpowers/specs/2026-07-28-table-creation-design.md)
(같은 문서가 T26·딜러 단말 신원도 담고 있으나, **이 티켓이 닫은 것은 테이블 생성
쪽뿐이다** — 아래 "남긴 것" 참고)
**범위**: `backend/src/payment/payment.service.ts`,
`backend/src/store/session/session.service.ts`,
`backend/src/store/session/session.controller.ts`,
`backend/src/redis/redis.service.ts`, `backend/prisma/schema.prisma`(+마이그레이션)
**프론트 영향**: 없음 (상점 콘솔 화면이 아직 없어 새 엔드포인트 둘에 호출자가 없다)

### 문제

`payment.service.ts:167-174`가 좌석 점유 수가 **정확히** 7이 되는 순간
`createTable`을 불러 테이블을 늘렸다. 카운트 비교라 엣지 트리거였다 — 기존
테이블에 8번째가 앉으면 `cnt === 8`이라 안전하지만, **7을 다시 넘는 경로**가 샜다.
탈락이 비트를 0으로 내리고(`playsync.service.ts:355`) 리바인·늦은 등록이 다시
1로 올리므로, 7 → 6 → 7이면 빈 테이블이 또 생겼고 반복할 수 있었다. `createTable`
자신도 이미 빈 테이블이 있는지 보지 않고 무조건 만들었다.

여기에 셋이 더 있었다. `session.service.ts:208`의 `tableOrder`가
`tournament.tables.length`를 트랜잭션 **밖에서** 읽어, 동시에 두 번 불리면 같은
번호가 나올 수 있었다. `dealerSession!` non-null 단언은 딜러 세션이 없는 대회
(`completeSession`이 닫으며 지운 경우)에서 그대로 런타임 예외로 죽었다. 그리고
`createTable`은 지금까지 내부 호출뿐이라 소유권 검사가 아예 없었다 — 엔드포인트로
노출하는 순간 필요해졌다.

### 결정

**자동 생성을 지우고 상점 콘솔의 버튼으로 옮긴다.** 테이블이 소리 없이 늘어나면
그 테이블에 앉은 손님을 아무도 응대하지 못하는 상황이 생긴다. 현장에서 테이블을
여는 것은 딜러를 배치하고 칩과 카드를 세팅하는 물리적 행위이므로, 시스템이 그
결정을 대신할 근거가 없다.

`POST /store/sessions/:id/tables` / `DELETE /store/sessions/:id/tables/:tableId`를
`@Roles(STORE_ADMIN)`으로 추가했다 — `reissueDealerOtp`·`revokeDealerSession`과
같은 권한이다. 소유권은 `assertTournamentOwnership`을 각 서비스 메서드의 **첫
문장**으로 재사용한다. `createTable`은 `FINISHED` 대회를 409로 막고(죽은 대회에
테이블이 되살아나는 것 방지), 트랜잭션 **안에서** `tableOrder`의 **최댓값**을
읽어(`tx.table.aggregate`) 다음 번호를 정한 뒤 `@@unique([tournamentId, tableOrder])`
제약으로 동시 호출의 경합을 재시도 코드가 아니라 구조로 막는다(P2002를 잡아
409로 변환). 처음에는 개수(`tx.table.count`)로 셌는데 삭제가 번호를 재정렬하지
않는 것과 어긋나 영구 장애가 났다 — 아래 "머지 직전 전체 리뷰 대응" 참고.
`dealerSession`
없음은 명시적 409로 바꾸고 `!` 단언을 지웠다. 성공 시 `SEAT_LIST_UPDATED`를 새로
방출한다 — 자동 생성일 때는 바로 뒤에서 `buyIn`이 이벤트를 냈지만, 상점이 단독으로
부르면 아무도 내지 않아 전광판과 좌석 목록이 새 테이블을 모른다.

`deleteTable`은 **빈 테이블만, 그리고 마지막 하나는 남기고** 지운다. 점유 검사와
삭제 사이의 경합은 한 트랜잭션 안에서 대상 행에 `SELECT ... FOR UPDATE`를 먼저
거는 것으로 막는다 — 참가자 INSERT가 외래키 때문에 부모 `Table` 행에 자동으로
거는 `FOR KEY SHARE`와 충돌하므로 두 방향 모두 직렬화된다. 중간에
`deleteMany` 한 문장으로 묶는 안을 썼다가 되돌렸다(아래 "머지 직전 전체 리뷰
대응" 참고). `tableOrder`는 재정렬하지 않는다 — 재정렬하면 전광판과 딜러 화면이 보는 번호가
통째로 바뀌어 물리 테이블과 화면이 어긋난다. 번호가 비는 것보다 나쁘다.

### 버린 선택지

- **테이블 상태 컬럼** — 딜러의 `startPreFlop`이 곧 진행 중이고, 별도 컬럼은 같은
  사실의 두 번째 기록이 되어 언젠가 어긋난다.
- **대기열** — 환불 경로가 없다. 참가비는 포인트 차감이 먼저 일어나므로 좌석을
  나중에 배정하면 실패 시 되돌릴 방법이 있어야 한다.
- **자동 생성을 멱등하게 고쳐 유지** — 조건을 "빈 좌석 있는 테이블이 없으면 만든다"로
  바꾸면 버그는 사라지지만, 딜러 없는 테이블이 소리 없이 생기는 문제는 남는다.
- **Redis 유실 지연 복구** — 브레인스토밍에서 한 번 채택했다가 뺐다. `createTable`의
  DB→Redis 순서 노출은 T25가 만드는 것이 아니라 `buyIn`·`startSession`과 같은 기존
  패턴이고, 빈 비트맵으로 채우는 반쪽 복구는 앉아 있던 사람이 사라진 화면을 만든다.
  B2에서 `buttonUser`·스냅샷과 함께 본다.

### RED 확인 방법

**자동 생성 제거**(Task 1) — `table-autocreate.int-spec.ts`가 수정 전에 그대로
빨갰다. 일곱 번째 착석이 `cnt === 7`을 통과해 `createTable`을 한 번 더 불러
"테이블 수 1"을 기대한 자리에 "테이블 수 2"가 나왔다.

**`tableOrder` 경합**(Task 2) — 수정 전 실행이 실제로 실패했다. 동시 호출 2건 중
1건만 성공해 "중복 없는 번호 2개 / 전체 3개"였고, 딜러 세션 없음 테스트는
`dealerSession!.id`에서 `TypeError`가 났다(기대는 `ConflictException`). 리뷰가
이 동시성 테스트를 "우연히 초록일 수 있다"고 지적했다 — 두 호출이 전부 실패해도
"중복 없음"만 보면 통과하기 때문이다. `insertTable`에 강제 실패를 임시로 넣어
새로 추가한 "적어도 하나는 성공했다" 단언이 실제로 빨개지는 것을 확인한 뒤
되돌렸다.

**엔드포인트·소유권·이벤트**(Task 3) — 6건 중 5건은 계획대로 빨갰다(컨트롤러
라우팅 3건, 소유권 403, `FINISHED` 409, 이벤트 미발행). **딜러 세션 없음 409
테스트 하나는 처음부터 우연히 통과했다.** 옛 `createTable(tournamentId)`
시그니처에 인자를 하나 더 얹은 새 시그니처가 인자 **개수** 면에서는 호환됐던
탓에, 소유권·상태 검사를 아직 넣지 않은 코드로도 이 테스트만은 다른 경로로
"무언가를 던진다"는 조건을 만족시켰다. T22·T23·T24와 같은 종류의 "테스트가
처음부터 초록이면 의심한다"가 여기서도 한 번 더 맞았다.

**`deleteTable`**(Task 4) — 컨트롤러 3건·통합 3건 전부 "핸들러/메서드가 없다"는
이유로 정확히 빨갰다. 리뷰가 지적한 check-then-act 경합에 대응해 추가한 "좌석에
사람이 있으면 `TablePlayer` 행도 그대로 남는다" 테스트는, 가드를 임시로 무조건
삭제(`deleteMany({ where: { id, tournamentId } })`)로 되돌려 실제로 빨개지는 것
(`Received promise resolved instead of rejected`)을 확인한 뒤 정상 코드로
복원했다.

### 작업 중 추가로 나온 것

- `new SessionService(...)` 생성자 호출부가 계획이 예고한 12곳이 아니라 13곳이었다
  (`session.service.int-spec.ts`의 "tableOrder 경합" describe에 계획이 언급하지
  않은 세 번째 호출이 있었다). 같은 describe의 `createTable` 호출 3곳도 새
  시그니처로 `ownerId`가 필요해져 함께 배선했다.
- `emitSeatList`가 부르는 `this.redis.getTournamentTables`가 계획이 준 단위
  테스트 mock에 없어 `TypeError`로 죽었다 — mock에 메서드를 추가해 해결했다.
- 리뷰가 `deleteTable`의 check-then-act 경합을 잡았다. `findFirst`로 점유를
  확인하고 별도 왕복으로 `table.delete`를 부르는 사이, 동시 `buyIn` 트랜잭션이
  같은 테이블에 참가자를 꽂으면 `TablePlayer`의 `onDelete: Cascade`가 그 행을
  조용히 지울 수 있었다 — 참가비를 이미 뗀 사람이 장부에서 사라지는, 이 가드가
  막으려던 바로 그 피해다. 점유 검사와 삭제를 `deleteMany`의 `where` 절 하나
  (`tablePlayers: { none: {} }`)로 묶어 구조로 막았다 — **고 믿었으나 틀렸다.**
  아래 "머지 직전 전체 리뷰 대응"의 C2가 그것이다.

리뷰가 남긴 사소한 지적(고치지 않고 이월한 것)은 `docs/backlog.md`의 "T25가
남긴 이월 항목"에 있다.

### 머지 직전 전체 리뷰 대응

브랜치 전체를 다시 리뷰해 여섯 건이 나왔고, 한 파도로 함께 고쳤다. 셋은 위
"결정"에 적힌 내용 자체를 뒤집는 것이라 그 문단들도 같이 고쳤다.

**C1 — `tableOrder`를 개수에서 뽑아 테이블 추가가 영구히 죽었다.**
`insertTable`이 `count + 1`로 다음 번호를 정했는데, `deleteTable`은 번호를
재정렬하지 않는다. 1·2·3에서 2를 지우면 개수는 2라 다음 번호로 이미 쓰이는 3을
고르고, `@@unique`가 P2002를 던져 409("동시에 요청되었습니다. 다시 시도해 주세요")가
나간다. **다시 눌러도 같은 계산이라 영원히 같은 결과다** — 그 대회의 테이블
추가가 통째로 죽는다. 재정렬하지 않기로 한 결정과 번호를 세는 쪽이 어긋나
있었다. `tx.table.aggregate({ _max: { tableOrder: true } })`로 바꿨다.

**C2 — 조건부 `deleteMany` 한 문장은 자기가 주장한 보장을 하지 않았다.**
"조건을 삭제문에 실어 한 문장으로 만들면 구조적으로 안전하다"고 주석까지
적었는데, PostgreSQL READ COMMITTED에서 성립하지 않는다. `NOT EXISTS` 서브쿼리는
DELETE 문장의 스냅샷으로 평가되고, DELETE는 그 뒤 동시 INSERT가 쥔
`FOR KEY SHARE`에 막혔다가 **상대가 커밋하면 서브쿼리를 다시 보지 않고**
진행한다(EvalPlanQual은 대상 행이 UPDATE된 경우에만 재평가하는데, 여기서는
key-share로 잠겼을 뿐이다). 두 커넥션으로 재현했다 — 삭제 1건 성공, 방금 앉은
`TablePlayer`가 cascade로 소멸.

피해는 `TablePlayer` 한 행에서 끝나지 않는다. `joinSessionWithSeat`의 트랜잭션은
포인트 차감, `TournamentParticipation`, `totalPlayers`/`activePlayers`/
`totalBuyinAmount` 증가를 **이미 커밋한 뒤**다. 좌석만 사라진 참가자는 탈락도
수상도 되지 않고, `completeSession`의 정산 게이트
(`totalBuyinAmount − Σ prizeAmount === 0`)가 영원히 맞지 않아 **대회를 닫을 수
없게 된다.**

한 트랜잭션 안에서 대상 행에 `SELECT id FROM "Table" WHERE id = ... FOR UPDATE`를
먼저 걸도록 바꿨다. 외래키 INSERT가 부모 행에 자동으로 거는 `FOR KEY SHARE`와
충돌하므로 양방향이 직렬화된다 — 바이인이 먼저면 이쪽이 커밋까지 대기했다가
새 문장(새 스냅샷)의 점유 검사에서 409를 내고, 이쪽이 먼저면 바이인의 INSERT가
막혔다가 외래키 위반으로 실패해 그 트랜잭션 전체가 롤백된다(포인트도 되돌아간다).
**`payment.service.ts`는 한 줄도 고치지 않았다** — 충돌하는 락을 이미 걸고 있다.
"거짓 보장을 적은 주석은 주석이 없는 것보다 나쁘다"라서 주석도 다시 썼다.

**I1 — 마지막 테이블을 지우면 참가자용 조회가 500이 된다.**
막는 것이 없어 유일한 테이블도 지울 수 있었다. 필드가 지워지면 해시 키가
통째로 사라져 `getTournamentTables`가 `[]`를 주고, `getTournamentInfo`의 재구성
분기 가드가 `if (!session || !session.tables)`라 `[]`(truthy)를 그대로 통과한 뒤
`session.tables[0].id`에서 `TypeError`로 죽는다. 그 대회를 보고 있는 참가자
전원이 500을 본다. 양쪽을 다 고쳤다 — `deleteTable`은 마지막 하나를 409로
거부하고, `getTournamentInfo`는 truthiness가 아니라 `length`로 본다(테이블 0개는
`completeSession`이 대회를 닫은 뒤에도 생기므로 거부가 아니라 건너뛴다).

**I2 — 동시성 테스트가 유니크 인덱스를 지워도 초록이었다.**
`Promise.allSettled`로 `createTable`을 두 번 부르던 테스트다. 두 호출이
사실상 직렬화돼 충돌이 **한 번도 일어나지 않았고**, 제약은 실행조차 되지
않았다. `DROP INDEX "Table_tournamentId_tableOrder_key"` 후 실행해도 그대로
통과하는 것을 직접 확인했다. 커밋하지 않은 원시 커넥션이 같은 번호를 먼저
꽂아두는 결정적 충돌로 바꿨다 — 인덱스를 지우면 대기가 사라져 빨개진다.
CLAUDE.md의 "새 테스트가 처음부터 통과하면 의심한다"가 네 번째로 맞았다.

**I3 — 지워진 테이블이 좌석 목록에 되살아난다. Redis 실패는 필요 없다.**
`UPDATE_SEAT_BIT` Lua가 필드가 없으면 9칸 빈 비트맵을 만들어 줬고,
`eliminatePlayer`는 DB 커밋 **뒤에** 좌석 비트를 내린다. 마지막 참가자의 탈락이
커밋된 직후 상점이 그 테이블을 닫으면(점유 검사를 통과한다), 뒤늦은 비트
내리기가 방금 지운 필드를 전부 0인 채로 다시 써 넣는다. DB에 없는 9칸짜리 빈
테이블이 좌석 목록에 24시간 떠 있고, 그 자리를 고른 참가자는
`tablePlayer.create`의 외래키 실패로 이유 없는 500을 본다. 스크립트를 **필드가
없으면 아무것도 하지 않게** 바꿨다 — 만드는 것은 `setSeatBitmap`의 일이다.
호출부 둘(`joinSessionWithSeat`, `eliminatePlayer`) 다 반환값을 쓰지 않고, 없는
필드를 만드는 데 의존하지도 않는다. Redis가 통째로 비었을 때의 복구는 원래
이 자리가 아니다 — 빈 비트맵에 한 칸만 세우면 앉아 있던 사람들이 화면에서
사라지는 "반쪽 복구"고, 설계 문서가 그 이유로 B2에 미뤄둔 것이다.
함께: `deleteTable`이 `table:state:<tableId>`를 지우지 않아 스냅샷이 남았다
(`completeSession`은 `deleteTournament`로 지운다). `deleteTableState`를 더했다.

**I4 — 마이그레이션에 중복 사전 점검이 없다.** 고치지 않고
`docs/backlog.md`에 적었다. 판단 근거는 그쪽에 있다 — 요약하면 이 위험에 닿는
DB가 이 프로젝트에 존재하지 않고, 자동 재번호는 "번호를 재정렬하지 않는다"는
이 티켓의 결정과 정면으로 어긋나며, 가드를 넣어도 얻는 것이 에러 메시지뿐이기
때문이다.

부수 효과로 이월 항목 하나가 사라졌다 — "동시에 같은 테이블을 두 번 삭제하면
404 대신 409"는 `deleteMany`가 조건 불일치의 이유를 구분하지 못해서였는데,
`FOR UPDATE`가 행을 못 찾으면 그대로 404다.

#### RED 확인

여섯 건 모두 제품 코드를 되돌려 빨간불을 직접 봤다. 통합 8건이 늘었다.

| | 되돌린 것 | 실제로 본 실패 |
|---|---|---|
| C1 | `aggregate(_max)` → `count + 1` | `ConflictException: 테이블 추가가 동시에 요청되었습니다` (다시 눌러도 같음) |
| C2 | `FOR UPDATE` 트랜잭션 → 옛 `deleteMany` | `결과 undefined / Table 0행 / TablePlayer 0행` — 삭제가 성공하고 참가자가 cascade로 소멸 |
| I1(a) | 마지막 테이블 가드 제거 | `Received promise resolved instead of rejected` |
| I1(b) | `length > 0` → `!session.tables` | `TypeError: Cannot read properties of undefined (reading 'id')` |
| I2 | `DROP INDEX Table_tournamentId_tableOrder_key` | 새 테스트는 `대기 중 아님`으로 실패. **옛 테스트는 같은 조건에서 그대로 통과했다** — 그것이 이 지적의 내용이다 |
| I3 | Lua의 `if not bitmap then ... end` 복원 / `deleteTableState` 호출 제거 | `좌석 목록의 지워진 테이블 있음`, `반환 001000000 / 필드 001000000`, `스냅샷 있음` |

C2는 테스트 이전에 **두 커넥션 실험**으로 먼저 확인했다(테스트 Postgres 5433,
원시 `pg` 클라이언트 셋). 조건부 `deleteMany`는 `rowCount = 1`과 함께 참가자
행을 없앴고, `FOR UPDATE`를 먼저 거는 쪽은 바이인이 선행하면 409를, 삭제가
선행하면 상대에게 `23503 ... violates foreign key constraint
"TablePlayer_tableId_fkey"`를 돌려줬다 — 즉 바이인 트랜잭션 전체가 롤백된다.

### 테스트

| 파일 | 계층 | 무엇 |
|---|---|---|
| `payment/payment.service.int-spec.ts` | 통합 | 자동 생성 제거로 안 쓰이게 된 `createTable` 스텁 제거 |
| `scenario/table-autocreate.int-spec.ts` | 시나리오(신규) | 일곱 명이 앉아도 테이블 수는 늘지 않는다 |
| `store/session/session.service.int-spec.ts` | 통합 | `tableOrder` 결정적 경합(원시 커넥션이 같은 번호를 먼저 꽂아 두면 뒤늦은 추가가 유니크 인덱스에 막혀 409로 나간다), 딜러 세션 없음 409, 추가의 소유권 403/`FINISHED` 409/이벤트 발행, 삭제(빈 테이블/점유 시 409·`TablePlayer` 잔존/다른 대회 404) |
| `store/session/session.service.spec.ts` | 단위 | `createTable` 소유권·상태 분기 |
| `store/session/session.controller.spec.ts` | 단위 | 새 두 라우트에 `@Roles(STORE_ADMIN)`이 실제로 붙어 있는지(진짜 `RolesGuard` 실행, T23·T24와 같은 방식) |
| `redis/redis.service.ts` | — | `removeSeatBitmap` 추가. 단독 스펙은 없고 삭제 경로의 통합 테스트가 Redis 필드 소멸을 함께 확인한다 |

기준선: contract 44 / 백엔드 단위 150 (10 스위트) / 프론트 단위 52 (14 파일) /
통합 252 (20 스위트) / 타입 에러 0. 통합 8건은 머지 직전 전체 리뷰 대응에서
늘었다 — 아래 참고.

### 남긴 것

- **상점 콘솔 화면이 없어 새 엔드포인트 둘에 호출자가 없다.** T23의 재발급·
  내보내기와 같은 상태다. B5 명세 → B7 구현.
- **좌석 선택 화면의 "빈 자리 없음" 판정이 없다.** 백엔드는 `getSeatStatus`가
  비트맵을 주는 것으로 끝났다.
- **더블클릭으로 빈 테이블이 둘 생기는 것은 막지 않는다.** 순차 실행이면
  `tableOrder`의 최댓값을 각각 다시 읽어 유니크 제약을 우회한다 — 콘솔이 버튼을
  비활성화할 문제고, 삭제가 있으므로 되돌릴 수 있다.
- **T26(딜러 단말 신원)은 이 티켓이 아니다.** 설계 문서가 T25·T26을 한 문서에
  담았지만, 구현은 T25(테이블 생성)까지만이다. `DealerSession`을 단말 단위로
  내리는 일, `Table.dealerId` 제거, 즉시 소켓 끊기는 여전히 미착수다 — `backlog.md`
  의 계획 B로 남아 있다.

---

<!--
티켓 서술 형식 (1단계에서 쓰던 것):

## T22 — 제목

**항목**: backlog.md의 B번호 또는 발견 경위
**범위**: 건드리는 파일
**프론트 영향**: 있음 / 없음

### 문제

무엇이 왜 잘못됐는가. 코드 인용.

### 결정

무엇을 선택했고 **다른 선택지를 왜 버렸는가**.

### 작업 중 추가로 나온 것

원래 범위 밖에서 발견한 것.

### 테스트

| 파일 | 계층 | 무엇 |
-->
