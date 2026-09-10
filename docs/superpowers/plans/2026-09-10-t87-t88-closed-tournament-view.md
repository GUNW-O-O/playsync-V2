# T87 · T88 — 닫힌 대회를 화면이 따라가지 않는다

대장: `docs/tickets-audit.md`의 T87 · T88. 둘 다 T84의 정산 촬영이 잡았고,
둘 다 **프론트 표시 로직 하나씩**이다. 백엔드는 이미 옳다.

## 무엇이 틀렸나

**T87** — `frontend/src/app/(player)/me/page.tsx`의 `isOver`가 대회 쪽에서
`FINISHED` 하나만 본다. 중단(`abortSession`)·취소(`cancelSession`)는 대회를
`CANCELLED`로 만들고 **참가 행의 `status`는 그대로 둔다**(장부라서 지우지
않는다 — `session.service.ts`의 두 자리 주석). 그래서 환불까지 받은 사람이
「진행 중」 칸에 남는다. 서버는 이미 `isClosedTournament`로 `playerOtp`를
지우므로(`user.service.ts`의 `getMyParticipations`), 그 카드는 OTP 대신
「참가 OTP가 없습니다. 상점에 문의하세요」를 띄운다 — 문의할 것이 없는데도.

**T88** — 콘솔 상세(`ConsoleClient`)의 등록 배지와 평균 스택이 **전광판 값이
없을 때 컬럼으로 떨어진다.** 대회를 닫으면 Redis가 지워져 `dashboard`가
`null`이 되고, 그 폴백이 그대로 발화한다. 배지는 「취소」 옆에 「등록 열림」,
지표는 나머지가 전부 `-`인데 평균 스택만 `5,000`(`tournament.startStack`)이다.
폴백 자체는 T77이 일부러 넣은 것이라 **지우지 않는다** — 시작 전 대회에는
파생할 재료가 없다. 닫힌 대회에서만 끈다.

## Global Constraints

- **실패를 먼저 본다.** 검사마다 빨간불을 확인한 출력이 보고서에 있어야 한다.
  제품 코드를 먼저 고쳤다면 되돌리고 다시 시작한다.
- **`docs/`와 `CLAUDE.md`는 건드리지 않는다.** 티켓 상태와 기준선은 메인이
  PR 번호를 받은 뒤에 얹는다. 주석은 예외다 — 주석은 코드다.
- **닫힌 상태 목록을 손으로 복사하지 않는다.** `@playsync/contract`의
  `ClosedTournamentStatusSchema`(`options`가 `["FINISHED", "CANCELLED"]`)를
  읽는다. 프론트가 contract를 import하는 것은 이 리포의 규칙이고, 상태가
  하나 늘 때 두 화면이 같이 따라간다.
- 주석과 문서는 **줄 번호가 아니라 이름**으로 코드를 가리킨다.
- 커밋 메시지는 한국어. 기존 커밋의 어투를 따른다.
- 끝나기 전에 루트에서 `npm run typecheck`와 `npm test`가 통과해야 한다.

## Task 1 — 두 화면이 닫힌 대회를 알아보게 한다

한 태스크다. 파일 둘, 각각 조건 한 줄과 그 회귀다.

### 1-a. `/me`가 닫힌 대회를 「지난 참가」로 보낸다

파일: `frontend/src/app/(player)/me/page.tsx` ·
`frontend/src/app/(player)/me/page.test.tsx`

먼저 `page.test.tsx`에 검사 둘을 넣고 **빨간불을 본다.**

1. `중단된 대회는 「지난 참가」로 간다` — 참가 행 하나를 먹인다.
   기존 `ONGOING` 픽스처를 본떠 `status: 'PLAYING'`, `finalPlace: null`,
   `prizeAmount: 0`, `playerOtp: null`(서버가 `isClosedTournament`로 이미
   지운다), `tournament.status: 'CANCELLED'`. 단언은 셋이다 —
   「지난 참가」가 있고, 「진행 중」 머리글이 없고,
   「참가 OTP가 없습니다. 상점에 문의하세요」가 없다.
2. `중단된 대회는 「탈락」이 아니라 「중단」으로 적는다` — 같은 행에서
   「중단」이 뜨고 「탈락」이 안 뜬다.

그다음 제품을 고친다.

- `isOver`의 대회 쪽 조건을 `ClosedTournamentStatusSchema.options`에 드는지로
  바꾼다. 참가 쪽 조건(`ELIMINATED` · `AWARDED`)은 그대로 둔다 — 대회가 도는
  중의 탈락을 잡는 것이 그 둘이고, 그 뜻은 기존 검사
  (`대회가 도는 중에 탈락했으면 OTP가 아니라 순위가 남는다`)가 지킨다.
- 「지난 참가」 목록에서 `finalPlace === null`이면 지금 「탈락」을 적는데,
  중단된 대회의 참가자는 탈락한 것이 아니라 **환불을 받았다.** 대회가
  닫힌 쪽이 `CANCELLED`면 「중단」을 적는다.
- `isOver` 위 주석에 **왜 대회 쪽을 목록으로 안 적었는지**를 한 줄 남긴다
  (상태가 늘면 조용히 빠진다 — `tournament-status.ts`가 같은 이유로 있다).

### 1-b. 닫힌 대회의 콘솔 배지와 평균 스택

파일:
`frontend/src/app/(console)/stores/[storeId]/tournaments/[tournamentId]/ConsoleClient.tsx` ·
같은 폴더의 `ConsoleClient.test.tsx`

먼저 `ConsoleClient.test.tsx`의 `등록 마감` describe에 검사 둘을 넣고
**빨간불을 본다.** 둘 다 `tournament`를
`{ ...TOURNAMENT, status: 'CANCELLED', isRegistrationOpen: true }`로,
`dashboard`는 `null`로 그린다(닫으면 Redis가 지워져 실제로 `null`이 온다).

1. `닫힌 대회는 컬럼이 열려 있어도 「등록 마감」이다` — 「등록 마감」이 뜨고
   「등록 열림」이 없다.
2. `닫힌 대회는 평균 스택도 값이 남지 않는다` — 「평균 스택」 칸의 값이
   `-`이고, 화면 어디에도 `5,000`이 없다.

그다음 제품을 고친다.

- 닫힘 판정을 `ClosedTournamentStatusSchema`로 한 번 만들고 두 자리가 쓴다.
- 배지: 닫힌 대회면 전광판 값도 컬럼도 보지 않고 「등록 마감」이다.
- 평균 스택: `numbers`가 없고 대회가 닫혔으면 다른 지표와 같은 `-`.
  **닫히지 않은 대회의 `startStack` 폴백은 그대로 둔다** — 기존 검사
  `전광판 값이 없으면 컬럼을 그대로 쓴다`(시작 전 대회)가 계속 초록이어야
  한다.
- 폴백을 끄는 이유를 그 자리에 한 줄로 남긴다. 폴백 자체가 T77의 답이라,
  왜 여기서만 끄는지가 없으면 다음 사람이 폴백을 통째로 지운다.

### 검증

루트에서 돌린다.

```
npm run typecheck
npm test
```

프론트 단위가 210에서 214로 는다(검사 넷). 다른 검사는 하나도 안 깨진다.
