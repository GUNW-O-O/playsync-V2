# 테이블 생성과 딜러 단말 설계 (T25 · T26)

**항목**: `docs/backlog.md`의 B1 계획 B 일부와, 그 과정에서 드러난 테이블 생성 버그.
**구현 순서**: T25(테이블 생성)를 먼저, T26(딜러 단말 신원)은 뒤에.

한 문서에 둘을 담는 이유는 **UX 흐름이 하나이기 때문**이다. 딜러 태블릿이 대회와
테이블을 고르는 방식과, 상점이 테이블을 만드는 방식이 같은 화면 위에서 만난다.
따로 정하면 어긋난다. 구현을 쪼개는 이유는 그 반대다 — 겹치는 코드가 거의 없고
(공유하는 것은 `session.service.ts`의 `tournament.dealerSession!` 한 줄뿐),
T26은 마이그레이션과 인증 경로 재검증을 동반해 T25의 버그 수정과 섞이면 실패
원인을 분리할 수 없다.

---

## 도메인 전제

**한 테이블 = 한 딜러 태블릿. 태블릿은 물리적으로 고정이고, 사람만 교대한다.**

그러나 **시스템은 태블릿과 테이블을 결합하지 않는다.** 태블릿 바탕화면의 바로가기가
들고 있는 것은 상점까지(`/dealer?store=xxx`)이고, 대회와 테이블은 런타임에 고른다.
느슨하게 두는 이유는 태블릿이 소모품이기 때문이다 — 고장 나면 다른 기기를 갖다
놓으면 그만이어야 한다. 하드웨어에 신원을 굽는 순간 교체가 운영 작업이 된다.

이 전제는 `docs/superpowers/specs/2026-07-27-frontend-screens-design.md`가 이미
`/dealer?store=xxx` → 대회·테이블 선택 → OTP로 확정한 흐름과 같다.

---

## 결정

### 테이블 상태 컬럼: **만들지 않는다**

"딜러가 이 테이블에 붙었다"를 나타내는 상태를 `Table`에 두는 안을 검토했고 버렸다.
막는 것이 없기 때문이다.

- 핸드는 이미 딜러의 `startPreFlop` 없이는 시작하지 않는다. **딜러가 그 버튼을
  누르는 것이 곧 "진행 중"이다.** 별도 컬럼은 같은 사실의 두 번째 기록이 되고,
  두 기록은 언젠가 어긋난다.
- 참가자 착석을 막을 이유도 없다. 오프라인이라 사람은 어차피 자리에 앉아
  딜러를 기다린다. 시스템이 앉는 것을 막으면 현실과 화면이 어긋난다.

### 테이블 자동 생성: **제거한다. 상점이 수동으로 추가한다**

지금은 `payment.service.ts`가 좌석 점유 수가 7이 되는 순간 `createTable`을 부른다.
이것을 지우고 상점 콘솔의 버튼으로 옮긴다.

**운영상의 이유가 먼저다.** 테이블이 소리 없이 늘어나면, 그 테이블에 앉은 손님을
아무도 응대하지 못하는 상황이 생긴다. 현장에서 테이블을 여는 것은 딜러를 한 명
배치하고 칩과 카드를 세팅하는 물리적 행위다. 시스템이 그 결정을 대신할 근거가 없다.

**그리고 지금 조건이 실제로 틀렸다.** 아래 "고치는 결함" 참고.

### 테이블이 모두 찼을 때: **막고 안내한다**

대기열도, 자동 생성도 아니다. 좌석 선택 화면이 "빈 자리 없음"을 보여주고,
상점이 테이블을 추가하면 풀린다. 오프라인이라 손님이 직원에게 말하면 되는 상황이다.

대기열을 버린 이유는 환불 경로가 없기 때문이다. 참가비는 포인트 차감이 먼저
일어나므로, 좌석을 나중에 배정하는 구조는 배정 실패 시 되돌릴 방법이 있어야 한다.
`TransactionType.REFUND`는 스키마에만 있고 경로가 없다(`backlog.md`의 "대회 취소와 환불").

### 테이블이 둘 이상일 때 참가자가 앉는 곳: **아무 데나**

서버가 배정하지도, 상점이 "지금 받는 테이블"을 지정하지도 않는다. 상점이 필요할
때만 테이블을 추가하면 빈 자리가 사실상 한 테이블에만 있으므로, 흩어짐은 운영
실수일 때만 생긴다. 인원 균형은 B8(다중 테이블·밸런싱)이다.

### 테이블 삭제: **넣는다**

추가를 사람 손으로 옮기면 실수도 사람 손에서 나온다. 잘못 만든 빈 테이블이 좌석
선택 화면에 계속 떠서 사람을 흩는다. 취소가 없는 추가 버튼은 운영자가 누르기를
두려워한다.

---

## T25 — 테이블 생성을 상점 수동으로

### 고치는 결함

자동 생성 제거로 사라지는 것 하나, 따로 고쳐야 하는 것 셋.

**1. 좌석이 비었다 다시 차면 빈 테이블이 또 생긴다.**

`payment.service.ts:167-174`가 하는 판정은 "그 테이블의 점유 좌석이 **정확히** 7이면
생성"이다. 카운트 비교라 엣지 트리거다.

- 기존 테이블에 8번째가 앉으면 `cnt === 8`이라 생성되지 않는다. 이 경우는 안전하다.
- 새는 곳은 **7을 다시 넘는 경로**다. `playsync.service.ts:355`가 탈락 시 비트를 0으로
  내리고, 리바인·늦은 등록은 `joinSessionWithSeat`을 그대로 타서(`payment.service.ts:85`의
  `isOngoing` 분기) 비트를 다시 1로 올린다. 7 → 6 → 7이면 빈 테이블이 또 생기고,
  반복할 수 있다.
- `createTable`은 **이미 빈 테이블이 있는지 보지 않는다.** 무조건 만든다.

자동 생성을 지우면 이 경로 자체가 사라진다.

**2. `tableOrder` 경합.** `session.service.ts:208`이 `tournament.tables.length`를
트랜잭션 **밖에서** 읽고 안에서 쓴다. 동시에 두 번 불리면 같은 값이 나온다.

**3. `dealerSession!` 단언.** `session.service.ts:214`. 딜러 세션이 없는 대회
(`completeSession`이 닫으며 지운 경우)에 부르면 런타임에 터진다.

**4. 소유권 검사 없음.** `createTable`은 지금 내부 호출뿐이라 검사가 없다.
엔드포인트로 노출하는 순간 필요해진다.

### 엔드포인트

```
POST   /store/sessions/:id/tables               @Roles(STORE_ADMIN)
DELETE /store/sessions/:id/tables/:tableId      @Roles(STORE_ADMIN)
```

`@Roles`가 `STORE_ADMIN`만인 것은 `reissueDealerOtp`·`revokeDealerSession`과 같다
(`session.controller.ts:50, 56`). 소유권은 이미 있는 `assertTournamentOwnership`
(`session.service.ts:432`)을 **서비스 메서드 첫 문장**으로 재사용한다. 컨트롤러가
아니라 서비스에 두는 이유는 그 함수의 주석(`:423-427`)에 이미 적혀 있다 —
컨트롤러에만 있으면 서비스를 직접 부르는 경로가 우회한다.

**contract 패키지는 건드리지 않는다.** REST에 경계 규칙(인바운드 `.strict()`,
아웃바운드 스트립)을 적용할지는 `backlog.md`가 B6로 미뤄놓은 결정이다. 여기서
한 엔드포인트만 먼저 적용하면 규칙이 두 벌이 된다.

### `createTable`

1. `assertTournamentOwnership(tournamentId, ownerId)` — 첫 문장
2. `FINISHED` 대회면 거부. `completeSession`이 닫으며 테이블을 지우므로, 여기서
   만들면 죽은 대회에 테이블이 되살아난다
3. 트랜잭션 안에서 `tx.table.count({ where: { tournamentId } })` → `tableOrder = count + 1`
   → `tx.table.create`
4. `dealerSession`이 없으면 명시적 예외. `!` 단언 제거
5. 커밋 후 `setSeatBitmap` — 기존 순서 유지
6. `SEAT_LIST_UPDATED` 방출

6번만 설명이 필요하다. 지금 `createTable`은 이벤트를 내지 않는다. 자동 생성일 때는
바로 뒤에서 `buyIn`이 냈기 때문이다(`payment.service.ts:175-179`). 상점이 단독으로
부르면 아무도 내지 않아 전광판과 좌석 목록이 새 테이블을 모른다. 복구가 아니라
기능의 일부다.

### `deleteTable`

1. `assertTournamentOwnership` — 첫 문장
2. 해당 `tableId`가 그 대회 소속인지 확인. 아니면 404
3. `TablePlayer`가 1건이라도 있으면 409. **빈 테이블만 지운다**
4. DB 삭제 → Redis 필드 삭제 → `SEAT_LIST_UPDATED`

`RedisService`에 필드 하나를 지우는 메서드가 없다. 지금 있는 것은 `tournament:*:seat`
키를 통째로 지우는 경로뿐이다(`redis.service.ts:380`, 대회 종료용). `hdel` 한 줄짜리
`removeSeatBitmap(tournamentId, tableId)`를 더한다 — `setSeatBitmap` 바로 옆이다.

`tableOrder`는 **재정렬하지 않는다.** 2번을 지우면 1, 3이 남는다. 재정렬하면
전광판과 딜러 화면이 보고 있는 번호가 통째로 바뀌어, 물리 테이블과 화면이
어긋난다. 번호가 비는 것보다 나쁘다.

### 스키마

```prisma
model Table {
  ...
  @@unique([tournamentId, id])
  @@unique([tournamentId, tableOrder])   // 추가
}
```

마이그레이션 하나. 경합을 재시도 코드가 아니라 제약이 막는다 —
`CLAUDE.md`의 "방어 코드보다 구조로 막는다"와 같은 자리다.

### 제거

`payment.service.ts:167-174`의 `cnt === 7` 블록. 좌석 비트맵 갱신(`:167`)과
이벤트 방출(`:175-179`)은 남긴다.

### 에러

| 상황 | 응답 |
|---|---|
| 없는 대회 | 404 (`assertTournamentOwnership`) |
| 남의 대회 | 403 (같음) |
| `FINISHED` 대회 | 409 |
| `dealerSession` 없음 | 409 |
| `tableOrder` 동시 경합 | 409 — P2002를 변환 |
| 삭제 대상이 그 대회 소속이 아님 | 404 |
| 좌석이 찬 테이블 삭제 | 409 |

`dealerSession` 없음은 사실상 `FINISHED`와 겹친다(`completeSession`이 같이 지운다).
그래도 따로 두는 이유는 `!` 단언을 지우는 것이 목적이기 때문이다 — 겹치더라도
터지는 것보다 낫다.

### 막지 않는 것

- **더블클릭으로 테이블이 둘 생기는 것.** 순차 실행이면 `count`가 각각 달라 둘 다
  성공한다. 유니크 제약은 진짜 동시 실행만 잡는다. 멱등키를 넣을 수도 있지만
  상점 콘솔이 버튼을 비활성화하면 되는 문제고, 빈 테이블은 지울 수 있으므로
  되돌릴 수 있다.
- **인원 균형.** 테이블 셋에 열 명이 3/4/3으로 흩어지는 것. 운영으로 푼다. B8.
- **Redis 유실 복구.** `createTable`은 DB 커밋 뒤 Redis를 쓴다. 실패하면 테이블 행은
  있는데 비트맵이 없어 좌석 목록에 뜨지 않는다. **T25가 만드는 문제가 아니다** —
  `buyIn`도(`payment.service.ts:147-167`), `startSession`도(`session.service.ts:225-233`의
  주석이 그 순서를 설명한다) 같은 모양이고, 자동 생성일 때 노출은 오히려 더
  나빴다(Redis 실패가 `joinSessionWithSeat` 전체를 500으로 만드는데 참가자는 이미
  앉아 있고 포인트도 빠져 있다). 수동으로 옮기면 실패 범위가 "테이블 추가 한 번"으로
  줄고, 운영자는 새로고침하거나 다시 누르면 된다. 유실 복구는 B2에서
  `buttonUser`·스냅샷과 함께 본다. 빈 비트맵으로 채우는 반쪽 복구는 앉아 있던
  사람이 사라진 화면을 만들 수 있어 더 위험하다.
- **`payment.service.ts:47-58`의 반쪽 복구** (`totalPlayers === 0`이고 `tables[0]`일
  때만 비트맵을 채우는 코드). 같은 이유로 그대로 둔다.
- **만석 판정.** 백엔드가 새로 할 일이 없다. `buyIn`이 이미 두 겹으로 막는다 —
  `payment.service.ts:91-99`의 좌석 중복 조회와 `@@unique([tableId, seatPosition])`.
  "빈 자리 없음"은 `getSeatStatus`가 주는 비트맵을 화면이 읽어 판정한다.
  B5 명세 / B7 구현 항목이다.

### 테스트

**RED 먼저** — `payment.service.int-spec.ts`에 재현 하나.

> *참가자가 착석해도 테이블 수는 늘지 않는다.*

지금 코드로 일곱 명을 앉히면 테이블이 둘이 되어 빨개진다. 자동 생성 블록을 지우면
초록이 된다.

7 → 탈락 6 → 재착석 7로 빈 테이블이 또 생기는 경로는 자동 생성이 사라지면 자명하게
통과한다. **별도 테스트로 남기지 않는다** — 통과가 보장된 검사를 쌓으면 회귀를 잡는
것이 아니라 실행 시간만 는다. 결함의 내용은 이 문서와 커밋 메시지에 남긴다.

**단위** (`session.service.spec.ts`)

- 남의 대회 403 / 없는 대회 404 / `FINISHED` 409 / `dealerSession` 없음 409
- 삭제: `TablePlayer`가 있으면 409

**통합** (`session.service.int-spec.ts`)

- 추가 → `tableOrder`가 2, 3으로 증가하고 Redis 필드가 생긴다
- `Promise.all`로 동시 추가 2건 → `tableOrder`가 중복되지 않는다.
  **RED 확인**: `@@unique`를 뺀 채 돌려 중복이 실제로 나오는지 본다
- 삭제 → DB 행과 Redis 필드가 **둘 다** 사라진다
- 좌석이 찬 테이블 삭제 → 409고 DB·Redis 어느 쪽도 바뀌지 않는다

**컨트롤러** (`session.controller.spec.ts`)

- 새 두 라우트에 `@Roles(STORE_ADMIN)`이 실제로 붙어 있는지. T24가
  `ws-ticket.controller.spec.ts`에서 쓴 방식과 같다

**깨지지 않는 것**: 시나리오 하네스는 `findFirstOrThrow`로 1번 테이블만 잡고 여섯 명
이하를 앉힌다(`harness.ts:145-159`). 자동 생성을 빼도 영향이 없다.
`payment.service.int-spec.ts:94`의 `createTable` 스텁은 쓰이지 않게 되므로 지운다.

---

## T26 — 딜러 단말 신원 (구현은 나중)

데이터 모델만 정한다. 화면은 B5·B7이다.

### 지금

`DealerSession`이 `tournamentId @unique` + `tokenVersion`이다. 대회당 한 행이고,
OTP 해시는 `Tournament.dealerOtpHash`에 따로 있다. 그래서 두 가지가 성립하지 않는다.

- **로그에서 딜러 단말이 구분되지 않는다.** JWT `sub`가 대회 단위 `DealerSession.id`라
  한 대회의 딜러 셋이 같은 값을 쓴다.
- **한 단말만 끊을 수 없다.** `revokeDealerSession`이 올리는 `tokenVersion`이 대회
  단위라, 딜러 하나를 내보내려는 조작이 실제로는 그 대회 딜러 전원을 끊는다.
  T24가 즉시 소켓 끊기를 뺀 이유가 이것이다.
- **`Table.dealerId`가 정보를 담지 않는다.** 그 대회 모든 테이블이 같은 행을 가리킨다.

### 바꾸는 것

`DealerSession`을 **단말 단위 다중 행**으로 내린다. OTP를 통과할 때마다 행 하나를
만들고, JWT `sub`가 그 행의 id가 된다. `tournamentId`의 `@unique`가 빠진다.

그러면 위 셋이 차례로 풀린다.

- `sub`가 단말을 가리키므로 로그가 구분된다
- `revokeDealerSession`이 행 단위가 되어 **한 단말만** 끊을 수 있다. 즉시 소켓
  끊기가 비로소 의미 있는 조작이 된다
- **`Table.dealerId`를 뗀다.** 단말 단위가 된 세션을 테이블이 가리키면 "이 테이블
  담당 단말"이라는 결합이 생기는데, 이 문서의 도메인 전제(태블릿과 테이블을 결합하지
  않는다)와 정면으로 충돌한다

함께 정리할 이월 항목: `ws.gateway.ts:116` 근처, 예매 경로가 티켓의 `tournamentId`를
쿼리스트링 값으로 덮어쓰는 분기(T24 이월).

### 비용

마이그레이션에 기존 행 이관이 필요하다(대회당 1행 → 대회 0행 + 단말 N행). 그리고
T23·T24가 깐 인증 경로 전부가 재검증 대상이다 — `assertDealerSessionValid`,
`POST /ws/ticket` 발급, `POST /dealer/refresh`, OTP 게이트, 그리고
`dealer.int-spec.ts` / `ws-ticket.int-spec.ts` / `ws.gateway.int-spec.ts`.

T25와 분리하는 이유가 여기 있다.

---

## 범위 밖

| | 어디로 |
|---|---|
| 인원 균형·테이블 통합 | B8 |
| Redis 유실 복구, `buttonUser` 재구성 | B2 |
| 상점 콘솔·좌석 선택 화면 | B5 명세 → B7 구현 |
| REST에 contract 경계 규칙 적용 | B6 |
| 대회 취소와 환불 | 미판단 항목 |
| 전역 레이트 리밋, 대회 단위 잠금에 IP 차원 | T23 이월 |

---

## 관련 문서

| | |
|---|---|
| [`../../backlog.md`](../../backlog.md) | B1·B8 항목, T23·T24 이월 |
| `2026-07-27-frontend-screens-design.md` | 딜러 태블릿 진입 흐름, 좌석 선택. **아직 `main`에 없다** — `GUNW-O-O/front-end` 브랜치에 미머지 상태다 |
| [`2026-07-28-ws-ticket-design.md`](./2026-07-28-ws-ticket-design.md) | T24. 즉시 소켓 끊기를 넘긴 근거 |
| [`../../threat-model.md`](../../threat-model.md) | 관찰 6·7, 질문 Q3·Q4 |
