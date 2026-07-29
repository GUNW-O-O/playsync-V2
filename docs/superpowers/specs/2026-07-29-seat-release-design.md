# T29 — 상점의 좌석 해제

**2026-07-29.** T28이 좌석을 입장 시점에 확정하게 만들었다. 이 티켓은 그 반대
방향을 만든다: 상점이 앉아 있는 사람을 자리에서 뗀다. 그리고 그러려면 칩이
좌석보다 오래 살아야 하므로, `currentStack`을 `TablePlayer`에서
`TournamentParticipation`으로 옮긴다.

B8(테이블 간 인원 이동)의 마지막 조각이다. T27(참가 OTP) → T28(입장 시 좌석
확정) → **T29(좌석 해제)**로 이 흐름이 닫힌다.

## 왜

지금 테이블 사이를 오가는 경로가 없다. `SessionService.manualMovingPlayer()`가
본문이 주석 두 줄인 스텁이고(`session.service.ts:675`), T25가 "테이블이 둘
이상일 때 참가자가 앉는 곳은 아무 데나"로 정하면서 3/4/3처럼 흩어진 인원을
교정할 수단이 하나도 없다.

**서버가 옮기지 않는다.** 처음에는 "상점이 좌석을 재배치하는 API"로 설계했다가
폐기했다([`2026-07-28-reseat-design.md`](./2026-07-28-reseat-design.md)). 서버가
좌석을 옮겨 놓아도 새 자리에 앉을 사람을 인증할 방법이 없었다 — 좌석 태블릿은
자리에 고정이고 사람이 걸어가도 세션은 따라가지 않는다.

**OTP는 사람을 따라간다.** 그래서 방향이 바뀌었다.

```
쉬는 시간. 상점 콘솔이 전체 판을 그린다
→ 옮길 사람들을 체크해서 해제한다
→ 오프라인에서 "3번 테이블로 가세요" 안내한다
→ 손님이 걸어가서 빈 자리에 앉는다
→ 폰(마이페이지)에서 참가 OTP를 확인해 그 태블릿에 넣는다 (T28)
→ 그 자리가 그 사람의 좌석이 된다
```

**이 흐름에 마법이 없다.** 시스템은 누구를 어디로 보낼지 정하지 않고, 상점이
체크한 사람을 뗄 뿐이다. 자동 밸런싱과 테이블 통합 규칙은 하지 않기로 한
것이다(`backlog.md`의 B8 절) — 언제 누구를 어디로 보낼지는 규칙이 아니라 현장
판단이다.

## 무엇을

1. `currentStack`을 `TournamentParticipation`으로 이사한다.
2. `POST /tournaments/:id/tables/:tableId/seats/release`를 만든다.
3. `startSession`의 참가자 일괄 `PLAYING` 승격을 지운다.

## 지금 구조

### 칩이 좌석에 산다

`TablePlayer.currentStack`이 현재 스택이다. 쓰는 곳 셋, 읽는 곳 하나.

| | 위치 | 하는 일 |
|---|---|---|
| 생성 | `entry.service.ts:153` | 착석하며 `startStack` 또는 기존 스택으로 |
| 체크포인트 | `playsync.service.ts:219` | 핸드마다 스냅샷의 스택을 DB로 |
| 리바인 | `playsync.service.ts:539` | `increment: startStack` |
| 읽기 | `entry.service.ts:93` | 재입장 시 `seated?.currentStack ?? startStack` |

좌석을 해제하면 `TablePlayer` 행이 사라지고 칩도 같이 사라진다. 그 사람이 다른
자리에 앉으면 `seated`가 `null`이라 `startStack`을 새로 받는다 — **칩이 복제된다.**

### 상태 기계가 반쪽이다

T28이 착석에서 `WAITING → PLAYING`을 올린다. 내려오는 경로는 탈락
(`ELIMINATED`)뿐이라, "칩은 있는데 자리는 없는" 상태를 표현할 방법이 없다.

여기에 `startSession`이 참가자 전원을 조건 없이 승격시킨다.

```ts
// session.service.ts:387-390
await tx.tournamentParticipation.updateMany({
  where: { tournamentId: id },              // 조건이 대회 하나뿐
  data: { status: PlayerStatus.PLAYING },
});
```

결제만 하고 오지 않은 사람도 시작 버튼 한 번에 `PLAYING`이 된다.

## 결정 1 — 칩의 집을 옮긴다

`currentStack`을 `TournamentParticipation`으로 옮긴다. 두 모델의 뜻이 갈린다.

| | 뜻 | 수명 |
|---|---|---|
| `TablePlayer` | **좌석 배치표** — 누가 어느 의자에 | 앉을 때 생기고 뜰 때 사라진다 |
| `TournamentParticipation` | **장부** — 참가·칩·상금 | 대회 내내 |

이사 후 `TablePlayer`에 남는 것은 `tournamentId`, `tableId`, `userId`,
`seatPosition`, `nickname`, `joinedAt`이다. 순수한 배치표가 된다.

### 쓰기 경로 셋이 전부 이미 참가 행을 안다

- **결제**가 참가 행을 만들 때 `currentStack: startStack`을 함께 넣는다
  (`payment.service.ts:99`). 좌석을 정하는 것이 아니라 **칩을 산 것**이므로
  T28이 그은 경계를 넘지 않는다.
- **리바인**은 아예 합쳐진다. `playsync.service.ts:532`가 이미
  `tournamentParticipation.update({ where: { tournamentId_userId } })`로
  `buyInCount`를 올리고 있으니 `currentStack: { increment: startStack }`을 같은
  update에 얹으면 `tablePlayer.update` 한 문장이 통째로 사라진다.
- **입장**은 `participation.currentStack`을 그대로 읽는다.
  `seated?.currentStack ?? startStack`이라는 분기가 없어진다 — 참가 행은 항상
  있고 항상 값이 있기 때문이다.

### 마이그레이션

`TournamentParticipation.currentStack Int @default(0)`을 추가하고, 기존
`TablePlayer.currentStack`을 참가 행으로 옮긴 뒤 컬럼을 지운다. 한 마이그레이션
안에서 세 문장이다.

```sql
ALTER TABLE "TournamentParticipation" ADD COLUMN "currentStack" INTEGER NOT NULL DEFAULT 0;

UPDATE "TournamentParticipation" p
   SET "currentStack" = t."currentStack"
  FROM "TablePlayer" t
 WHERE t."tournamentId" = p."tournamentId" AND t."userId" = p."userId";

ALTER TABLE "TablePlayer" DROP COLUMN "currentStack";
```

백필이 놓치는 것은 앉은 적 없는 참가자인데, 그 사람의 칩은 착석할 때
`startStack`으로 정해진다. 다만 이사 후에는 결제가 값을 넣으므로, **이 대회
중간에 배포하는 경우**에만 기본값 0이 남는다. 운영 배포가 없는 리포이므로
보정하지 않는다.

### 체크포인트는 시끄럽게 바꾼다

```ts
// 지금
this.prisma.tablePlayer.updateMany({
  where: { userId: p.id, tableId: p.tableId },
  data: { currentStack: p.stack },
})

// 바꾼 뒤
this.prisma.tournamentParticipation.update({
  where: { tournamentId_userId: { tournamentId: state.tournamentId, userId: p.id } },
  data: { currentStack: p.stack },
})
```

`updateMany`는 대상이 0행이어도 조용히 성공한다. T28 최종 리뷰가 찾은 결함이
정확히 그것이었다 — `TablePlayer`가 사라진 사람이 스냅샷에 남아 있으면 칩
불일치가 아무 에러 없이 진행됐다. `update`는 대상이 없으면 P2025로 즉시 터진다.

이미 `try/catch`가 감싸고 있어서(`syncTableInventoryToDb`) 유한 재시도 경로로
간다. 재시도가 전부 실패하면 `checkpointTableToDb`가 실패를 반환하고
`resolveWinners`가 다음 핸드로 넘어가지 않는다 — 기존 동작 그대로다.

## 결정 2 — 해제는 한 테이블, 묶음, 쌍으로 확인한다

```
POST /tournaments/:id/tables/:tableId/seats/release
{ "seats": [ { "seatIndex": 3, "userId": "..." }, ... ] }
```

`@Roles(STORE_ADMIN)` + 대회 소유권 검사(`assertTournamentOwnership`).

### 한 요청은 한 테이블만 다룬다

체크한 사람들이 여러 테이블에 걸치면 프론트가 테이블별로 나눠 보낸다.

락을 하나만 잡으므로 **데드락이 구조적으로 불가능하다.** 여러 테이블을 한
트랜잭션으로 묶으면 락 순서 규약(`tableOrder` 오름차순 같은)을 새로 만들어야
하는데, 그 규약을 다른 경로(`resolveWinners`, 입장)는 모른다. 규약을 아는
코드가 하나뿐인 규약은 규약이 아니다.

핸드 중인 테이블이 하나 있어도 나머지는 풀린다는 부수 효과도 있다.

### `userId`를 함께 받아 검증한다

상점 콘솔은 30초 전에 그린 판을 보고 체크한다. 그 사이 3번 자리 사람이
탈락하고 다른 사람이 OTP로 앉았을 수 있다 — T28이 핸드 도중 착석을 허용하므로
새 사람이 들어오는 창은 항상 열려 있다.

좌석 번호만 받으면 엉뚱한 사람을 뗀다. 쌍이 안 맞으면 409를 던져 화면을 새로
그리게 한다. **락 안에서 다시 검사한다**는 원칙을 API 경계까지 끌어올린 것이다.

### 해제된 사람은 `WAITING`으로 돌아간다

`PlayerStatus`의 주석이 원래 그렇게 적혀 있다 — `WAITING // 바이인 완료 후
대기`, `PLAYING // 테이블 착석 중`. T28의 착석이 올렸으니 해제가 되돌린다.

새 상태를 만들지 않는다. `MOVING` 같은 것을 넣으면 그것을 읽는 모든 곳(재입장
검사, 종료 조건, 전광판)에 분기가 하나씩 늘어나는데, 얻는 것은 상점 화면의
표시 문구 하나뿐이다.

재입장은 `ELIMINATED`/`AWARDED`만 막으므로 `WAITING`은 그대로 통과한다.

**단, `PLAYING`이 아닌 참가는 애초에 해제 대상이 아니다.** 끝난 참가에 좌석이
남는 경로가 둘 있다.

- **킥.** `handleDealerAction`의 KICK은 상태를 `ELIMINATED`로 내리고
  `activePlayers`를 깎지만 `TablePlayer` 행은 지우지 않는다 — 엔진은 폴드만
  시킨다. 그 사람은 칩과 함께 스냅샷에 남는다.
- **우승.** `tournamentFinished`가 `awardPrize`로 `AWARDED`를 매기고 좌석은
  그대로 둔다.

둘 다 좌석 행 + 스냅샷 점유 + `WAITING` 페이즈라 검사 1·2를 통과한다. 조건
없이 `WAITING`으로 되돌리면 **끝난 참가가 되살아난다.** 킥당한 사람은 자기
OTP로 다시 앉고, 나중에 진짜로 터질 때 `eliminatePlayer`가 같은 사람 몫으로
`activePlayers`를 두 번 깎는다(T30의 카운터를 더 망가뜨린다). 우승자 쪽은 더
직접적이다 — `awardPrize`의 멱등 키가 곧 상태
(`prize.ts`의 `status: { notIn: ['ELIMINATED','AWARDED'] }`)라, `AWARDED`를
풀면 같은 등수의 포인트 지급이 한 번 더 열린다.

그래서 대상 중 하나라도 `PLAYING`이 아니면 **요청 전체를 409로 막는다.**
조용히 건너뛰지 않는다 — 상점은 두 명을 뗐다고 믿는데 한 명만 떨어지는 것이
이 API가 하지 않기로 한 부분 성공이다. 검사는 트랜잭션 안, 검사 2 옆에
둔다(검사 3).

다만 **이 검사는 `FOR UPDATE`가 지켜 주지 않는다.** 잠근 것은 `Table` 행이라
직렬화되는 것은 `TablePlayer`의 INSERT/DELETE뿐이고, 참가의 `status`는 다른
행이며 다른 경로가 쓴다. 킥은 같은 테이블 락 아래라 덤으로 막히지만
`tournamentFinished`는 아니다 — `PLAYING`인 사람을 테이블과 무관하게
`findFirst`로 골라 `AWARDED`를 매기므로, 1번 테이블의 마지막 탈락이 2번
테이블에 앉은 사람에게 상금을 주는 사이 우리가 2번 테이블에서 그 사람을 뗄 수
있다. 읽을 때 `PLAYING`이던 것이 쓸 때는 아니다. 그래서 되돌리는
`updateMany`에도 `status: PLAYING`을 조건으로 걸고 **바뀐 행 수가 요청 수와
다르면 던진다.** 조건만 걸면 0행이 조용히 성공으로 지나가고, 그때 잃는 것은
방금 나간 상금의 멱등성이다.

## 결정 3 — 트랜잭션을 락 **안**에 둔다

T28은 트랜잭션을 락 밖에 뒀다. T29는 안에 둔다. 모순이 아니라 근거가 다르다.

### T28이 밖으로 뺀 이유는 여기에 없다

T28의 근거는 대회 시작에 수십 명이 한꺼번에 들어와 **커넥션 풀이 차는**
상황이었다. 트랜잭션이 커넥션을 기다리는 동안 락의 TTL(5초)이 먼저 만료되면,
락이 말없이 풀린 채 쓰는 쪽은 자기가 아직 쥐고 있다고 믿는다.

해제는 상점 운영자 한 명의 조작이고 행이 최대 9개다. 팬인이 없다.

### 이 리포에 선례가 있다

`resolveWinners` 3단계가 `eliminatePlayer`를 락 **안**에서 돌린다
(`dealer.service.ts:319-331`). 그것은 상금 지급·포인트 증감·거래 내역까지 들어
있어 해제보다 훨씬 큰 트랜잭션이다.

같은 함수가 2단계(사람이 리바인 수락을 기다림)와 4단계(백오프 재시도)는 락
밖으로 뺐다. 즉 이 리포의 실제 규칙은 "트랜잭션 금지"가 아니라 **"기다림이
무한정인 일 금지"**다.

### 레디스 락은 좌석의 DB 쓰기를 직렬화하지 않는다

T28이 입장의 트랜잭션을 락 밖으로 뺐기 때문에, **입장은 테이블 락을 건드리지
않고 `TablePlayer`를 INSERT한다.** 해제가 락만 믿으면 우리가 지우는 순간
누군가 같은 자리에 꽂을 수 있다.

`deleteTable`이 쓴 방법을 그대로 쓴다(`session.service.ts:283-287`).

```sql
SELECT id FROM "Table" WHERE id = $1 AND "tournamentId" = $2 FOR UPDATE
```

`TablePlayer`의 INSERT는 외래키 때문에 부모 `Table` 행에 `FOR KEY SHARE`를
자동으로 건다. `FOR UPDATE`는 그것과 충돌하므로 두 방향 모두 직렬화된다.

- 입장이 먼저 꽂았고 아직 커밋 전이면 이 SELECT가 그 커밋까지 막힌다. 풀린 뒤의
  쌍 검증은 **새 문장**이고 Read Committed는 문장마다 스냅샷을 다시 뜨므로,
  방금 커밋된 `TablePlayer`가 보인다 → 쌍 불일치로 409.
- 해제가 먼저 잠갔으면 입장의 INSERT가 막힌다. 해제를 커밋하면 그 INSERT는
  이제 빈 자리에 들어가므로 성공한다 — 그리고 입장은 우리 **뒤에** 테이블 락을
  잡으므로 스냅샷에도 자기를 올바르게 쓴다.

두 번째 경우는 결과적으로 "상점이 뗀 사람이 즉시 다시 앉는" 것이다. 막지
않는다. 그 사람이 실제로 그 태블릿에 OTP를 넣었다는 뜻이고, 안내를 받고
걸어가는 것은 시스템 밖의 일이다. 상점은 다시 누르면 된다.

### 순서

```
0. table.findUnique({ tournamentId_id })  → 없으면 404   # 락보다 먼저
withTableLock(tableId):
  1. 스냅샷 읽기 — 없으면 404
  2. state.phase !== GamePhase.WAITING  → 409
  3. 스냅샷의 자리 주인 == 요청의 userId  → 아니면 409
  4. $transaction:
       SELECT id FROM "Table" WHERE ... FOR UPDATE     # 입장 INSERT와 직렬화
       tablePlayer.findMany로 쌍 재검증               → 아니면 409
       참가 상태가 전부 PLAYING인지                    → 아니면 409
       tablePlayer.deleteMany
       tournamentParticipation.updateMany  status = WAITING
  5. 스냅샷의 해당 자리를 null로, 저장
  6. 좌석 비트맵 비트 0
  7. deleteUserContexts
락 밖:
  8. SEAT_LIST_UPDATED
```

0번은 `claimSeat`이 "어떤 쓰기보다도 먼저" 두는 테이블 확인과 같은 자리다.
4번의 `FOR UPDATE`가 `tableId`와 `tournamentId`를 묶어 주긴 하지만 거기 닿는
것은 이미 **남의 테이블 락을 쥐고 DB를 한 바퀴 돈 뒤**다. A 대회 주인이 B
대회의 tableId를 넣어 B의 게임 락을 잡아 둘 수 있고, 404와 409의 차이로 남의
좌석 상태를 떠볼 수도 있다.

3번과 4번이 같아 보이지만 중복이 아니다. 3번은 **스냅샷**(게임의 진실)을 보고
4번은 **DB**(좌석의 진실)를 본다. T28이 세운 권위 규칙 그대로다 — 스냅샷은
파생 뷰이므로 게임 상태를 판단할 때만 믿고, 좌석의 소유는 DB가 정한다.

DB 쓰기(4)가 레디스 쓰기(5~8)보다 먼저다. 트랜잭션이 실패하면 레디스에 아무
흔적이 없다 — T28이 테스트로 고정한 그 보증과 같은 방향이다.

### 비트맵과 유저 컨텍스트는 락 **안**이다 — 초안을 뒤집었다

이 문서의 초안과 구현 계획은 6·7번을 8번과 함께 락 밖에 뒀다. 근거는 "비트맵은
해시 필드 단위 원자 연산이라 락이 필요 없다"였다. **그 근거가 틀린 것은
아니지만 질문이 틀렸다** — 필요한 것은 원자성이 아니라 **입장과의 순서**다.

락 밖에 두면 이런 인터리빙이 열린다.

```
해제: 트랜잭션 커밋 → 스냅샷 비우기 → 락 놓음
입장:                                    락 잡음 → 스냅샷에 자기 쓰기 → 락 놓음
입장:                                                컨텍스트 쓰기, 비트 1
해제:                                                   비트 0, 컨텍스트 삭제  ←
```

결과는 **비트 0 / 스냅샷 있음 / 컨텍스트 없음**이고, 스스로 낫지 않는다. 좌석
목록에는 빈 자리로 보이는데 `TablePlayer`와 스냅샷은 앉아 있다고 말한다 —
시나리오 계층이 단계마다 확인하는 불변식 `좌석 비트맵 == 스냅샷`이 깨진
상태다. 초안의 순서 논증(위 "DB 쓰기가 레디스 쓰기보다 먼저")은 **스냅샷**에
대한 것이었고 비트맵까지 늘어나지 않는다.

그래서 6·7번을 락 안으로 옮긴다. 둘 다 왕복이 정해진 Redis 호출이라 이 리포의
규칙("기다림이 무한정인 일 금지")을 어기지 않는다. 8번(브로드캐스트)만 밖에
남는다 — 락을 쥔 채 이벤트를 뿌리지 않는다.

**닫히는 것은 한 방향뿐이고, 그나마 같은 테이블에 한해서다.** 해제 → 입장은
막힌다(입장의 비트 쓰기가 항상 마지막에, 올바른 값으로 도착한다). 반대 방향 —
입장의 비트 1이 자기 락 **밖**에 있어서 뒤이은 해제의 비트 0보다 늦게 도착하는
경우 — 는 그대로 남는다. 그건 T28이 입장의 레디스 쓰기를 락 밖에 둔 데서 오는
것이고 T29 이전부터 있었다. 여기서 고치지 않는다.

"같은 테이블에 한해"인 이유는 락이 테이블 단위이기 때문이다. 비트맵은 테이블별
필드라 상관없지만 유저 컨텍스트는 대회 단위이고, T29는 애초에 뗀 사람이 **다른
테이블**로 걸어가라고 있는 기능이다 — 트랜잭션이 커밋된 뒤 2번 테이블에 앉은
사람의 컨텍스트를, 아직 1번 테이블 락을 쥔 우리가 지울 수 있다. 그 컨텍스트를
읽는 곳은 `handleAction`의 KICKED 검사 하나뿐이고 검사 3을 통과한 사람은
`PLAYING`이라 영향이 작다. 감수한다.

### `FOR UPDATE` 대기가 락 TTL을 넘길 수 있다 — 감수한다

4번의 트랜잭션은 진행 중인 **입장** 트랜잭션의 커밋을 기다린다. 대기 시간이 우리
손 밖이라, 5초(`withTableLock`의 TTL)를 넘기면 레디스 락이 말없이 만료되고
5번의 `saveSnapShot`이 보호 없이 돈다 — T28이 트랜잭션을 락 밖으로 뺀 이유로
든 바로 그 위험이다.

그래도 고치지 않는다. 복구가 셀프서비스다 — 참가 OTP를 다시 넣으면
`alreadySeated` 경로가 DB를 권위로 삼아 점유자를 고쳐 쓴다. 그리고 해제가
일어나는 시점은 착석 러시가 아니라 쉬는 시간이라 입장 트랜잭션과 겹칠 일이
드물다. **감수하는 것이지 막은 것이 아니다.**

### `GamePhase.WAITING` 가드

핸드 중에는 자리가 움직이지 않는다. 이 가드 하나가 팟·차례·폴드 상태·사이드팟을
전부 비껴간다.

T28은 이 가드를 쓰지 않았다 — 신규 착석은 핸드 도중이어도 허용이고(늦은 참가),
폴드 상태로 들어가면 아무것에도 끼지 않는다. 이미 앉은 사람을 빼는 것은 다르다.
**T29가 이 가드를 실제로 쓰는 첫 자리다.**

휴식 시간(`isBreak`)을 따로 볼 필요가 없다. 휴식 중에는 `startPreFlop`이 이미
거부하므로(`dealer.service.ts:189`) 테이블이 자연히 `WAITING`에 머물고,
극후반에 휴식이 아니어도 핸드 사이라면 같은 조건으로 열린다.

## 결정 4 — `startSession`의 일괄 승격을 지운다

```ts
// session.service.ts:387-390 — 지운다
await tx.tournamentParticipation.updateMany({
  where: { tournamentId: id },
  data: { status: PlayerStatus.PLAYING },
});
```

T28부터 `PLAYING`을 올리는 것은 착석이다. 이 줄이 남아 있으면 결제만 하고 오지
않은 사람도 시작 버튼 한 번에 `PLAYING`이 되고, `tournamentFinished`의
`findFirst({ where: { status: PLAYING } })`가 한 번도 앉지 않은 사람을 우승자로
뽑을 수 있다.

지우면 상태 기계가 `WAITING ⇄ PLAYING`으로 닫힌다.

| 전이 | 하는 곳 |
|---|---|
| `WAITING → PLAYING` | 착석 (`entry.service.ts`) |
| `PLAYING → WAITING` | 해제 (T29) |
| `PLAYING → ELIMINATED` | 탈락 (`eliminatePlayer`) |
| `PLAYING → AWARDED` | 상금 (`awardPrize`) |

**T30의 절반만 낫는다.** 우승자 오선정은 사라지지만 `activePlayers`는 여전히
결제 시점에 오른다. 노쇼가 있으면 `activePlayerCount <= 1`이 걸리지 않아
`tournamentFinished`가 **애초에 호출되지 않는다.** 카운터 쪽은 T30에 남는다.

## 에러

| 상황 | 응답 |
|---|---|
| 대회·테이블 없음, 소유자 아님 | 404 / 403 |
| 스냅샷 없음 | 404 |
| 핸드 진행 중 (`phase !== WAITING`) | 409 |
| 좌석과 사용자 쌍 불일치 (낡은 렌더) | 409 |
| 빈 좌석을 해제 시도 | 409 (쌍 불일치와 같은 경로) |
| 대상 중 하나라도 `PLAYING`이 아님 (킥·우승) | 409 |

전부 시끄럽게 던진다. 부분 성공을 반환하지 않는다 — 한 테이블 한 트랜잭션이라
전부 되거나 전부 안 된다.

## 테스트

### 단위

- 체크포인트가 `tournamentId_userId`로 `update`를 부르는가
- 해제 DTO 검증 — `seats`가 비었거나 `seatIndex`가 범위 밖이면 400

### 통합

- **이사 회귀**: 리바인·체크포인트·입장이 새 위치를 읽고 쓴다
- **체크포인트가 대상 없을 때 실제로 터진다** (P2025) — `updateMany` 시절에는
  조용히 통과하던 입력으로 확인한다
- 핸드 중 해제 → 409, DB·레디스 무변화
- 낡은 렌더(쌍 불일치) → 409
- **해제 ↔ 입장 경합**: 두 커넥션으로 같은 자리를 동시에 노려 `FOR UPDATE`가
  직렬화하는지 확인한다. `deleteTable`의 회귀 테스트와 같은 모양
- **해제 후 재입장이 원래 칩을 들고 앉는다** — 이사가 없으면 여기서
  `startStack`이 나와 깨진다
- 트랜잭션 실패 시 레디스 무흔적 (비트맵·스냅샷·유저 컨텍스트)
- `startSession` 후 미착석자가 `WAITING`으로 남는다
- 킥당한 사람(`ELIMINATED`)은 좌석이 남아 있어도 해제되지 않는다 → 409
- 한 명이라도 `AWARDED`면 나머지 좌석도 그대로 남는다 (부분 성공 없음)
- **DB는 맞는데 스냅샷 점유자만 다른 경우** → 검사 1만으로 409. 이 입력이
  없으면 두 검사가 서로를 가려 어느 쪽을 지워도 초록이 유지된다
- **해제의 비트 내리기 직전에 들어온 재입장이 지워지지 않는다** — 6·7번을 락
  밖에 두면 "비트 0 / 스냅샷 있음 / 컨텍스트 없음"으로 깨진다
- 남의 대회 테이블 id는 **락을 잡기도 전에** 404 (그 테이블 락을 미리 쥐어 둔
  상태에서 즉시 404가 나오는지로 확인한다)

### 시나리오

**두 테이블짜리 시나리오 하나.** 지금 하네스는 테이블 하나만 돈다
(`scenario/harness.ts`의 `tableId`). 백로그가 T29에서 필요해진다고 적어 둔
것이다.

흐름: 두 테이블에 나눠 앉힘 → 한쪽에서 핸드 → 쉬는 시간에 한쪽 인원 해제 →
반대 테이블 빈 자리에 OTP로 재착석 → 칩 총량 보존 확인 → 계속 진행.

단계마다 도메인 불변식을 검사한다 — 칩 총량 보존, 좌석 비트맵 == 스냅샷,
스냅샷 == `TablePlayer`.

## 범위 밖

- **자동 밸런싱과 테이블 통합 규칙.** 언제 누구를 어디로 보낼지는 현장 판단이다.
- **`activePlayers`의 기준 통일(T30).** 결정 4가 절반을 닫지만 카운터는 남는다.
- **여러 테이블을 한 요청으로.** 프론트가 나눠 보낸다.
- **해제된 사람의 열린 WS 연결을 끊는 것.** `assertTableAccess`가 스냅샷만
  보므로 다음 연결부터 막히고, `handleAction`도 스냅샷에 없는 사람을 거부한다.
  이미 열린 소켓은 아무것도 할 수 없는 상태로 남을 뿐이다. 화면 처리는 B7.
- **좌석 토큰 무효화.** 위와 같은 이유로 토큰이 남아도 권한이 없다. 만료
  정책은 T28이 남긴 항목 그대로다.
