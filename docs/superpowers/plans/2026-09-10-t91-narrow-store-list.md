# T91 — 참가자 대회 목록이 행을 통째로 내보낸다

대장: `docs/tickets-audit.md`의 T91. T90의 최종 리뷰가 잡았다. **기존 결함이고
T90이 만든 것이 아니다** — T90은 그 조회를 열어 조인을 붙였지만 응답에는 안 실었다.

## 무엇이 틀렸나

`PaymentService.getStoreAvailableSessions`가 `select` 없는 `findMany`라 대회 행의
스칼라를 전부 싣는다 — `payoutTable` · `pausedMs` · `blindId` · `avgStack` ·
`totalBuyinAmount` · `finishedAt` 따위가 **가드 없는 공개 라우트**로 나간다.
`dealerOtpHash`는 `PrismaService`의 전역 `omit`이 막지만, 그 그물은 해시 하나짜리다.

같은 파일의 `getTournamentInfo`가 이미 답을 들고 있다. 화면이 실제로 읽는 필드만
`select`하고, 왜 그런지를 주석에 적어 뒀다(T66). 같은 모양으로 좁힌다.

## 누가 이 라우트를 읽나

**계획을 쓰기 전에 프론트의 `fetch` 호출로 확인했다** — T90에서 화면-라우트
대응을 확인 없이 단정했다가 브랜치를 중간에 늘렸다. 소비자는 셋이다.

| 화면 | 파일 | 읽는 필드 |
|---|---|---|
| 참가자 대회 목록 | `(player)/tournaments/page.tsx` | `id` · `name` · `status` · `isRegistrationOpen` · `entryFee` · `startStack` · `totalPlayers` |
| 딜러 대기 | `(terminal)/dealer/page.tsx` → `DealerWaitingClient` | `id` · `name` · `status` |
| 좌석 대기 | `(terminal)/table/page.tsx` → `WaitingClient` | `id` · `name` · `status` |

합집합이 일곱이다. e2e(`terminal.spec.ts` · `console.spec.ts`)는 이 라우트를
직접 단언하지 않고 화면에 그려진 것만 본다.

## Global Constraints

- **실패를 먼저 본다.**
- **`select`가 파생의 재료까지 덮어야 한다.** T90이 이 조회에 `isRegistrationOpenNow`
  판정을 얹었고 그 함수는 `startedAt` · `pausedMs` · `rebuyUntil` ·
  `blindStructure.structure`를 쓴다. 재료는 select하되 **응답에 실리기 전에 떼어
  낸다** — 지금 `blindStructure`를 떼는 것과 같은 자리, 같은 방식이다.
- **판정 로직을 건드리지 않는다.** T90이 세운 파생·마감 흐름은 그대로다. 이 티켓은
  나가는 필드만 줄인다.
- **`docs/`와 `CLAUDE.md`는 건드리지 않는다.** 주석은 예외다.
- 주석은 **줄 번호가 아니라 이름**으로 가리킨다. 커밋 메시지는 한국어.
- 루트에서 `npm run typecheck` · `npm test` · `npm run test:int`가 통과해야 한다.
  **통합을 돈다** — 백엔드 응답이 바뀐다.

## Task 1 — 나가는 필드를 화면이 읽는 것으로 좁힌다

파일: `backend/src/payment/payment.service.ts` ·
`backend/src/payment/payment.service.int-spec.ts` ·
`frontend/src/app/(player)/tournaments/page.tsx`(주석만)

먼저 통합 검사를 넣고 **빨간불을 본다.**

1. `목록 조회는 화면이 읽는 필드만 내보낸다` — 응답 행의 **키 집합**을 통째로
   단언한다. 위 표의 일곱과 정확히 같아야 한다. 「없어야 할 키가 없다」를 몇 개
   집어서 부정 단언하지 않는다 — 그 방식은 **다음에 늘어나는 필드를 못 잡는다.**
   키 집합을 통째로 비교해야 스키마에 컬럼이 붙는 날 이 검사가 운다.
2. `블라인드 구조는 판정에만 쓰고 내보내지 않는다` — T90의 조인이 응답에 새지
   않는 것을 그 검사 안에서 같이 못 박는다(1번의 키 집합이 이미 잡지만, 이
   항목은 **의도**라 이름으로 남을 값이 있다). 1번과 합쳐도 된다 — 합친다면
   검사 이름이 둘 다를 말하게 적는다.

그다음 제품을 고친다.

- `findMany`에 `select`를 명시한다. 화면이 읽는 일곱 + 파생의 재료
  (`startedAt` · `pausedMs` · `rebuyUntil` · `blindStructure: { select: { structure: true } }`).
  `rebuyUntil`은 재료이면서 화면은 안 읽는다 — 떼어 내는 쪽이다.
- 응답을 만들 때 **재료를 떼어 낸다.** 지금 `blindStructure`를 떼는 그 자리에
  나머지도 함께 떼면 된다.
- 주석에 **누가 이 라우트를 읽는지**를 남긴다. 위 표의 세 화면을 이름으로 적는다 —
  다음에 필드를 줄이거나 늘리는 사람이 프론트를 다시 뒤지지 않게. `getTournamentInfo`의
  주석이 같은 일을 하고 있으니 어투를 맞춘다.
- 프론트 `page.tsx`의 타입 주석이 「`dealerOtpHash`를 `omit`한 `Tournament` 행」이라
  적고 있다. 이제 좁힌 `select`다. 사실에 맞게 고친다.

### 검증

루트에서 `npm run typecheck` · `npm test` · `npm run test:int`. 통합이 607에서
늘어난다(검사 하나 또는 둘). 실측 숫자를 보고서에 적는다.
