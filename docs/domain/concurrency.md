# 도메인 — 동시성 규약

[`domain.md`](../domain.md)의 한 장이다. 전제와 다른 장의 지도는 거기 있다.

## 동시성 규약

**스냅샷은 JSON 통째로 덮어쓴다.** 읽기 → 수정 → 쓰기가 겹치면 나중에 쓴 쪽이
앞선 쓰기를 통째로 지운다. 그래서 셋이 반드시 같은 락 안에 있어야 하고,
**그 셋을 소유하는 것이 `RedisService.mutateSnapshot`이다.**

```ts
await this.redis.mutateSnapshot(tableId, async (state) => {
  if (!state) throw new Error('...');   // 읽기는 이미 락 안에서 끝났다
  // ...고친다...
  return state;                          // 반환이 곧 저장. null이면 쓰지 않는다
});
```

**스냅샷을 쓰는 길은 둘뿐이고, 그 밖에는 컴파일이 안 된다**(T42). 실제 쓰기
(`writeSnapshot`)가 private이라 밖에서 부를 수 없다.

> **T42가 선언한 것이 사실이 된 것은 T61부터다.** 그때까지
> `saveInitialTableSnapshots`가 락 없이 `pipeline.set`을 하는 **세 번째 경로**로
> 남아 있었다. 이름에도 `reason` 인자에도 그 사실이 안 적혀 있어서, 규약을 읽고
> 코드를 보면 없는 것처럼 보였다. 지금은 시작 준비도 `mutateSnapshot`을 지나간다.

| 길 | 언제 |
|---|---|
| `mutateSnapshot` | 그 외 전부. 락·읽기·쓰기를 이쪽이 소유한다 |
| `saveSnapshotUnlocked(tableId, state, reason)` | 락이 필요 없다고 **선언된** 예외. `reason`이 열거형이라 새 예외는 유니온을 고쳐야 하고 그 diff가 리뷰에 보인다 |

`fn`의 규약 셋. **스냅샷이 없으면 `null`을 받는다**(착석이 유실 뒤 새로 세우는
경로). **`null`을 돌려주면 쓰지 않는다**(낡은 `TIME_OUT`이나 턴이 아닌 사람의
액션처럼 건드리지 않고 나가는 자리). **반환값은 저장한 상태, 쓰지 않았으면 읽은
상태다** — `mutateSnapshot`은 "안 썼다"를 반환값으로 표현하지 않는다.

그래서 **쓰지 않았다는 사실은 호출자가 따로 들고 나가야 한다.**
`PlaysyncService.handleAction`은 `acted` 플래그로 그것을 세우고 `null`을 돌려준다.
받는 쪽(`WsGateway.handlePlayerAction`)은 `null`이면 전파하지 않는다 — 안 바뀐
스냅샷을 테이블 전원에게 다시 배달하는 것은 증폭기일 뿐이다(T65).

두 가지가 여기서 나온다.

- **전파는 쓰기 뒤다.** 저장이 `fn`이 돌아온 뒤에 일어나므로, `fn` 안에서 emit하면
  아직 Redis에 없는 상태가 먼저 나간다. 락을 안 잡는 조회가 그 틈에 낡은 값을
  읽는다. emit은 `mutateSnapshot` **밖**에서 한다(`playsync.service.ts`의 두 자리).
- **상태가 아닌 값**(예: 파산자 id 목록)은 반환된 상태에서 락 밖에서 파생시킨다.
  다시 읽는 것이 아니라 방금 저장한 그 객체를 순회하는 순수 계산이라 새 레이스가
  아니다(`dealer.service.ts`의 `resolveWinners` 1단계).

**락 밖에서 읽은 스냅샷으로 쓰지 마라**는 규칙은 그대로지만, 이제 어길 수단이
없다 — 호출자에게 `getSnapShot` 줄이 아예 없어서 **지울 수 있는 줄이 없다.**
조회 목적의 락 밖 읽기는 여전히 괜찮다.

`withTableLock`은 남아 있다. 스냅샷 **밖**의 것을 테이블 단위로 직렬화할 때
쓴다.

락 없는 쓰기 예외는 둘이고, 전부 근거가 있다. 근거가 깨지면 예외도 깨진다.

| `reason` | 자리 | 근거 |
|---|---|---|
| `boot-recovery` | `recovery.service.ts` — 재구성은 `rebuildTable`, 빈 테이블은 `recoverTournament` | `app.listen()` 이전이라 경합 상대가 없다 |
| `table-created` | `session.service.ts`의 `createSession` · `createTable` | 테이블이 방금 생겨 아직 아무도 모른다 |

**테이블이 있으면 스냅샷이 있다**(T38). 위 `table-created`가 그 불변식을 세운다.
그래서 **「스냅샷이 없다」의 뜻이 하나로 좁아진다 — 유실이다.** 착석의 복구 가드
(`EntryService`의 `shouldBlockEmptySnapshot`)가 이 위에 서 있다: 좌석 행은 있는데
스냅샷이 없으면 빈 스냅샷으로 앞사람을 지우는 대신 409로 물러난다.

**테스트가 테이블을 만들 때도 이 불변식을 세운다.** `prisma.table.create`만 하면
프로덕션에 없는 출발 상태가 되고, 동시 착석이 복구 가드와 경합해 간헐적으로
「복구하는 중입니다」를 받는다 — 실제로 `entry.service.int-spec.ts`가 그렇게
빨갰다. 유실을 흉내 내려는 테스트만 일부러 스냅샷 없이 시작한다.

**만료는 `SET`에 접어 넣는다. 쪼개지 마라.** `writeSnapshot`이
`set(key, value, 'EX', 86400)` 한 명령을 쓰는 이유는 두 왕복 사이의 실패 창을
없애려는 것만이 아니다. **`SET`은 기존 TTL을 지운다** — 그래서 `expire`를
빠뜨린 쓰기 경로가 하나라도 있으면 그 경로가 지나갈 때마다 이미 붙어 있던 만료가
조용히 벗겨진다. 실제로 그랬다(T61의 `saveInitialTableSnapshots`).

**거부되는 시작은 Redis 대회 메타를 남기지 않는다.** `initializeGame`의
`setTournamentMeta`가 스냅샷 준비와 `missing` 검사 **뒤에** 있는 이유다. 위로
올려도 락 밖인 것은 같지만 — 락은 각 `mutateSnapshot` 안에서 열리고 닫힌다 —
얻는 것 없이 누출만 생긴다.

`blindField`의 **존재 자체가 "대회가 시작했다"의 대용으로 읽히기 때문이다.**
착석의 `syncActivePlayer`도 시작 전에 `tournament:{id}:info`를 만들지만
`blindField`는 쓰지 않아서, 그 필드의 유무가 판별식으로 서 있다. 읽는 자리가 둘.

| 자리 | 메타가 새면 |
|---|---|
| `DealerService.startPreFlop` | 대회 상태 검사가 `checkAndSyncBlindLevel`의 결과 하나뿐이다. **`PENDING`·`startedAt`이 null인 대회에서 핸드가 돈다.** `cancelSession`은 `startedAt`으로만 막으므로 칩이 움직인 뒤에도 전액 환불 취소가 통과한다 |
| `PlaysyncService.getDashboardInfo` | 전광판이 거부된 시각을 기준으로 블라인드를 세고, 1초 폴링이 `checkAndSyncBlindLevel`을 밀어 **시작하지도 않은 대회의 레벨이 스스로 올라간다** |

**턴 판정은 엔진 하나다.** `TableEngine.act`가 턴이 아닌 사람의 액션을 예외 없이
흘리고(딜러가 자기 차례 아닌 사람을 접는 기능이 그 위에 서 있다), **실제로
반영했는지를 `boolean`으로 돌려준다.** 밖(서비스·게이트웨이)은 그 답을 읽을 뿐
같은 검사를 다시 두지 않는다 — 검사가 둘이 되면 한쪽만 고쳐지는 날이 온다.

이 답을 안 읽으면 무엇이 깨지나: `handleAction`이 조건 없이
`scheduleTurnTimeout`을 부르던 시절, 착석자 아무나 30초마다 아무 액션을 던져
**현재 턴 플레이어의 제한시간을 무한히 연장**할 수 있었고 마감을 넘긴 턴도
되살아났다(T65). 시간 제한은 사람의 자리 비움을 처리하는 장치라, 옆자리가
그것을 무력화하면 장치가 아니게 된다.

좌석 비트맵은 애초에 이 규약 밖이다 — 읽고 고쳐 쓰는 것이 아니라 Redis 원자
연산이다(`redis.service.ts`의 `UPDATE_SEAT_BIT` · `UPDATE_SEAT_BITS_MANY`).
복구의 비트맵 되세우기(`recoverTournament`·`rebuildTable`의 `rebuildSeatBitmap`)도 같다.

### 트랜잭션과 락 — 규칙은 "기다림이 무한정인 일 금지"다

"락 안에서 트랜잭션 금지"가 아니다. `releaseSeats`의 주석이 그 근거를
적어 뒀다 — `resolveWinners`가 3단계(탈락 확정)는 락 **안**에서 돌리고,
2단계(사람이 리바인 수락을 기다림)와 4단계(백오프 재시도)만 락 밖으로 뺀다.

그래서 자리마다 다르다.

| | 어디서 커밋 | 왜 |
|---|---|---|
| `enterSeat` | 락 **밖** (`entry.service.ts`의 `claimSeat`) | 착석 러시라 겹칠 일이 잦다 |
| `releaseSeats` | 락 **안** (`store/session/session.service.ts`) | 상점 운영자 한 명 · 행 최대 9개 |

**`releaseSeats`는 알면서 감수한 것이다.** `SELECT ... FOR UPDATE` 대기가 진행
중인 입장 트랜잭션의 커밋을 기다리므로 시간이 우리 손 밖이고, 5초를 넘기면 레디스
락이 말없이 만료돼 뒤따르는 스냅샷 쓰기가 보호 없이 돈다(`mutateSnapshot`으로
옮긴 뒤에도 같다 — 헬퍼는 락을 잡아 줄 뿐 TTL을 늘려 주지 않는다). 그래도 고치지 않는
근거는 (1) 복구가 셀프서비스이고(참가 OTP를 다시 넣으면 `alreadySeated` 경로가
점유자를 고쳐 쓴다) (2) 해제는 착석 러시가 아니라 쉬는 시간에 일어난다는 것이다.
근거 주석 전문은 `releaseSeats`의 docblock. **막은 것이 아니라 감수한 것**이라고
적혀 있으니, 여기를 건드릴 때 "이미 안전하다"고 읽지 마라.

**T61 이후 그 대기가 시작 경로와 만난다.** 준비(`initializeGame`)도 테이블 락을
잡게 됐으므로, 좌석 해제가 도는 중에 상점이 시작을 누르면 `withTableLock`의 5초
대기에 걸린다. 그 실패는 `Error('… 락 획득 실패')`라 그대로 두면 500에 인프라
언어로 나가므로, `initializeGame`이 **그것만 골라** 409로 번역한다
(`isTableLockTimeout`. 다른 예외는 그대로 올린다 — 뭉뚱그리면 진짜 장애가
"잠시 후 다시"로 위장된다).

레디스 락이 좌석의 **DB 쓰기까지 직렬화하지는 않는다** — 입장이 락을 건드리지
않고 `TablePlayer`를 INSERT하기 때문이다. 그래서 해제 쪽이 `FOR UPDATE`로 부모
`Table` 행을 잡아 INSERT의 `FOR KEY SHARE`와 충돌시켜 직렬화한다.

**빈 스냅샷의 뜻이 하나다 — 유실.** T38 이후 테이블 생성이 빈 스냅샷을 함께
세우므로(`createSession`·`createTable`), 스냅샷이 없다는 것은 "아직 아무도
안 앉았다"가 아니라 "잃어버렸다"는 뜻이다.

**복구도 같은 자리를 세운다**(T44, `recoverTournament`). 생성만 닫으면
재기동이 그 뜻을 다시 넓힌다 — 좌석 0인 테이블은 재구성할 게임 상태가 없어
건너뛰었고, 그래서 Redis를 잃고 재기동한 뒤 아무도 안 앉은 테이블에 딜러가
붙으면 `joinTable`이 500을 냈다. 세 지점(생성 둘 · 복구 하나) 모두 **스냅샷이
없을 때만** 세운다.

**반대로 좌석 비트맵의 유무는 스냅샷과 독립이다**(T46). 비트맵은
`tournament:{id}:seat` 키 하나에 대회의 모든 테이블이 필드로 들어 있어, 그
키만 잃는 유실이 따로 가능하다 — 그러면 `getTournamentTables`(hgetall)에서
테이블이 사라지는데 `UPDATE_SEAT_BIT`가 없는 필드에 아무것도 쓰지 않으므로
착석으로도 낫지 않는다. 그래서 복구는 **스냅샷이 살아 있어도 비트맵을 따로
본다**(`recoverTournament`). 되세울 때의 권위는 **스냅샷**이다 — DB 좌석
행에는 참가가 끝난 잔재가 남고, 불변식이 "좌석 비트맵 == 스냅샷"이다.

### 닫힌 대회에는 아무것도 쓰지 않는다

`FINISHED`·`CANCELLED`가 되면 그 대회는 **회계가 끝났다.** 닫는 쪽이 「걷은
참가비 == 나간 상금」을 맞춰 놓고 닫으므로(`completeSession`의 게이트), 그
뒤에 들어온 쓰기는 어느 상금으로도 나가지 않는다.

**판정과 쓰기가 같은 문장이어야 한다.** 상태를 트랜잭션 **밖**에서 읽고
안에서 쓰면 그 사이가 창이다. 네 자리가 그 모양이었다.

| 자리 | 새던 것 |
|---|---|
| `PlaysyncService.executeRebuyTransaction` | 참가비 차감 · `totalBuyinAmount` · `buyInCount` |
| `PlaysyncService.eliminatePlayer` | 상금 지급 · `activePlayers` |
| `PaymentService.joinSession` | 참가비 · 참가 행 · `totalPlayers` |
| `DealerService.handleDealerAction`의 KICK | `activePlayers` · 참가 `ELIMINATED` |

막는 모양은 하나다 — 대회 장부를 건드리는 UPDATE의 `where`에 상태를 얹는다.

```ts
where: { id: tournamentId, status: NOT_CLOSED_TOURNAMENT_FILTER }
```

UPDATE가 행 잠금을 잡으므로, **닫는 쪽과 쓰는 쪽 중 하나는 반드시 상대의
커밋을 보고 결정한다.** 걸리면 P2025가 나고 같은 트랜잭션의 나머지 쓰기가
함께 되돌아간다. P2025의 문구는 "필요한 레코드를 찾지 못했다"라 대회가 사라진
것처럼 읽히므로 `asClosedTournamentWrite`가 뜻을 바꿔 준다.

**창이 제일 넓은 곳은 리바인이다.** 사람에게 15초를 묻고 오는 길이라
(`waitForRebuyResponse`) 묻는 동안 닫히는 것이 드물지 않다.

**리바인은 스냅샷에 칩을 먼저 넣고 DB를 나중에 쓴다**(T100, `processRebuy`).
DB가 먼저면 Redis가 죽은 순간의 수락이 **돈만 빼고** 칩을 못 넣는다. 스냅샷을
먼저 쓰면 장애도, 닫혀서 스냅샷이 지워진 대회도 **돈이 움직이기 전에** 멈춘다.
대가는 실패 방향이 뒤집히는 것이다 — DB가 거절하면(포인트 경합 · 닫힌 대회) 넣은
칩을 락 안에서 되돌린다(`revertRebuy`). 되돌리는 순간 Redis까지 끊기거나, 칩을 넣은
뒤 DB 전에 프로세스가 죽으면 **칩은 있고 돈은 안 빠진 채** 남는다 — 상점이 잃는
방향이다. 예전 순서의 같은 창에서는 참가자가 돈을 잃었다. 전광판(`rebuyPlayer`)은 여전히 DB 뒤다(아래
「Redis 쓰기는 트랜잭션 뒤로」). 칩 쓰기는 락 안에서 장애 세대를 다시 보고, 쓰기가
반영된 뒤 던졌으면 복구를 기다려 되돌린 다음 「중단」으로 끝낸다.

**그리고 트랜잭션 뒤의 Redis 쓰기는 요청의 성패를 정하지 않는다**(T105,
`redis/mirror.ts`의 `mirrorAfterCommit`). DB가 이미 이겼는데 미러가 던져 503을
돌려주면, 참가자는 **앉았는데 실패 화면**을 보고 그 사이 좌석 비트맵이 0이라
남이 그 자리를 고른다. 세 자리가 그 모양이었다(`joinSession` · `enterSeat` ·
`finishClose`). 던지지 않고, `down`이면 시도조차 하지 않고(재시도 예산 7~10초를
물지 않으려고) 복구 뒤에 한 번 돈다.

**실패가 보여야 그 길이 탄다.** `pipeline.exec()`는 명령별 실패로 reject하지
않으므로 pipeline을 쓰는 미러는 `execOrThrow`를 지난다 — 안 그러면 죽은 연결에
대고도 성공으로 돌아와, 복구 뒤 재시도가 한 번도 안 돈다(`joinPlayer`가 전광판
카운터를 **에러 한 줄 없이** 잃던 경로다).

**커밋 전에 Redis를 읽는 경로는 애초에 커밋까지 못 간다.** 장애가 통째로 걸치면
`enterSeat`의 `getSnapShot`이나 시작한 대회의 `getTournamentDashboard`에서 먼저
거절된다 — 돈이 안 움직이므로 그쪽이 안전한 실패다. 미러 규칙이 닫는 것은
**「읽기 뒤 · 미러 앞」의 창**과, 커밋 전에 Redis를 안 읽는 경로(시작 전 대회
참가)다.

**`isUp()`으로 가르지 않는다.** `booting`·`recovering`은 Redis가 곧 응답하는
구간이라 미루면 안 된다 — 미루면 착석 직후 좌석 비트맵이 비어 있는 창이 생긴다.
가르는 것은 `phase === 'down'` 하나다.

**Redis 쓰기는 트랜잭션 뒤로 보낸다.** 되돌아가지 않아서다. 딜러 킥의
`setUserContext('KICKED')`가 트랜잭션 앞에 있었는데, 거절된 킥이 그 자국을
남기면 킥당하지 않은 사람이 무엇을 눌러도 폴드가 된다(`handleAction`의
`isKicked` 분기). 같은 이유로 `RedisService.rebuyPlayer`의 `hincrby`는
**없는 키를 만들므로**, 트랜잭션이 먼저 거절해야 닫으면서 지운
`tournament:{id}:info`가 TTL 없는 쓰레기로 부활하지 않는다.

**지금 안전한 자리들은 가드가 아니라 부수효과로 안전하다.** `startPreFlop` ·
`handleAction` · `resolveWinners`는 대회 상태를 아예 안 보고, 닫는 쪽이 Redis
스냅샷을 지워 `SNAPSHOT_MISSING`으로 죽을 뿐이다 — **스냅샷 삭제 전에 락을
잡은 호출은 그대로 지나간다.** 여기를 건드릴 때 "이미 막혀 있다"고 읽지 마라.

**그 부수효과가 서려면 삭제가 락을 타야 한다**(T104). `deleteTournament`는
`table:state:*`를 `withTableLock` 안에서 지운다 — 예전에는 락 밖이라, 삭제가
`mutateSnapshot`의 **읽기와 쓰기 사이**에 끼면 뒤이은 SET이 방금 지운 키를
TTL째로 되살렸다. 그러면 「스냅샷이 없어서 죽는다」가 성립하지 않는다. 대회 키
셋(`info` · `user` · `seat`)은 스냅샷 경로가 안 만지므로 pipeline 그대로다.
`deleteTableState`는 Prisma 트랜잭션 안이라 락을 안 태운다 — 부르는 쪽
`deleteTable`의 `FOR UPDATE` + `occupied === 0`이 그 창을 닫는다.

**그리고 그 부수효과는 Redis가 죽으면 늦게 온다**(T103). 닫는 세 문은
`SessionService.finishClose`를 지나는데, 장애 중에는 `deleteTournament`가 7~10초
붙잡혔다 던지므로 **정리를 복구 뒤로 미루고 알림(`TOURNAMENT_CLOSED`)을 먼저
보낸다** — 알림을 받는 쪽은 메모리만 만져 장애 중에도 선다. 순서가 up일 때와
반대인 이유는 up일 때는 알림이 푸는 리바인 고리가 스냅샷을 다시 읽기 때문이다
(먼저 지워야 「스냅샷 없음」으로 끝난다). **미뤄 둔 정리는 리바인 고리와 같은
`whenUp`에 나란히 매달리고, 끝나는 순서는 보장되지 않는다** — 정리가 늦는
판에서는 스냅샷이 살아 있어 「스냅샷 없음 == 닫혔다」가 성립하지 않는다.
그 경합에 기대지 않고 `DealerService.closedTables`가 몫을 든다. 정리 실패로
요청을 실패시키지는 않는다 — 닫힘은 이미 커밋됐다. 대신 `deleteTournament`가
**하나라도 못 지우면 던진다**(`pipeline.exec()`는 명령별 실패로 reject하지
않는다). 안 던지면 「실패하면 복구 뒤 재시도」라는 길이 영영 안 탄다.
