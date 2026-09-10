# T89 — 취소된 대회의 상세 화면이 참가를 열어 둔다

대장: `docs/tickets-audit.md`의 T89. T87·T88의 최종 리뷰가 잡았다. 같은 결함이
참가자 쪽에 하나 더 남아 있었다.

## 무엇이 틀렸나

`frontend/src/app/(player)/tournaments/[id]/page.tsx`가 닫힘을
`!isRegistrationOpen || status === 'FINISHED'`로 판정한다. 취소된 대회는 그
둘 중 어디에도 안 걸린다 — `getTournamentInfo`는 상태로 거르지 않고,
`abortSession`·`cancelSession`은 **등록 컬럼을 flip하지 않는다**(flip하는 자리는
`closeRegistration` 하나다). 그래서 **취소된 대회가 초록 「등록 열림」으로 뜨고
`JoinPanel`이 `disabled={false}`로 그려진다.**

돈은 `PaymentService.joinSession`의 `isClosedTournament`가 막는다. 사고가 아니라
**거짓 화면**이다 — 누르면 거절당하는 버튼을 참가자에게 내주고 있다.

대회 목록(`(player)/tournaments/page.tsx`)에도 같은 리터럴이 있다. 이쪽은
`getStoreAvailableSessions`가 닫힌 대회를 걸러 **지금은 도달 불가**지만, 리터럴이
남아 있는 한 그 조회가 바뀌는 날 같은 결함이 된다.

## Global Constraints

- **실패를 먼저 본다.** 검사마다 빨간불을 확인한 출력이 보고서에 있어야 한다.
- **닫힌 상태 목록을 손으로 적지 않는다.** `@playsync/contract`의
  `ClosedTournamentStatusSchema`를 읽는다. T87·T88이 두 화면에 그 길을 냈고
  (`me/page.tsx` · `ConsoleClient.tsx`), 백엔드 목록과 어긋나지 않는지 보는
  검사도 이미 있다(`tournament-status.spec.ts`).
- **`docs/`와 `CLAUDE.md`는 건드리지 않는다.** 주석은 예외다.
- 주석은 **줄 번호가 아니라 이름**으로 코드를 가리킨다.
- 커밋 메시지는 한국어.
- 루트에서 `npm run typecheck`와 `npm test`가 통과해야 한다.

## Task 1 — 참가자 화면이 닫힌 대회를 알아본다

### 1-a. 대회 상세

파일: `frontend/src/app/(player)/tournaments/[id]/page.tsx` ·
같은 폴더에 **새로 만드는** `page.test.tsx`

이 화면에는 지금 검사가 하나도 없다. `JoinPanel.test.tsx`는 패널만 본다.
새 파일의 배선은 `(player)/me/page.test.tsx`를 본뜬다 — msw로
`GET /tournaments/:id` 봉투를 돌려주고, 서버 컴포넌트를 직접 `render`한다.
**봉투를 벗기는 자리가 있다**(`{ tournament }`) — 지어내지 말고 그 모양대로 준다.

먼저 검사 셋을 넣고 **빨간불을 본다.**

1. `취소된 대회는 참가 버튼이 죽어 있다` — 상태 `CANCELLED`, `isRegistrationOpen`
   `true`. 참가 버튼이 `disabled`다.
2. `취소된 대회는 「취소된 대회」로 적는다` — 같은 대회에서 「등록 열림」이 없다.
3. `등록이 열린 대회는 참가 버튼이 살아 있다` — 상태 `PENDING`,
   `isRegistrationOpen` `true`. 버튼이 `disabled`가 아니고 「등록 열림」이 뜬다.
   **셋째가 있어야 첫 둘이 증명된다** — 닫는 쪽만 검사하면 판정을 항상 참으로
   접어도 초록이다(T29).

그다음 제품을 고친다.

- `closed`를 `!isRegistrationOpen || 닫힌 상태인가`로 바꾼다. 판정은
  `ClosedTournamentStatusSchema`로 한다.
- **상태 문구를 셋으로 가른다.** 지금은 「등록 열림」과 「등록 마감」 둘인데,
  취소된 대회에 「등록 마감」을 적으면 "등록만 닫혔고 대회는 돈다"로 읽힌다.
  `CANCELLED`는 「취소된 대회」, `FINISHED`는 「종료된 대회」, 나머지는 지금 그대로
  「등록 열림」/「등록 마감」이다. 색은 지금 규칙을 따른다 — 열린 것만 `--ok`고
  나머지는 `--ink-subtle`이다.
- 왜 컬럼만으로는 안 되는지를 한 줄로 남긴다. 중단·취소가 등록 컬럼을 flip하지
  않는다는 사실이 이 결함의 원인이고, 그것이 안 적혀 있으면 다음 사람이 판정을
  컬럼 하나로 되돌린다.

### 1-b. 대회 목록의 같은 리터럴

파일: `frontend/src/app/(player)/tournaments/page.tsx` ·
같은 폴더에 **새로 만드는** `page.test.tsx`

`open` 판정의 `t.status !== 'FINISHED'`를 같은 스키마 판정으로 바꾼다.
**지금은 도달 불가라는 사실을 지우지 않는다** — 기존 주석이
`getStoreAvailableSessions`가 걸러 준다고 적고 있다. 그 주석 옆에, 그럼에도
리터럴을 남기지 않는 이유(조회가 바뀌는 날 같은 결함이 된다)를 붙인다.

검사 둘을 먼저 넣고 빨간불을 본다.

1. `닫힌 대회가 목록에 오면 열림으로 그리지 않는다` — 조회를 목으로 바꿔
   `CANCELLED` 대회를 하나 흘려 넣는다.
2. `열린 대회는 열림으로 그린다` — 같은 이유로 반대쪽을 고정한다.

### 검증

루트에서 `npm run typecheck`와 `npm test`. 프론트 단위가 215에서 220으로 는다
(검사 다섯). 다른 검사는 하나도 안 깨진다.
