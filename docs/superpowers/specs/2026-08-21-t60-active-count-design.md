# T60 — 인원수의 진실을 DB 하나로 모은다

> 2026-08-21. 결함 대장의 [T60 절](../../tickets-audit.md)이 무엇이 깨졌는지를
> 들고 있다. 여기는 **어떻게 고칠 것인가**만 적는다.

## 문제의 모양

인원수는 두 곳에 있다.

| | 어디 | 누가 쓰나 |
|---|---|---|
| `Tournament.activePlayers` | DB | 대회 시작·복구가 Redis 메타를 지을 때의 입력 |
| `activePlayer` | Redis 해시 `tournament:{id}:info` | **최후 1인 판정과 탈락 등수**, 전광판, 평균 스택의 분모 |

둘 다 **상대 증감**이다 — DB는 `increment`/`decrement`, Redis는 `hincrby`.
짝을 강제하는 것은 관행과 주석뿐이라 네 곳이 빠져 있다(대장의 4-1 ~ 4-4).

상대 증감의 성질이 결함을 되돌릴 수 없게 만든다. **한 번 어긋나면 영영
어긋난다** — 이후의 모든 증감이 틀어진 값 위에 얹히기 때문이다. 재기동 복구도
낫게 하지 못한다. `RecoveryService.recoverTournament`는 `getTournamentBlind`가
`null`일 때, 즉 info 키가 **통째로 없을 때만** 메타를 다시 세운다.

## 결정 — DB가 진실이고 Redis는 파생 표시다

이 리포는 이미 돈에 같은 규칙을 적용하고 있다. `eliminatePlayer`의 주석:

> 풀과 분배율은 DB에서 읽는다. Redis 대시보드에도 `totalBuyinAmount`가 있지만
> 그건 화면용 파생값이고, **돈의 진실은 DB다.**

인원수에도 같은 규칙을 적용한다. 셋이 따라온다.

1. **Redis `activePlayer`는 `hincrby`로 움직이지 않는다.** DB 트랜잭션이
   돌려준 값을 **대입**(`hset`)한다.
2. **판정의 출처가 DB로 옮겨간다.** `activePlayerCount <= 1`과 탈락 등수는
   트랜잭션이 돌려준 값을 본다. Redis는 전광판 전용이 된다.
3. **재기동이 언제나 치유한다.** 복구가 info 키의 유무와 무관하게 카운터를
   DB 값으로 맞춘다.

### 왜 대입인가 — 멱등이 구조를 만든다

대장의 「할 일」이 요구한 것은 "짝을 구조로 만든다"였다. 상대 증감으로는 그것이
불가능하다. 호출부마다 짝을 정확히 한 번 불러야 하고, 그 규율을 강제하는 장치가
없기 때문이다.

대입은 다르다.

- **두 번 불러도 같다.** 중복 도착이 카운터를 망가뜨리지 않는다.
- **한 번 놓쳐도 다음이 고친다.** 4-2가 정확히 이 경우다 —
  `EntryService.claimSeat`이 커밋 뒤 `mutateSnapshot`에서 던져 `seatPlayer`가
  스킵되면, 지금은 **재시도로도 안 낫는다**(같은 OTP로 다시 오면 `promoted = 0`).
  대입이면 다음 착석·탈락 한 번이 값을 통째로 다시 써서 드리프트를 지운다.
- **재기동이 최후의 그물이다.** 복구가 항상 대입하므로, 짝을 빠뜨린 새 경로가
  생겨도 그 대회의 다음 재기동에서 사라진다.

즉 **빠뜨릴 수 있는 줄이 여전히 있지만, 빠뜨린 결과가 영구적이지 않다.**
`mutateSnapshot`이 스냅샷 쓰기에 한 것과 방식은 다르되 목적은 같다.

## 인터페이스

### `RedisService`

```ts
/**
 * 인원수를 DB 값으로 맞춘다. **대입이다.**
 *
 * 호출부는 DB 트랜잭션이 돌려준 `Tournament.activePlayers`를 그대로 넘긴다.
 * 상대 증감이 아니라서 두 번 불러도, 한 번 놓쳐도 다음 호출이 고친다.
 */
async syncActivePlayer(
  tournamentId: string, activePlayers: number,
  startStack: number, entryFee: number,
): Promise<void>
```

`seatPlayer`와 `eliminatedPlayer`를 **지운다.** 남겨 두면 상대 증감 경로가
살아 있어 새 호출부가 그쪽을 고를 수 있다 — 검사가 둘이면 한쪽만 고쳐지는 날이
온다는 것과 같은 문제다. 호출부는 각각 한 곳뿐이라 대체가 좁다.

`rebuyPlayer`는 `activePlayer`를 건드리지 않으므로 그대로 둔다.

### 변화가 0이어도 대입한다

네 호출부 모두 "실제로 바뀐 행 수"가 0일 수 있다 — 재입장(`RELEASED` →
`PLAYING`), 중복 킥, 중복 탈락이다. 그때도 트랜잭션은 **현재**
`activePlayers`를 읽어 돌려주고 호출부는 그대로 대입한다.

지금 코드가 `changed.count > 0`으로 감싸는 것은 상대 증감이 멱등이 아니어서였다.
대입에는 그 이유가 없고, 오히려 **중복 도착이 드리프트를 지우는 기회**가 된다.
`RedisService.seatPlayer`의 `if (count <= 0) return` 가드도 같은 이유로 사라진다.

### `recalculateAvgStack`의 분모

지금은 `parseInt(active || '1')`이다. 필드가 없을 때 분모가 0이 아니라 **1**이라,
바로 아래 `activeNum > 0` 가드가 무력해지고 `avgStack`이 "전체 칩 총량"으로
튄다. `'0'`으로 고쳐 가드를 살린다(대장의 잔여 목록, 묻어갈 곳 = T60).

## 고칠 자리 넷

### 4-1 · KICK — `DealerService.handleDealerAction`

트랜잭션이 `activePlayers`를 `select`해 돌려주고, 그 값으로 `syncActivePlayer`를
부른다.

**최후 1인 판정은 새로 달지 않는다.** `tournamentFinished`를 부르는 자리는
`eliminatePlayer` 하나뿐이라, 킥으로 마지막 한 명이 남으면 대회를 닫을 경로가
없다. 그 상황은 "헤즈업에서 딜러가 킥한다"이고, 규칙으로 막는 것이 옳다는 판단이
섰다(2026-08-21) — `backlog.md`의 **파이널 테이블부터의 딜러 개입 제한**.
**그 규칙이 서기 전까지 이 구멍은 남는다.** T60은 카운터만 맞춘다.

### 4-2 · 착석 — `EntryService.claimSeat`

트랜잭션이 `promoted`(바뀐 행 수)와 함께 갱신 후 `activePlayers`를 돌려준다.
`seatPlayer(promoted)` 자리에 `syncActivePlayer(activePlayers)`가 들어간다.

호출 위치는 **지금과 같다** — 스냅샷을 쓴 뒤다. 앞으로 당기면 "좌석 행은 있는데
스냅샷이 없다"는 창이 넓어지고 `shouldBlockEmptySnapshot`이 동시 착석자에게
409를 준다(이미 겪은 회귀다).

**주석을 고친다.** 지금 주석은 "이쪽이 실패하면 재기동 복구가 DB의
`activePlayers`로 메타를 다시 세우므로 낫는다"라고 적혀 있는데 **사실이 아니다** —
복구는 info 키가 통째로 없을 때만 그렇게 한다. 이 설계가 그 문장을 사실로
만든다(아래 「복구」).

### 4-3 · 딜러 로그인 — `DealerService.loginDealer`

`WAITING → PLAYING` 승격 트랜잭션에 같은 처리를 붙인다. 지금은 DB만 오른다.

### 4-4 · 시드 — `prisma/seed.ts`

`activePlayers: players.length`를 **0**으로 바꾼다. T55 이후 이 값은 **첫 착석만**
올리는 값인데(`PaymentService.joinSession`은 주석까지 달아 가며 올리지 않는다),
시드가 참가자를 전원 `WAITING`으로 만든 뒤 7을 써 넣어 착석 후 14가 된다.

`seed-load.ts`는 이 필드를 건드리지 않아 이미 옳다. 두 시드가 같은 규칙 위에
선다.

## 판정의 이관 — `PlaysyncService.eliminatePlayer`

두 값이 Redis 대시보드에서 왔다. 둘 다 트랜잭션 안으로 옮긴다.

| 지금 | 바뀐 뒤 |
|---|---|
| `eliminatedRank = tournamentInfo.activePlayer` | 트랜잭션 안에서 읽은 **감소 전** `activePlayers` |
| `activePlayerCount = await redis.eliminatedPlayer(...)` | 트랜잭션이 돌려준 **감소 후** `activePlayers` |

등수가 상금을 정하므로(`prizeFor`) 이 값이 화면용 캐시에서 오는 것은 그 자체로
위험하다. 대장이 지적한 4-4의 증상 — 첫 탈락이 "14위"라 상금이 한 푼도 안
나가는 것 — 이 경로를 그대로 지난 것이다.

`tournamentInfo` 인자는 `startStack`·`entryFee`에 계속 쓰이므로 남긴다.

## 복구 — 항상 맞춘다

`RecoveryService.recoverTournament`의 `blind`가 살아 있는 분기에서도
`syncActivePlayer`를 부른다. `downtime`과 무관하다 — 다운타임이 0이어도 카운터는
어긋나 있을 수 있다.

메타를 통째로 잃은 분기(`else`)는 `buildTournamentMeta`가 이미 DB
`activePlayers`를 싣고 있으므로 그대로 둔다.

이것이 **최후의 그물**이다. 짝을 빠뜨린 새 경로가 생겨도 그 대회의 다음
재기동에서 사라진다.

## 테스트

전부 통합이다. 검증 대상이 "DB와 Redis가 갈라지지 않는가"라 진짜 둘이 있어야
의미가 있다.

| 무엇 | 어디 | 지금 왜 못 잡나 |
|---|---|---|
| 킥이 Redis도 깎는다 | `playsync/elimination.int-spec.ts`의 딜러 킥 절 | DB `activePlayers`만 단언한다 |
| 착석이 스냅샷 뒤에서 던져도 다음 인원 변화가 값을 되찾는다 | `entry` 통합 | 이 경로를 아무도 안 본다 |
| 딜러 로그인의 승격이 Redis에 반영된다 | `dealer` 통합 | 없다 |
| 탈락 등수가 Redis 캐시가 아니라 DB에서 온다 | `playsync` 통합 | 둘이 같은 입력만 먹였다 |
| 복구가 어긋난 카운터를 맞춘다 | `recovery` 통합 | info 키를 통째로 지운 경우만 본다 |
| 시드가 인원을 이중 계상하지 않는다 | `prisma/seed.ts` 대상 | 시드에 테스트가 없다 |

### 둘이 어긋나는 입력을 먹인다

T29에서 물린 것을 반복하지 않는다 — 두 검사에 **일치하는 입력만** 먹이면 검사
하나를 통째로 지워도 전부 초록이다. 카운터가 둘인 이 티켓은 정확히 그 함정
위에 있다. **DB와 Redis를 일부러 갈라 놓고 시작하는 케이스**가 각 테스트에
있어야 "맞췄다"가 증명된다.

### 실패를 먼저 본다

사후에 추가한 검사는 제품 코드를 되돌려 빨간불을 확인한다.

## 하지 않는 것

- **KICK 경로의 최후 1인 판정.** 위 4-1. 규칙으로 막는다
- **인원수의 단일 함수화.** `activePlayers`를 직접 `update`하는 것을 금지하고
  전이 함수 하나로 감싸는 안은, 대입이 드리프트를 자가 치유하므로 값에 비해
  범위가 크다. 네 호출부의 트랜잭션 모양이 서로 달라(승격 · 탈락 · 킥 · 상금)
  공통 함수가 얇아지지 않는다
- **Redis 카운터 제거.** 전광판이 `hgetall` 한 번으로 읽는 구조를 깬다
