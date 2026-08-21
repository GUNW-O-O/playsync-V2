# T60 인원수 카운터 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DB `Tournament.activePlayers`를 인원수의 유일한 진실로 두고, Redis `activePlayer`를 대입으로 파생시켜 둘이 갈라지지 않게 만든다.

**Architecture:** Redis 카운터의 상대 증감(`hincrby`)을 대입(`hset`)으로 바꾼다. 호출부는 DB가 돌려준 값을 그대로 넘긴다. 대입이라 중복 호출이 해가 없고 한 번 놓쳐도 다음 인원 변화가 고친다. 최후 1인 판정과 탈락 등수의 출처도 Redis 대시보드에서 DB 트랜잭션으로 옮긴다.

**Tech Stack:** NestJS · Prisma(드라이버 어댑터 + pg) · ioredis · jest(통합은 `docker-compose.test.yml`의 5433 / 6380)

**Spec:** [`docs/superpowers/specs/2026-08-21-t60-active-count-design.md`](../specs/2026-08-21-t60-active-count-design.md)

## Global Constraints

- **작업 전에 [`docs/domain.md`](../../domain.md)와 [`CLAUDE.md`](../../../CLAUDE.md)를 읽는다.** 이 도메인은 "카드는 물리, 칩은 디지털"이다.
- **실패를 먼저 본다.** 사후에 추가한 검사는 제품 코드를 일부러 되돌려 빨간불을 확인한다(`git stash push <파일>` 또는 임시 편집 후 복원).
- **통합 테스트는 `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- <패턴>`으로 돌린다.** 컨테이너 기동은 자동이고, 내릴 때는 `npm run test:int:down -w backend`.
- **문서와 주석이 코드를 가리킬 때 줄 번호가 아니라 이름을 쓴다.**
- 문서 파일은 전부 **CRLF**다. 스크립트로 편집하면 `newline`을 보존하고, `String.replace`의 치환 문자열에 백틱이 들어가면 **함수 replacer(`() => new`)를 쓴다** — 아니면 `` $` ``가 "매치 앞 전체"로 확장돼 파일이 두 배가 된다.
- 커밋 메시지·주석·문서는 **한국어**.
- 기준선: 타입 에러 0 / contract 62 / 백엔드 단위 250 / 프론트 단위 27 files / 통합 451.

## 파일 지도

| 파일 | 이 계획에서의 책임 |
|---|---|
| `backend/src/redis/redis.service.ts` | `syncActivePlayer` 신설. `seatPlayer`·`eliminatedPlayer` 제거. `recalculateAvgStack` 분모 |
| `backend/src/playsync/playsync.service.ts` | `eliminatePlayer` — 등수와 최후 1인 판정을 DB로 |
| `backend/src/entry/entry.service.ts` | `claimSeat` — 착석의 카운터 대입 + 거짓 주석 수정 |
| `backend/src/dealer/dealer.service.ts` | `loginDealer` 승격 · `handleDealerAction`의 KICK |
| `backend/src/recovery/recovery.service.ts` | `recoverTournament` — 항상 카운터를 맞춘다 |
| `backend/prisma/seed.ts` | 이중 계상 제거 |
| `backend/src/playsync/elimination.int-spec.ts` | 탈락·킥의 카운터 단언 |
| `backend/src/entry/entry.service.int-spec.ts` | 착석 |
| `backend/src/dealer/dealer.service.int-spec.ts` | 딜러 로그인 승격 |
| `backend/src/recovery/recovery.service.int-spec.ts` | 복구의 치유 |
| `docs/tickets-audit.md` · `docs/domain.md` | 상태 열 · 잔여 목록 · 인원 카운터 규칙 |

---

### Task 1: `syncActivePlayer` 프리미티브

**Files:**
- Modify: `backend/src/redis/redis.service.ts` (`recalculateAvgStack`, 그 아래에 `syncActivePlayer` 추가)
- Test: `backend/src/redis/redis.service.int-spec.ts` (없으면 만든다)

**Interfaces:**
- Consumes: 없음
- Produces: `RedisService.syncActivePlayer(tournamentId: string, activePlayers: number, startStack: number, entryFee: number): Promise<void>`

이 태스크는 **프리미티브만 만든다.** `seatPlayer`·`eliminatedPlayer`는 아직 호출부가 있으므로 남긴다 — Task 5에서 지운다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/src/redis/redis.service.int-spec.ts`가 이미 있으면 `describe`를 더하고, 없으면 `elimination.int-spec.ts`의 `createTestRedis` / `flushTestRedis` 배선을 그대로 따라 만든다.

```ts
describe('syncActivePlayer', () => {
  const TOURNAMENT = 'sync-active-1';
  const infoKey = `tournament:${TOURNAMENT}:info`;

  it('상대 증감이 아니라 대입이다 — 어긋난 값을 통째로 덮는다', async () => {
    // 실제로 갈라진 상태를 만든다. 지금 코드의 hincrby는 이 9를 고치지 못한다.
    await redis.hset(infoKey, 'activePlayer', 9, 'totalChips', 30000);

    await redisService.syncActivePlayer(TOURNAMENT, 3, 10000, 1000);

    expect(Number(await redis.hget(infoKey, 'activePlayer'))).toBe(3);
  });

  it('두 번 불러도 같다', async () => {
    await redis.hset(infoKey, 'activePlayer', 9);

    await redisService.syncActivePlayer(TOURNAMENT, 3, 10000, 1000);
    await redisService.syncActivePlayer(TOURNAMENT, 3, 10000, 1000);

    expect(Number(await redis.hget(infoKey, 'activePlayer'))).toBe(3);
  });

  it('평균 스택의 분모를 새 인원으로 다시 계산한다', async () => {
    // recalculateAvgStack: totalChips = (totalBuyinAmount / entryFee) * startStack
    //                      avgStack   = floor(totalChips / activePlayer)
    // 3000 / 1000 * 10000 = 30000. 분모 3이면 10000, 2면 15000이라 서로 다르다.
    await redis.hset(infoKey, 'totalBuyinAmount', 3000, 'activePlayer', 3);

    await redisService.syncActivePlayer(TOURNAMENT, 2, 10000, 1000);

    expect(Number(await redis.hget(infoKey, 'avgStack'))).toBe(15000);
  });

  it('인원이 0이면 평균도 0이다 — 분모 기본값이 1이면 총량이 그대로 나온다', async () => {
    await redis.hset(infoKey, 'totalBuyinAmount', 3000);

    await redisService.syncActivePlayer(TOURNAMENT, 0, 10000, 1000);

    expect(Number(await redis.hget(infoKey, 'avgStack'))).toBe(0);
  });
});
```

`recalculateAvgStack`은 private이라 직접 못 부른다. `syncActivePlayer`를 통해 검사하는 것이 맞다 — 검증 대상이 "대입한 인원이 분모가 되는가"다.

- [ ] **Step 2: 빨간불을 본다**

```bash
KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- redis.service.int-spec
```

Expected: `redisService.syncActivePlayer is not a function`

- [ ] **Step 3: 분모를 고친다**

`recalculateAvgStack`의

```ts
const activeNum = parseInt(active || '1');
```

를

```ts
// 필드가 없으면 0이다. 예전에는 '1'이었는데, 그러면 바로 아래 `activeNum > 0`
// 가드가 무력해지고 avgStack이 "전체 칩 총량"으로 튄다.
const activeNum = parseInt(active || '0');
```

- [ ] **Step 4: `syncActivePlayer`를 쓴다**

`recalculateAvgStack` 아래, `eliminatedPlayer` 위에 놓는다.

```ts
/**
 * 인원수를 DB 값으로 맞춘다. **대입이다.**
 *
 * 호출부는 DB 트랜잭션이 돌려준 `Tournament.activePlayers`를 그대로 넘긴다.
 * 상대 증감(`hincrby`)이 아닌 이유는 짝을 구조로 만들기 위해서다 — 두 번
 * 불러도 같고, 한 번 놓쳐도 다음 인원 변화가 값을 통째로 다시 써서
 * 드리프트를 지운다. **DB가 진실이고 이 값은 전광판용 파생 표시다**
 * (`eliminatePlayer`가 돈에 적용하는 규칙과 같다).
 *
 * 평균 스택도 다시 계산한다. 분모가 이 인원이므로, 대입만 하고 두면
 * 전광판의 평균이 한 박자 늦는다.
 */
async syncActivePlayer(
  tournamentId: string,
  activePlayers: number,
  startStack: number,
  entryFee: number,
) {
  const key = this.getInfoKey(tournamentId);
  await this.redis.hset(key, 'activePlayer', activePlayers);
  await this.recalculateAvgStack(tournamentId, startStack, entryFee);
}
```

- [ ] **Step 5: 초록불을 본다**

```bash
KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- redis.service.int-spec
```

- [ ] **Step 6: 분모 수정이 실제로 검사되는지 확인한다**

`parseInt(active || '0')`을 `'1'`로 되돌려 돌린다. 「인원이 0이면 평균도 0이다」가 빨개져야 한다 — 안 빨개지면 그 테스트가 분모를 안 덮는 것이므로 입력을 다시 고른다. 확인 후 `'0'`으로 되돌린다.

- [ ] **Step 7: 커밋**

```bash
git add backend/src/redis/redis.service.ts backend/src/redis/redis.service.int-spec.ts
git commit -m "feat: 인원수를 DB 값으로 대입하는 syncActivePlayer를 만든다"
```

---

### Task 2: 탈락 — 등수와 최후 1인 판정을 DB로

**Files:**
- Modify: `backend/src/playsync/playsync.service.ts` (`eliminatePlayer`)
- Test: `backend/src/playsync/elimination.int-spec.ts` (`describe('eliminatePlayer')`)

**Interfaces:**
- Consumes: `RedisService.syncActivePlayer` (Task 1)
- Produces: `eliminatePlayer`의 시그니처는 그대로다. `tournamentInfo: Dashboard`는 `startStack`·`entryFee`에 계속 쓰이고, **`activePlayer` 필드만 더 이상 읽지 않는다**

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`elimination.int-spec.ts`의 `describe('eliminatePlayer')` 안에 더한다. **DB와 Redis를 일부러 갈라 놓고 시작한다** — 그래야 "어느 쪽을 읽는가"가 증명된다.

```ts
it('등수를 Redis 대시보드가 아니라 DB에서 읽는다', async () => {
  // 대시보드는 3을 들고 있지만 DB는 2다. 지금 코드는 대시보드를 읽어
  // 3위 상금을 계산하고, 고친 뒤에는 DB를 읽어 2위가 되어야 한다.
  await prisma.tournament.update({
    where: { id: TOURNAMENT },
    data: { activePlayers: 2 },
  });

  await playsync.eliminatePlayer(TOURNAMENT, TABLE, [makePlayer('carol', 2, 0)], dashboard());

  const row = await prisma.tournamentParticipation.findUniqueOrThrow({
    where: { tournamentId_userId: { tournamentId: TOURNAMENT, userId: 'carol' } },
  });
  expect(row.place).toBe(2);
});

it('Redis 카운터를 DB 값으로 맞춘다 — 갈라져 있어도', async () => {
  await redis.hset(infoKey, 'activePlayer', 9);

  await playsync.eliminatePlayer(TOURNAMENT, TABLE, [makePlayer('carol', 2, 0)], dashboard());

  expect(await activePlayerInRedis()).toBe(await activePlayersInDb());
});

it('중복 도착도 어긋난 카운터를 고친다', async () => {
  await playsync.eliminatePlayer(TOURNAMENT, TABLE, [makePlayer('carol', 2, 0)], dashboard());
  await redis.hset(infoKey, 'activePlayer', 9); // 그 사이 누가 어긋뜨렸다

  await playsync.eliminatePlayer(TOURNAMENT, TABLE, [makePlayer('carol', 2, 0)], dashboard());

  expect(await activePlayerInRedis()).toBe(2);
});
```

`place` 컬럼 이름은 `awardPrize`가 실제로 쓰는 것을 확인하고 맞춘다. 없으면 `PointTransaction`의 `description`(`` `${eliminatedRank}위 상금` ``)으로 단언한다.

- [ ] **Step 2: 빨간불을 본다**

```bash
KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- elimination.int-spec
```

Expected: 첫 테스트가 `place`가 3(대시보드 값), 나머지 둘이 9 근처의 값으로 실패한다.

- [ ] **Step 3: 트랜잭션이 두 값을 돌려주게 한다**

`eliminatePlayer`의 트랜잭션 안:

```ts
// 등수도 DB에서 읽는다. 예전에는 Redis 대시보드의 activePlayer였는데,
// 등수가 상금을 정하므로(prizeFor) 화면용 파생값에서 오는 것 자체가
// 위험했다 — 시드의 이중 계상이 "첫 탈락이 14위"로 나타난 경로가 이것이다.
const { activePlayers, totalBuyinAmount, prizePayouts } =
  await tx.tournament.findUniqueOrThrow({
    where: { id: tournamentId },
    select: { activePlayers: true, totalBuyinAmount: true, prizePayouts: true },
  });
const eliminatedRank = activePlayers;
```

그리고 감소 뒤의 값을 함께 돌려준다.

```ts
let remaining = activePlayers;
if (changed.count > 0) {
  const updated = await tx.tournament.update({
    where: { id: tournamentId },
    data: { activePlayers: { decrement: changed.count } },
    select: { activePlayers: true },
  });
  remaining = updated.activePlayers;
}
return { eliCount: changed.count, remaining };
```

- [ ] **Step 4: 대입과 판정을 바꾼다**

```ts
// 카운터는 **조기 반환보다 앞에서** 맞춘다. 중복 도착은 정상 경로이고,
// 대입이라 그때가 어긋난 값을 지우는 기회다.
await this.redis.syncActivePlayer(
  tournamentId, result.remaining, tournamentInfo.startStack, tournamentInfo.entryFee,
);

// 중복 도착이면 여기서 끝난다. 좌석 비트맵과 userContext는 첫 번째가 이미 지웠다.
if (result.eliCount === 0) return;
```

아래의 `const activePlayerCount = await this.redis.eliminatedPlayer(...)` 줄을 지우고, 마지막 판정을 `if (result.remaining <= 1)`로 바꾼다.

- [ ] **Step 5: 초록불을 본다**

```bash
KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- elimination.int-spec
```

기존 테스트(`같은 유저의 탈락이 두 번 도착해도…`, `Redis 카운터도 한 번만 준다`, `Redis 정리 실패가 조용히 묻히지 않는다`)도 함께 통과해야 한다.

- [ ] **Step 6: 커밋**

```bash
git add backend/src/playsync/playsync.service.ts backend/src/playsync/elimination.int-spec.ts
git commit -m "fix: 탈락 등수와 최후 1인 판정을 Redis 캐시가 아니라 DB에서 읽는다"
```

---

### Task 3: 인원이 오르는 두 경로 — 착석과 딜러 로그인

**Files:**
- Modify: `backend/src/entry/entry.service.ts` (`claimSeat`)
- Modify: `backend/src/dealer/dealer.service.ts` (`loginDealer`)
- Test: `backend/src/entry/entry.service.int-spec.ts`, `backend/src/dealer/dealer.service.int-spec.ts`

**Interfaces:**
- Consumes: `RedisService.syncActivePlayer` (Task 1)
- Produces: 없음(내부 변경)

둘을 한 태스크로 묶는 이유는 **같은 결함의 같은 모양**이기 때문이다 — `WAITING → PLAYING` 승격이 DB만 올린다(대장의 4-2 · 4-3).

- [ ] **Step 1: 실패하는 테스트 둘을 쓴다**

`entry.service.int-spec.ts`:

```ts
it('스냅샷 쓰기가 던져도 다음 착석이 카운터를 되찾는다', async () => {
  // 4-2. 커밋 뒤 mutateSnapshot이 던지면 지금은 seatPlayer가 통째로 스킵되고,
  // 같은 OTP로 다시 와도 promoted가 0이라 Redis는 영원히 1 모자란다.
  jest.spyOn(redisService, 'mutateSnapshot').mockRejectedValueOnce(new Error('락 실패'));
  await expect(
    service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 0 }),
  ).rejects.toThrow();

  await service.enterSeat(TOURNAMENT, { otp: '00000002', tableId: TABLE, seatIndex: 1 });

  expect(await activePlayerInRedis()).toBe(await activePlayersInDb());
});

it('재입장은 인원을 두 번 세지 않는다', async () => {
  await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 0 });
  // 좌석 해제 → RELEASED. 이 스펙 파일이 이미 쓰는 해제 경로를 그대로 쓴다.
  await releaseSeat(TOURNAMENT, TABLE, 0);
  await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 2 });

  expect(await activePlayerInRedis()).toBe(await activePlayersInDb());
  expect(await activePlayersInDb()).toBe(1);
});
```

OTP 값(`00000001`·`00000002`)과 `TOURNAMENT`·`TABLE` 상수는 이 스펙 파일의 `participate` 헬퍼가 이미 만드는 것이다. 해제 경로(`releaseSeat`)는 파일에 있는 것을 쓰고, 없으면 `TournamentParticipation.status`를 `RELEASED`로 직접 바꾸고 좌석 행을 지운다 — 그 둘이 해제의 정의다.

`dealer.service.int-spec.ts`:

```ts
it('딜러 로그인의 승격이 Redis 인원에도 반영된다', async () => {
  // 4-3. 앉아 있는데 WAITING인 사람을 loginDealer가 PLAYING으로 올린다.
  // 지금은 DB만 오르고 Redis는 그대로다.
  await prisma.tournamentParticipation.updateMany({
    where: { tournamentId: TOURNAMENT },
    data: { status: 'WAITING' },
  });
  await prisma.tournament.update({ where: { id: TOURNAMENT }, data: { activePlayers: 0 } });
  await redis.hset(infoKey, 'activePlayer', 0);

  await service.loginDealer(/* 정상 OTP + tableId */);

  expect(await activePlayerInRedis()).toBe(await activePlayersInDb());
  expect(await activePlayersInDb()).toBeGreaterThan(0);
});
```

각 스펙 파일에 `activePlayerInRedis` / `activePlayersInDb` 헬퍼가 없으면 `elimination.int-spec.ts`의 것을 그대로 가져다 쓴다. `claimSeat`의 dto 모양과 OTP 발급은 **그 스펙 파일에 이미 있는 헬퍼를 쓴다** — 새로 짜지 않는다.

- [ ] **Step 2: 빨간불을 본다**

```bash
KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- entry.service.int-spec dealer.service.int-spec
```

- [ ] **Step 3: `claimSeat`을 고친다**

`seatPlayer` 호출을 대입으로 바꾼다. **위치는 그대로 스냅샷 쓰기 뒤다** — 앞으로 당기면 `shouldBlockEmptySnapshot`이 동시 착석자에게 409를 준다(이미 겪은 회귀다).

```ts
// 전광판이 읽는 카운터를 DB와 맞춘다(T60).
//
// **커밋 이후의 값을 다시 읽는다.** 트랜잭션 반환값을 쓰지 않는 이유는
// 분기가 셋이기 때문이다 — 첫 착석(증가) · 재입장(변화 없음) · 이미 앉아
// 있음(트랜잭션 자체를 건너뜀). 한 번의 왕복으로 셋을 같은 코드가 덮는다.
//
// **대입이라 이 줄을 놓쳐도 영구 결함이 아니다.** 다음 인원 변화 한 번이
// 값을 통째로 다시 쓰고, 재기동 복구도 같은 일을 한다
// (`RecoveryService.recoverTournament`).
const { activePlayers } = await this.prisma.tournament.findUniqueOrThrow({
  where: { id: tournamentId },
  select: { activePlayers: true },
});
await this.redis.syncActivePlayer(
  tournamentId, activePlayers, table.tournament.startStack, table.tournament.entryFee,
);
```

`let promoted = 0;`과 트랜잭션의 `return changed.count;`가 더 이상 쓰이지 않으면 지운다. 트랜잭션이 `changed.count`를 **재입장 분기의 조건**으로 계속 쓰고 있는지 확인하고, 쓰고 있으면 그대로 둔다.

- [ ] **Step 4: `claimSeat`의 거짓 주석을 고친다**

지금 주석은 "이쪽이 실패하면 … 재기동 복구가 DB의 `activePlayers`로 메타를 다시 세우므로 낫는다"라고 적혀 있다. **사실이 아니다** — 복구는 info 키가 통째로 없을 때만 그렇게 한다. Task 5가 그 문장을 사실로 만들 것이므로, 위 Step 3의 주석으로 대체하고 낡은 문장을 지운다.

- [ ] **Step 5: `loginDealer`를 고친다**

승격 트랜잭션이 갱신 후 인원을 함께 돌려주게 한다.

```ts
if (promoted.count > 0) {
  const updated = await tx.tournament.update({
    where: { id: dto.tournamentId },
    data: { activePlayers: { increment: promoted.count } },
    select: { activePlayers: true },
  });
  activePlayersAfter = updated.activePlayers;
}
```

`activePlayersAfter`를 트랜잭션 반환값에 실어 나가고, **토큰이 실제로 나간 뒤에** 대입한다(카운터를 지우는 기존 코드와 같은 자리, 같은 이유 — 403이 나가는 요청까지 반영할 이유가 없다).

```ts
if (activePlayersAfter !== null) {
  await this.redis.syncActivePlayer(
    dto.tournamentId, activePlayersAfter, tournament.startStack, tournament.entryFee,
  );
}
```

`tournament`가 `startStack`·`entryFee`를 이미 읽고 있는지 확인하고, 없으면 `select`에 더한다.

- [ ] **Step 6: 초록불을 본다**

```bash
KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- entry.service.int-spec dealer.service.int-spec
```

- [ ] **Step 7: 커밋**

```bash
git add backend/src/entry/entry.service.ts backend/src/dealer/dealer.service.ts backend/src/entry/entry.service.int-spec.ts backend/src/dealer/dealer.service.int-spec.ts
git commit -m "fix: 승격 두 경로가 Redis 인원까지 맞춘다"
```

---

### Task 4: 킥과 시드

**Files:**
- Modify: `backend/src/dealer/dealer.service.ts` (`handleDealerAction`의 KICK 분기)
- Modify: `backend/prisma/seed.ts`
- Test: `backend/src/playsync/elimination.int-spec.ts` (`describe('딜러 킥')`)

**Interfaces:**
- Consumes: `RedisService.syncActivePlayer` (Task 1)
- Produces: 없음

**최후 1인 판정을 KICK 경로에 새로 달지 않는다.** `tournamentFinished`를 부르는 자리는 `eliminatePlayer` 하나뿐이고, 킥으로 마지막 한 명이 남는 상황은 규칙으로 막기로 했다 — `backlog.md`의 「파이널 테이블부터의 딜러 개입 제한」. 스펙의 4-1 절을 읽고 그 판단을 확인한 뒤 진행한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
it('킥이 Redis 인원도 깎는다', async () => {
  await dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK');

  expect(await activePlayerInRedis()).toBe(await activePlayersInDb());
  expect(await activePlayerInRedis()).toBe(2);
});

it('두 번 킥해도 Redis 인원은 한 번만 준다', async () => {
  await dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK');
  await dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK');

  expect(await activePlayerInRedis()).toBe(2);
});
```

- [ ] **Step 2: 빨간불을 본다**

```bash
KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- elimination.int-spec
```

Expected: 첫 테스트가 3(안 깎였다)으로 실패한다.

- [ ] **Step 3: KICK 분기를 고친다**

트랜잭션이 갱신 후 인원을 돌려주게 하고, 트랜잭션 밖에서 대입한다. **중복 킥(`changed.count === 0`)일 때도 현재 값을 읽어 대입한다** — 대입에는 멱등을 위한 가드가 필요 없고, 오히려 어긋난 값을 지우는 기회다.

```ts
const activePlayers = await this.prisma.$transaction(async (tx) => {
  const changed = await tx.tournamentParticipation.updateMany({
    where: {
      tournamentId,
      userId: targetUserId,
      status: { notIn: ['ELIMINATED', 'AWARDED'] },
    },
    data: { status: 'ELIMINATED' },
  });
  if (changed.count === 0) {
    const row = await tx.tournament.findUniqueOrThrow({
      where: { id: tournamentId },
      select: { activePlayers: true },
    });
    return row.activePlayers;
  }
  const updated = await tx.tournament.update({
    where: { id: tournamentId },
    data: { activePlayers: { decrement: changed.count } },
    select: { activePlayers: true },
  });
  return updated.activePlayers;
});
```

`startStack`·`entryFee`가 이 메서드 안에 없으면 `tournament`를 한 번 읽어 가져온다. `mutateSnapshot` 콜백 **안에서** Redis에 쓰는 것이 되지 않게 주의한다 — 대입은 락과 무관하지만, 콜백 안의 예외가 스냅샷 쓰기를 되돌리므로 부수효과를 섞지 않는다.

- [ ] **Step 4: 초록불을 본다**

```bash
KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- elimination.int-spec
```

- [ ] **Step 5: 시드의 이중 계상을 없앤다**

`backend/prisma/seed.ts`의

```ts
activePlayers: players.length,
```

를

```ts
// T55 이후 이 값은 **첫 착석만** 올린다(`EntryService.claimSeat`).
// 참가자를 전원 WAITING으로 만들면서 여기에 인원을 써 넣으면, 그들이
// OTP로 앉는 순간 두 배가 된다 — 첫 탈락이 "14위"가 되어 상금이 한 푼도
// 안 나가고 대회를 닫을 수 없다. `seed-load.ts`는 이 필드를 건드리지 않는다.
activePlayers: 0,
```

- [ ] **Step 6: 시드를 실제로 돌려 확인한다**

**자동 테스트가 없는 자리다.** 시드는 개발 DB를 지우고 다시 만드는 스크립트라 통합 테스트가 부르지 않는다. 손으로 확인한다.

```bash
npm run seed
```

그 뒤 개발 DB에서 `SELECT "activePlayers", "totalPlayers" FROM "Tournament";`가 `0` / `7`인지 본다. 확인 사실을 커밋 메시지에 적는다.

- [ ] **Step 7: 커밋**

```bash
git add backend/src/dealer/dealer.service.ts backend/prisma/seed.ts backend/src/playsync/elimination.int-spec.ts
git commit -m "fix: 킥이 Redis 인원도 깎고, 시드가 인원을 이중 계상하지 않는다"
```

---

### Task 5: 복구가 항상 맞춘다 · 죽은 프리미티브 제거 · 문서

**Files:**
- Modify: `backend/src/recovery/recovery.service.ts` (`recoverTournament`)
- Modify: `backend/src/redis/redis.service.ts` (`seatPlayer`·`eliminatedPlayer` 제거)
- Test: `backend/src/recovery/recovery.service.int-spec.ts`
- Modify: `docs/tickets-audit.md`, `docs/domain.md`

**Interfaces:**
- Consumes: Task 1~4의 전부
- Produces: 없음

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
it('info 키가 살아 있어도 어긋난 인원을 DB로 맞춘다', async () => {
  // 지금 복구는 getTournamentBlind가 null일 때, 즉 메타를 통째로 잃었을
  // 때만 DB로 다시 세운다. 카운터만 어긋난 이 경우는 영영 안 낫는다.
  await redis.hset(infoKey, 'activePlayer', 9);

  await recovery.recoverAll();

  expect(await activePlayerInRedis()).toBe(await activePlayersInDb());
});

it('다운타임이 0이어도 맞춘다', async () => {
  await redis.hset(infoKey, 'activePlayer', 9);

  await recovery.recoverAll();

  expect(await activePlayerInRedis()).toBe(await activePlayersInDb());
});
```

`recoverTournament`은 private이라 `recoverAll()`로 들어간다 — 이 스펙 파일이 이미 그렇게 부른다. 두 번째 테스트는 하트비트 키를 두지 않아 `downtimeMs()`가 0을 주는 상태에서 부른다.

- [ ] **Step 2: 빨간불을 본다**

```bash
KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- recovery.service.int-spec
```

- [ ] **Step 3: 복구를 고친다**

`recoverTournament`의 `blind`가 살아 있는 분기 끝에 더한다. `downtime > 0` 안이 아니라 **분기 자체의 끝**이다.

```ts
if (blind) {
  if (downtime > 0) {
    // ... 기준점 밀기와 캐시 재계산 (그대로)
  }

  // 인원수는 다운타임과 무관하게 맞춘다. **이것이 최후의 그물이다** —
  // 짝을 빠뜨린 새 경로가 생겨도 그 대회의 다음 재기동에서 사라진다.
  // 대입이라(`syncActivePlayer`) 여기서 다시 써도 잃는 정보가 없다.
  await this.redis.syncActivePlayer(tournamentId, t.activePlayers, t.startStack, t.entryFee);
} else {
  // 메타를 통째로 잃었다. buildTournamentMeta가 이미 DB activePlayers를 싣는다.
}
```

`t`가 `startStack`·`entryFee`를 들고 있는지 확인한다(`include: { blindStructure: true }`라 스칼라는 전부 온다).

- [ ] **Step 4: 죽은 프리미티브를 지운다**

`RedisService`의 `seatPlayer`와 `eliminatedPlayer`를 제거한다. 호출부가 남아 있으면 타입 체크가 잡는다.

```bash
npm run typecheck
```

테스트가 이 둘을 직접 부르고 있으면 `syncActivePlayer`로 바꾼다. **`rebuyPlayer`는 `activePlayer`를 건드리지 않으므로 남긴다.**

- [ ] **Step 5: 초록불과 전체 회귀를 본다**

```bash
npm run typecheck
npm run test
KEEP_TEST_CONTAINERS=1 npm run test:int -w backend
```

기준선(타입 0 / contract 62 / 단위 250 / 통합 451)에 이 계획이 더한 테스트 수만큼 늘어야 한다. **줄어들면 무언가를 지운 것이다.**

- [ ] **Step 6: 문서를 고친다**

`docs/tickets-audit.md`:
- 우선순위 표의 T60 상태를 `대기` → `완료 (#PR번호)`
- 잔여 목록에서 `RedisService.recalculateAvgStack` 줄을 지운다(Task 1이 고쳤다)

`docs/domain.md`의 인원 카운터 절(「카운터는 **첫 착석**에서만 오른다」 부근):
- DB가 진실이고 Redis `activePlayer`는 `syncActivePlayer`가 대입하는 파생 표시라는 것
- 최후 1인 판정과 탈락 등수가 **DB에서** 온다는 것
- 킥으로 마지막 한 명이 남는 경우는 판정 경로가 없고, 규칙으로 막는다는 것 (`backlog.md`)

- [ ] **Step 7: 커밋**

```bash
git add -A
git commit -m "fix: 재기동 복구가 인원수를 항상 맞추고, 상대 증감 경로를 지운다"
```

---

## 완료 조건

- [ ] 대장 4-1 ~ 4-4가 각각 테스트로 덮였고, 각 테스트의 빨간불을 봤다
- [ ] **DB와 Redis를 일부러 갈라 놓고 시작하는 케이스**가 각 경로에 있다 (T29의 함정)
- [ ] `hincrby`로 `activePlayer`를 움직이는 코드가 리포에 없다 (`grep -rn "activePlayer'" backend/src`)
- [ ] `npm run typecheck` 0건, 단위·통합 전부 초록, 개수가 기준선 이상
- [ ] `npm run seed` 후 `activePlayers`가 0이다
- [ ] 문서 셋이 갱신됐다 — `tickets-audit.md` 상태·잔여 목록, `domain.md` 규칙
