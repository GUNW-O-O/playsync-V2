# T31 — 서버 장애 복구

**전신**: `backlog.md`의 B2. 그 절의 축소본(`buttonUser` 영속화 + 누적 진행시간
필드 + 재구성 함수 하나)을 그대로 받는다.

---

## 왜

Redis AOF는 켜져 있다(`docker-compose.yml:20`, `--appendonly yes`). 그런데
**되살리는 코드가 하나도 없다.** 서버가 다시 뜨면 Redis에 무엇이 있든 없든
아무도 확인하지 않고, 블라인드 시계는 죽어 있던 시간을 진행 시간으로 셈한다.

두 가지가 별개로 깨진다.

**블라인드가 앞질러 간다.** 레벨은 `startedAt`과 현재 시각의 차이로 매번 다시
계산된다(`shared/util/util.ts:4`, `getCurrentBlindLevel`). 20분 서 있었으면 복구
직후 레벨이 20분만큼 앞에 있다. 아무도 플레이하지 않은 20분이 진행 시간으로
들어간 것이다.

**버튼 위치를 잃는다.** `TableState.buttonUser`(`src/game-engine/types.ts:59`)가
DB 어디에도 없다. `Table` 모델에 상태 컬럼이 하나도 없고, 좌석
(`TablePlayer.seatPosition`)과 칩(`TournamentParticipation.currentStack`)만 있다.
스냅샷이 사라지면 다음 핸드 블라인드가 엉뚱한 사람에게 간다.

그리고 `currentStack`은 지금 **읽는 코드가 0이다.** 쓰기만 셋이다
(`payment.service.ts:107`, `playsync.service.ts:226`, `playsync.service.ts:546`).
체크포인트는 찍히는데 그걸로 되돌리는 경로가 없다. 이 티켓의 재구성 함수가
첫 독자가 된다.

---

## 무엇을

서버가 다시 뜰 때 스스로 복구한다. **엔드포인트도 화면도 만들지 않는다.**

| | 무엇 |
|---|---|
| 스키마 | `Table.buttonUser`, `Tournament.pausedMs`, `ServerHeartbeat` |
| 쓰기 | 시작 트랜잭션과 핸드 종료 트랜잭션에 `buttonUser` |
| 주기 작업 | 하트비트 (Redis ping이 조건) |
| 부팅 훅 | 정지 시간 보정 → 스냅샷 없는 테이블만 재구성 |
| API·화면 | **없다** |

**재구성은 상점이 판단할 일이 아니다.** 서버를 되살리는 것은 플랫폼의 책임이다.
상점 운영자는 대회를 운영하고, 장애 복구는 그 아래에서 조용히 끝나야 한다.
그래서 상점 콘솔에 버튼이 생기지 않는다.

backlog가 B2를 앞으로 뺀 근거는 그대로다 — 스키마 변경이 있어 마이그레이션이
겹치지 않게 일찍 해야 한다(`backlog.md:34`). 다만 **프론트에 미치는 영향은
0이다.** B5·B7과 엮이지 않는다.

---

## 두 가지 장애를 구분한다

이 티켓이 다루는 것은 둘이고, 하는 일이 다르다.

| 장애 | Redis | 하는 일 |
|---|---|---|
| 서버만 셧다운 | 볼륨 살아 있음. AOF 재생 | 정지 시간만 보정. **스냅샷은 손대지 않는다** |
| 셧다운 + Redis 데이터 유실 | 볼륨 유실 / AOF 손상 / 새 인스턴스 | 정지 시간 보정 + DB로 스냅샷 재구성 |

첫 번째에서 AOF가 이미 많은 것을 지킨다. `appendfsync`를 주지 않았으므로 Redis
기본값 `everysec`이고, 유실 상한은 **한 핸드가 아니라 약 1초**다. 스냅샷이
살아 돌아오니 재구성할 것이 없다.

두 번째에서 AOF는 0이다. 여기서만 DB가 유일한 근거가 된다.

---

## 결정 1 — 두 `startedAt`을 다른 뜻으로 갈라 선언한다

`startedAt`이라는 이름이 두 곳에 있다.

| | 뜻 |
|---|---|
| `Tournament.startedAt` (`schema.prisma:137`) | 대회가 **실제로** 시작된 시각 |
| `BlindField.startedAt` (`shared/types/tournamentMeta.ts:33`) | 블라인드 시계의 기준점 |

지금 이 둘은 같은 값이고, `startSession`이 **일부러 맞춘다**
(`session.service.ts:391-399`). 주석이 그렇게 하라고 적혀 있다.

정지 시간을 보정하는 가장 단순한 방법은 블라인드 기준점을 뒤로 미는 것이다.
그런데 두 값이 같은 것이라면 미는 순간 `Tournament.startedAt`도 거짓이 된다 —
20분 밀면 "이 대회는 20분 늦게 시작했다"가 DB에 남는다. 그 값은 사용자에게
그대로 보인다(`user.service.ts:80`이 select한다).

**그래서 뜻을 가른다.** `Tournament.startedAt`은 대회 시작 시각이고 **절대
안 밀린다.** `BlindField.startedAt`은 진행 시간의 기준점이고 **밀린다.**
시작 시점에 두 값이 같은 것은 정합이 아니라 t=0의 우연이다.

`session.service.ts:391-399`의 주석은 정합을 맞추라고 말하고 있으므로 **고친다.**
안 고치면 나중에 읽는 사람이 둘을 다시 묶는다.

### 스톱워치 모델을 채택하지 않는 이유

경과 시간을 wall-clock 차이 대신 누적으로 들고 가는 모양
(`elapsedMs` + `resumedAt`, `resumedAt === null`이면 정지)도 검토했다. 이쪽의
이점으로 꼽은 것은 "장애 정지와 운영자 수동 정지가 같은 메커니즘이 된다"였다.

**그 이점은 요구사항이 아니다.** 홀덤에서 운영자가 핸드 중간에 대회를 끊는
상황은 없다. 있는 것은 예정된 휴식이고 그건 이미 블라인드 구조표의 `lv === 99`가
표현한다(`util.ts:21`). 없는 요구를 위해 `getCurrentBlindLevel`의 시그니처와
`BlindField`를 바꾸고 기존 테스트를 손보는 것은 비용만 남는다.

뜻을 가르는 것으로 같은 결과가 나오고, 시그니처는 그대로다.

### 필드

`Tournament.pausedMs Int @default(0)` — 이 대회가 장애로 정지한 **누적** 시간.

누적인 이유: 대회 하나가 두 번 장애를 겪을 수 있다. 덮어쓰면 첫 번째가 사라지고,
`BlindField.startedAt`은 이미 첫 번째만큼 밀려 있으므로 두 번째는 더해야 맞다.

`@default(0)`이지 `null`이 아닌 이유는 기계적이다 — Prisma `increment`가 `null`에
먹지 않는다. "장애가 없었다"는 0이 충분히 말한다.

### 두 복구 경로가 이 컬럼을 함께 쓴다

이 값이 DB에 있어야 하는 이유다.

| 상황 | 하는 일 |
|---|---|
| 스냅샷 살아 있음 | 기존 `BlindField.startedAt += 정지시간` |
| 스냅샷 유실 | `BlindField`를 새로 만든다. 기준점 = `Tournament.startedAt + pausedMs` |

두 번째가 없으면 재구성 함수가 블라인드 시계를 세울 재료가 없다.

---

## 결정 2 — 하트비트는 서버 단위 한 행이고, Redis ping이 조건이다

정지 시간을 사람에게 묻지 않는다. 서버가 마지막으로 살아 있던 시각을 스스로
남긴다.

### 서버 단위다

**하트비트는 이 서버가 관리하는 전체 대회에 대한 것이다.** 대회마다 찍지 않는다.
근거 둘:

- 단위가 그렇다. "한 행사장 한 프로세스"가 이 시스템의 배치 단위다
  (`backlog.md:85`). 서버가 죽으면 그 서버의 모든 대회가 같이 죽는다. 대회별로
  다른 다운타임이 나올 수 없다.
- 쓰기가 대회 수에 비례하지 않는다. 대회가 셋이면 30초에 UPDATE 하나지 셋이
  아니다.

```prisma
/// 서버가 마지막으로 살아 있던 시각. 행이 하나다 — "한 행사장 한 프로세스"가
/// 배치 단위라 이 서버가 죽으면 그가 든 모든 대회가 같이 죽는다.
model ServerHeartbeat {
  id     String   @id @default("singleton")
  beatAt DateTime
}
```

`beatAt`을 `@updatedAt`으로 두지 않는다. 그러면 값이 Prisma의 update 동작에
묶이는데, 우리는 **Redis ping이 성공했을 때만** 이 값이 올라가야 한다. 명시적으로
쓰는 것이 조건과 값의 관계를 한 자리에 남긴다. 쓰기는 `upsert` 하나다 — 최초
부팅에 행을 만들고, 그 뒤에는 갱신한다.

### DB에 쓴다

Redis에 쓰면 **Redis가 날아간 케이스에서 하트비트도 같이 날아간다.** 정확히
필요한 순간에 없어진다. 그래서 DB다. 30초에 UPDATE 한 줄은 무해하다.

### Redis ping이 성공할 때만 찍는다

시각만 찍으면 "서버는 살아 있고 Redis만 죽은" 구간을 못 잡는다. 대회는 멈춰
있는데(모든 게임 경로가 스냅샷을 못 읽어 던진다) 하트비트는 계속 찍혀서 정지
시간이 0이 된다.

Redis 왕복이 성공할 때만 찍으면 그 구간도 자동으로 다운타임에 들어간다. 조건
하나로 케이스 하나가 닫힌다.

### 임계값을 두지 않는다

`정지시간 = now - beatAt`을 **항상** 더한다. "얼마 이상이면 장애"를 정하지
않는다. 정상 재시작 5초도 5초 밀리는데 그게 맞다 — 그 5초 동안 대회는 진짜로
돌지 않았다.

행이 없을 때만(서버 최초 부팅) 건너뛴다. 그때는 비교 대상이 없다.

과소계상은 마지막 하트비트 이후 죽기까지의 최대 한 주기(30초)다. 레벨이 분
단위라 무해하다.

### 구현 수단

`@nestjs/schedule`이 리포에 없다. BullMQ는 있지만(`@nestjs/bullmq`) 반복 잡은
Redis에 살고 at-least-once라 하트비트에는 중복이 노이즈다.

**`setInterval` + `onModuleInit`/`onModuleDestroy`로 간다.** 새 의존성 0, 새 큐
0. `prisma.service.ts:53`이 이미 같은 라이프사이클 패턴을 쓰고 있어 배선이
같다. Redis ping 조건이 코드에 명시적으로 보이는 것도 이쪽이다.

---

## 결정 3 — `buttonUser`는 좌석 인덱스로, 이미 있는 체크포인트에 쓴다

### 왜 스냅샷에서 복구할 수 없나

`TableState`가 바로 잃는 물건이다(Redis `table:state:{tableId}`). 갈래가 둘뿐이다.

- 스냅샷이 살아 있다 → `buttonUser`도 거기 있다. **복구할 게 없다.**
- 스냅샷이 없다 → 읽을 것이 존재하지 않는다.

"스냅샷에서 복구"는 선택지가 아니라 복구가 필요 없는 경우의 정의다.

두 번째 이유가 더 중요하다. `TableState`의 필드를 전부 훑으면 `buttonUser`만
DB에서 나오지 않는다.

| 필드 | 복구 출처 |
|---|---|
| `players[].seatIndex` | `TablePlayer.seatPosition` |
| `players[].id` / `nickname` | `TablePlayer.userId` / `nickname` |
| `players[].stack` | `TournamentParticipation.currentStack` |
| `phase` | `WAITING` — 핸드 경계에서 재개한다 |
| `pot`, `sidePots`, `currentBet`, `bet`, `totalContributed` | 0. 핸드 경계다 |
| `hasFolded`, `hasChecked`, `isAllIn` | `false` |
| `smallBlind`, `ante` | `Tournament.startedAt + pausedMs` → `getCurrentBlindLevel` |
| `currentTurnSeatIndex` | 없음 (`WAITING`) |
| `actionDeadline`, `timerEpoch`, `dbSyncStatus` | 초기화 |
| `tournamentId` | `Table.tournamentId` |
| **`buttonUser`** | **없다** |

`buttonUser`만 **역사의 함수**다. 나머지는 전부 현재 사실 — 누가 어디 앉았고,
칩이 얼마고, 몇 분 지났나 — 에서 나온다. 버튼은 "지난 핸드에 누가 버튼이었나"
에서만 나온다. 현재 상태를 아무리 봐도 뽑을 수 없다.

### 좌석 인덱스로 적는다

`Table.buttonUser Int?` — `TablePlayer.seatPosition`과 같은 좌표계다.

`userId`로 두는 안도 검토했다. 그쪽은 "그 사람이 이미 나갔다"를 푸는 분기가
하나 늘어난다. 인덱스는 `findNextActiveSeat`가 이미 빈 좌석을 건너뛰므로
(`table-engine.ts:401`) 코드가 이미 있다.

**그리고 다운타임 동안 좌석이 바뀔 창이 없다.** 확률이 아니라 구조다 — 좌석을
바꾸는 모든 경로가 스냅샷을 먼저 읽고 없으면 던진다.

```
playsync.service.ts:40   if (!tableState) throw new Error(`TableState ${tableId} not found`)
dealer.service.ts:363    if (!state) throw new Error('테이블을 찾을 수 없습니다.')
```

`releaseSeats`도 스냅샷 404가 앞에 있다(T29). 탈락도 해제도 스냅샷 없이는 돌지
않는다. 다운타임 동안 좌석은 얼어붙는다.

예외가 하나 있는데, 그것이 결정 5다.

### 쓰는 자리 둘

**핸드 종료 체크포인트.** `syncTableInventoryToDb`
(`playsync.service.ts:219`)가 핸드마다 `currentStack`을 트랜잭션으로 쓴다. 같은
트랜잭션에 `Table.buttonUser` 한 줄을 더한다. 그러면 DB는 **최대 한 핸드 낡은**
상태다.

핸드 중간에 죽으면 그 핸드는 잃는다. **그게 맞다** — 카드가 물리라 그 핸드는
사람이 다시 딜한다. 시스템이 지킬 선은 "다음 핸드가 옳은 사람에게서 시작된다"
까지다.

**시작 트랜잭션.** `initializeGame`이 테이블마다 버튼을 랜덤으로 뽑는다
(`session.service.ts:468-469`). 랜덤인 것은 맞다 — 첫 버튼 추첨이다. 그런데 그
값이 DB에 없어서, 첫 핸드가 끝나기 전에 죽으면 읽을 것이 없다.

`initializeGame`의 반환에 뽑은 값을 실어 보내고, `startSession`의 트랜잭션
(`session.service.ts:391`)이 `status`·`startedAt`과 함께 쓴다. 그러면 시작 이후
`buttonUser`가 `null`인 구간이 사라진다.

`Int?`로 두는 이유는 시작 **전**에는 값이 없기 때문이다. 재구성은 ONGOING
대회만 보므로 그때는 항상 채워져 있다.

---

## 결정 4 — 재구성은 부팅 시 자동이고, 판정 기준은 스냅샷 유무다

### 서버는 무슨 일이 있었는지 추측하지 않는다

"정상 재시작이었나 Redis가 날아갔나"를 서버가 판단하려 하면 근거가 없다. 대신
**지금 무엇이 없는지**만 본다.

판정의 **단위가 둘이라는 점이 중요하다.** 블라인드 시계는 대회 하나에 하나고
(`tournament:{id}:info`의 `blindField`), 스냅샷과 좌석 비트맵은 테이블마다다.
섞으면 안 된다.

부팅 훅에서 `ONGOING` 대회를 훑고, 대회마다:

1. `정지시간 = now - beatAt`. 하트비트 행이 없으면 이 대회의 보정을 건너뛴다.
2. `pausedMs += 정지시간` (DB).
3. **대회 단위** — `getTournamentBlind`:
   - 있음 → `BlindField.startedAt += 정지시간`. 나머지 필드는 손대지 않는다
   - 없음 → `initializeGame`의 dashboard·blindField 구성을 그대로 다시 돌린다.
     기준점만 `Tournament.startedAt + pausedMs`
4. **테이블 단위** — 착석 테이블마다 `getSnapShot`:
   - 있음 → **아무것도 하지 않는다.** 스냅샷에는 시간이 안 들어 있다
   - 없음 → DB로 스냅샷과 좌석 비트맵을 세운다

3단계가 대회 단위인 이유는 `BlindField`가 대회 하나에 하나이기 때문이다. 테이블
루프 안에서 밀면 테이블 수만큼 밀린다.

4단계에서 스냅샷이 살아 있으면 손댈 것이 없다 — `smallBlind`·`ante`는 다음 핸드
시작(`startPreFlop`)이 그때의 블라인드로 다시 채우므로, 3단계가 고친 기준점이
자동으로 반영된다.

**테이블 단위 판정이라 부분 유실도 커버된다.** 그리고 관심사가 갈린다 — 하트비트는
정지 시간만 정하고, 키 유무는 재구성 여부만 정한다. 서로 엮이지 않는다.

### 재구성 함수는 `initializeGame`의 세 군데를 바꾼 것이다

`initializeGame`(`session.service.ts:406`)이 이미 재구성의 대부분을 한다.
dashboard 필드 전부가 `Tournament` 컬럼에서 나오고 blindStructure도 relation에서
나온다. "Redis가 통째로 날아가도 DB로 다시 세울 수 있다"가 이미 코드로 증명돼
있다.

| # | 지금 | 재구성 |
|---|---|---|
| 1 | `const startedAt = new Date()` (`:420`) | `Tournament.startedAt + pausedMs` |
| 2 | `btnIdx` 랜덤 추첨 (`:468`) | `Table.buttonUser`를 읽는다 |
| 3 | `initialState = await this.redis.getSnapShot(t.id)` (`:471`) | **DB로 `players`를 짠다** |

세 번째가 진짜 구멍이다. 지금은 스택을 기존 스냅샷에서 가져오므로 스냅샷이
없으면 아무것도 못 세운다. 재구성은 `TablePlayer.seatPosition` +
`TournamentParticipation.currentStack`으로 `players` 배열을 새로 짠다 — 그리고
이것이 `currentStack`의 **첫 독자**가 된다.

`TournamentParticipation.status`가 `PLAYING`인 사람만 앉힌다. `ELIMINATED`와
`AWARDED`는 좌석 행이 남아 있을 수 있으므로(T29의 검사 3) 좌석만 보면 탈락자를
되살린다.

재구성은 스냅샷과 **좌석 비트맵**을 함께 세운다. 비트맵도 Redis에 산다
(`tournament:{id}:seat` 해시의 `table:{tableId}` 필드). 스냅샷만 세우면
`entry`가 좌석을 비어 있는 것으로 보고 다른 사람에게 팔 수 있다.

### 실패는 대회 단위로 격리한다

재구성이 한 대회에서 실패해도 프로세스를 죽이지 않는다. 대회 하나 때문에 다른
대회까지 못 뜨는 것은 과하다. 시끄럽게 로그를 남기고 다음 대회로 간다.

에러가 조용해지는 것이 아니다 — 실패한 대회는 스냅샷이 계속 없는 상태이므로
게임 경로가 전부 던진다. 딜러가 첫 액션에서 즉시 안다.

**단, 그 안전성이 결정 5에 의존한다.**

---

## 결정 5 — `entry`의 빈 스냅샷 fallback을 대회 시작 전으로 가둔다

스냅샷을 읽는 경로 중 하나만 던지지 않는다.

```ts
// entry.service.ts:212
const state =
  (await this.redis.getSnapShot(dto.tableId)) ?? this.emptyTableState(tournamentId);
```

이 fallback은 **정상 흐름에 필요하다.** 대회 시작 전 첫 착석이 스냅샷을 만드는
경로다.

그런데 대회 진행 중 스냅샷이 없는 상태에서 리바인이나 재입장 한 명이 도착하면:

```ts
// entry.service.ts:281
private emptyTableState(tournamentId: string): TableState {
  return { phase: WAITING, players: Array(9).fill(null),
           buttonUser: 0, smallBlind: 100, ... };
}
```

그 테이블의 **나머지 전원이 스냅샷에서 사라진다.** `buttonUser`는 0,
`smallBlind`는 100으로 굳는다. DB에는 다 남아 있는데 스냅샷만 한 명이 된다.
그리고 재구성이 나중에 돌면 이미 오염된 위에서 돈다.

**그래서 이 가드는 선택이 아니다.** 결정 4가 실패를 대회 단위로 격리하는 순간,
스냅샷 없이 서버가 뜨는 상태가 정상 경로에 들어온다. 그때 `entry`가 빈 스냅샷을
만들면 격리가 파괴로 바뀐다.

대회가 `ONGOING`인데 스냅샷이 없으면 fallback 대신 던진다. fallback은 시작 전에만
남는다.

이것이 재구성을 **부팅 시 자동**으로 두는 이유이기도 하다. 사람이 누르는
방식이면 그 버튼보다 `entry`가 먼저 도착할 수 있다.

---

## 에러

에러는 시끄럽게 낸다.

| 상황 | 하는 일 |
|---|---|
| 하트비트 행 없음 (최초 부팅) | 정지 시간 보정 건너뜀. `info` 로그 |
| 하트비트 UPDATE 실패 | `warn`. 다음 주기가 재시도다. 프로세스는 유지 |
| Redis ping 실패 | 하트비트를 **찍지 않는다.** `warn` |
| 재구성 중 한 대회 실패 | `error`. 그 대회만 건너뛰고 다음으로. 프로세스는 뜬다 |
| `ONGOING`인데 `Table.buttonUser`가 `null` | 그 테이블 재구성 실패로 본다. 시작 트랜잭션이 채우므로 일어나면 버그다 |
| `ONGOING`인데 스냅샷 없고 `entry` 도착 | 409. `emptyTableState`로 새지 않는다 |

---

## 테스트

### 단위

- 두 `startedAt`이 갈라졌다: `pausedMs`가 0이 아닐 때
  `Tournament.startedAt`은 그대로고 블라인드 기준점만 밀린다
- 정지 시간이 **누적**된다: 두 번 보정하면 합이 더해진다. 덮어쓰기면 실패한다
- `getCurrentBlindLevel`이 기준점을 밀었을 때 레벨을 되돌린다

### 통합

- 하트비트가 Redis ping 실패 시 찍히지 않는다
- 하트비트 행이 없으면 보정을 건너뛴다
- `blindField`가 살아 있으면 기준점만 밀고 나머지 필드는 그대로 둔다
- `blindField`가 없으면 `Tournament.startedAt + pausedMs`로 새로 세운다
- 기준점을 **대회당 한 번만** 민다: 테이블이 셋인 대회에서 밀린 양이 정지 시간과
  같다. 테이블 루프 안에서 밀면 3배가 되어 빨개진다
- 부팅 훅이 스냅샷 있는 테이블은 **건드리지 않는다**
- 부팅 훅이 스냅샷 없는 테이블만 재구성한다 (한 대회 안에 둘이 섞인 입력)
- 재구성이 `PLAYING`만 앉힌다: `ELIMINATED`/`AWARDED` 좌석 행이 남아 있어도
  스냅샷에 안 들어간다
- 재구성이 좌석 비트맵도 세운다
- 재구성이 한 대회에서 실패해도 다른 대회는 복구된다
- `ONGOING` + 스냅샷 없음에서 `entry`가 409를 던지고 빈 스냅샷을 만들지 않는다
- 시작 전 첫 착석은 여전히 fallback으로 스냅샷을 만든다 (가드가 정상 경로를
  깨지 않는다)
- 핸드 종료 체크포인트가 `buttonUser`를 쓴다
- 시작 트랜잭션이 `buttonUser`를 쓴다

### 시나리오

`src/scenario/`에 하나. 대회를 시작해 몇 핸드 돌린 뒤:

1. Redis를 통째로 비운다 (`FLUSHDB`)
2. 하트비트를 과거로 되돌린다
3. 부팅 훅을 돌린다
4. **불변식을 검사한다**: 칩 총량 보존, 좌석 비트맵 == 스냅샷,
   `buttonUser` == 마지막 체크포인트 값, 블라인드 레벨이 정지 시간만큼 되돌아옴
5. 이어서 핸드를 하나 더 돌려 정상 진행되는지 본다

**두 검사가 서로를 가리지 않게** 입력을 만든다(CLAUDE.md의 네 번째 가짜 초록).
스냅샷 유무 판정과 시간 보정은 별개이므로, **한 대회 안에 스냅샷이 있는 테이블과
없는 테이블을 섞는다.** 둘이 일치하는 입력만 먹이면 판정 코드를 지워도 초록이
된다.

### RED을 먼저 본다

사후에 추가하는 검사는 제품 코드를 일부러 되돌려 빨간불을 확인한다. 특히:

- `pausedMs` 누적을 덮어쓰기(`=`)로 바꾸면 누적 테스트가 빨개져야 한다
- 재구성의 `status: PLAYING` 필터를 지우면 탈락자 테스트가 빨개져야 한다
- `entry` 가드를 지우면 409 테스트가 빨개져야 한다

---

## 감수한 것

**핸드 중간은 복구되지 않는다.** `pot`·`bet`·`currentTurnSeatIndex`는 체크포인트
사이에만 존재한다. 카드가 물리라 그 핸드는 사람이 다시 딜한다. 시스템이 지킬
선은 핸드 경계다.

이 선을 더 밀 수 있지만 **밀지 않는다.** 액션마다 DB를 쓰면 핸드 중간까지
복구되는데, 그러면 Redis를 캐시로 둔 이유가 사라지고 락 구간에 DB 왕복이
들어간다 — 이 리포가 T8부터 T29까지 지켜 온 "락 안에서 무한 대기 없음"에 정면으로
부딪힌다. 상한을 핸드 경계로 두는 것이 설계다.

**`buttonUser`가 최대 한 핸드 낡다.** 체크포인트 주기가 그것이다.

**버튼 한 바퀴의 공정성이 어긋날 수 있다.** 좌석 인덱스로 적으므로, 복구 시점에
그 좌석이 비어 있으면 `findNextActiveSeat`가 다음 사람을 집는다. 동작은 하고,
어긋나는 것은 순서의 공정성이다. 다운타임 중에는 좌석이 얼어붙어 이 창이 거의
없고, 복구는 딜러가 보고 있는 상황이라 육안으로 고칠 수 있다.

**정지 시간이 최대 한 하트비트 주기만큼 과소계상된다.** 마지막 하트비트 이후
죽기까지의 구간이다. 레벨이 분 단위라 30초는 무해하다.

**태블릿이 못 붙는 정지는 잡지 못한다.** 서버와 Redis가 정상인데 행사장 WiFi만
끊긴 경우, 하트비트는 계속 찍히고 블라인드는 계속 오른다. 자동으로는 알 수 없다.
운영자의 수동 레벨 지정이 이 케이스를 위한 것인데, backlog가 이미 범위 밖으로
뺐다(`backlog.md:66`).

---

## 범위 밖

- **운영자 조작 화면과 수동 레벨 지정.** backlog의 축소가 이미 뺐다. 재구성이
  자동이므로 상점이 판단할 것이 남지 않는다.
- **`activePlayers`의 기준(T30).** 재구성이 카운터를 다시 계산하지 않는다. DB
  누적값을 그대로 읽는다. 그 값이 결제 기준이라 노쇼에서 안 깎이는 문제는 T30이다.
- **AOF 설정 강화.** `appendfsync always`로 바꾸면 유실이 0에 가까워지지만 쓰기
  지연이 붙는다. 지금 `everysec`의 1초 상한은 이 티켓이 다루는 두 케이스 어느
  쪽도 바꾸지 않는다.
- **여러 서버.** 하트비트가 단일 행이므로 서버가 둘이면 서로를 덮어쓴다. "한
  행사장 한 프로세스"가 단위라는 전제(`backlog.md:85`, B9 하지 않음)를 그대로
  따른다.
- **감사 로그(B10).** 언제 어떤 복구가 돌았는지 남기지 않는다. 로그만 남는다.
