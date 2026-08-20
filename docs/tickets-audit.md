# Playsync V2 전수검사 티켓 (T58~)

> **코드만 읽어서 만든 목록이다.** 2026-08-19에 `backend/src` · `frontend/src` ·
> `packages/contract` · `backend/prisma`를 문서 없이 전수로 훑고, 그중
> **재현했거나 코드 경로를 끝까지 추적한 것**만 남겼다.
>
> 이 문서는 [`backlog.md`](./backlog.md)와 같은 자리다 — **아직 착수하지 않은
> 것**이 여기 있다. 착수해도 옮겨 적지 않는다. 우선순위 표의 **상태 열이 그대로
> 진행 현황**이고(`대기` → `완료 (#PR)`), 계획과 설계는
> `docs/superpowers/plans/`·`specs/`에, 판단 과정은 `chat-log`에, 바뀐 규칙은
> [`domain.md`](./domain.md)에 간다. 자세한 배치는 `CLAUDE.md`의
> 「티켓을 어디에 기록하나」.
>
> 백로그와 갈라 두는 이유: `backlog.md`는 **하기로 정한 방향**(B1~B11)이고
> 여기 있는 것은 **이미 깨져 있는 것**이다. 방향과 결함을 한 표에 섞으면
> "안 하기로 한 것"의 근거가 결함 목록에 묻힌다.
>
> 좌표는 **이름으로 적는다**(CLAUDE.md의 작업 규칙). 줄 번호를 쓰지 않는 이유는
> 이 문서가 기록물이 아니라 **살아 있는 할 일 목록**이라서다 — 고칠 때까지
> 코드를 따라와야 한다.

## 이 목록이 기존 테스트에 안 걸린다

검사 시점의 기준선을 먼저 실행해 확인했다.

```
contract       62  (4 suites)   전부 통과
백엔드 단위   208  (21 suites)  전부 통과
프론트 단위   117  (26 files)   전부 통과
```

**전부 초록인 상태에서 나온 목록이다.** 통합·e2e는 Docker가 없어 못 돌렸으므로
그쪽이 잡고 있을 가능성은 각 티켓의 "기존 테스트가 왜 못 잡나"에 적었다.

## 우선순위

`backlog.md`와 같은 기준(커플링 → 의존성 → 심각도)에 하나를 더 얹는다:
**되돌릴 근거가 없는 것 먼저.** 카드가 실물이라 잘못 나간 칩과 상금은 테이블
위에 되돌릴 근거가 남지 않는다(`domain.md`). 그래서 돈과 칩이 맨 앞이고,
화면 결함이 뒤다.

**표의 순서가 곧 아래 절의 순서이고, 그것이 작업 순서다.** 번호순으로 쌓지 않는
이유는 `backlog.md`에서 겪었다 — 거기는 T22~T37 오름차순 뒤에 T57~T38 내림차순이 붙어,
어느 것이 다음인지 문서를 읽어서는 알 수 없게 됐다.

**"기다리는 것"이 같은 줄끼리는 동시에 돌린다.** 만지는 파일이 겹치지 않는다는 뜻이다.

| # | 티켓 | 무엇이 깨지나 | 등급 | 기다리는 것 | 상태 |
|---|---|---|---|---|---|
| T64 | 대회 입력이 검증을 지나가지 않는다 | 포인트가 찍히고 전광판이 멎는다 | 높음 | — | **완료 (#60)** |
| T58 | 앤티가 사이드팟에 담기지 않고 화면에도 없다 | 칩이 증발하고 참가자가 모른다 | 치명 | T64 | 대기 |
| T60 | 인원수가 DB와 Redis에서 갈라진다 | 최후 1인 판정과 등수가 통째로 틀어진다 | 치명 | T64 | 대기 |
| T66 | 가드 없는 읽기 경로 | 남의 대회·상점이 그대로 나간다 | 높음 | T64 | 대기 |
| T70 | 콘솔 좌석 선택이 새로 그린 판을 따라간다 | 엉뚱한 사람이 좌석에서 빠진다 | 중간 | T64 | 대기 |
| T68 | 레이즈 입력이 낼 수 있는 금액과 어긋난다 | 합법적인 레이즈 불가 / 조용한 올인 | 중간 | T58 | 대기 |
| T59 | 동시 파산의 등수와 상금 | 상금이 두 번 나가고 대회가 안 닫힌다 | 치명 | T60 | 대기 |
| T67 | 좌석 태블릿이 실패를 삼킨다 | 참가자가 모르는 채로 탈락한다 | 높음 | T70 | 대기 |
| T61 | 시작 준비가 락 없이 스냅샷을 덮어쓴다 | 방금 앉은 사람이 게임에서 사라진다 | 치명 | T64 | 대기 |
| T62 | 체크포인트 재시도가 던지면 테이블이 갇힌다 | 어떤 조작으로도 다음 핸드로 못 간다 | 높음 | T59 | 대기 |
| T63 | 휴식 레벨이 등록을 영구히 닫는다 | 리바인이 예정보다 일찍 죽는다 | 높음 | T64 | 대기 |
| T71 | 계약·스키마의 드리프트 | 아직 증상 없음. 다음 필드에서 터진다 | 낮음 | T64 | 대기 |
| T65 | 비턴 액션이 현재 턴의 타이머를 리셋한다 | 제한시간을 무한히 늘릴 수 있다 | 높음 | T62 · T71 | 대기 |
| T69 | 체크포인트 실패의 탈출구가 화면에 없다 | 멈춘 테이블에서 나올 길이 없다 | 중간 | T62 · T71 | 대기 |
| T72 | 목업 결제와 실패 경로 | 부하가 거절을 한 번도 안 밟았다 | 중간 | T66 | 대기 |

아래 **잔여 목록**은 티켓을 따로 세우지 않은 것들이다. 가까운 티켓에 묻어 간다.

## 무엇을 기다리는가

**파일이 아니라 함수로 갈랐다.** `redis.service.ts`를 넷이 만지지만 T60은
`eliminatedPlayer`·`seatPlayer`·`joinPlayer`, T61은 `saveInitialTableSnapshots`·
`mutateSnapshot` 계열, T63은 `checkAndSyncBlindLevel`, T64는 `recalculateAvgStack`이라
서로 안 닿는다. 파일 이름만 보고 직렬화하면 넷을 한 줄로 세우게 된다.

| 기다림 | 왜 |
|---|---|
| T58 · T60 · T66 · T70 → T64 | T64가 `session.controller`·`session.service`·`shared/dto`·`util`·`redis`·`schema.prisma`를 건드려 뒤의 거의 전부와 닿는다. 그리고 T58의 앤티 정수 보장은 `BlindLevelDto`가 **한 번도 실행되지 않았다**는 사실(6-1) 위에 있었다 |
| T68 → T58 | 같은 `table-engine.ts`. T58은 `payAnte`·`executeBet`, T68은 `handleRaise` |
| T59 → T60 | 카운터가 맞아야 등수가 뜻을 갖는다. `eliminatedRank`가 `tournamentInfo.activePlayer`다 |
| T61 → T64 | 같은 `session.service.ts` |
| T62 → T59 | 같은 `playsync.service.ts` |
| T63 · T71 → T64 | T63은 구조 검증안을 고른 경우, T71은 같은 마이그레이션 |
| T65 → T62 · T71 | `playsync.service`(T62)와 `ws.gateway`(T71)를 둘 다 만진다 |
| T69 → T62 · T71 | 탈출구가 실제로 열려 있어야 하고(T62), 타입은 T71이 연다 |
| T72 → T66 | 충전 라우트가 `payment.controller.ts`에 붙는데 T66이 같은 파일의 가드를 정리한다. **포인트를 늘리는 라우트를 가드가 정리되기 전 컨트롤러에 붙이지 않는다** |

**T71을 T69보다 앞에 두는 이유.** `contract`의 `TableStateSchema`에 `dbSyncStatus`가
**이미 있다.** T71 9-2로 프론트가 손 복사본을 버리고 contract를 import하면 T69의 타입
구멍이 같이 닫힌다 — 반대 순서면 `types/game.ts`에 필드를 손으로 더해 드리프트를 한 번
더 만든다.

## 착수 전에 사람이 정해야 하는 것

코드가 아니라 규칙이 없는 자리다. 정하지 않으면 그 티켓이 멈춘다.

| 무엇 | 어디 | 정한 것 |
|---|---|---|
| `entryFee: 0`을 허용할 것인가 | T64 6-3 | **막는다**(`@Min(1)`). 2026-08-20 |
| 앤티 금액의 정수 보장 | T58 | **`sb`에 5의 배수 강제**. 전원 앤티는 유지한다. 2026-08-20 |
| 동시 파산의 등수 기준 | T59 | 미정. 핸드 시작 스택이면 `resolveWinners`가 그 값을 들고 나와야 한다 |
| 휴식을 별도 필드로 뺄 것인가 | T63 | 미정. 계약 변경이면 프론트·시드·복구가 함께 움직인다 |
| 목업 결제의 실패율과 실패 시 봇 행동 | T72 | 미정. 부하 모양을 바꾼다 |

---

## T64 — 대회 입력이 검증을 지나가지 않는다

**등급**: 높음 · **범위**: `store/session/session.controller.ts`, `store/session/session.service.ts`, `shared/dto/`, `shared/util/util.ts`, `redis/redis.service.ts`, `prisma/schema.prisma` · **프론트 영향**: 없음

여섯 개를 한 티켓으로 묶는다. 전부 **"경계에서 안 본 값이 한참 뒤에 터진다"**는
같은 모양이고, 고치는 자리(DTO와 그 DTO를 실제로 태우는 시그니처)가 겹친다.

### 6-1. 블라인드 구조가 검증을 통째로 우회한다 (확실)

`SessionController.create`가 블라인드 구조를 `any`로 받는다.

```ts
@Body('blindStructure') blindStructure?: any,
```

전역 `ValidationPipe`는 **파라미터의 메타타입**으로 검증할 DTO를 고른다. `any`면
고를 것이 없어 `CreateBlindStructureDto`와 `BlindLevelDto`의 규칙(`sb >= 100`,
`duration >= 10`, `ante`가 boolean …)이 **하나도 안 돈다.** 같은 핸들러의
`@Body('dto') dto: CreateTournamentDto`는 정상 검증된다 — **한 핸들러 안에서
한쪽만 뚫려 있다.**

**증거가 리포 안에 있다.** `CreateBlindStructureDto`를 받는 라우트가 하나도 없고
(`createBlind` 서비스 메서드에 컨트롤러가 없다), 그래서 `seed.ts`의
`BLIND_STRUCTURE`는 `duration`이 2~3분이라 그 DTO의 `@Min(10)`을 **정면으로
위반한다.** 아무도 알아채지 못했다.

### 6-2. 빈 블라인드 구조가 터진다 (확실)

`getCurrentBlindLevel`이 모든 레벨을 지난 경우 `structure[structure.length - 1]`을
읽는다. 배열이 비면 `structure[-1]`이라 `undefined.lv`다.

```
TypeError: Cannot read properties of undefined (reading 'lv')
  at getCurrentBlindLevel (shared/util/util.ts)
```

도달 경로가 둘. 6-1로 아무 값이나 들어오는 것, 그리고 정상 DTO로도 `@IsArray()`에
`@ArrayNotEmpty()`가 없어 `[]`이 통과하는 것(`parseBlindStructure`도 빈 배열을
통과시킨다). 터지는 자리는 **대회 시작**(`initializeGame` → `buildTournamentMeta`)
이다 — 참가자가 다 앉은 뒤에 500이 난다.

### 6-3. `entryFee: 0`이 전광판을 영구히 멎게 하고 무한 무료 리바인을 연다 (확실)

`CreateTournamentDto.entryFee`가 `@Min(0)`이라 0이 통과한다.
`RedisService.recalculateAvgStack`이 그 값으로 나눈다.

```ts
const totalChips = (parseInt(totalBuyin || '0') / entryFee) * startStack;
```

`0 / 0 = NaN` → `hset`으로 `"NaN"` 저장 → `getFullTournamentInfo`의
`parseInt('NaN')` → `NaN`. 전선에는 `JSON.stringify(NaN) === 'null'`이라 `null`이
나가고, contract의 `DashboardSchema.avgStack = z.int().min(0)`가 `safeParse`에서
거부한다. `DisplayClient`는 `if (!parsed.success) return;`이라 **"대기 중"에
영구히 머문다** — 전광판이 통째로 죽는다. 상점 콘솔은 인원·프라이즈풀이 `-`,
평균 스택이 `startStack`으로 대체되는 **부분 열화**다.

**`seed-load.ts`가 실제로 `entryFee: 0`을 쓴다** — 부하 무대 전체가 이 경로다.

같은 원인으로 하나 더: `PlaysyncService.processRebuy`의 `userPoints.points <
entryFee` 게이트가 항상 통과해 파산자가 **무한 무료 리바인**으로 `startStack`을
계속 받는다. 칩 총량이 바이인 수와 무관해지는데 돈은 0이라 `completeSession`의
회계 게이트가 아무것도 못 잡는다.

### 6-4. `UpdateTournamentDto`에만 하한이 없어 포인트를 찍어낼 수 있다 (확실)

```ts
@IsInt() @IsOptional() startStack?: number;   // create 쪽에는 @Min(0)이 있다
@IsInt() @IsOptional() entryFee?: number;
@IsInt() @IsOptional() rebuyUntil?: number;
```

`SessionService.updateSession`은 이 셋을 그대로 `updateData`에 실어
`tournament.update`한다(분배율만 `parsePayouts`로 검증한다).

`PATCH /store/sessions/:id`에 `{ "entryFee": -50000 }`(자기 대회라 소유권 검사는
통과) → `PaymentService.joinSession`이 DB에서 그 값을 읽는다 → `user.points <
-50000` 통과 → `UserService.paymentPoint`의 `points: { decrement: -50000 }`이
**포인트를 찍어낸다.** `PointTransaction`에는 `BUY_IN` 타입에 `+50000`이 기록되고
`totalBuyinAmount`는 음수가 된다. `@@unique([tournamentId, userId])` 때문에 대회당
1회지만 대회를 여러 개 만들면 배수다. 음수 `startStack`은 `currentStack`을 음수로
만들어 칩 보존을 깬다.

**같은 메서드에 하나 더.** `updateSession`은 `isClosedTournament`만 막으므로
**진행 중(ONGOING) 대회의 `entryFee`도 바꿀 수 있다.** `recalculateAvgStack`이
`totalBuyinAmount / entryFee`로 바이인 횟수를 역산하고 `cancelSession`이
`참가자 수 × entryFee === totalBuyinAmount`를 요구하므로, 값을 한 번 바꾸면 그
대회는 **취소도 종료도 불가능한 상태로 굳는다.**

### 6-5. `updateSession`이 `blindId`를 검증하지 않는다 (확실)

`createSession`은 `blindStructure.findUnique` → `blind.storeId !== dto.storeId`면
403으로 막는다. `updateSession`은 `updateData.blindId = dto.blindId`를 그대로
쓴다.

- 남의 상점 구조 id → 그대로 저장된다. 그 대회가 **다른 테넌트의 블라인드 구조로
  돌고**, 가드 없는 `GET /playsync/dashboard/:id`가 `blindField.blindStructure`
  전체를 공개한다(T66과 겹친다).
- 없는 id → 외래키 위반(P2003). 리포에 예외 필터가 하나도 없어 그대로 **500**이
  나간다.

### 6-6. `BlindStructure.name`이 전역 유니크라 대회 생성이 500으로 죽는다 (확실)

`schema.prisma`의 `BlindStructure.name String @unique`가 **상점 스코프가 아니라
전역**이다. `createSession`의 `blindStructure.create`는 트랜잭션 밖이고 P2002를
잡는 코드가 없다.

두 상점이 각각 `"주말 딥스택"`이라는 이름을 쓰면 두 번째 상점의
`POST /store/sessions`가 **500**이다. 응답 차이로 다른 상점이 어떤 이름을 쓰는지
떠볼 수도 있다. `seed-load.ts`가 상점마다 이름에 인덱스를 붙이며 **이미 이 사실에
부딪혔다.** `Store.name @unique`도 같은 모양이지만 상점 생성 라우트가 지금
없어서 드러나지 않는다.

### 할 일

- `@Body('blindStructure')`에 타입을 준다. 지금 `any`인 이유가 "Prisma Json
  대응"이면 그건 **저장 타입의 문제지 입력 타입의 문제가 아니다.**
- 블라인드 구조에 최소 길이를 건다. **`getCurrentBlindLevel`에도 방어를 둘지는
  따로 판단한다** — 이 리포는 "방어 코드보다 구조로 막는다"가 규칙이라, 입구가
  막히면 그쪽은 안 두는 쪽이 일관된다.
- `UpdateTournamentDto`를 `CreateTournamentDto`와 같은 하한으로 맞춘다.
  **두 DTO가 갈라진 것 자체**가 원인이므로, 한쪽에서 파생시킬 수 있는지 본다.
- `updateSession`의 `blindId` 검증을 `createSession`과 **같은 함수**로 뽑는다.
- `entryFee: 0`을 허용할지 정한다. 허용한다면 `recalculateAvgStack`이 참가비가
  아니라 **참가 건수**로 총 칩을 세야 한다(지금 식은 나눗셈으로 건수를
  역산한다). 허용하지 않는다면 `@Min(1)` 한 줄인데, **`seed-load.ts`가 그 값에
  의존하므로 부하 무대가 함께 움직인다.**
- `BlindStructure.name` · `Store.name`의 유니크를 상점 스코프로 좁힌다
  (마이그레이션).

---

## T58 — 앤티가 사이드팟에 담기지 않는다

**등급**: 치명 (칩 보존 위반) · **범위**: `game-engine/table-engine.ts`, `shared/dto/blind-structure.dto.ts`, `src/scenario/`, `component/felt/`, `(board)/.../display/` · **프론트 영향**: **있음**(앤티가 화면에 없다)

### 문제

`TableEngine`의 `payAnte`가 칩을 옮기는 **유일한 지점**인 `executeBet`을 거치지
않는다. 스택에서 빼고 `state.pot`에만 더한 뒤 `totalContributed`를 안 올린다.

사이드팟은 `calculateSidePots`가 **`totalContributed`만 보고** 만든다. 앤티로
들어온 칩은 어느 층에도 안 담기고, `resolveWinner`가 마지막에 `state.pot = 0`으로
지우는 순간 사라진다. 3인 · `smallBlind 100` · `ante: true` 한 핸드 실측:

```
블라인드 직후  pot 360, totalContributed [200, 0, 100]   ← 앤티 60이 어디에도 없다
쇼다운         pot 660, 사이드팟 합 600                   ← 60 차이
정산 후        테이블 위 총 칩 29940 (시작 30000)
```

`executeBet`의 주석이 "칩이 스택에서 팟으로 옮겨 가는 **유일한 지점**"이라고
적는데, `payAnte`가 그 문장의 반례다.

**두 번째 결함이 같은 함수에 있다.** 앤티가 `smallBlind / 5`인데 `sb`가 5의
배수라는 보장이 없다(`BlindLevelDto`는 `@IsInt() @Min(100)`뿐이고, 그나마도
T64의 이유로 실행되지 않는다). `sb: 101`이면 앤티가 20.2가 되어 **스택과 팟이
소수가 된다.** 그 뒤 `PlaysyncService.syncTableInventoryToDb`가 소수
`currentStack`을 `Int` 컬럼에 쓰려다 실패하고 → `dbSyncStatus: 'FAILED'` →
`retryCheckpoint`가 같은 값을 다시 써서 또 실패 → **그 테이블은 `HAND_END`에서
못 나온다**(T62와 같은 막다른 곳).

### 기존 테스트가 왜 못 잡나

**불변식은 이미 있다.** `src/scenario/harness.ts`의 `checkInvariants` 검사 2가
"사이드팟 총액은 팟과 일치한다"를 본다. 그런데 **`ante: true`인 시나리오가 하나도
없다** — 리포에서 `ante: true`가 나오는 곳은 `table-engine.spec.ts`의 두 케이스와
`recovery.service.int-spec.ts` 하나뿐이다. 그중 "칩 총량이 보존된다"가 초록인
이유는 `totalChips`가 `스택 합 + pot`이라 **팟 안에 있는 동안은 증발이 안
보이기** 때문이다. 사라지는 것은 `resolveWinner`가 `pot`을 0으로 만드는 순간이다.

검사가 둘이면 **둘이 어긋나는 입력**이 있어야 각각이 증명된다(T29에서 데인 자리).
여기서 그 입력이 `ante: true`다.

### 세 번째 결함 — 앤티가 화면에 없다

```
grep -rn "ante" frontend/src  →  테스트 파일 다섯과 타입 선언 둘. 렌더하는 곳 0건
```

계약은 값을 싣는다(`BlindLevelSchema.ante` · `TableStateSchema.ante`). **데이터는
도착하는데 `Felt`도 `DisplayClient`도 안 그린다.**

미관 문제가 아니다. 칩이 디지털이고 화면이 유일한 장부인데, **매 핸드 스택에서 돈이
빠지면서 왜 빠졌는지 화면에 없다.** 참가자가 확인할 방법이 없고, 딜러도 이 대회에
앤티가 붙는지 화면으로는 모른다.

그리고 `ante`가 전부 `boolean`이라, 화면이 "앤티 20"을 그리려면 **프론트가
`sb / 5`를 직접 계산해야 한다.** 그 순간 금액 규칙이 두 곳이 되고, 백엔드가 식을
바꾸면 조용히 어긋난다 — T71이 적은 드리프트와 같은 모양이다.

### 결정 — 5의 배수를 강제한다 (2026-08-20)

앤티는 **전원이 낸다**(지금 코드가 맞다). 오프라인이 BB 앤티를 쓰는 이유는 딜러가
여섯 명한테서 걷어야 하는 불편 때문인데, **이 시스템에는 그 불편이 없다** — 칩이
디지털이라 `payAnte`가 자동으로 뺀다. 오프라인의 익숙함을 온라인의 편의와 합치는
것이 이 도메인이고, 전원 앤티가 거기 맞는다.

그래서 남는 것은 산수뿐이다: **`sb`가 5의 배수여야 한다.** 소수가 생기지 않도록
입구에서 강제한다. T64가 `BlindLevelDto`를 실제로 돌게 만들었으므로 그 자리에 얹는다.
**코드가 `Math.floor`하지 않는다** — 그건 딜러가 모르는 사이에 칩을 증발시키는 것이다.

칩 최소 단위(100·500 같은) 규칙은 **세우지 않는다.** 실물 칩이 테이블에 없으므로
20을 만들 수 없다는 제약이 성립하지 않고, 세우면 `splitPot`의 나머지 분배(지금
1칩씩)와 시나리오 불변식까지 따라온다. 운영 관례일 뿐 정합성 제약이 아니다.

### 할 일

- `payAnte`가 `executeBet`을 거치게 한다. 상한과 올인 판정도 그 한 곳에 모인다.
- `BlindLevelDto.sb`에 5의 배수 제약을 건다.
- **앤티 금액을 한 곳에서 계산한다.** 프론트가 `sb / 5`를 다시 쓰지 않게, 파생을
  백엔드나 contract 한 곳에 두고 화면은 받아 그린다.
- **`Felt`와 `DisplayClient`에 앤티를 그린다.** 유무와 금액 둘 다.
- **시나리오에 앤티 핸드를 추가한다.** 이 티켓의 값은 고침이 아니라 여기 있다 —
  불변식이 있는데도 통과한 이유가 "그 입력이 없어서"였다.

---

## T60 — 인원수가 DB와 Redis에서 갈라진다

**등급**: 치명 · **범위**: `dealer/dealer.service.ts`, `entry/entry.service.ts`, `redis/redis.service.ts`, `prisma/seed.ts` · **프론트 영향**: 없음

인원수는 **두 곳**에 있다 — DB `Tournament.activePlayers`와 Redis 해시의
`activePlayer`. 최후 1인 판정과 탈락 등수는 **Redis 쪽**을 본다
(`eliminatePlayer`의 `activePlayerCount <= 1`, `eliminatedRank =
tournamentInfo.activePlayer`). 둘을 짝으로 움직이는 것이 **관행일 뿐 구조가
아니라서**, 네 곳이 빠져 있다.

### 4-1. 킥이 Redis를 안 깎는다 (확실)

`DealerService.handleDealerAction`의 `KICK` 분기가 DB만 `decrement`한다. Redis
`activePlayer`를 내리는 곳은 `RedisService.eliminatedPlayer` 하나뿐인데 부르지
않는다.

**자가 치유 경로가 없다.** `TableEngine.act`의 `DEALER_KICK`은 `hasFolded`만
세우고 스택을 남기므로 `resolveWinners` 3단계의 `stack <= 0` 필터에 **영원히 안
걸린다.** 나중에 실제로 파산해도 `awardPrize`의
`status: { notIn: ['ELIMINATED','AWARDED'] }`가 0행을 돌려주고 `eliCount === 0`
에서 조기 반환한다 — **Redis 카운터에 닿기 전이다.**

킥 K건이면 Redis `activePlayer`의 하한이 `1 + K`라 **`tournamentFinished`(우승
상금)가 영영 안 돈다.** 등수도 전부 K만큼 밀린다.

### 4-2. 착석이 예외로 끊기면 Redis만 영구히 뒤처진다 (확실)

`EntryService.claimSeat`은 DB 트랜잭션(좌석 행 + `WAITING → PLAYING` +
`activePlayers` increment)을 **커밋한 뒤** `mutateSnapshot`을 돌리고, `seatPlayer`는
그 **다음**이다. `mutateSnapshot`이 던지면 뒤의 네 줄(`seatPlayer` ·
`setUserContext` · `updateSeatBitmap` · 이벤트)이 통째로 스킵된다. 던지는 경로가
넷이고 전부 커밋 이후다 — 락 획득 실패(5초), `좌석 정보가 바뀌었습니다`,
`테이블 상태를 복구하는 중입니다`, `tablePlayer.findUnique`의 DB 오류.

**재시도로 낫지 않는다.** 같은 OTP로 다시 들어오면 `enterSeat`의 `seated`가 방금
만든 행을 찾아 `alreadySeated = true`가 되고 트랜잭션 블록을 건너뛴다 →
`promoted = 0` → `seatPlayer`가 `count <= 0`으로 즉시 리턴한다. **Redis는 영원히
1 모자란다.**

`claimSeat`의 주석("이쪽이 실패하면 … 재기동 복구가 DB의 `activePlayers`로 메타를
다시 세우므로 낫는다")은 **사실이 아니다.** `RecoveryService.recoverTournament`는
`getTournamentBlind`가 `null`일 때 — 즉 info 키가 **통째로 없을 때만** —
`buildTournamentMeta`로 메타를 다시 세운다. Redis가 살아 있고 카운터만 어긋난 이
경우는 그 분기에 들어가지 않는다. **주석도 함께 고쳐야 한다.**

방향이 반대라 더 나쁘다: Redis가 실제보다 **작으므로** `activePlayerCount <= 1`이
**일찍** 걸려, 아직 둘이 남았는데 임의의 생존자에게 1위 상금이 나간다.

### 4-3. 딜러 로그인의 승격도 짝이 없다 (확실)

`DealerService.loginDealer`가 `WAITING → PLAYING` 승격을 하며 DB만 올리고
`RedisService.seatPlayer`를 부르지 않는다. 4-2와 같은 방향이다.

### 4-4. 시드가 인원수를 이중 계상한다 (확실)

`prisma/seed.ts`가 참가자를 전원 `PlayerStatus.WAITING`으로 만든 뒤
`activePlayers: players.length`(=7)를 써 넣는다. 그런데 T55 이후 `activePlayers`는
**첫 착석만** 올리는 값이다 — `PaymentService.joinSession`은 주석까지 달아 가며
올리지 않는다.

7명이 OTP로 착석하면 `activePlayers`가 **7 → 14**가 되고, `startSession`의
`buildTournamentMeta`가 그 값을 그대로 Redis에 싣는다. 결과:

- 첫 탈락이 "14위"다. `prizeFor(pool, [1,2,3], 14)`는 0 → **상금이 한 푼도 안
  나간다.**
- `activePlayerCount <= 1`에 닿으려면 13번 탈락해야 하는데 사람이 7명뿐 →
  **우승 상금도 안 나간다.**
- `completeSession`이 `350,000 - 0 !== 0`으로 영구 차단된다 — **데모 대회를 닫을
  수 없다.**
- 전광판의 `activePlayer`(14)가 `totalPlayer`(7)보다 크고, `recalculateAvgStack`의
  분모가 두 배라 평균 스택이 절반으로 보인다.

`seed-load.ts`는 이 필드를 건드리지 않아 옳다 — **두 시드가 갈라져 있다.**

### 할 일

네 곳을 각각 고치는 것으로는 다음 경로에서 또 빠진다. **짝을 구조로 만든다** —
`mutateSnapshot`이 스냅샷 쓰기에 한 것(호출부에서 지울 수 있는 줄을 없앤다)과 같은
처리가 이 카운터에도 필요한지 먼저 판단한다.

### 기존 테스트가 왜 못 잡나

`src/playsync/elimination.int-spec.ts`의 딜러 킥 절과
`src/scenario/dealer-intervention.int-spec.ts`가 **DB `activePlayers`만** 단언한다.
Redis 쪽을 아무도 안 본다.

---

## T66 — 가드 없는 읽기 경로가 남의 대회·상점을 내준다

**등급**: 높음 (테넌트 격리) · **범위**: `playsync/playsync.controller.ts`, `payment/payment.controller.ts`, `dealer/dealer.controller.ts`, `frontend/src/app/(console)/.../page.tsx` · **프론트 영향**: 있음

### 문제

**`GET /playsync/:id`(`PlaysyncController.joinTable`)에 `JwtAuthGuard`밖에 없다.**
서비스가 `getSnapShot(tableId)`를 그대로 돌려주고 소유권·좌석·대회 소속을
**아무것도 대조하지 않는다.** 좌석이 없으면 `seatIndex: -1`과 함께 전체 스냅샷(각
플레이어의 `id` · `nickname` · `stack` · `bet` · `tournamentId`)이 나간다.

WS는 같은 자원에 `WsGateway.assertTableAccess`를 요구한다 — 딜러는 서명된 토큰의
`tableId` 일치, 플레이어는 스냅샷에 실제로 앉아 있을 것. **같은 자원에 문이 둘
있고 한쪽만 잠겨 있다.** 그 게이트웨이의 `assertTournamentAccess` 주석이 이미 같은
논법을 적었다 — "테이블 경로는 바로 아래에서 막고 있었으므로, 대회 경로만 뚫려
있던 비대칭 자체가 빠뜨렸다는 증거다."

**`tableId`는 추측할 필요가 없다.**

- `GET /tournaments/:id`(`PaymentController.getTournamentInfo`)는 **가드가 아예
  없고** `select`에 `tables: true`가 있어 누구나 테이블 id 목록을 얻는다.
- `GET /tournaments/stores`(`PaymentController.searchStore`)는 쿼리를 안 주면
  Prisma가 `contains: undefined`를 "조건 없음"으로 처리해 **모든 `Store` 행**을
  준다 — `id` · `name` · **`ownerId`** · `createdAt`이 전부. 가드도 페이징도 없어
  상점 관리자 uuid까지 한 번에 열거된다.
- `GET /dealer/:id`(`DealerController.getTournamentWithTables`)도 가드 없이 임의
  대회의 `entryFee` · `prizePayouts` · `startedAt` · `pausedMs` · 테이블 id를
  준다. `session.service.ts`의 `getSeatOccupants` 주석은 이 라우트를 "지금은
  테이블 뼈대만 준다"고 전제하는데, **실제로는 `Tournament` 행 전체**(해시만
  제외)가 나간다 — 주석도 함께 고쳐야 한다.

**상점 콘솔이 그 구멍 위에 서 있다.** `(console)/.../page.tsx`의
`fetchTournament` · `fetchTables` · `fetchDashboard`가 전부 가드 없는 라우트를
부르고, 미들웨어의 `ROLE_RULES`는 `/stores`에 **역할만** 본다 — URL의 `storeId`가
로그인한 관리자의 것인지 아무도 확인하지 않는다. 아무 `STORE_ADMIN`이나
`/stores/<남의 상점>/tournaments/<남의 대회>`를 열면 대회명 · 상태 · 프라이즈풀 ·
인원 · 테이블 목록 · 블라인드 시계가 전부 렌더된다. 좌석 패널만 서버
가드(`getSeatOccupants`)에 막혀 배너를 띄운다.

### 신뢰 경계와의 관계

`docs/threat-model.md`는 신뢰 경계를 행사장 폐쇄망으로 잡는다. 그 전제에서도
**이건 대회 간 · 상점 간 격리**라 성격이 다르다 — 같은 망 안의 다른 상점이 이
시스템의 테넌트다. 착수할 때 위협 모델에 이 REST 경로를 적는다(지금 그 문서의
좌석 자격 항목은 WS `assertTableAccess`만 가리킨다).

### 할 일

- `joinTable`에 `assertTableAccess`와 **같은 규칙**을 건다. 두 벌이 되면 한쪽만
  고쳐지는 날이 오므로 판정을 한 곳에 두고 REST와 WS가 함께 부르는 형태를 본다.
- `GET /tournaments/:id`가 `tables`를 실어야 하는지 다시 본다. 프론트에서 이
  필드를 쓰는 곳은 테이블 **번호**를 구하는 두 자리뿐이다.
- `searchStore`가 빈 쿼리에 전체를 주는 것이 의도인지 정한다. 프론트가 "전체
  목록"으로 쓰고 있으므로(`(player)/tournaments/page.tsx`의 `fetchStores('')`)
  **끊으면 화면이 함께 움직인다.** 최소한 `ownerId`는 빼야 한다.
- 콘솔의 `storeId` 소유권을 서버에서 확인한다.

---

## T70 — 콘솔 좌석 선택이 새로 그린 판을 따라간다

**등급**: 중간 · **범위**: `(console)/stores/[storeId]/tournaments/[tournamentId]/ConsoleClient.tsx` · **프론트 영향**: 있음

`selected`는 **좌석 인덱스**의 `Set`이고 `selectTable`과 해제 성공에서만 비워진다.
`selectedSeats`는 매 렌더마다 **지금의** `occupantBySeat`에서 `userId`를 다시
뽑는다.

```ts
const selectedSeats = [...selected]
  .map((i) => occupantBySeat.get(i))
  .filter((p): p is SeatOccupant => p !== undefined);
```

관리자가 3번 자리(A)를 체크한다 → 다른 조작이 `run`에서 `router.refresh()`를
부른다 → 서버 컴포넌트가 다시 조회하는 사이 그 자리에 B가 앉는다 → "고른 자리
해제"를 누른다. **B가 떨어진다.**

`ReleaseSeatItem`이 `seatIndex`와 함께 `userId`를 요구하는 이유가 정확히 이 낡은
화면을 서버가 거절하게 하려는 것이다. 그런데 클라이언트가 id를 판과 함께 갱신해
버려 **그 가드가 항상 통과한다.**

### 할 일

선택을 `seatIndex`가 아니라 `{ seatIndex, userId }`로 들고 있게 한다. 그러면 주인이
바뀐 자리는 서버가 409로 거절하고, 그것이 원래 설계된 동작이다.

---

## T68 — 레이즈 입력이 낼 수 있는 금액과 어긋난다

**등급**: 중간 · **범위**: `(terminal)/table/[tableId]/SeatActionPanel.tsx`, `game-engine/table-engine.ts` · **프론트 영향**: 있음

엔진의 `handleRaise`는 `amount`를 **총 베팅액**으로 읽고 `betAmount - player.bet`을
뺀다. 그래서 낼 수 있는 최대 총액은 `stack`이 아니라 `stack + bet`이다. 슬라이더의
`max`와 올인 버튼은 그렇게 쓰는데 **차례가 돌아올 때의 초기화만 `stack`을 쓴다.**

```ts
setRaiseVal(Math.min(state.currentBet + bigBlind, myPlayer?.stack ?? 0));
```

`currentBet 200` · `bigBlind 200` · BB를 낸 상태(`bet 100`) · `stack 300`이면 최소
레이즈 400을 낼 수 있는데(300 + 100) 클램프가 300을 만들어 `canRaise = 300 >= 400`
이 거짓이다. **버튼이 "레이즈 300"이라 적힌 채 비활성이고 슬라이더는 400에 서
있다** — 숫자와 슬라이더가 서로 다른 말을 한다.

**둘째.** 초기화는 `turnKey`가 **바뀔 때만** 돈다. `lastTurnKey`가 현재
`turnKey`로 시드되므로 **내 차례 도중에 마운트되면 한 번도 안 돈다** — 새로고침이나
재접속이 그 순간에 걸리면 `raiseVal`이 슬라이더 `min`보다 작은 채 남아, 슬라이더를
건드리기 전까지 레이즈가 불가능하다.

**셋째.** 슬라이더 `max`가 `Math.max(stack + bet, currentBet + bigBlind)`라 낼 수
없는 금액까지 올라간다. `currentBet 100` · `bet 0` · `bb 20` · `stack 110`이면
`goingToAllIn`이 거짓이라 레이즈 UI가 뜨고 슬라이더가 120에 고정된다. "레이즈
120"을 보내면 `handleRaise`가 `Math.min(needed, stack)`으로 깎아 **에러 없이 110
올인**이 된다.

### 할 일

세 자리가 같은 값(`stack + bet`)을 서로 다르게 계산하는 것이 뿌리다. **낼 수 있는
최대 총액을 한 번 계산해 셋이 함께 쓴다.** 마운트 시 초기화는 `turnKey` 변화가
아니라 "지금 내 차례인가"로 판정해야 한다.

셋째는 화면만으로 못 닫는다 — 엔진이 **선언한 금액과 실제 낸 금액이 다를 때 조용히
통과시키는 것**이 옳은지 함께 본다(`executeBet`의 상한은 블라인드·앤티 때문에
필요하지만, 플레이어가 명시한 레이즈는 성격이 다르다).

---

## T59 — 동시 파산의 등수와 상금

**등급**: 치명 (돈이 두 번 나간다) · **범위**: `playsync/playsync.service.ts` · **프론트 영향**: 없음

### 문제

`PlaysyncService`의 `eliminatePlayer`가 여러 명을 받는데 등수와 금액을 **루프
밖에서 한 번** 계산해 전원에게 같은 값을 매긴다.

```ts
playerIds.map(userId => ({ userId, place: eliminatedRank, amount: prize }))
```

`DealerService`의 `resolveWinners` 3단계가 `stack <= 0`인 사람을 **한 배열로**
넘기므로 그대로 도달한다. 사이드팟이 갈리는 표준 핸드(숏스택 둘이 올인)면 흔한
배치다. 풀 40000 · 분배율 50/30/20 · `activePlayer: 3` 실측:

```
a → place 3, amount 8000
b → place 3, amount 8000
```

**3위 상금이 두 번 나가고 2위(12000)는 아무도 못 받는다.** 우승자가 20000을
받으면 합계가 36000이라, `SessionService.completeSession`이 요구하는
`걷은 참가비 == 나간 상금`이 영영 맞지 않는다 — **대회를 닫을 수 없다.**
분배율에 따라 반대 방향(합계가 풀 초과)도 가능하고, 그쪽 메시지는 "지급된 상금이
참가비 총액보다 많습니다"다. `awardPrize`를 부르는 곳이 `eliminatePlayer`와
`tournamentFinished` 둘뿐이라 **손으로 메울 API가 없다.**

**교차 테이블에서도 같은 일이 난다.** `tournamentInfo`는 `resolveWinners` 맨
앞에서 락 없이 읽는다. 두 테이블이 동시에 정산하면 둘 다 같은 `activePlayer`를
읽어 같은 등수를 매긴다.

### 결정해야 하는 것

순수한 버그가 아니라 **규칙이 없는 자리**다. 실제 홀덤은 같은 핸드에 파산한 둘을
핸드 시작 시점의 스택으로 가른다. `eliminatePlayer`에는 그 정보가 없다 — 받는
`TablePlayer[]`가 파산 **이후** 상태다.

1. **등수를 무엇으로 가를 것인가.** 핸드 시작 스택이라면 `resolveWinners`가
   1단계에서 그 값을 들고 나와야 한다.
2. **동점 등수를 인정한다면 상금을 어떻게 나눌 것인가.** 두 등수의 상금을 합쳐
   나누는 것이 표준이다.
3. 어느 쪽이든 **"나간 상금의 합 == 풀"이 구조적으로 성립해야 한다.**
   `calculatePrizes`가 1위에게 나머지를 흡수시켜 그 성질을 만든 것과 같은 방식이
   필요하다.

파산 순서는 **칩이 정하는 값이라 딜러 입력이 아니다** — `resolveWinner`의 "승자는
계산되지 않고 딜러가 입력한다"와 성격이 다르다.

### 기존 테스트가 왜 못 잡나

`src/playsync/prize.int-spec.ts`가 전부 **한 명씩** 탈락시킨다. 두 명을 한 배열로
넘기는 경로에 테스트가 없다.

---

## T67 — 좌석 태블릿이 실패를 삼킨다

**등급**: 높음 · **범위**: `(terminal)/table/[tableId]/SeatGameClient.tsx`, `(terminal)/table/[tableId]/page.tsx`, `(terminal)/dealer/table/[tableId]/page.tsx` · **프론트 영향**: 있음

셋 다 **"실패가 화면에 도달하지 않는다"**는 같은 결함이고, 좌석 태블릿에서 그건
곧 참가자의 돈이다.

### 7-1. 서버의 `error` 이벤트를 버린다

`WsGateway.handlePlayerAction`은 거절마다 `{ event: 'error', data }`를 누른
사람에게만 돌려준다. `SeatGameClient`의 `socket.onmessage`는 `renderGame`과
`REBUY_PROMPT`만 처리하므로 그 프레임은 **파싱만 되고 사라진다.**

`DealerGameClient`는 같은 이벤트로 모달을 띄운다. 비대칭이 곧 빠뜨렸다는
증거다. 그리고 `SeatGameClient`의 머리말이 스스로 최악의 실패 모드를 적어 뒀다 —
"화면은 멀쩡해 보이는데 아무것도 안 움직이는 상태가 가장 나쁘다."

### 7-2. 소켓이 닫혀 있어도 리바인 팝업이 닫힌다

```ts
if (socketRef.current?.readyState === WebSocket.OPEN) { …send… }
updateRebuyData(null);   // 무조건
```

행사장 Wi-Fi가 한 번 끊긴 순간 참가자가 리바인을 누르면 **화면은 수락된 것처럼
닫히고** 서버는 15초 마감을 거절로 처리한다(`waitForRebuyResponse`). 참가자는
성공 화면을 본 채 탈락한다. `sendPlayerAction`도 같은 모양이라 `console.error`
한 줄만 남는다.

### 7-3. 백엔드 에러가 정상 화면으로 렌더된다

두 `page.tsx`의 `getInitialGameData`가 `res.ok`를 안 보고 `return res.json()`
한다. 토큰 만료(401)나 스냅샷 유실(500)이면 **에러 객체가 truthy**라
`initialData ? <SeatGameClient …> : <p>아직 게임이 시작되지 않았습니다.</p>`가
항상 성공 분기를 탄다. `initialData.tableState`가 `undefined`인 채로 빈 펠트가
그려지고 영원히 안 움직인다. **폴백 문구는 본문이 리터럴 `null`이어야만 나오는
죽은 코드다.**

여기에 하나가 물려 있다. `getTableContext`가 `tournamentId` 없이 빈 객체를
돌려주므로 `storeId`도 `undefined`가 되고, `EliminatedOverlay`의 `waitingUrl`이
`/table?store=`가 되어 7초 뒤 **"주소에 상점이 없습니다."**로 자동 이동한다 —
태블릿이 막다른 곳에 선다.

### 할 일

`DealerGameClient`가 이미 `actionError` 모달을 갖고 있으므로 형태는 그쪽을 따른다
— 다만 좌석 화면은 **참가자가 읽고 지워야 하는 것**과 **저절로 낫는 것**을 갈라야
한다(딜러 화면의 연결 끊김 배너 / 거절 모달 구분과 같은 자리).

---

## T61 — 시작 준비가 락 없이 스냅샷을 덮어쓴다

**등급**: 치명 · **범위**: `store/session/session.service.ts`, `redis/redis.service.ts` · **프론트 영향**: 없음

### 문제

`SessionService.initializeGame`이 테이블마다 `getSnapShot`(**락 없음**) →
`buttonUser` 대입 → `setTournamentMeta` 왕복 → `saveInitialTableSnapshots`로
`pipeline.set`(**락 없음**)을 한다. 전형적인 read-modify-write인데 그 사이에
Redis 왕복이 하나 더 끼어 창이 넓다.

`RedisService.writeSnapshot`의 주석은 "밖에서 부를 수 없어야 '스냅샷을 쓰는 길은
둘뿐'이 문서가 아니라 타입으로 선다"고 적는다. **`saveInitialTableSnapshots`가
세 번째 경로다** — `mutateSnapshot`도 `saveSnapshotUnlocked`도 아니고, 예외
사유를 자백하는 `reason` 인자도 없다.

재현: 상점이 시작 버튼을 누른다 → `initializeGame`이 1번 테이블 스냅샷을 읽는다
→ 그 사이 u9가 `POST /tournaments/:id/enter`로 그 테이블 5번 자리에 착석한다
(`claimSeat`은 **락을 정상적으로 잡고** DB 행·좌석 비트·유저 컨텍스트를 전부
만든다) → `saveInitialTableSnapshots`가 낡은 스냅샷을 덮어쓴다.

결과: `TablePlayer` 행 · 비트맵 · `activePlayers`는 u9가 앉았다고 하는데 게임
스냅샷에는 없다. 딜러가 그를 포함해 딜할 수 없고, 체크포인트
(`syncTableInventoryToDb`)는 그의 스택을 갱신하지 않으며, `releaseSeats`의 검사
1(스냅샷 점유자 대조)이 통과하지 않아 **상점도 뗄 수 없다.** 부팅 복구도
스냅샷이 "있으므로" 손대지 않는다. 유일한 탈출은 그 사람이 OTP를 다시 넣는
것이다(`alreadySeated` 경로가 점유자를 고쳐 쓴다).

**대회 시작 순간은 착석이 가장 몰리는 시각이다.** 창이 좁아서 안 걸리는 게 아니라,
가장 넓을 때 열려 있다.

### 할 일

시작 준비도 `mutateSnapshot`을 지나가게 하거나, 지나갈 수 없다면
`saveSnapshotUnlocked`의 `reason` 유니온에 항목을 더해 **예외라는 사실이 diff에
보이게** 한다. 지금은 세 번째 경로가 조용히 있다.

---

## T62 — 체크포인트 재시도가 던지면 테이블이 갇힌다

**등급**: 높음 · **범위**: `common/retry.ts`, `playsync/playsync.service.ts` · **프론트 영향**: 없음(T69가 화면 쪽)

### 문제

`retryAsync`는 **`fn`의 예외만** 값으로 바꾼다. `await onRetry?.(...)`와
`await sleep(...)`은 `try` 밖이라 거기서 던지면 `{ ok: false }`가 아니라 예외가
그대로 전파된다 — 파일 머리말의 "throw하지 않고 결과를 값으로 돌려준다"가 이
경로에서 거짓이다.

`checkpointTableToDb`의 `onRetry`는 `markDbSyncStatus`이고, 그것은
`mutateSnapshot` → `withTableLock`이라 **락 획득 실패(5초)나 Redis 오류로 던질 수
있다.** DB가 흔들려 재시도에 들어간 상황이면 Redis도 함께 힘든 경우가 많다.

그러면:

- `checkpointTableToDb`가 `false`를 돌려주는 대신 던진다 → `resolveWinners`
  4단계가 던진다
- 스냅샷의 `dbSyncStatus`는 `'FAILED'`가 **아니다**(미설정이거나 `'RETRYING'`)
- 테이블은 `HAND_END`에 남고, `startPreFlop`은 `WAITING`만 받으며,
  `retryCheckpoint`는 `state.dbSyncStatus !== 'FAILED'`라 **"재시도할 체크포인트가
  없습니다"를 던진다**

→ 그 테이블은 **어떤 조작으로도 다음 핸드로 못 간다.** `checkpointTableToDb`
마지막의 `markDbSyncStatus(tableId, 'FAILED')`가 던지는 경우도 결과가 같다.

설계 의도는 "멈추는 것 자체가 안전 상태이고, 대신 나올 길이 있다"였다. 나올 길이
**바로 그 상황에서** 닫힌다.

### 할 일

`onRetry`와 `sleep`을 `try` 안으로 넣을지, 아니면 `onRetry`의 실패를 삼킬지
정한다. 그리고 `retryCheckpoint`의 문지기(`dbSyncStatus === 'FAILED'`)가 **표시에
의존한다는 사실 자체**를 다시 본다 — 표시를 못 남긴 실패가 존재하는 한 그 조건은
막다른 곳을 만든다. `phase === HAND_END`만으로 충분한지 검토한다.

---

## T63 — 휴식 레벨이 등록을 영구히 닫는다

**등급**: 높음 · **범위**: `store/session/registration.ts`, `redis/redis.service.ts` · **프론트 영향**: 없음

### 문제

휴식 구간은 **`lv === 99`인 원소**다(`BlindLevelSchema`가 `lv`에 상한을 안 거는
이유). 그런데 등록 마감 판정은 같은 `lv`를 숫자로 비교한다.

```ts
// isRegistrationOpenAtLevel
return manuallyOpen && currentLv < rebuyUntil;
```

휴식에 들어가는 순간 `currentLv`가 99라 어떤 정상값에서도 거짓이다. 실측:

```
isRegistrationOpenAtLevel(true, 99, 6) === false
```

`RedisService.checkAndSyncBlindLevel`은 `curLv >= rebuyUntil`이면
`isRegistrationOpen`을 `'0'`으로 내리고, **그 마감은 단조라 되돌아오지 않는다.**
리바인 마감 전에 휴식이 한 번 오면 그 대회의 리바인은 거기서 죽는다 —
`resolveWinners`가 `tournamentInfo.isRegistrationOpen`을 보고 **리바인 팝업 자체를
안 띄우므로**, 규정상 5레벨까지 리바인 가능한 대회에서 3레벨에 파산한 사람이
리바인 없이 탈락한다. 결제(`isRegistrationOpenNow`)도 같은 식으로 막힌다.

`prisma/seed.ts`가 **이 결함을 우회하고 있다.** 휴식을 `REBUY_UNTIL`(4) 바로 앞에
놓고 그 자리에 근거를 적어 뒀다("휴식을 리바인 종료 뒤에 놓았다. 마감 판정이
`curLv < rebuyUntil`인데 …"). 시드가 우회해야 한다는 것 자체가 규칙이 아니라
결함이라는 증거다. 상점이 임의 구조를 만드는 경로(`createSession` ·
`updateSession`)에는 어떤 검증도 없다.

### 결정해야 하는 것

**센티널과 레벨 번호가 같은 필드에 있는 것**이 뿌리다.

1. 휴식을 별도 필드(`isBreak: true`)로 옮긴다 — 계약 변경이라 프론트·시드·복구가
   함께 움직인다.
2. 마감 판정이 휴식 원소를 건너뛰고 **직전 실제 레벨**을 쓰게 한다.
3. 블라인드 구조 검증이 "휴식은 `rebuyUntil` 이후에만"을 강제한다 — 가장 싸지만
   규칙을 상점에게 떠넘긴다.

`isRegistrationOpenAtLevel`이 판정의 **유일한 자리**라는 T47의 성질은 어느 쪽을
골라도 지켜야 한다.

---

## T71 — 계약과 스키마의 드리프트

**등급**: 낮음 (지금 증상 없음) · **범위**: `packages/contract/src/table-state.ts`, `ws/ws.gateway.ts`, `frontend/src/app/types/game.ts`, `prisma/schema.prisma` · **프론트 영향**: 있음

### 9-1. 아웃바운드 그물이 실제로는 안 쳐져 있다

`table-state.ts`의 머리말은 "아웃바운드라 `.strict()`를 걸지 않는다. zod 기본
스트립이 목적이다 — 백엔드 `TableState`에 필드를 추가해도 여기 없으면 조용히
제거되므로 내부 값이 자동으로 새지 않는다"고 적는다.

**`TableStateSchema`와 `RenderGameEventSchema`의 프로덕션 사용처가 0건이다.**
`WsGateway`는 `broadcastToTable(tableId, 'renderGame', updatedState)`로 원시 객체를
그대로 쏜다. 그래서 그 문장은 `renderGame` 경로에 성립하지 않는다.

같은 계약의 다른 둘은 **실제로 지켜지고 있다** — `WsTicketResponseSchema`는
`api/ws-ticket/route.ts`가 `parse`하고(그 파일이 "여기서 실행돼야 사실이 된다"고
적었다), `FullTournamentInfoSchema`는 `DisplayClient`와 콘솔 `page.tsx`가
`safeParse`한다. 스냅샷만 빠졌다.

### 9-2. 프론트 타입이 손으로 복사돼 어긋났다

`frontend/src/app/types/game.ts`의 `TablePlayer`에 **`button: boolean`이 있는데
백엔드는 그런 필드를 안 보낸다**(엔진은 `state.buttonUser` 하나만 옮긴다) — 항상
`undefined`다. 반대로 백엔드가 실제로 보내는 **`hasChecked`가 타입에 없다.**
`TableState`에는 `dbSyncStatus`가 없다(T69).

`Felt`는 `state.buttonUser`를 읽어 우회하고 그 자리에 근거를 적어 뒀지만, 타입은
여전히 올 수 없는 필드를 광고한다. **contract에 `TableState`가 이미 있는데 손으로
복사한 것**이고, 이게 정확히 contract 패키지가 막으려던 드리프트다.

### 9-3. 스키마가 선언했는데 코드가 쓰지 않는 것들

| 선언 | 실태 |
|---|---|
| `TournamentStatus.SYNCING` | **어디서도 대입하지 않는다.** 주석과 `isClosedTournament`의 여집합에만 등장한다. `getStoreAvailableSessions`·`getGameSessionWithTables`가 `in: [ONGOING, PENDING]`으로 거르므로, 이 값이 붙는 순간 대회가 목록과 딜러 조회에서 통째로 사라진다 — 값이 없어서 아무도 그걸 모른다 |
| `TransactionType.CHARGE` | 사용처 0건. **T72로 옮겼다** — 포인트 충전 경로가 없는 것이 `seed-load.ts`의 `entryFee: 0`을 낳았고, T64가 그 값을 걷어내며 드러났다 |
| `GameType.SIT_AND_GO` | `@IsEnum(GameType)`이 받아 저장하지만 `Tournament.type`을 읽고 분기하는 코드가 **한 줄도 없다.** SIT_AND_GO로 만든 대회가 TOURNAMENT와 완전히 같이 동작한다 |
| `Table.tableOrder @default(autoincrement())` | 전역 시퀀스인데 쓰는 데가 없다 — `createSession`은 `1`, `insertTable`은 대회별 `max+1`, 시드 둘은 명시값이다. 명시 INSERT는 시퀀스를 밀지 않으므로 언젠가 이 기본값에 기대는 경로가 생기면 `@@unique([tournamentId, tableOrder])`에 즉시 P2002로 걸린다 |
| `Tournament.itmCount @default(3)` vs `prizePayouts @default("[]")` | 두 기본값이 서로 모순이다("상금권 3자리인데 분배율 없음"). `startablePayouts`가 시작 시점에야 잡는다 |

### 할 일

- 프론트가 `@playsync/contract`의 `TableState`를 import하게 한다. 손 복사본을
  지우면 드리프트가 구조적으로 불가능해진다.
- `renderGame`이 나가기 전에 `TableStateSchema`를 태울지 정한다. 태우면 계약이
  사실이 되지만, 백엔드가 필드를 늘릴 때 **브로드캐스트가 조용히 필드를 잃는**
  방향의 사고가 생긴다 — 그 트레이드오프가 원래 주석이 말하던 것이다. **태우지
  않기로 한다면 주석을 사실에 맞게 고친다.**
- 9-3은 지우거나 쓰거나 둘 중 하나다. 남겨 둘 항목은 **왜 남기는지**를 스키마에
  적는다.

---

## T65 — 비턴 액션이 현재 턴의 타이머를 리셋한다

**등급**: 높음 · **범위**: `playsync/playsync.service.ts`, `ws/ws.gateway.ts` · **프론트 영향**: 없음

### 문제

`TableEngine.act`는 `!isPlayerTurn`이면 **예외를 던지지 않고 `return this.state`**
한다(자기 턴이 아닌 사람을 딜러가 접는 경우를 위해 그렇게 만들어졌다). 그런데
`PlaysyncService.handleAction`은 그 뒤에 **조건 없이**
`scheduleTurnTimeout(tableId, state)`를 부른다. 게이트웨이의 `handlePlayerAction`
에도 턴 검사가 없다.

alice(0번, 현재 턴, `timerEpoch 7`, 마감 1초 뒤) 상태에서 bob(1번)이
`PLAYER_ACTION { action: 'CHECK' }`를 보낸 실측:

```
removed: ['t1-7']                                   ← alice의 타임아웃 잡이 삭제됨
added:   jobId 't1-8', delay 30000, userId 'alice'  ← 30초짜리로 새로 등록
deadline: +1000ms → +30000ms,  epoch 7 → 8
alice.hasChecked: false, bob.hasChecked: false      ← 게임 상태는 그대로
```

**아무 착석자나 30초마다 아무 액션을 던지면 현재 턴 플레이어의 제한시간을 무한히
연장할 수 있다.** 이미 마감을 넘긴 턴도 되살아난다 — `isExpired`로 `TIME_OUT`으로
바뀌어도 `act`가 비턴이라 no-op인데 타이머는 갱신된다. 덤으로 매번 스냅샷 쓰기와
`renderGame` 브로드캐스트가 일어난다(부하 무대에서 조용한 증폭기다).

시간 제한이 사람의 자리 비움을 처리하는 장치인데, **옆자리가 그걸 무력화할 수
있다.**

### 할 일

`scheduleTurnTimeout` 호출을 **상태가 실제로 바뀐 경우로 좁힌다.** `act`가
no-op이었는지를 호출자가 알 수 있어야 하므로, `handleAction`이 이미 `acted`
플래그로 낡은 `TIME_OUT`을 가르는 것과 같은 방식이 필요하다 — 다만 `act`의
반환값만으로는 안 갈린다는 점이 여기서도 같다.

턴 검사를 엔진 밖(게이트웨이나 서비스)에 하나 더 두는 것은 **하지 않는 쪽이
맞다** — 검사가 둘이 되면 한쪽만 고쳐지는 날이 온다.

---

## T69 — 체크포인트 실패의 탈출구가 화면에 없다

**등급**: 중간 · **범위**: `(terminal)/dealer/table/[tableId]/DealerGameClient.tsx`, `frontend/src/app/types/game.ts` · **프론트 영향**: 있음

백엔드는 핸드 종료 체크포인트가 재시도까지 실패한 상태를 **안전 상태**로 설계하고
나올 길을 둘 만들어 뒀다.

- `dbSyncStatus: 'RETRYING' | 'FAILED'` — 스냅샷 필드다. `types.ts`의 주석이
  "딜러만이 아니라 테이블 전원이 알아야 하고, 재접속한 단말도 같은 것을 봐야
  한다"고 근거를 적었다.
- `RETRY_CHECKPOINT` — `DealerActionSchema`의 명령이고 `DealerService`의
  `retryCheckpoint`가 받는다. "막다른 골목을 없애는 기능"이라고 적혀 있다.

**프론트에 둘 다 없다.**

```
grep -rn "RETRY_CHECKPOINT\|dbSyncStatus" frontend/src  →  0건
```

`DealerGameClient`의 `canStartHand`가 `phase === WAITING`이라 `HAND_END`에서 멈춘
테이블은 **아무 버튼도 안 켜지고** 왜 멈췄는지 표시도 없다.
`app/types/game.ts`의 `TableState`에 `dbSyncStatus`가 아예 없어 타입으로도 못
읽는다. **T62를 고쳐도 이 화면이 없으면 딜러는 여전히 나올 길을 모른다.**

**같은 자리에 하나 더.** `DEALER_FOLD`가 `DealerActionSchema`에 있는데 딜러 화면에
컨트롤이 없다 — 자리를 비운 사람을 **내보낼(KICK)** 수는 있어도 **접을(FOLD)**
수는 없다. 둘은 다른 조작이다(킥은 참가를 끝내고 폴드는 이 핸드만 포기시킨다).

---

## T72 — 목업 결제와 실패 경로

**등급**: 중간 · **범위**: `payment/payment.controller.ts`, `payment/payment.service.ts`, `user/user.service.ts`, `load/` · **프론트 영향**: 없음

### 왜 티켓인가

T64가 부하 무대의 `entryFee: 0`을 걷어내면서(6-3) 드러난 자리다. 그 값이
`recalculateAvgStack`의 분모라 **지금까지의 부하 실측은 전부 `avgStack = NaN`인 상태에서
잰 것**이었고, 참가비를 1로 올리자 이번에는 실행 중 가입하는 봇(`load/lib/table.js`의
`NEW_USER_RATIO`, 기본 10%)이 포인트가 없어 `PaymentService.joinSession`의 게이트에
409로 막혔다. T64는 가입이 `SIGNUP_INITIAL_POINTS`를 싣게 해서 **정상 경로만** 뚫었다.

**그래서 남은 것은 거절이다.** 부하는 지금까지 결제 실패를 한 번도 밟은 적이 없다.
거절됐을 때 참가 행 · 참가 OTP · 거래 내역 · 프라이즈풀이 안 남는지, 그 롤백이 부하
아래서도 도는지를 아무도 재지 않았다. **이 티켓의 값어치는 "가짜 결제"가 아니라 실패를
부하에 넣는 것이다.**

### 전제 — 실 PG 연동 계획이 없다

2026-08-20에 사람이 밝혔다. 그래서 **만들지 않는 것**을 먼저 적는다.

- **멱등성 키를 두지 않는다.** PG 웹훅 재시도가 없으면 이중 충전이 성립하지 않는다.
- **금액 출처를 서버로 올리지 않는다.** 승인 금액을 PG가 정하는 구조가 없다.
- **외부 거래 id 컬럼을 만들지 않는다.**

셋 다 실결제를 전제해야 값을 하는 구조다. 지금 지으면 쓰지 않을 것의 유지 비용만 낸다.
나중에 PG가 생기면 그때 입구를 만든다 — 도메인 연산(`increment` + `CHARGE` 거래 내역)은
어느 쪽이든 같으므로 그 비용은 크지 않다.

### 무엇을 만드나

`TransactionType.CHARGE`가 `schema.prisma`에 **선언만 있고 사용처가 0건**이다(T71 9-3이
같은 항목을 적었다 — 그쪽에서 이리로 옮긴다). 충전은 `UserService.paymentPoint`의
거울이다: `decrement` + `BUY_IN` 대신 `increment` + `CHARGE`.

승인 판정과 포인트 반영을 **갈라 둔다.** 목업이 성공/실패를 돌려주는 자리가 그 사이다.
지금은 항상 성공이어도, 그 경계가 있어야 나중에 실패를 끼워 넣을 수 있다.

### 결정해야 하는 것

1. **실패율을 무엇이 정하나.** 고정 비율인지, 특정 계정/금액이 항상 실패하는지.
   비율이면 부하 결과의 재현성이 떨어진다.
2. **실패한 봇이 무엇을 하나.** 죽는지(`must()`가 `fail()`), 재시도하는지, 다음 대회로
   가는지. **이 선택이 부하 모양을 바꾼다** — 죽으면 VU가 줄고, 재시도하면 결제 경로에
   부하가 몰린다.
3. **게이팅.** 프로덕션이 없으므로 환경변수 하나로 충분하다. 다만 환경변수가 **없을 때
   라우트가 존재하지 않아야** 한다 — 요청 시점 가드로 두면 설정이 곧 방어가 된다.

### 기존 테스트가 왜 못 잡나

결제 거절 경로에 통합 테스트가 없다. `PaymentService.joinSession`의 포인트 게이트를
단위로 확인하는 것은 있어도, **거절 뒤에 무엇이 남지 않는지**를 보는 검사가 없다.

---

## 잔여 목록

티켓을 따로 세우지 않는다. 괄호 안 티켓에 묻어 간다.

| 자리 | 무엇 | 묻어갈 곳 |
|---|---|---|
| `RedisService.recalculateAvgStack` | `parseInt(active \|\| '1')`. `activePlayer` 필드가 없을 때 분모가 0이 아니라 **1**이라, 바로 아래 `activeNum > 0` 가드가 무력해지고 `avgStack`이 "전체 칩 총량"으로 튄다 | T60 |
| `ActionTimer` | 서버가 만든 `actionDeadline`을 태블릿 시계와 직접 비교한다. `DisplayClient`는 같은 이유로 `blindField.serverTime`으로 오프셋을 보정하는데 여기엔 없다 — 시계가 뒤처진 태블릿은 게이지가 남은 채 자동 폴드된다. 초기 렌더 100ms 동안 "0초 남음"이 뜨는 것도 같은 함수 | T68 |
| `WaitingClient.submit` · `DealerWaitingClient.submit` | 제출 버튼이 `otp.length === 0`만 본다. `OTP_LENGTH`(8 / 6)와 대조하지 않아 짧은 코드가 백엔드까지 왕복한다 | T67 |
| `WaitingClient.poll` · `DisplayClient.poll` · `selectTournament` · `ConsoleClient.run` | `try`/`catch`가 없다. 네트워크 블립마다 처리되지 않은 프라미스 거부가 난다. 폴링 쪽은 다음 주기에 낫지만 `selectTournament`는 테이블 목록이 낡은 채 아무 안내도 안 뜬다 | T67 · T70 |
| `auth/action.ts`의 `handleLogin` · `handleRegister` | `res.ok` 확인 **전에** `await res.json()`. 리포의 다른 액션 파일은 전부 `.catch(() => null)` + `failureMessage`를 쓴다. 프록시 502나 rate-limit HTML이 오면 서버 액션이 던지고 빈 에러 바운더리가 뜬다 | T67 |
| `UserService.findByUUID` | `await`가 빠져 `if (!user) throw`가 도달 불가한 죽은 분기다. **오동작은 없다** — `async` 반환값이 thenable을 풀어 주고 호출부 둘(`paymentPoint` · `joinSession`)이 각자 null을 막는다. 정리 대상 | 아무 티켓 |
| `EntryController` · `PaymentController` | 둘이 같은 `@Controller('tournaments')`를 쓴다. 겹치는 패턴은 `GET /tournaments/stores/:storeId`(Payment)와 `GET /tournaments/:id/seats`(Entry)이고, 지금 맞게 도는 이유는 `app.module.ts`의 `imports`에서 `PaymentModule`이 앞이기 때문이다. **순서가 바뀌면 깨지는데 아무 테스트도 안 운다** — 같은 베이스를 쓴다는 사실이 어디에도 표시돼 있지 않다 | T66 |
| `CreateTournamentDto` | `startStack` · `entryFee` · `rebuyUntil`에 `@Max`가 없다. class-validator의 `@IsInt()`는 `2^31`을 넘는 안전 정수를 통과시키는데 Prisma `Int`는 postgres `integer`다. 22003이 예외 필터 없이 **500**으로 나가고, `totalBuyinAmount` 쪽은 **대회 도중에** 터진다 | T64 |
| `WsIdentity.role` | 타입이 Prisma `Role`인데 좌석 티켓은 `SEAT_ROLE = 'PLAYER'`를 싣는다. 그 값은 enum에 없다(`req: any`라 타입 체커가 못 잡는다). 게이트웨이가 `role === Role.DEALER`만 보므로 지금은 동작하지만, 티켓 신원의 타입이 실제로 흐르는 값과 다르다 | T71 |
| `WaitingClient`의 좌석 도식 | `seatStatus.map`이 `SEAT_POSITIONS[i]`를 인덱싱한다. 비트맵이 9칸보다 길면 `.left`에서 던진다. 지금은 어디서나 9칸 | 아무 티켓 |
| `middleware.ts`의 `config.matcher` | 마지막 세그먼트에 점이 있는 경로를 통째로 건너뛴다(`[^/]+\.[a-zA-Z0-9]+$`). 지금 그런 라우트 파라미터가 없어 악용 불가지만, slug나 닉네임이 URL에 들어오는 날 가드가 꺼진다 | T66 |

---

## 검사에서 **깨끗했던** 것

찾다가 안 나온 것도 적는다 — 다음 사람이 같은 자리를 다시 파지 않게.

- `RedisService`의 `UPDATE_SEAT_BIT` · `UPDATE_SEAT_BITS_MANY` Lua 인덱스 계산.
  0-based `idx`에 대해 `sub(bitmap,1,idx) .. value .. sub(bitmap,idx+2)`가
  정확하고, `for i = 2, #ARGV - 1` / `value = ARGV[#ARGV]`도 빈 배열 포함해 경계가
  맞는다. 좌석 인덱스는 `EnterTournamentDto`의 `@Min(0) @Max(8)`이 막아 범위
  에러도 도달 불가다.
- `TableEngine.calculateSidePots`의 층 나누기와 마지막 층 흡수. 폴드한 사람의
  기여(데드 머니)가 위층으로 가는 것까지 손으로 따라가 맞았다 — **앤티만 빠져
  있다**(T58).
- `TableEngine.splitPot`의 나머지 칩 분배. 버튼 다음 자리부터 시계 방향이 맞다.
- `refundUncalledBets`. 폴드한 최고 기여자가 환급을 받는 경우까지 따라가 맞았다.
- `OtpAttempts`의 `reserveAttempt` / `refund` / `clear` 원자성.
- `WsTicketService.consume`의 `GETDEL` 1회용 성질.

---

## 검사 범위와 방법

`backend/src` · `backend/shared` · `backend/prisma` · `frontend/src` ·
`packages/contract`의 **비테스트 파일 전부**(약 15,000줄). 문서는 읽지 않고
코드만 봤다 — 주석은 읽되 **주장을 믿지 않고 코드가 실제로 그렇게 도는지 확인하는
용도**로만 썼다. 실제로 주석이 사실과 다른 자리를 셋 찾았다(T60의 `claimSeat`,
T61의 `writeSnapshot`, T66의 `getSeatOccupants`).

Docker가 없어 통합 테스트는 못 돌렸다. 재현은 단위 스펙과 페이크(가짜 Redis /
가짜 Prisma)로 했고, 만든 임시 파일은 전부 지웠다.
