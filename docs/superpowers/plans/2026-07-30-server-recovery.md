# T31 서버 장애 복구 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 서버가 다시 뜰 때 정지한 시간을 블라인드 시계에서 빼고, Redis를 잃은
테이블만 DB로 재구성한다.

**Architecture:** 하트비트(서버 단위 한 행, DB)가 "마지막으로 살아 있던 시각"을
남긴다. 부팅 훅이 `ONGOING` 대회를 훑어 **대회 단위**로 블라인드 기준점을 밀고,
**테이블 단위**로 Redis 키 셋(스냅샷·좌석 비트맵·유저 컨텍스트)이 없는 테이블만
DB로 세운다. 서버는 "무슨 장애였나"를 추측하지 않고 "지금 무엇이 없나"만 본다.

**Tech Stack:** NestJS, Prisma 7.8(드라이버 어댑터 + pg Pool), ioredis, jest.

**설계 근거:** [`../specs/2026-07-30-server-recovery-design.md`](../specs/2026-07-30-server-recovery-design.md).
이 계획은 그 스펙의 결정 1~5을 구현한다.

## Global Constraints

- **엔드포인트도 화면도 만들지 않는다.** 재구성은 플랫폼 몫이고 상점이 판단할
  것이 없다. contract 패키지도 건드리지 않는다.
- **`Tournament.startedAt`은 절대 밀지 않는다.** 밀리는 것은 Redis
  `BlindField.startedAt`뿐이다. 두 값은 다른 뜻이다.
- **`getCurrentBlindLevel`(`shared/util/util.ts:4`)의 시그니처를 바꾸지 않는다.**
  스톱워치 모델은 기각됐다.
- **블라인드 기준점은 대회당 한 번만 민다.** 테이블 루프 안에서 밀면 테이블 수만큼
  밀린다.
- **재구성은 `TournamentParticipation.status === 'PLAYING'`인 사람만 앉힌다.**
  좌석 행만 보면 `ELIMINATED`/`AWARDED`를 되살린다(T29 검사 3과 같은 이유).
- **락 안에 새 무한 대기를 넣지 않는다.** 이 리포가 T8~T29까지 지킨 규칙이다.
- 정지 시간 계산에 **임계값을 두지 않는다.** `now - beatAt`을 항상 더한다.
  하트비트 행이 없을 때만 건너뛴다.
- 커밋 메시지·주석·문서는 **한국어**. PR 제목/본문도 한국어.
- 버그 수정과 새 검사는 **실패를 먼저 본다.** 처음부터 통과하는 테스트는 의심한다.
- 검사가 둘이면 **둘이 어긋나는 입력**을 먹인다(CLAUDE.md의 네 번째 가짜 초록).

## 리뷰 예산

CLAUDE.md의 `### 리뷰 예산`을 따른다.

| Task | 태스크 리뷰 |
|---|---|
| 1. 스키마 + `buttonUser` 쓰기 | **받는다** — 트랜잭션에 줄을 넣는다 |
| 2. 하트비트 + 대회 단위 보정 | **받는다** — 부팅 경로의 새 제품 코드 |
| 3. 테이블 단위 재구성 + `entry` 가드 | **받는다** — 락 경계와 좌석에 닿는다 |
| 4. 시나리오 + 문서 | **안 받는다** — 최종 전체 리뷰가 본다 |

리뷰어에게 전체 스위트를 다시 돌리게 하지 않는다. 돌려도 되는 것:

```bash
cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json \
  --testPathPatterns <해당 스펙>
```

## File Structure

**만드는 것**

| 파일 | 책임 |
|---|---|
| `backend/src/store/session/tournament-meta.ts` | `Dashboard`·`BlindField`를 DB 행에서 짜는 순수 함수. `initializeGame`과 재구성이 공유 |
| `backend/src/recovery/heartbeat.service.ts` | `setInterval`로 하트비트를 찍는다. Redis ping이 조건 |
| `backend/src/recovery/recovery.service.ts` | `recoverAll()`. 부팅 훅이 이것을 부른다 |
| `backend/src/recovery/recovery.module.ts` | 위 둘 등록 |
| `backend/prisma/migrations/<ts>_server_recovery/migration.sql` | 컬럼 둘 + 테이블 하나 |
| `backend/src/recovery/recovery.service.int-spec.ts` | 보정·재구성 통합 테스트 |
| `backend/src/recovery/heartbeat.service.int-spec.ts` | 하트비트 통합 테스트 |
| `backend/src/store/session/tournament-meta.spec.ts` | 순수 함수 단위 테스트 |
| `backend/src/scenario/server-recovery.int-spec.ts` | 시나리오 |

**고치는 것**

| 파일 | 무엇 |
|---|---|
| `backend/prisma/schema.prisma` | `Table.buttonUser`, `Tournament.pausedMs`, `ServerHeartbeat` |
| `backend/src/store/session/session.service.ts` | `initializeGame`이 뽑은 버튼을 반환, `startSession` 트랜잭션이 쓴다, `tournament-meta.ts` 사용, `:391-399` 주석 정정 |
| `backend/src/playsync/playsync.service.ts` | `syncTableInventoryToDb`가 `buttonUser`를 같은 트랜잭션에 쓴다 |
| `backend/src/entry/entry.service.ts` | 락 밖 `table.findUnique`에 대회 상태를 얹고, `ONGOING`이면 빈 스냅샷 fallback 금지 |
| `backend/src/app.module.ts` | `RecoveryModule` 등록 |
| `backend/src/scenario/harness.ts` | `recovery` 추가 |
| `docs/tickets-next.md`, `docs/backlog.md`, `CLAUDE.md` | 기록과 기준선 |

---

### Task 1: 스키마와 `buttonUser` 쓰기 경로 둘

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/<timestamp>_server_recovery/migration.sql`
- Modify: `backend/src/store/session/session.service.ts:384-403` (`startSession`), `:460-490` (`initializeGame`)
- Modify: `backend/src/playsync/playsync.service.ts:219-234` (`syncTableInventoryToDb`)
- Test: `backend/src/playsync/playsync.service.int-spec.ts`, `backend/src/store/session/session.service.int-spec.ts`

**Interfaces:**
- Produces: `Table.buttonUser Int?`, `Tournament.pausedMs Int @default(0)`,
  `ServerHeartbeat { id: String, beatAt: DateTime }`.
  `initializeGame`의 반환이 `{ startedAt: Date, buttons: { tableId: string; buttonUser: number }[] }`가 된다.
  Task 2·3이 이 컬럼들을 읽는다.

- [ ] **Step 1: 스키마에 셋을 추가한다**

`schema.prisma`의 `Table` 모델:

```prisma
  /// 직전 핸드의 버튼 좌석. `TablePlayer.seatPosition`과 같은 좌표계다.
  ///
  /// `TableState`의 필드 중 DB에서 파생되지 않는 유일한 값이다 — 나머지는
  /// 현재 사실(누가 어디 앉았고 칩이 얼마인가)에서 나오는데 버튼만 "지난
  /// 핸드에 누가 버튼이었나"의 함수다. 그래서 스냅샷을 잃으면 이것만
  /// 복구할 근거가 없다.
  ///
  /// 시작 전에는 값이 없다(`null`). 시작 트랜잭션이 첫 추첨 결과를 쓰고,
  /// 그 뒤에는 핸드 종료 체크포인트가 갱신한다.
  buttonUser Int?
```

`Tournament` 모델:

```prisma
  /// 장애로 정지한 **누적** 시간(ms). 블라인드 시계의 기준점을 이만큼 뒤로
  /// 민다.
  ///
  /// 누적인 이유: 대회 하나가 두 번 장애를 겪을 수 있고, 그때 Redis의
  /// 기준점은 이미 첫 번째만큼 밀려 있으므로 두 번째는 더해야 맞다.
  /// 덮어쓰면 첫 번째가 사라진다.
  ///
  /// `startedAt`과 뜻이 다르다. `startedAt`은 대회가 실제로 시작한 시각이고
  /// 절대 밀리지 않는다. 미는 것은 Redis `BlindField.startedAt`이다.
  pausedMs Int @default(0)
```

파일 끝에 새 모델:

```prisma
/// 서버가 마지막으로 살아 있던 시각. 행이 하나다 — "한 행사장 한 프로세스"가
/// 배치 단위라(backlog.md의 B9) 이 서버가 죽으면 그가 든 모든 대회가 같이
/// 죽는다. 대회별로 다른 다운타임이 나올 수 없다.
///
/// Redis가 아니라 DB에 산다. Redis에 두면 Redis를 잃은 케이스에서 하트비트도
/// 같이 사라져 다운타임을 알 방법이 없어진다 — 정확히 필요한 순간에 없다.
///
/// `@updatedAt`을 쓰지 않는다. 이 값은 **Redis ping이 성공했을 때만** 올라가야
/// 하므로, 조건과 값의 관계가 코드 한 자리에 보여야 한다.
model ServerHeartbeat {
  id     String   @id @default("singleton")
  beatAt DateTime
}
```

- [ ] **Step 2: 마이그레이션을 만든다**

```bash
cd backend && npx prisma migrate dev --name server_recovery
```

이미 적용된 마이그레이션 파일은 **고치지 않는다**(`backlog.md:322`). 새 파일만
생긴 것을 확인한다.

- [ ] **Step 3: 실패하는 테스트를 쓴다 — 시작 트랜잭션이 버튼을 쓴다**

`backend/src/store/session/session.service.int-spec.ts`에 추가:

```ts
it('시작 트랜잭션이 뽑은 버튼 좌석을 DB에 남긴다', async () => {
  // 준비: 대회 하나, 테이블 하나, 착석 2명 (기존 헬퍼 사용)
  await session.startSession(tournamentId);

  const table = await prisma.table.findUniqueOrThrow({
    where: { id: tableId },
    select: { buttonUser: true },
  });
  const snapshot = await redisService.getSnapShot(tableId);

  expect(table.buttonUser).not.toBeNull();
  expect(`DB ${table.buttonUser}`).toBe(`DB ${snapshot!.buttonUser}`);
});
```

값을 문자열로 감싸는 이유는 실패 메시지에 무엇이 어긋났는지 남기기 위한 것이다
(이 리포의 시나리오 관례).

- [ ] **Step 4: 실패를 확인한다**

```bash
cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json \
  --testPathPatterns session.service
```

Expected: FAIL. `table.buttonUser`가 `null`이라 `not.toBeNull()`이 깨진다.
**expected/received를 보고서에 그대로 옮긴다.**

- [ ] **Step 5: `initializeGame`이 뽑은 버튼을 반환한다**

`session.service.ts:465-475`의 `tableStates` 구성은 그대로 두고, 반환만 바꾼다:

```ts
    await this.redis.setTournamentMeta(id, dashboard, blindField);
    await this.redis.saveInitialTableSnapshots(
      tableStates as { tableId: string; state: TableState }[],
    );

    // 뽑은 버튼을 호출자에게 넘긴다. 여기서 DB에 쓰지 않는 이유는 이 메서드가
    // "아직 시작이 아니다"라는 계약을 갖기 때문이다 — 커밋은 startSession의
    // 트랜잭션 하나뿐이어야 실패 시 PENDING으로 남아 재시도가 성립한다.
    const buttons = (tableStates as { tableId: string; state: TableState }[])
      .map(t => ({ tableId: t.tableId, buttonUser: t.state.buttonUser }));

    return { startedAt, buttons };
```

- [ ] **Step 6: `startSession`의 트랜잭션이 버튼을 쓴다**

`session.service.ts:385`부터:

```ts
    const { startedAt, buttons } = await this.initializeGame(id);
```

그리고 트랜잭션 안, `tournament.update` **앞**에:

```ts
    return await this.prismaService.$transaction(async (tx) => {
      // 첫 버튼 추첨 결과를 시작과 같은 트랜잭션에 남긴다. 이것이 없으면
      // 첫 핸드가 끝나기 전에 죽었을 때 복구가 읽을 버튼이 없다 — 핸드 종료
      // 체크포인트가 첫 독자가 되기 전까지 null인 구간이 생긴다.
      for (const b of buttons) {
        await tx.table.update({
          where: { id: b.tableId },
          data: { buttonUser: b.buttonUser },
        });
      }

      return await tx.tournament.update({ /* 기존 그대로 */ });
    });
```

- [ ] **Step 7: `:391-399`의 주석을 정정한다**

지금 주석은 DB `startedAt`과 Redis 기준 시각의 **정합을 맞추라고** 말한다. 뜻을
갈랐으므로 고친다:

```ts
      // startedAt은 준비 단계가 정한 값을 그대로 쓴다. 여기서 다시 찍으면
      // 대회 시작 시각이 Redis에 올린 블라인드 기준점보다 뒤가 되어, 시작
      // 직후 경과 시간이 음수 방향으로 벌어진다.
      //
      // 단 이 둘은 **같은 값을 유지해야 하는 관계가 아니다**(T31). 이 컬럼은
      // 대회가 실제로 시작한 시각이고 영구히 밀리지 않는다. Redis의
      // BlindField.startedAt은 진행 시간의 기준점이라 장애 정지만큼 뒤로
      // 밀린다. 시작 시점에 두 값이 같은 것은 정합이 아니라 t=0의 우연이다.
```

- [ ] **Step 8: 테스트가 통과하는 것을 확인한다**

```bash
cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json \
  --testPathPatterns session.service
```

Expected: PASS.

- [ ] **Step 9: 실패하는 테스트를 쓴다 — 체크포인트가 버튼을 갱신한다**

`backend/src/playsync/playsync.service.int-spec.ts`에 추가:

```ts
it('핸드 종료 체크포인트가 버튼 좌석도 같은 트랜잭션에 남긴다', async () => {
  const state = await redisService.getSnapShot(tableId);
  state!.buttonUser = 5;
  await redisService.saveSnapShot(tableId, state!);

  const ok = await playsync.syncTableInventoryToDb(state!);
  expect(ok).toBe(true);

  const table = await prisma.table.findUniqueOrThrow({
    where: { id: tableId },
    select: { buttonUser: true },
  });
  expect(`버튼 ${table.buttonUser}`).toBe('버튼 5');
});
```

- [ ] **Step 10: 실패를 확인한다**

Expected: FAIL. `버튼 null`(또는 시작 시 뽑힌 값)을 받는다. 값을 보고서에 옮긴다.

- [ ] **Step 11: `syncTableInventoryToDb`에 한 줄을 더한다**

`playsync.service.ts:225`의 `updates` 배열 뒤에:

```ts
    // 버튼도 같은 트랜잭션이다. 스택과 버튼이 갈라지면 복구가 "칩은 이 핸드,
    // 버튼은 저 핸드"인 상태를 만든다. 체크포인트가 원자적이어야 DB가 항상
    // **어떤 한 핸드의 끝**을 가리킨다.
    //
    // `updateMany`가 아니라 `update`인 이유는 위 스택과 같다 — 대상이 0행이면
    // 조용히 성공한다.
    const updates = [
      ...state.players.filter(p => p !== null).map(/* 기존 그대로 */),
      this.prisma.table.update({
        where: { id: tableId },
        data: { buttonUser: state.buttonUser },
      }),
    ];
```

`syncTableInventoryToDb`는 지금 `state: TableState`만 받고 `tableId`가 없다.
`state.players[].tableId`가 있지만 빈 테이블에서는 못 뽑는다. **시그니처에
`tableId`를 앞에 추가한다.** 고칠 자리가 셋뿐이다:

| 파일:줄 | 무엇 |
|---|---|
| `playsync.service.ts:219` | 정의 |
| `playsync.service.ts:257` | 유일한 제품 호출자. `checkpointTableToDb(tableId)` 안이라 이미 갖고 있다 |
| `playsync.service.int-spec.ts:521` | 기존 테스트 호출 |

`dealer.service.int-spec.ts`의 스파이 7개는 `jest.spyOn(...).mockResolvedValue(...)`
라 인자를 보지 않으므로 손대지 않는다.

- [ ] **Step 12: 통과 확인 + 단위·통합 전체**

```bash
cd backend && npm run test -w backend
cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json \
  --testPathPatterns "playsync.service|session.service"
```

- [ ] **Step 13: 커밋**

```bash
git add backend/prisma backend/src/store/session backend/src/playsync
git commit -m "feat: 버튼 좌석과 정지 시간을 DB가 들게 한다"
```

---

### Task 2: 하트비트와 대회 단위 시간 보정

**Files:**
- Create: `backend/src/store/session/tournament-meta.ts`
- Create: `backend/src/recovery/heartbeat.service.ts`, `recovery.service.ts`, `recovery.module.ts`
- Modify: `backend/src/store/session/session.service.ts:420-450` (`initializeGame`이 새 함수를 쓴다)
- Modify: `backend/src/app.module.ts`
- Test: `backend/src/store/session/tournament-meta.spec.ts`,
  `backend/src/recovery/heartbeat.service.int-spec.ts`,
  `backend/src/recovery/recovery.service.int-spec.ts`

**Interfaces:**
- Consumes: Task 1의 `Tournament.pausedMs`, `ServerHeartbeat`.
- Produces:
  - `buildTournamentMeta(game, blindBaseAt: number): { dashboard: Dashboard; blindField: BlindField }`
  - `HeartbeatService.beatOnce(): Promise<boolean>` — 찍었으면 `true`, ping 실패면 `false`
  - `RecoveryService.recoverAll(): Promise<void>` — 부팅 훅이 부른다. Task 3이 이
    안의 테이블 루프를 채운다
  - `RecoveryService.downtimeMs(): Promise<number | null>` — 하트비트 행이 없으면 `null`

- [ ] **Step 1: `buildTournamentMeta`를 추출한다**

`session.service.ts:421-450`의 `dashboard`·`blindField` 구성을 그대로 옮긴다.
**로직을 바꾸지 않는다** — 기준점만 인자로 받는다.

`backend/src/store/session/tournament-meta.ts`:

```ts
import { BlindField, Dashboard } from 'shared/types/tournamentMeta';
import { getCurrentBlindLevel, parseBlindStructure } from 'shared/util/util';
import { startablePayouts } from 'src/playsync/prize';

/**
 * 대회 메타(전광판 + 블라인드 시계)를 DB 행에서 짠다.
 *
 * 두 호출자가 있다. 대회 시작(`initializeGame`)은 기준점이 "지금"이고, 장애
 * 복구(`RecoveryService`)는 `Tournament.startedAt + pausedMs`다. 구성 자체는
 * 같아야 한다 — 갈라지면 복구된 대회의 전광판이 정상 대회와 다른 값을 보인다.
 *
 * `blindBaseAt`은 **Redis BlindField의 기준점**이고 DB `Tournament.startedAt`이
 * 아니다. 둘은 다른 뜻이다(T31 스펙 결정 1).
 */
/**
 * 이 함수가 읽는 것만 받는다. Prisma 모델 전체를 받지 않는 이유는 두 호출자의
 * `include`가 다를 수 있는데 이 함수는 둘 다에서 같은 필드만 쓰기 때문이다.
 */
export interface TournamentMetaSource {
  name: string;
  entryFee: number;
  startStack: number;
  isRegistrationOpen: boolean;
  totalPlayers: number;
  activePlayers: number;
  totalBuyinAmount: number;
  rebuyUntil: number;
  avgStack: number;
  itmCount: number;
  prizePayouts: PrizePayout[];
  blindStructure: { structure: unknown };
}

export function buildTournamentMeta(
  game: TournamentMetaSource,
  blindBaseAt: number,
): { dashboard: Dashboard; blindField: BlindField } {
  const blindStructure = parseBlindStructure(game.blindStructure.structure);
  const blindInfo = getCurrentBlindLevel(blindStructure, blindBaseAt);

  // `session.service.ts:421-441`의 `dashboard` 리터럴을 **그대로** 옮긴다.
  // 주석까지 함께 옮긴다 — 그 주석들이 왜 DB 누적값을 쓰는지(`totalBuyinAmount`),
  // 왜 금액을 여기서 굳히지 않는지(`prizes`)를 설명한다. 다시 타이핑하면
  // 드리프트가 생기므로 잘라 붙인다.
  const dashboard: Dashboard = { /* ← 그 리터럴 */ };
  const blindField: BlindField = {
    isBreak: blindInfo.isBreak,
    startedAt: blindBaseAt,
    currentBlindLv: blindInfo.currentIndex,
    nextLevelAt: blindInfo.nextLevelAt,
    serverTime: Date.now(),
    blindStructure,
  };

  return { dashboard, blindField };
}
```

**주의**: 지금 `initializeGame`은 `blindField.isBreak`를 `false`로 **하드코딩**한다
(`session.service.ts:443`). 시작 시점에는 항상 레벨 0이라 맞는 값이지만, 복구는
중간 레벨에서 시작하므로 `blindInfo.isBreak`를 써야 한다. 위 코드가 그렇게 바꾼다 —
시작 경로에서도 결과가 같다(레벨 0이 휴식인 구조표는 없다).

- [ ] **Step 2: 단위 테스트를 쓴다**

`backend/src/store/session/tournament-meta.spec.ts`:

```ts
it('기준점을 미루면 레벨이 되돌아간다', () => {
  const structure = [
    { lv: 1, sb: 100, ante: false, duration: 10 },
    { lv: 2, sb: 200, ante: false, duration: 10 },
  ];
  const game = { blindStructure: { structure }, prizePayouts: [], /* 나머지 0 */ };

  // 25분 전에 시작 → 레벨 2 (인덱스 1)
  const now = Date.now();
  const running = buildTournamentMeta(game, now - 25 * 60 * 1000);
  expect(`레벨 ${running.blindField.currentBlindLv}`).toBe('레벨 1');

  // 20분을 정지했다면 기준점이 20분 뒤로 밀린다 → 레벨 1 (인덱스 0)
  const paused = buildTournamentMeta(game, now - 25 * 60 * 1000 + 20 * 60 * 1000);
  expect(`레벨 ${paused.blindField.currentBlindLv}`).toBe('레벨 0');
});

it('중간 레벨이 휴식이면 isBreak가 참이다', () => {
  // lv 99가 휴식이다. 하드코딩된 false였다면 이 테스트가 빨개진다.
});
```

- [ ] **Step 3: 실패를 확인한다**

```bash
cd backend && npx jest --testPathPatterns tournament-meta
```

Expected: FAIL, `Cannot find module` (파일이 아직 없으면 Step 1 뒤에 도니 통과).
Step 1을 먼저 했으므로 여기서는 **두 번째 테스트(`isBreak`)가 하드코딩을 잡는지**
확인하는 것이 목적이다. `isBreak: blindInfo.isBreak`를 `false`로 되돌려 빨간불을
보고 복원한다.

- [ ] **Step 4: `initializeGame`이 새 함수를 쓴다**

`session.service.ts:421-450`을 지우고:

```ts
    const { dashboard, blindField } = buildTournamentMeta(game, startedAt.getTime());
```

`session.service.spec.ts`와 관련 통합 테스트가 그대로 통과하는지 본다. 값이
바뀌면 추출이 잘못된 것이다.

- [ ] **Step 5: `HeartbeatService`를 쓴다**

```ts
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from 'src/prisma/prisma.service';

const HEARTBEAT_ID = 'singleton';
const DEFAULT_INTERVAL_MS = 30_000;

/**
 * 서버가 살아 있다는 사실을 DB에 남긴다. 복구가 다운타임을 계산하는 유일한
 * 근거다.
 *
 * **Redis ping이 성공할 때만 찍는다.** 시각만 찍으면 "서버는 살아 있고 Redis만
 * 죽은" 구간을 못 잡는다 — 그 구간에는 모든 게임 경로가 스냅샷을 못 읽어
 * 던지므로 대회는 실제로 멈춰 있는데, 하트비트가 계속 찍히면 정지 시간이 0이
 * 된다. 조건 하나가 케이스 하나를 닫는다.
 *
 * BullMQ 반복 잡을 쓰지 않는 이유: 잡이 Redis에 살고 at-least-once라 중복
 * 배달이 하트비트에는 노이즈다. `@nestjs/schedule`을 넣지 않는 이유: 의존성
 * 하나를 위해 얻는 것이 `setInterval` 대비 없다. `prisma.service.ts:53`이 이미
 * 같은 라이프사이클 패턴을 쓴다.
 */
@Injectable()
export class HeartbeatService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(HeartbeatService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  onApplicationBootstrap() {
    const ms = Number(process.env.HEARTBEAT_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
    this.timer = setInterval(() => {
      void this.beatOnce().catch(e =>
        // 실패를 삼키지 않는다. 다음 주기가 재시도이므로 프로세스는 유지한다.
        this.logger.warn(`하트비트 실패: ${(e as Error).message}`),
      );
    }, ms);
    // 하트비트가 이벤트 루프를 붙잡아 프로세스 종료를 막지 않게 한다.
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** 찍었으면 true. Redis ping이 실패하면 찍지 않고 false. */
  async beatOnce(): Promise<boolean> {
    try {
      await this.redis.ping();
    } catch (e) {
      this.logger.warn(`Redis ping 실패 — 하트비트를 찍지 않는다: ${(e as Error).message}`);
      return false;
    }

    const now = new Date();
    await this.prisma.serverHeartbeat.upsert({
      where: { id: HEARTBEAT_ID },
      create: { id: HEARTBEAT_ID, beatAt: now },
      update: { beatAt: now },
    });
    return true;
  }
}
```

- [ ] **Step 6: `RecoveryService`의 시간 보정 부분을 쓴다**

```ts
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { TournamentStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { buildTournamentMeta } from 'src/store/session/tournament-meta';

@Injectable()
export class RecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async onApplicationBootstrap() {
    await this.recoverAll();
  }

  /**
   * 하트비트가 마지막으로 찍힌 뒤 흐른 시간. 행이 없으면 `null`(최초 부팅).
   *
   * 임계값을 두지 않는다. 정상 재시작 5초도 5초 밀리는데 그게 맞다 — 그 5초
   * 동안 대회는 진짜로 돌지 않았다. "얼마 이상이면 장애"를 정하면 그 미만의
   * 정지가 조용히 진행 시간으로 들어간다.
   */
  async downtimeMs(): Promise<number | null> {
    const beat = await this.prisma.serverHeartbeat.findUnique({
      where: { id: 'singleton' },
    });
    if (!beat) return null;
    return Math.max(0, Date.now() - beat.beatAt.getTime());
  }

  /**
   * 부팅 복구. **서버는 무슨 장애였는지 추측하지 않는다** — 지금 무엇이
   * 없는지만 본다.
   *
   * 실패는 대회 단위로 격리한다. 대회 하나 때문에 프로세스가 안 뜨면 다른
   * 대회까지 서비스가 없어진다. 조용해지는 것이 아니다 — 실패한 대회는
   * Redis 키가 계속 없으므로 게임 경로가 전부 던지고 딜러가 첫 액션에서 안다.
   * 그 안전성은 `entry`의 빈 스냅샷 fallback 금지에 의존한다(Task 3).
   */
  async recoverAll(): Promise<void> {
    const downtime = await this.downtimeMs();
    if (downtime === null) {
      this.logger.log('하트비트가 없다 — 최초 부팅으로 보고 정지 시간 보정을 건너뛴다');
    }

    const tournaments = await this.prisma.tournament.findMany({
      where: { status: TournamentStatus.ONGOING },
      select: { id: true },
    });

    for (const t of tournaments) {
      try {
        await this.recoverTournament(t.id, downtime ?? 0);
      } catch (e) {
        this.logger.error(`대회 복구 실패 (tournament=${t.id})`, e as Error);
      }
    }
  }

  private async recoverTournament(tournamentId: string, downtime: number) {
    // 1. 누적 정지 시간을 더한다. increment이지 대입이 아니다 — 대회 하나가
    //    두 번 장애를 겪으면 Redis 기준점은 이미 첫 번째만큼 밀려 있다.
    const t = downtime > 0
      ? await this.prisma.tournament.update({
          where: { id: tournamentId },
          data: { pausedMs: { increment: downtime } },
          include: { blindStructure: true },
        })
      : await this.prisma.tournament.findUniqueOrThrow({
          where: { id: tournamentId },
          include: { blindStructure: true },
        });

    // 2. **대회 단위**로 블라인드 기준점을 다룬다. blindField는 대회 하나에
    //    하나(`tournament:{id}:info`)이므로, 테이블 루프 안에서 밀면 테이블
    //    수만큼 밀린다.
    const blind = await this.redis.getTournamentBlind(tournamentId);
    if (blind) {
      if (downtime > 0) {
        await this.redis.setTournamentBlind(tournamentId, {
          ...blind,
          startedAt: blind.startedAt + downtime,
        });
      }
    } else {
      // 메타를 통째로 잃었다. DB로 다시 세운다. 기준점은 대회가 실제로
      // 시작한 시각에 누적 정지를 더한 값이다.
      if (!t.startedAt) throw new Error('ONGOING인데 startedAt이 없다');
      const { dashboard, blindField } = buildTournamentMeta(
        t,
        t.startedAt.getTime() + t.pausedMs,
      );
      await this.redis.setTournamentMeta(tournamentId, dashboard, blindField);
    }

    // 3. 테이블 단위 재구성은 Task 3이 채운다.
  }
}
```

**정정(최종 리뷰 Important 1).** 아래 문단은 절반만 맞다.

맞는 절반: **레벨은 밀기만으로 이미 옳다.** 기준점을 D만큼 밀었는데 실제 시계도
D만큼 흘렀으므로 경과 시간이 상쇄돼, 부팅 시점의 레벨이 죽은 시점의 레벨과 같다 —
그게 재개할 레벨이다. 다음 핸드가 어느 경로로 레벨을 읽든(핸드 중에는
`TableState`, 핸드 시작에는 `checkAndSyncBlindLevel`) 그 값을 본다. 서버가 상태를
안 들고 기준점에서 파생시키는 설계가 여기서 값을 한다.

틀린 절반: 그 파생 **앞에 캐시가 있다.** `checkAndSyncBlindLevel`
(`redis.service.ts`)에는 조기 반환(`if (blind.nextLevelAt && now <
blind.nextLevelAt) return { ...blind };`)이 있고, 쓰기도 레벨·`isBreak`가 바뀔
때만 한다. 둘 다 "기준점은 그대로"를 전제해서, 기준점이 밖에서 움직인 직후에는
답을 못 낸다. 결과 둘:

1. 레벨이 그대로면 쓰기 게이트가 안 열려 `nextLevelAt`이 낡은 채로 남는다 —
   전광판 카운트다운이 0에 닿은 뒤 다운타임만큼 멈춘다.
2. 하트비트 주기(30초) 때문에 측정된 D는 실제 정지보다 최대 그만큼 크다. 과잉
   보정으로 민 기준점의 레벨이 한 칸 내려가면, 캐시가 낡은 레벨을 들고 있어
   전광판과 다음 핸드가 서로 다른 레벨을 본다.

그래서 실제 구현은 기준점을 민 뒤 `checkAndSyncBlindLevel(id, { force: true })`로
캐시를 다시 세운다. 파생식을 `recovery`에 복제하지 않는 이유는 재계산이 등록 마감
내리기(`curLv >= rebuyUntil`)를 함께 하기 때문이다 — 복제하면 그 규칙이 복구
경로에서만 빠진다.

> ~~`blind`가 있을 때 `nextLevelAt`을 다시 계산하지 않는 이유:
> `checkAndSyncBlindLevel`(`redis.service.ts:353`)이 `startedAt`으로부터 매번
> 다시 계산하고, 여러 칸을 한 번에 뛰는 것도 이미 처리한다(`:378` 주석). 여기서
> 손대면 같은 계산이 두 곳이 된다.~~ — 이 문단이 놓친 것은 그 재계산이 캐시
> 조기 반환 뒤에서만 일어난다는 점이다.

- [ ] **Step 7: `RecoveryModule`을 만들고 `app.module.ts`에 등록한다**

```ts
@Module({ providers: [HeartbeatService, RecoveryService] })
export class RecoveryModule {}
```

`RedisModule`이 `@Global`이고 `PrismaModule`도 전역이므로 import는 필요 없다.
확인만 한다.

- [ ] **Step 8: 실패하는 통합 테스트를 쓴다**

`heartbeat.service.int-spec.ts`:

```ts
it('Redis ping이 실패하면 하트비트를 찍지 않는다', async () => {
  const before = await prisma.serverHeartbeat.findUnique({ where: { id: 'singleton' } });
  const broken = { ping: () => Promise.reject(new Error('down')) } as any;
  const svc = new HeartbeatService(prisma as any, broken);

  expect(await svc.beatOnce()).toBe(false);
  const after = await prisma.serverHeartbeat.findUnique({ where: { id: 'singleton' } });
  expect(`행 ${after?.beatAt.getTime() ?? 'none'}`).toBe(`행 ${before?.beatAt.getTime() ?? 'none'}`);
});

it('ping이 성공하면 upsert로 찍는다 (최초에는 행을 만든다)', async () => { /* ... */ });
```

`recovery.service.int-spec.ts`:

```ts
it('하트비트 행이 없으면 정지 시간 보정을 건너뛴다', async () => { /* pausedMs === 0 */ });

it('정지 시간을 누적한다 — 두 번 복구하면 합이 더해진다', async () => {
  await setHeartbeatAgo(60_000);
  await recovery.recoverAll();
  const first = (await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } })).pausedMs;

  await setHeartbeatAgo(30_000);
  await recovery.recoverAll();
  const second = (await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } })).pausedMs;

  // 대입(`=`)이면 second가 30초쯤이 되어 빨개진다.
  expect(second).toBeGreaterThan(first + 25_000);
});

it('블라인드 기준점을 대회당 한 번만 민다 — 테이블이 셋이어도', async () => {
  // 테이블 셋을 만들고 60초 다운타임 후 복구.
  // 밀린 양이 ~60초여야 한다. 테이블 루프 안에서 밀면 ~180초가 되어 빨개진다.
  const before = (await redisService.getTournamentBlind(tournamentId))!.startedAt;
  await setHeartbeatAgo(60_000);
  await recovery.recoverAll();
  const after = (await redisService.getTournamentBlind(tournamentId))!.startedAt;

  expect(after - before).toBeGreaterThan(55_000);
  expect(after - before).toBeLessThan(75_000);
});

it('blindField가 없으면 startedAt + pausedMs로 새로 세운다', async () => { /* ... */ });

it('한 대회의 복구가 실패해도 다른 대회는 복구된다', async () => {
  // 대회 둘. 하나는 ONGOING인데 startedAt이 null이 되게 만들어 던지게 한다.
  // 다른 하나의 pausedMs가 올라가야 한다.
});

it('블라인드 기준점을 밀면 레벨이 되돌아간다', async () => { /* checkAndSyncBlindLevel */ });
```

- [ ] **Step 9: 실패를 확인하고 통과시킨다**

```bash
cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json \
  --testPathPatterns "recovery|heartbeat"
```

RED을 먼저 보고 expected/received를 보고서에 옮긴다. 특히 **누적 테스트**와
**대회당 한 번** 테스트는 제품 코드를 일부러 되돌려(`increment` → 대입, 밀기를
테이블 루프로 이동) 빨간불을 확인하고 복원한다.

- [ ] **Step 10: 커밋**

```bash
git add backend/src/recovery backend/src/store/session backend/src/app.module.ts
git commit -m "feat: 하트비트로 정지 시간을 재고 블라인드 기준점을 되돌린다"
```

---

### Task 3: 테이블 단위 재구성과 `entry` 가드

**Files:**
- Modify: `backend/src/recovery/recovery.service.ts` (3단계를 채운다)
- Modify: `backend/src/entry/entry.service.ts:137-143`, `:212`
- Test: `backend/src/recovery/recovery.service.int-spec.ts`,
  `backend/src/entry/entry.service.int-spec.ts`

**Interfaces:**
- Consumes: Task 1의 `Table.buttonUser`, Task 2의 `RecoveryService.recoverTournament`.
- Produces: `RecoveryService`가 스냅샷·좌석 비트맵·유저 컨텍스트를 세운다.
  Task 4의 시나리오가 이것을 검사한다.

- [ ] **Step 1: 재구성 함수를 쓴다**

`recoverTournament`의 3단계:

```ts
    // 3. **테이블 단위**로 Redis 키 셋을 본다. 대회 하나 안에서 어떤 테이블은
    //    살아 있고 어떤 테이블만 유실될 수 있다(부분 유실).
    const tables = await this.prisma.table.findMany({
      where: { tournamentId },
      select: {
        id: true,
        buttonUser: true,
        tablePlayers: { select: { userId: true, nickname: true, seatPosition: true } },
      },
    });

    for (const table of tables) {
      if (table.tablePlayers.length === 0) continue;

      const existing = await this.redis.getSnapShot(table.id);
      if (existing) continue; // 살아 있다. 스냅샷에는 시간이 없으므로 손댈 것이 없다.

      await this.rebuildTable(tournamentId, table);
    }
```

```ts
  /**
   * 스냅샷을 잃은 테이블 하나를 DB로 세운다.
   *
   * **핸드 경계에서 재개한다.** phase는 WAITING이고 pot·bet·currentTurn은 0이다.
   * 핸드 중간 상태는 체크포인트 사이에만 존재하므로 복구되지 않는다 — 카드가
   * 물리라 그 핸드는 사람이 다시 딜한다. 시스템이 지킬 선은 "다음 핸드가 옳은
   * 사람에게서 시작된다"까지다.
   *
   * 락을 잡지 않는다. 부팅 시점이라 경합할 상대가 없고, 스냅샷이 없으면 모든
   * 게임 경로가 던진다. 유일한 예외인 `entry`는 같은 티켓에서 막았다.
   */
  private async rebuildTable(tournamentId: string, table: {
    id: string;
    buttonUser: number | null;
    tablePlayers: { userId: string; nickname: string | null; seatPosition: number }[];
  }) {
    if (table.buttonUser === null) {
      // 시작 트랜잭션이 반드시 채운다(Task 1). 여기 오면 버그다.
      throw new Error(`ONGOING 테이블에 buttonUser가 없다 (table=${table.id})`);
    }

    // 장부는 참가 행이다. **좌석 행만 보면 안 된다** — T29 이후 ELIMINATED와
    // AWARDED는 좌석 행이 남아 있을 수 있어서, 좌석만 보면 탈락자와 우승자를
    // 되살린다.
    const participations = await this.prisma.tournamentParticipation.findMany({
      where: {
        tournamentId,
        userId: { in: table.tablePlayers.map(p => p.userId) },
        status: PlayerStatus.PLAYING,
      },
      select: { userId: true, currentStack: true },
    });
    const stackOf = new Map(participations.map(p => [p.userId, p.currentStack]));

    const blind = await this.redis.getTournamentBlind(tournamentId);
    if (!blind) throw new Error(`블라인드 정보가 없다 (tournament=${tournamentId})`);
    const level = blind.blindStructure[blind.currentBlindLv];

    // 엔진의 좌석 타입과 Prisma 모델 이름이 둘 다 `TablePlayer`다. 이 파일은
    // 양쪽을 다 쓰므로 import에서 가른다:
    //   import { TablePlayer as SeatPlayer, TableState, GamePhase } from 'src/game-engine/types';
    const players: (SeatPlayer | null)[] = Array(9).fill(null);
    const seated: number[] = [];
    for (const p of table.tablePlayers) {
      const stack = stackOf.get(p.userId);
      if (stack === undefined) continue; // PLAYING이 아니다. 앉히지 않는다.
      players[p.seatPosition] = {
        id: p.userId,
        tableId: table.id,
        nickname: p.nickname ?? '',
        seatIndex: p.seatPosition,
        stack,
        bet: 0,
        hasFolded: false,
        hasChecked: false,
        isAllIn: false,
        totalContributed: 0,
      };
      seated.push(p.seatPosition);
    }

    const state: TableState = {
      phase: GamePhase.WAITING,
      players,
      buttonUser: table.buttonUser,
      currentTurnSeatIndex: -1,
      pot: 0,
      sidePots: [],
      currentBet: 0,
      smallBlind: level.sb,
      ante: level.ante,
      tournamentId,
    };

    await this.redis.saveSnapShot(table.id, state);

    // 스냅샷만 세우면 나머지가 어긋난다. 좌석 비트맵이 없으면 `entry`가 좌석을
    // 비어 있는 것으로 보고 다른 사람에게 판다.
    await this.redis.rebuildSeatBitmap(tournamentId, table.id, seated);

    // 유저 컨텍스트는 지금 읽는 곳이 한 군데뿐이고(playsync.service.ts:120의
    // isKicked), 재구성이 PLAYING만 앉히므로 킥된 사람은 스냅샷에 없다 — 즉
    // 안 세워도 지금은 틀리지 않는다. 그래도 세운다: 착석과 컨텍스트가 짝이라는
    // 불변식(entry.service.ts:267)을 재구성만 예외로 두면, 이 키를 읽는 코드가
    // 하나 붙는 순간 조용히 깨진다.
    for (const seat of seated) {
      const p = players[seat]!;
      await this.redis.setUserContext(tournamentId, p.id, table.id, seat, 'PLAYING');
    }

    this.logger.warn(
      `테이블을 DB로 재구성했다 (table=${table.id}, 좌석 ${seated.length}개, 버튼 ${table.buttonUser})`,
    );
  }
```

- [ ] **Step 2: `rebuildSeatBitmap`을 `RedisService`에 만든다**

`updateSeatBitmapMany`(`redis.service.ts:197`)를 쓸 수 없다. 그 Lua는 **필드가
없으면 아무것도 만들지 않고 `null`을 돌려준다** — 지워진 테이블을 되살리지 않기
위한 규칙이고 T29에서 load-bearing으로 확인됐다. 재구성은 정확히 "없는 필드를
만드는" 일이므로 별도 메서드가 맞다.

```ts
  /**
   * 좌석 비트맵을 통째로 새로 쓴다. **재구성 전용이다.**
   *
   * `updateSeatBitmapMany`를 쓸 수 없다 — 그쪽 Lua는 필드가 없으면 아무것도
   * 만들지 않고 null을 돌려준다. 지워진 테이블을 되살리지 않기 위한 규칙이고,
   * 예전에 그것이 없어서 설명되지 않는 500이 났다. 재구성은 정확히 그 반대
   * 방향이라 경로를 가른다.
   */
  async rebuildSeatBitmap(tournamentId: string, tableId: string, seatIndexes: number[]) {
    const bitmap = Array(9).fill('0');
    for (const i of seatIndexes) bitmap[i] = '1';
    await this.redis.hset(
      `tournament:${tournamentId}:seat`,
      `table:${tableId}`,
      bitmap.join(''),
    );
  }
```

좌석 수 9는 `emptyTableState`(`entry.service.ts:284`)와 `getTableSeatStatus`가 쓰는
값과 같다. 상수를 새로 만들지 않고 그 관례를 따른다.

- [ ] **Step 3: 실패하는 통합 테스트를 쓴다**

```ts
it('스냅샷 없는 테이블만 재구성한다 — 한 대회에 둘이 섞여 있어도', async () => {
  // 테이블 A는 스냅샷을 남기고, 테이블 B만 지운다.
  // A의 스냅샷 JSON이 바이트 단위로 그대로여야 하고, B는 새로 생겨야 한다.
  //
  // **검사 둘이 서로를 가리지 않게** 하는 입력이다(CLAUDE.md 네 번째 가짜
  // 초록). A와 B가 같은 상태였으면 "손대지 않았다"와 "새로 세웠다"를
  // 구별할 수 없다.
  const aBefore = JSON.stringify(await redisService.getSnapShot(tableA));
  await redis.del(`table:state:${tableB}`);

  await recovery.recoverAll();

  expect(JSON.stringify(await redisService.getSnapShot(tableA))).toBe(aBefore);
  expect(await redisService.getSnapShot(tableB)).not.toBeNull();
});

it('PLAYING만 앉힌다 — ELIMINATED의 좌석 행이 남아 있어도', async () => {
  // p3의 participation.status를 ELIMINATED로 바꾸되 TablePlayer 행은 남긴다.
  // 재구성된 스냅샷의 p3 좌석이 null이어야 한다.
  // status 필터를 지우면 빨개진다.
});

it('스택을 currentStack에서 읽는다', async () => {
  // participation.currentStack을 특정 값으로 바꾸고 재구성 → 스냅샷 stack이 그 값
});

it('버튼을 Table.buttonUser에서 읽는다', async () => { /* ... */ });

it('좌석 비트맵이 스냅샷 점유 좌석과 일치한다', async () => { /* ... */ });

it('유저 컨텍스트를 세운다', async () => { /* ... */ });

it('블라인드를 현재 레벨로 맞춘다', async () => {
  // 기준점을 과거로 만들어 레벨 2에 있게 하고 재구성 → smallBlind가 레벨 2의 sb
});

it('buttonUser가 null이면 그 테이블 재구성이 실패한다', async () => {
  // 다른 테이블은 복구되고, 이 테이블만 스냅샷이 없는 채로 남는다
});
```

- [ ] **Step 4: 실패 확인 → 통과**

```bash
cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json \
  --testPathPatterns recovery
```

`status: PlayerStatus.PLAYING` 필터를 지워 탈락자 테스트가 빨개지는 것을 확인하고
복원한다.

- [ ] **Step 5: `entry` 가드 — 실패하는 테스트를 먼저 쓴다**

`entry.service.int-spec.ts`:

```ts
it('ONGOING인데 스냅샷이 없으면 빈 스냅샷을 만들지 않고 던진다', async () => {
  await session.startSession(tournamentId);
  await redis.del(`table:state:${tableId}`);

  await expect(entry.enterSeat(/* p2의 OTP, 다른 좌석 */)).rejects.toThrow();

  // 핵심 단언: 빈 스냅샷이 생기지 않았다. 던지기만 하고 상태를 만들면
  // 다음 재구성이 오염된 위에서 돈다.
  expect(await redisService.getSnapShot(tableId)).toBeNull();
});

it('시작 전 첫 착석은 여전히 fallback으로 스냅샷을 만든다', async () => {
  // 가드가 정상 경로를 깨지 않는다. 이 테스트가 없으면 가드를 너무 넓게
  // 걸어도 초록이다.
});
```

- [ ] **Step 6: 실패를 확인한다**

Expected: FAIL. `getSnapShot`이 `null`이 아니라 `emptyTableState` 모양의 객체를
돌려준다(`buttonUser: 0`, `smallBlind: 100`). **받은 값을 보고서에 옮긴다.**

- [ ] **Step 7: 락 밖 조회에 대회 상태를 얹는다**

`entry.service.ts:137`:

```ts
    // 어떤 쓰기보다도 먼저 확인한다. (기존 주석 유지)
    //
    // 대회 상태를 여기서 함께 읽는다. 락 안에서 다시 읽으면 넣을 이유가 없는
    // 읽기가 TTL 예산을 먹는다.
    const table = await this.prisma.table.findUnique({
      where: { tournamentId_id: { tournamentId, id: dto.tableId } },
      select: { id: true, tournament: { select: { status: true } } },
    });
```

- [ ] **Step 8: fallback을 시작 전으로 가둔다**

`entry.service.ts:212`:

```ts
      const snapshot = await this.redis.getSnapShot(dto.tableId);
      if (!snapshot && table.tournament.status === TournamentStatus.ONGOING) {
        // 진행 중인 대회에 스냅샷이 없다 = Redis를 잃었고 아직 재구성되지
        // 않았다. 여기서 emptyTableState로 새 상태를 만들면 이 테이블의 나머지
        // 전원이 스냅샷에서 사라지고 buttonUser는 0, smallBlind는 100으로
        // 굳는다. DB에는 다 남아 있는데 스냅샷만 한 명이 된다. 그리고 나중에
        // 도는 재구성이 이미 오염된 위에서 돈다.
        //
        // 이 가드는 선택이 아니다. 부팅 복구가 실패를 대회 단위로 격리하는
        // 순간(RecoveryService), 스냅샷 없이 서버가 뜨는 상태가 정상 경로에
        // 들어온다. 그때 이 자리가 격리를 파괴로 바꾼다.
        //
        // fallback 자체는 남긴다 — 대회 시작 전 첫 착석이 스냅샷을 만드는
        // 정상 경로다.
        throw new ConflictException('테이블 상태를 복구하는 중입니다. 잠시 후 다시 시도해 주세요.');
      }
      const state = snapshot ?? this.emptyTableState(tournamentId);
```

- [ ] **Step 9: 통과 확인 + 통합 전체**

```bash
cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json \
  --testPathPatterns "recovery|entry"
```

- [ ] **Step 10: 커밋**

```bash
git add backend/src/recovery backend/src/redis backend/src/entry
git commit -m "feat: 스냅샷을 잃은 테이블을 DB로 세우고 빈 상태 생성을 막는다"
```

---

### Task 4: 시나리오와 기록

태스크 리뷰를 받지 않는다. 최종 전체 리뷰가 본다.

**Files:**
- Create: `backend/src/scenario/server-recovery.int-spec.ts`
- Modify: `backend/src/scenario/harness.ts`
- Modify: `docs/tickets-next.md`, `docs/backlog.md`, `CLAUDE.md`

- [ ] **Step 1: 하네스에 `recovery`를 붙인다**

`harness.ts`의 `Harness` 인터페이스와 배선에 `RecoveryService`를 추가한다. 스텁을
두지 않는다(이 계층의 규칙). 기존 6개 시나리오가 그대로 통과해야 한다.

- [ ] **Step 2: 시나리오를 쓴다**

`backend/src/scenario/server-recovery.int-spec.ts`. 테이블 **둘**을 세우고 몇 핸드
돌린 뒤:

1. 테이블 B의 스냅샷만 지운다 → 부분 유실. **A와 B의 상태를 다르게 만든다**
   (핸드 수를 다르게 돌려 스택과 버튼이 갈리게)
2. 하트비트를 과거로 되돌린다
3. `recovery.recoverAll()`
4. 단계마다 불변식을 검사한다:
   - 칩 총량 보존 (참가 행 `currentStack` 합)
   - 좌석 비트맵 == 스냅샷 점유 좌석 (A·B 각각)
   - A의 스냅샷은 바이트 단위로 그대로
   - B의 `buttonUser` == 마지막 체크포인트 값
   - 블라인드 레벨이 정지 시간만큼 되돌아옴
   - 밀린 양이 정지 시간과 같다 (테이블 둘인데 2배가 아니다)
5. 이어서 B에서 핸드를 하나 더 돌려 정상 진행되는지 본다

실패 메시지에 단계 이름이 남게 값을 문자열로 감싼다.

- [ ] **Step 3: 전체 스위트를 돌려 기준선을 확인한다**

```bash
npm run typecheck
npm run test
npm run test:int
```

세 숫자를 전부 기록한다. Task 4의 커밋 메시지와 CLAUDE.md 기준선에 쓴다.

- [ ] **Step 4: 기록을 남긴다**

**`docs/tickets-next.md`** — `## T31 — 서버 장애 복구` 절. 기존 티켓의 서술
방식을 따른다: 무엇이 문제였는지, 어떤 결정을 했고 무엇을 감수했는지. 반드시 포함:

- 두 `startedAt`을 다른 뜻으로 갈랐다는 결정과 그것이 없앤 요구(정합 유지)
- 스톱워치 모델을 기각한 근거(운영자 수동 정지는 요구사항이 아니다)
- `buttonUser`만 DB에서 파생되지 않는 이유(역사의 함수)
- `entry` 가드가 부팅 실패 격리의 전제라는 것
- `rebuildSeatBitmap`을 별도 메서드로 가른 이유(`UPDATE_SEAT_BITS_MANY`의
  "없으면 만들지 않는다"가 load-bearing이다)
- 감수한 것: 핸드 중간 미복구, 버튼 최대 한 핸드 낡음, 버튼 한 바퀴 공정성,
  하트비트 주기만큼 과소계상, 태블릿만 끊긴 정지는 못 잡음

**`docs/backlog.md`** — 두 곳:

- B2 절(`:325-344`)을 닫는다. **그리고 `:331`의 틀린 문장을 고친다** — 지금
  "`TablePlayer`가 `seatPosition`과 `currentStack`을 들고 있어"라고 쓰여 있는데,
  `currentStack`은 T29에서 `TournamentParticipation`으로 이사했다.
- 완주 경로(`:53`)에 B2 완료를 반영한다.

**`CLAUDE.md`** — 기준선 블록의 다섯 숫자를 T31 시점으로 갱신한다.

- [ ] **Step 5: 커밋**

```bash
git add backend/src/scenario docs CLAUDE.md
git commit -m "test: 부분 유실에서 복구되는 것을 시나리오로 잡는다"
```

---

## 최종 리뷰

전체 브랜치를 **opus**로 리뷰한다. 자르지 않는다. fix 디스패치는 **sonnet** —
찾는 일이 끝난 뒤 목록대로 고치는 데는 판단이 들지 않는다.

리뷰어에게 넘길 것: 계획 파일, `git diff` 패키지, 그리고 위 Global Constraints
전부. 특히 이 셋을 명시한다.

- 블라인드 기준점이 **대회당 한 번만** 밀리는가
- 재구성이 `PLAYING`만 앉히는가
- `entry` 가드가 정상 경로(시작 전 첫 착석)를 깨지 않는가

리뷰어에게 전체 스위트를 다시 돌리게 하지 않는다. 숫자는 Task 4 보고서에 있다.
