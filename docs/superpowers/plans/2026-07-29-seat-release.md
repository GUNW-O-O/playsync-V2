# T29 — 상점의 좌석 해제 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 상점이 앉아 있는 사람을 좌석에서 떼는 경로를 만들고, 그러기 위해
`currentStack`을 `TablePlayer`에서 `TournamentParticipation`으로 옮긴다.

**Architecture:** 칩의 집을 좌석 배치표(`TablePlayer`)에서 장부
(`TournamentParticipation`)로 옮겨 좌석보다 오래 살게 한다. 해제는 테이블 락
안에서 `GamePhase.WAITING`을 확인하고, DB 트랜잭션은 락 **안**에서 돌되
`SELECT ... FOR UPDATE`로 입장의 INSERT와 직렬화한다 — 입장은 T28부터 테이블
락을 건드리지 않고 `TablePlayer`를 INSERT하기 때문이다.

**Tech Stack:** NestJS, Prisma 7.8(드라이버 어댑터 `@prisma/adapter-pg`),
PostgreSQL, Redis(ioredis), Jest.

설계 근거는 [`2026-07-29-seat-release-design.md`](../specs/2026-07-29-seat-release-design.md)에 있다.

## Global Constraints

- **문서·주석·커밋 메시지는 한국어.** 기존 파일의 언어를 따른다.
- **버그 수정은 실패하는 테스트로 재현한 뒤 고친다.** 새 테스트가 처음부터
  통과하면 의심한다 — 제품 코드를 일부러 되돌려 빨간불을 확인한다.
- **트랜잭션은 `withTableLock` 안에 둔다**(T29 한정). T28의 입장 경로는 반대다.
  근거는 Task 2의 주석에 적는다.
- **`GamePhase.WAITING`이 아니면 좌석은 움직이지 않는다.**
- **한 요청은 한 테이블만 다룬다.** 여러 테이블을 한 트랜잭션으로 묶지 않는다.
- **좌석 해제는 `(seatIndex, userId)` 쌍으로 받고 둘 다 검증한다.**
- 부분 성공을 반환하지 않는다. 전부 되거나 전부 안 된다.
- `activePlayers` 카운터의 기준(결제 vs 착석)은 **T30이다. 건드리지 않는다.**
- 자동 밸런싱·테이블 통합 규칙은 범위 밖이다.
- 통합 테스트는 `closeTestPrisma()`로 닫는다. `$disconnect()`는 pg Pool을 닫지
  않아 jest가 종료되지 않는다.
- 기준선: 타입 에러 0 / contract 44(2 suites) / 백엔드 단위 169(14 suites) /
  프론트 단위 52(14 files) / 통합 273(22 suites).

---

## 파일 구조

| 파일 | 책임 | 태스크 |
|---|---|---|
| `backend/prisma/schema.prisma` | `currentStack`의 위치 | 1 |
| `backend/prisma/migrations/20260730000000_move_current_stack_to_participation/migration.sql` | 컬럼 이동 + 백필 | 1 |
| `backend/src/payment/payment.service.ts` | 참가 행 생성 시 초기 스택 | 1 |
| `backend/src/playsync/playsync.service.ts` | 체크포인트·리바인의 쓰기 대상 | 1 |
| `backend/src/entry/entry.service.ts` | 착석 시 스택 읽기 | 1 |
| `backend/shared/dto/seat-release.dto.ts` | 해제 요청 형태 | 2 |
| `backend/shared/dto/seat-release.dto.spec.ts` | 중첩 검증이 실제로 도는지 | 2 |
| `backend/src/store/session/session.controller.ts` | 라우트 | 2 |
| `backend/src/store/session/session.service.ts` | 해제 로직, 일괄 승격 삭제 | 2·3 |
| `backend/src/scenario/harness.ts` | 두 테이블 지원 | 4 |
| `backend/src/scenario/table-move.int-spec.ts` | 두 테이블 시나리오 | 4 |
| `docs/tickets-next.md`, `docs/backlog.md`, `CLAUDE.md` | 기록 | 4 |

---

### Task 1: 칩을 참가 행으로 옮긴다

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20260730000000_move_current_stack_to_participation/migration.sql`
- Modify: `backend/src/payment/payment.service.ts:99-106`
- Modify: `backend/src/playsync/playsync.service.ts:214-228` (체크포인트), `:538-541` (리바인)
- Modify: `backend/src/entry/entry.service.ts:45-51`, `:85-92`, `:143-152`
- Test: `backend/src/entry/entry.service.int-spec.ts`, `backend/src/playsync/playsync.service.int-spec.ts`

**Interfaces:**
- Produces: `TournamentParticipation.currentStack: Int @default(0)`. Task 2가
  해제 시 이 컬럼을 **건드리지 않는다**(칩은 남고 좌석만 사라진다).
- Produces: `TablePlayer`에 `currentStack`이 없다. Task 2의 `deleteMany`가
  이 행을 지워도 칩이 사라지지 않는 근거다.

- [ ] **Step 1: 실패하는 테스트를 쓴다 — 해제 없이도 드러나는 것부터**

`backend/src/entry/entry.service.int-spec.ts`의 마지막 `describe` 뒤에 새
`describe`를 추가한다. 이 파일의 기존 헬퍼(`participate`, `seedTournament`,
`snapshot`)를 그대로 쓴다.

```ts
describe('EntryService.enterSeat — 칩은 좌석보다 오래 산다', () => {
  it('좌석 행이 사라져도 참가 행의 칩으로 다시 앉는다', async () => {
    await seedTournament(TOURNAMENT, TournamentStatus.ONGOING, [TABLE]);
    await participate('u1', '11111111');

    await service.enterSeat(TOURNAMENT, { otp: '11111111', tableId: TABLE, seatIndex: 0 });

    // 핸드가 돌아 스택이 바뀐 상태를 만든다.
    await prisma.tournamentParticipation.update({
      where: { tournamentId_userId: { tournamentId: TOURNAMENT, userId: 'u1' } },
      data: { currentStack: 23400 },
    });
    // 상점이 좌석을 해제한 것과 같은 상태 — 좌석 행만 사라진다.
    await prisma.tablePlayer.deleteMany({ where: { tournamentId: TOURNAMENT, userId: 'u1' } });
    await redis.del(`table:state:${TABLE}`);

    await service.enterSeat(TOURNAMENT, { otp: '11111111', tableId: TABLE, seatIndex: 5 });

    const state = (await redisService.getSnapShot(TABLE))!;
    expect(`재착석 스택 ${state.players[5]!.stack}`).toBe('재착석 스택 23400');
  });
});
```

- [ ] **Step 2: 빨간불을 확인한다**

Run: `npm run test:int -w backend -- --testPathPattern entry.service`

Expected: FAIL. 두 가지 중 하나로 실패한다 — `currentStack`이 아직
`TournamentParticipation`에 없어 Prisma 타입 에러가 나거나(컴파일 단계),
스키마를 먼저 바꿨다면 `재착석 스택 10000`(= `startStack`)이 나온다.

**이 실패 메시지를 보고 넘어간다.** `10000`이 나와야 이사가 실제로 고치는
문제를 재현한 것이다.

- [ ] **Step 3: 스키마를 바꾼다**

`backend/prisma/schema.prisma`의 `TablePlayer`에서 `currentStack` 줄을 지운다.

```prisma
model TablePlayer {
  id       String  @id @default(uuid())
  nickname String?

  tableId String
  table   Table  @relation(fields: [tableId], references: [id], onDelete: Cascade)

  userId String
  user   User   @relation(fields: [userId], references: [id])

  seatPosition Int // 0~8 (9인테이블)
```

`TournamentParticipation`에 추가한다. `playerOtp` 필드 바로 위에 넣고 주석을
함께 쓴다.

```prisma
  status      PlayerStatus @default(WAITING)
  buyInCount  Int          @default(1)
  finalPlace  Int?
  prizeAmount Int          @default(0)

  /// 현재 칩 스택. 예전에는 `TablePlayer`에 있었는데, 상점이 좌석을 해제하면
  /// (T29) 그 행이 사라지면서 칩도 함께 사라졌다. `TablePlayer`는 좌석
  /// 배치표이고 이쪽이 장부다 — 칩은 좌석보다 오래 산다.
  currentStack Int @default(0)
```

- [ ] **Step 4: 마이그레이션을 손으로 쓴다**

`backend/prisma/migrations/20260730000000_move_current_stack_to_participation/migration.sql`

```sql
-- currentStack을 좌석 배치표에서 장부로 옮긴다.
-- TablePlayer는 좌석을 뜨면 사라지는 행이라 칩이 거기 있으면 함께 사라진다.
ALTER TABLE "TournamentParticipation" ADD COLUMN "currentStack" INTEGER NOT NULL DEFAULT 0;

-- 이미 앉아 있는 사람의 스택을 옮긴다. 앉은 적 없는 참가자는 0으로 남는데,
-- 이사 후에는 결제가 startStack을 넣으므로 대회 중간 배포에서만 생긴다.
UPDATE "TournamentParticipation" p
   SET "currentStack" = t."currentStack"
  FROM "TablePlayer" t
 WHERE t."tournamentId" = p."tournamentId" AND t."userId" = p."userId";

ALTER TABLE "TablePlayer" DROP COLUMN "currentStack";
```

- [ ] **Step 5: 결제가 초기 스택을 넣게 한다**

`backend/src/payment/payment.service.ts`의 `tournamentParticipation.create`
(`:99`). `session`은 이 함수 위에서 조회한 `tournament` 행이라 `startStack`이
들어 있다.

```ts
          // 착석 여부와 무관하게 WAITING이다. PLAYING으로 올리는 것은
          // 입장(EntryService)의 몫이다 — PlayerStatus의 주석이 원래
          // 그렇게 적혀 있다("바이인 완료 후 대기" / "테이블 착석 중").
          //
          // 칩은 여기서 정해진다. 좌석이 아니라 **돈을 낸 것**이므로 T28이 그은
          // 경계(결제는 좌석을 정하지 않는다)를 넘지 않는다.
          const created = await tx.tournamentParticipation.create({
            data: {
              userId,
              tournamentId: dto.tournamentId,
              status: PlayerStatus.WAITING,
              currentStack: session.startStack,
              playerOtp: playerOtp.generatePlayerOtp(),
            },
          });
```

- [ ] **Step 6: 체크포인트를 시끄럽게 바꾼다**

`backend/src/playsync/playsync.service.ts`의 `syncTableInventoryToDb`(`:214`).
`TableState`에 `tournamentId`가 있다(`entry.service.ts`의 `emptyTableState`가
채운다).

```ts
  public async syncTableInventoryToDb(state: TableState): Promise<boolean> {
    const updates = state.players
      .filter(p => p !== null)
      .map(p => this.prisma.tournamentParticipation.update({
        where: {
          tournamentId_userId: { tournamentId: state.tournamentId, userId: p.id },
        },
        data: { currentStack: p.stack },
      }));
    try {
      await this.prisma.$transaction(updates);
      return true;
    } catch (error) {
      this.logger.error(`[체크포인트] 테이블 스택 동기화 실패`, error);
      return false;
    }
  }
```

독스트링에 한 문단을 덧붙인다(기존 문단은 그대로 둔다).

```
   * `updateMany`가 아니라 `update`인 이유: `updateMany`는 대상이 0행이어도
   * 조용히 성공한다. 스냅샷에는 있는데 장부에 없는 사람이 있으면 칩 불일치가
   * 아무 에러 없이 지나갔다(T28 최종 리뷰). `update`는 P2025로 즉시 터지고,
   * 아래 `catch`가 유한 재시도 경로로 보낸다.
```

- [ ] **Step 7: 리바인의 두 update를 하나로 합친다**

`backend/src/playsync/playsync.service.ts:532-541`. `tablePlayer.update`를
지우고 참가 행 update에 `currentStack`을 얹는다.

```ts
      // 리바인은 장부 하나만 건드린다. 예전에는 buyInCount(참가 행)와
      // currentStack(좌석 행)이 갈라져 있어 update가 둘이었다.
      await tx.tournamentParticipation.update({
        where: { tournamentId_userId: { tournamentId, userId } },
        data: {
          buyInCount: { increment: 1 },
          currentStack: { increment: startStack },
        },
      });
```

이 변경으로 `processRebuy`의 `tableId` 인자가 트랜잭션 안에서 안 쓰이게 될 수
있다. **인자는 지우지 않는다** — 호출자(`resolveWinners` 2단계)와 시그니처가
얽혀 있고, 트랜잭션 밖에서 여전히 쓰인다. 컴파일이 통과하는지만 확인한다.

- [ ] **Step 8: 입장이 참가 행의 칩을 읽게 한다**

`backend/src/entry/entry.service.ts` 세 곳.

첫째, `include`에서 `startStack`을 뺀다(`:45-51`). 이제 참가 행에 칩이 있다.

```ts
    const participation = await this.prisma.tournamentParticipation.findUnique({
      where: { tournamentId_playerOtp: { tournamentId, playerOtp: dto.otp } },
      include: {
        user: { select: { nickname: true } },
        tournament: { select: { status: true } },
      },
    });
```

둘째, `Claimant`를 만들 때 참가 행에서 바로 읽는다(`:85-92`).

```ts
    await this.claimSeat(tournamentId, dto, {
      userId: participation.userId,
      participationId: participation.id,
      nickname: participation.user.nickname ?? '',
      // 칩은 장부(참가 행)에 있다. 결제가 startStack으로 넣고, 핸드마다
      // 체크포인트가 갱신한다. 좌석 행이 사라져도(T29의 해제) 남는다.
      stack: participation.currentStack,
      alreadySeated: seated !== null,
    });
```

셋째, `TablePlayer`를 만들 때 `currentStack`을 빼고 `who.stack`을 스냅샷에만
쓴다(`:143-152`).

```ts
          await tx.tablePlayer.create({
            data: {
              tournamentId,
              tableId: dto.tableId,
              userId: who.userId,
              nickname: who.nickname,
              seatPosition: dto.seatIndex,
            },
          });
```

`Claimant` 타입의 `stack` 주석도 고친다.

```ts
  /** 장부(`TournamentParticipation.currentStack`)의 현재 칩. */
  stack: number;
```

- [ ] **Step 9: 마이그레이션을 적용하고 타입 체크**

```bash
npm run typecheck
```

Expected: 0건. `tsc`가 지운 컬럼의 에러를 계속 보고하면 `backend/dist`를 지우고
다시 돌린다.

`prisma generate`가 필요하면 `npx prisma generate --schema backend/prisma/schema.prisma`.

- [ ] **Step 10: Step 1의 테스트가 통과하는지 확인한다**

Run: `npm run test:int -w backend -- --testPathPattern entry.service`

Expected: PASS. `재착석 스택 23400`.

- [ ] **Step 11: 체크포인트가 실제로 터지는 테스트를 쓴다**

`backend/src/playsync/playsync.service.int-spec.ts`의 **맨 아래**에 새 최상위
`describe`를 추가한다. 이 파일에는 이미 `PlaysyncService.handleAction`과
`PlaysyncService.processRebuy` 두 블록이 있고, 각각 자기 셋업을 들고 있다.
세 번째도 같은 모양으로 자기 것을 갖는다.

체크포인트는 참가 행이 **없을 때** 터지는지를 보는 것이라 대회를 세울 필요가
없다. DB에 닿기만 하면 된다.

```ts
describe('PlaysyncService.syncTableInventoryToDb', () => {
  let redis: Redis;
  let queueConnection: Redis;
  let queue: Queue;
  let prisma: PrismaClient;
  let service: PlaysyncService;

  const TABLE = 'sync-table-1';
  const TOURNAMENT = 'sync-tournament-1';

  beforeAll(() => {
    redis = createTestRedis();
    queueConnection = createTestRedis();
    queue = new Queue('table-timeout', { connection: queueConnection });
    prisma = createTestPrisma();
    service = new PlaysyncService(
      queue,
      new RedisService(redis),
      prisma as unknown as PrismaService,
      new EventEmitter2(),
    );
  });

  afterAll(async () => {
    await queue.close();
    await queueConnection.quit();
    await redis.quit();
    await closeTestPrisma(prisma);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await flushTestRedis(redis);
  });

  it('장부에 없는 사람이 스냅샷에 있으면 체크포인트가 실패한다', async () => {
    const state: TableState = {
      phase: GamePhase.HAND_END,
      players: [
        {
          id: 'ghost', tableId: TABLE, nickname: 'ghost', seatIndex: 0,
          stack: 5000, bet: 0, hasFolded: false, isAllIn: false,
          hasChecked: false, totalContributed: 0,
        },
        ...Array(8).fill(null),
      ],
      pot: 0, currentBet: 0, buttonUser: 0, currentTurnSeatIndex: -1,
      sidePots: [], ante: false, tournamentId: TOURNAMENT, smallBlind: 100,
    };

    const ok = await service.syncTableInventoryToDb(state);

    expect(`체크포인트 ${ok ? '성공' : '실패'}`).toBe('체크포인트 실패');
  });
});
```

`PlaysyncService`의 생성자 인자 순서가 다르면 파일 위쪽 두 블록이 어떻게
만드는지 보고 맞춘다. import는 이 파일에 이미 대부분 있다 — 없는 것만 추가한다.

- [ ] **Step 12: 빨간불을 확인한다 — 제품 코드를 되돌려서**

이 테스트는 Step 6을 이미 적용한 뒤에 쓰는 것이라 **처음부터 통과한다.** 그
자체가 의심 대상이므로, `syncTableInventoryToDb`를 옛 모양으로 임시 편집해
빨간불을 본다.

```ts
      .map(p => this.prisma.tournamentParticipation.updateMany({
        where: { tournamentId: state.tournamentId, userId: p.id },
        data: { currentStack: p.stack },
      }));
```

Run: `npm run test:int -w backend -- --testPathPattern playsync.service`
Expected: FAIL with `체크포인트 성공` — `updateMany`가 0행을 조용히 갱신한다.

확인한 뒤 Step 6의 코드로 되돌린다.

- [ ] **Step 13: 전체 테스트**

```bash
npm run typecheck && npm run test && npm run test:int
```

기존 테스트 중 `currentStack`을 `TablePlayer`에 쓰거나 읽는 것이 있으면 전부
고친다. 알려진 곳: `session.service.int-spec.ts`의 원시 SQL INSERT
(`INSERT INTO "TablePlayer"(... "currentStack" ...)`)에서 그 컬럼을 뺀다.

- [ ] **Step 14: 커밋**

```bash
git add backend/prisma backend/src docs
git commit -m "refactor: 칩을 좌석 배치표에서 장부로 옮긴다"
```

---

### Task 2: 좌석 해제

**Files:**
- Create: `backend/shared/dto/seat-release.dto.ts`
- Modify: `backend/src/store/session/session.controller.ts`
- Modify: `backend/src/store/session/session.service.ts` (`manualMovingPlayer` 스텁 자리)
- Test: `backend/src/store/session/session.service.int-spec.ts`

**Interfaces:**
- Consumes: Task 1의 `TournamentParticipation.currentStack` — 해제는 이 값을
  건드리지 않는다. `TablePlayer`에는 `currentStack`이 없다.
- Produces: `SessionService.releaseSeats(tournamentId: string, tableId: string,
  seats: { seatIndex: number; userId: string }[], ownerId: string): Promise<void>`

- [ ] **Step 1: DTO를 만든다**

`backend/shared/dto/seat-release.dto.ts`

```ts
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsString, Max, Min, ValidateNested } from 'class-validator';

/**
 * 해제할 좌석 하나.
 *
 * `userId`를 함께 받는 이유: 상점 콘솔은 조금 전에 그린 판을 보고 체크한다.
 * 그 사이 그 자리 사람이 탈락하고 다른 사람이 OTP로 앉았을 수 있다 — T28이
 * 핸드 도중 착석을 허용하므로 창은 항상 열려 있다. 좌석 번호만 받으면 엉뚱한
 * 사람을 뗀다.
 */
export class ReleaseSeatItem {
  @IsInt()
  @Min(0)
  @Max(8)
  seatIndex: number;

  @IsString()
  userId: string;
}

export class ReleaseSeatsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReleaseSeatItem)
  seats: ReleaseSeatItem[];
}
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`backend/src/store/session/session.service.int-spec.ts`에 새 `describe`를
추가한다. 이 파일의 기존 `deleteTable` 스위트와 같은 셋업
(`tournamentId`, `tableId`, `ownerId`, `sessionService`, `prisma`, `redis`)을
쓴다. 스냅샷을 직접 심어야 하므로 헬퍼를 하나 둔다.

```ts
describe('SessionService.releaseSeats', () => {
  /** 스냅샷과 좌석 행을 함께 만든다. */
  async function seat(userId: string, seatIndex: number, stack = 10000) {
    await prisma.user.create({ data: { id: userId, nickname: userId, password: 'x' } });
    await prisma.tournamentParticipation.create({
      data: {
        userId, tournamentId, playerOtp: `otp${seatIndex}0000`,
        status: 'PLAYING', currentStack: stack,
      },
    });
    await prisma.tablePlayer.create({
      data: { tournamentId, tableId, userId, nickname: userId, seatPosition: seatIndex },
    });
  }

  async function putSnapshot(phase: GamePhase, seated: { userId: string; seatIndex: number; stack: number }[]) {
    const players = Array(9).fill(null);
    for (const s of seated) {
      players[s.seatIndex] = {
        id: s.userId, tableId, nickname: s.userId, seatIndex: s.seatIndex,
        stack: s.stack, bet: 0, hasFolded: false, isAllIn: false,
        hasChecked: false, totalContributed: 0,
      };
    }
    await redis.set(`table:state:${tableId}`, JSON.stringify({
      phase, players, pot: 0, currentBet: 0, buttonUser: 0,
      currentTurnSeatIndex: -1, sidePots: [], ante: false, tournamentId, smallBlind: 100,
    }));
    await redis.hset(`tournament:${tournamentId}:seat`, `table:${tableId}`,
      Array(9).fill('0').map((c, i) => seated.some(s => s.seatIndex === i) ? '1' : c).join(''));
  }

  it('해제하면 좌석 행·스냅샷·비트맵이 함께 비고 칩은 남는다', async () => {
    await seat('u1', 3, 23400);
    await putSnapshot(GamePhase.WAITING, [{ userId: 'u1', seatIndex: 3, stack: 23400 }]);

    await sessionService.releaseSeats(tournamentId, tableId, [{ seatIndex: 3, userId: 'u1' }], ownerId);

    const rows = await prisma.tablePlayer.count({ where: { tableId, userId: 'u1' } });
    const p = await prisma.tournamentParticipation.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId, userId: 'u1' } },
    });
    const state = JSON.parse((await redis.get(`table:state:${tableId}`))!);
    const bitmap = await redis.hget(`tournament:${tournamentId}:seat`, `table:${tableId}`);

    expect(`좌석행 ${rows} / 상태 ${p.status} / 칩 ${p.currentStack} / 스냅샷 ${state.players[3] === null ? '빔' : '있음'} / 비트 ${bitmap![3]}`)
      .toBe('좌석행 0 / 상태 WAITING / 칩 23400 / 스냅샷 빔 / 비트 0');
  });

  it('핸드 중에는 409고 아무것도 바뀌지 않는다', async () => {
    await seat('u1', 3);
    await putSnapshot(GamePhase.FLOP, [{ userId: 'u1', seatIndex: 3, stack: 10000 }]);

    const caught = await sessionService
      .releaseSeats(tournamentId, tableId, [{ seatIndex: 3, userId: 'u1' }], ownerId)
      .catch(e => e);

    const rows = await prisma.tablePlayer.count({ where: { tableId, userId: 'u1' } });
    expect(`${caught instanceof ConflictException ? '409' : `결과 ${String(caught)}`} / 좌석행 ${rows}`)
      .toBe('409 / 좌석행 1');
  });

  it('낡은 화면이 보낸 쌍은 409로 막힌다', async () => {
    await seat('u1', 3);
    await putSnapshot(GamePhase.WAITING, [{ userId: 'u1', seatIndex: 3, stack: 10000 }]);

    const caught = await sessionService
      .releaseSeats(tournamentId, tableId, [{ seatIndex: 3, userId: 'u2' }], ownerId)
      .catch(e => e);

    const rows = await prisma.tablePlayer.count({ where: { tableId } });
    expect(`${caught instanceof ConflictException ? '409' : `결과 ${String(caught)}`} / 좌석행 ${rows}`)
      .toBe('409 / 좌석행 1');
  });
});
```

파일 상단 import에 `GamePhase`(`src/game-engine/types`)와 `ConflictException`이
없으면 추가한다.

- [ ] **Step 3: 빨간불을 확인한다**

Run: `npm run test:int -w backend -- --testPathPattern session.service`
Expected: FAIL — `releaseSeats`가 없어 타입 에러 또는
`sessionService.releaseSeats is not a function`.

- [ ] **Step 4: `releaseSeats`를 구현한다**

`backend/src/store/session/session.service.ts`의 `manualMovingPlayer()` 스텁을
지우고 그 자리에 넣는다.

```ts
  /**
   * 상점이 좌석에서 사람을 뗀다.
   *
   * 시스템은 누구를 어디로 보낼지 정하지 않는다. 상점이 체크한 사람을 뗄
   * 뿐이고, 그 사람은 걸어가서 빈 자리에 앉아 자기 참가 OTP를 넣는다(T28).
   * 자동 밸런싱은 하지 않기로 한 것이다 — 언제 누구를 어디로 보낼지는 규칙이
   * 아니라 현장 판단이다.
   *
   * **트랜잭션이 락 안에 있다.** T28의 입장은 반대로 락 밖에 두는데, 그
   * 근거는 대회 시작에 수십 명이 한꺼번에 들어와 커넥션 풀이 차는 상황이었다.
   * 해제는 상점 운영자 한 명의 조작이고 행이 최대 9개다. 이 리포의 실제 규칙은
   * "트랜잭션 금지"가 아니라 **기다림이 무한정인 일 금지**다 —
   * `resolveWinners`가 3단계(탈락 확정)는 락 안에서 돌리고 2단계(사람이 리바인
   * 수락을 기다림)와 4단계(백오프 재시도)만 락 밖으로 뺀 것이 그 증거다.
   *
   * **그런데 레디스 락은 좌석의 DB 쓰기를 직렬화하지 않는다.** T28이 입장의
   * 트랜잭션을 락 밖으로 뺐기 때문에 입장은 테이블 락을 건드리지 않고
   * `TablePlayer`를 INSERT한다. 그래서 `deleteTable`과 같은
   * `SELECT ... FOR UPDATE`가 필요하다 — INSERT가 부모 `Table` 행에 거는
   * `FOR KEY SHARE`와 충돌해 두 방향 모두 직렬화된다.
   */
  async releaseSeats(
    tournamentId: string,
    tableId: string,
    seats: { seatIndex: number; userId: string }[],
    ownerId: string,
  ) {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    await this.redis.withTableLock(tableId, async () => {
      const state = await this.redis.getSnapShot(tableId);
      if (!state) throw new NotFoundException('테이블 상태를 찾을 수 없습니다.');

      // 핸드 중에는 자리가 움직이지 않는다. 이 가드 하나가 팟·차례·폴드
      // 상태·사이드팟을 전부 비껴간다. T28은 이 가드를 쓰지 않았다 — 신규
      // 착석은 핸드 도중이어도 폴드 상태로 들어가 아무것에도 끼지 않는다.
      // 이미 앉은 사람을 빼는 것은 다르다.
      if (state.phase !== GamePhase.WAITING) {
        throw new ConflictException('핸드 진행 중에는 좌석을 해제할 수 없습니다.');
      }

      // 검사 1 — 스냅샷(게임의 진실). 상점 화면이 낡았으면 여기서 걸린다.
      for (const s of seats) {
        if (state.players[s.seatIndex]?.id !== s.userId) {
          throw new ConflictException('좌석 정보가 바뀌었습니다. 화면을 새로 고쳐 주세요.');
        }
      }

      const seatIndexes = seats.map(s => s.seatIndex);
      const userIds = seats.map(s => s.userId);

      await this.prismaService.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Table"
          WHERE id = ${tableId} AND "tournamentId" = ${tournamentId}
          FOR UPDATE
        `;
        if (locked.length === 0) throw new NotFoundException('테이블을 찾을 수 없습니다.');

        // 검사 2 — DB(좌석의 진실). 위 SELECT가 풀린 뒤의 **새 문장**이라
        // Read Committed가 스냅샷을 다시 뜬다. 방금 커밋된 입장이 보인다.
        const rows = await tx.tablePlayer.findMany({
          where: { tableId, seatPosition: { in: seatIndexes } },
          select: { seatPosition: true, userId: true },
        });
        const matched = rows.length === seats.length
          && seats.every(s => rows.some(r => r.seatPosition === s.seatIndex && r.userId === s.userId));
        if (!matched) {
          throw new ConflictException('좌석 정보가 바뀌었습니다. 화면을 새로 고쳐 주세요.');
        }

        await tx.tablePlayer.deleteMany({ where: { tableId, seatPosition: { in: seatIndexes } } });
        // 칩은 건드리지 않는다. 좌석만 사라지고 장부는 남는다(T29의 이사).
        await tx.tournamentParticipation.updateMany({
          where: { tournamentId, userId: { in: userIds } },
          data: { status: PlayerStatus.WAITING },
        });
      });

      for (const s of seats) state.players[s.seatIndex] = null;
      await this.redis.saveSnapShot(tableId, state);
    });

    // 락 밖. 비트맵은 필드 단위 원자 연산이라 락이 필요 없다.
    for (const s of seats) {
      await this.redis.updateSeatBitmap(tournamentId, tableId, s.seatIndex, false);
      await this.redis.deleteUserContext(tournamentId, s.userId);
    }
    await this.emitSeatList(tournamentId);
  }
```

import이 없으면 추가한다: `GamePhase`(`src/game-engine/types`),
`PlayerStatus`(`@prisma/client`), `NotFoundException`·`ConflictException`
(`@nestjs/common`).

- [ ] **Step 5: 초록불을 확인한다**

Run: `npm run test:int -w backend -- --testPathPattern session.service`
Expected: PASS (새 3건 포함).

- [ ] **Step 6: 해제 ↔ 입장 경합 테스트를 쓴다**

같은 `describe` 안에 추가한다. `deleteTable`의 C2 테스트와 같은 모양이다 —
원시 pg `Client`로 커밋하지 않은 INSERT를 만들어 `FOR UPDATE`가 대기하는지
본다. 파일 상단에 `import { Client } from 'pg'`가 이미 있다.

```ts
  /**
   * 레디스 락은 좌석의 DB 쓰기를 직렬화하지 않는다 — T28이 입장의 트랜잭션을
   * 락 밖으로 뺐기 때문에 입장은 테이블 락을 건드리지 않고 INSERT한다.
   * `SELECT ... FOR UPDATE`가 그 자리를 메운다.
   */
  it('해제 도중 들어온 착석은 지워지지 않고 해제가 409로 막힌다', async () => {
    await seat('u1', 3);
    await putSnapshot(GamePhase.WAITING, [{ userId: 'u1', seatIndex: 3, stack: 10000 }]);

    const newcomer = await prisma.user.create({ data: { nickname: 'newcomer', password: 'x' } });
    await prisma.tournamentParticipation.create({
      data: {
        userId: newcomer.id, tournamentId, playerOtp: '99999999',
        status: 'WAITING', currentStack: 10000,
      },
    });

    const entering = new Client({ connectionString: process.env.DATABASE_URL });
    await entering.connect();

    let outcome: unknown;
    try {
      await entering.query('BEGIN');
      // 해제 대상과 **다른** 자리에 앉는다. 커밋 전이라 아직 아무도 못 본다.
      await entering.query(
        `INSERT INTO "TablePlayer"(id,nickname,"tableId","userId","seatPosition","tournamentId")
         VALUES (gen_random_uuid(), 'newcomer', $1, $2, 4, $3)`,
        [tableId, newcomer.id, tournamentId],
      );

      let settled = false;
      const caught = sessionService
        .releaseSeats(tournamentId, tableId, [{ seatIndex: 3, userId: 'u1' }, { seatIndex: 4, userId: 'u1' }], ownerId)
        .then(v => { settled = true; return v; }, e => { settled = true; return e; });

      await new Promise(r => setTimeout(r, 500));
      expect(`대기 중 ${settled ? '아님' : '맞음'}`).toBe('대기 중 맞음');

      await entering.query('COMMIT');
      outcome = await caught;
    } finally {
      await entering.query('ROLLBACK').catch(() => undefined);
      await entering.end();
    }

    const seated = await prisma.tablePlayer.count({ where: { tableId } });
    expect(`${outcome instanceof ConflictException ? '409' : `결과 ${String(outcome)}`} / 좌석행 ${seated}`)
      .toBe('409 / 좌석행 2');
  });
```

**주의:** 이 테스트가 대기하려면 4번 자리가 요청에 들어 있어야 한다. 스냅샷
검사(검사 1)는 4번이 비어 있다고 보므로 락 안에서 먼저 걸릴 수 있다. 그러면
`FOR UPDATE`에 닿지 못해 **검증하려던 것을 검증하지 못한다.**

그래서 이 테스트는 스냅샷에도 4번을 채워 두고 시작한다. `putSnapshot` 호출을
아래로 바꾼다.

```ts
    await putSnapshot(GamePhase.WAITING, [
      { userId: 'u1', seatIndex: 3, stack: 10000 },
      { userId: 'u1', seatIndex: 4, stack: 10000 },
    ]);
```

- [ ] **Step 7: 이 테스트가 무엇을 잡는지 빨간불로 확인한다**

`releaseSeats`에서 `SELECT ... FOR UPDATE` 블록을 임시로 지우고(그리고
`locked.length === 0` 검사도 함께) 돌린다.

Run: `npm run test:int -w backend -- --testPathPattern session.service`
Expected: FAIL with `대기 중 아님` — 락이 없으면 해제가 기다리지 않고 그냥
지나간다.

확인한 뒤 되돌린다.

- [ ] **Step 8: 컨트롤러 라우트를 붙인다**

`backend/src/store/session/session.controller.ts`의 `deleteTable` 아래.

```ts
  // 좌석 해제도 남의 대회를 건드릴 수 없어야 한다. 소유권 확인은 서비스
  // 메서드 안이고, PLATFORM_ADMIN을 빼는 것도 테이블 추가/삭제와 같은 이유다.
  @Roles(Role.STORE_ADMIN)
  @Post(':id/tables/:tableId/seats/release')
  async releaseSeats(
    @Req() req,
    @Param('id') tournamentId: string,
    @Param('tableId') tableId: string,
    @Body() dto: ReleaseSeatsDto,
  ) {
    await this.sessionService.releaseSeats(tournamentId, tableId, dto.seats, req.user.userId);
    return { ok: true };
  }
```

import에 `ReleaseSeatsDto`(`shared/dto/seat-release.dto`)를 추가한다.

- [ ] **Step 9: 중첩 검증이 실제로 도는지 단위 테스트**

`main.ts`의 `ValidationPipe`가 `transform: true` 없이 구성돼 있다
(`new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`).
`@ValidateNested` + `@Type()`은 `plainToInstance`에 의존하므로, **선언만 보고
동작한다고 믿으면 안 된다.** 중첩 배열 안의 잘못된 값이 조용히 통과하면
`releaseSeats`가 `undefined` 좌석을 받는다.

인프라가 필요 없으므로 단위 테스트다.
`backend/shared/dto/seat-release.dto.spec.ts`

```ts
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ReleaseSeatsDto } from './seat-release.dto';

/** ValidationPipe가 하는 것과 같은 순서. */
function validate(payload: unknown) {
  return validateSync(plainToInstance(ReleaseSeatsDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('ReleaseSeatsDto', () => {
  it('좌석 번호가 범위 밖이면 거부한다', () => {
    const errors = validate({ seats: [{ seatIndex: 9, userId: 'u1' }] });
    expect(`중첩 오류 ${errors.length > 0 ? '있음' : '없음'}`).toBe('중첩 오류 있음');
  });

  it('userId가 없으면 거부한다', () => {
    const errors = validate({ seats: [{ seatIndex: 3 }] });
    expect(`중첩 오류 ${errors.length > 0 ? '있음' : '없음'}`).toBe('중첩 오류 있음');
  });

  it('빈 배열을 거부한다', () => {
    const errors = validate({ seats: [] });
    expect(`오류 ${errors.length > 0 ? '있음' : '없음'}`).toBe('오류 있음');
  });

  it('올바른 요청은 통과한다', () => {
    const errors = validate({ seats: [{ seatIndex: 3, userId: 'u1' }] });
    expect(`오류 ${errors.length > 0 ? '있음' : '없음'}`).toBe('오류 없음');
  });
});
```

Run: `npm run test -w backend -- --testPathPattern seat-release`
Expected: 4건 PASS.

**첫 두 건이 통과하면 의심한다** — 그것이 이 테스트의 목적이다. `@Type(() => ReleaseSeatItem)`
줄을 잠시 지우고 다시 돌려 `중첩 오류 없음`으로 실패하는지 본다. 실패하지
않으면 중첩 검증이 원래 안 돌고 있다는 뜻이므로 DTO를 고쳐야 한다. 확인 후
되돌린다.

- [ ] **Step 10: 전체 테스트**

```bash
npm run typecheck && npm run test && npm run test:int
```

- [ ] **Step 11: 커밋**

```bash
git add backend/shared backend/src
git commit -m "feat: 상점이 좌석에서 사람을 뗄 수 있게 한다"
```

---

### Task 3: `startSession`의 일괄 승격을 지운다

**Files:**
- Modify: `backend/src/store/session/session.service.ts:384-395`
- Test: `backend/src/store/session/session.service.int-spec.ts`

**Interfaces:**
- Consumes: Task 2가 만든 `PLAYING → WAITING` 전이. 이 태스크가 지우는 줄이
  없어야 그 전이가 뜻을 갖는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`session.service.int-spec.ts`의 `describe('쓰기 경로도 해시를 담아 보내지
않는다')` 블록(`:119`)이 이미 `startSession`을 부르고 있다. 그 블록 **뒤에**
새 `describe`를 형제로 추가한다 — 같은 `sessionService`·`prisma`·
`makeCreateDto()`를 쓴다.

`startSession`은 시작 최소 인원 게이트를 지나야 하므로 그 블록이 쓰는
`MIN_PLAYERS_TO_START` 우회를 그대로 따른다.

```ts
  describe('시작은 참가자 상태를 올리지 않는다', () => {
    it('결제만 한 사람이 WAITING으로 남는다', async () => {
      const created = await sessionService.createSession(makeCreateDto());
      const noshow = await prisma.user.create({
        data: { nickname: 'noshow', password: 'x' },
      });
      await prisma.tournamentParticipation.create({
        data: {
          userId: noshow.id, tournamentId: created.id, playerOtp: '77777777',
          status: 'WAITING', currentStack: 10000,
        },
      });

      process.env.MIN_PLAYERS_TO_START = '0';
      try {
        await sessionService.startSession(created.id);
      } finally {
        delete process.env.MIN_PLAYERS_TO_START;
      }

      const p = await prisma.tournamentParticipation.findUniqueOrThrow({
        where: { tournamentId_userId: { tournamentId: created.id, userId: noshow.id } },
      });
      expect(`미착석자 상태 ${p.status}`).toBe('미착석자 상태 WAITING');
    });
  });
```

- [ ] **Step 2: 빨간불을 확인한다**

Run: `npm run test:int -w backend -- --testPathPattern session.service`
Expected: FAIL with `미착석자 상태 PLAYING`.

- [ ] **Step 3: 그 줄을 지운다**

`backend/src/store/session/session.service.ts`의 `startSession`.

```ts
  async startSession(id: string) {
    const { startedAt } = await this.initializeGame(id);

    // 참가자 상태는 여기서 건드리지 않는다. `PLAYING`은 **착석**이 올린다
    // (T28의 `EntryService`). 예전에는 이 자리에서 대회의 참가자 전원을
    // 조건 없이 승격시켰는데, 그러면 결제만 하고 오지 않은 사람도 시작 버튼
    // 한 번에 `PLAYING`이 되고 `tournamentFinished`의
    // `findFirst({ where: { status: PLAYING } })`가 한 번도 앉지 않은 사람을
    // 우승자로 뽑을 수 있었다.
    return await this.prismaService.$transaction(async (tx) => {
      // startedAt은 준비 단계가 정한 값을 그대로 쓴다. 여기서 다시 찍으면
      // Redis의 블라인드 기준 시각과 어긋난다 — 블라인드 레벨은 startedAt으로
      // 부터의 경과 시간으로 계산되므로, DB를 읽는 쪽은 다른 레벨을 얻는다.
      return await tx.tournament.update({
        where: { id },
        data: { status: TournamentStatus.ONGOING, startedAt },
        omit: { dealerOtpHash: true },
      });
    });
  }
```

`$transaction`이 문장 하나만 감싸게 되지만 **그대로 둔다.** 지우면 이 함수의
반환 형태와 호출자가 바뀌고, 그건 이 티켓의 범위가 아니다.

- [ ] **Step 4: 초록불을 확인한다**

Run: `npm run test:int -w backend -- --testPathPattern session.service`
Expected: PASS.

- [ ] **Step 5: 전체 테스트 — 여기서 깨지는 것이 있다**

```bash
npm run test:int
```

시나리오와 통합 테스트 중 "시작하면 전원 `PLAYING`"을 전제하던 것이 깨질 수
있다. 깨지면 **테스트를 고친다** — 착석시킨 사람만 `PLAYING`이 되는 것이 이제
맞는 동작이다. 하네스의 `seatPlayer`가 이미 입장을 거치므로 시나리오는 대부분
그대로 통과한다.

`PlayerStatus.PLAYING`을 조건으로 쓰는 제품 코드가 새로 깨지면 그건 T30
영역이다. **고치지 말고 보고한다.**

- [ ] **Step 6: 커밋**

```bash
git add backend/src
git commit -m "fix: 대회 시작이 미착석자를 PLAYING으로 올리지 않게 한다"
```

---

### Task 4: 두 테이블 시나리오와 기록

**Files:**
- Modify: `backend/src/scenario/harness.ts`
- Create: `backend/src/scenario/table-move.int-spec.ts`
- Modify: `docs/tickets-next.md`, `docs/backlog.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: `SessionService.releaseSeats(tournamentId, tableId, seats, ownerId)`,
  `Harness.seatPlayer(tournamentId, tableId, seatIndex, userId)`,
  `Harness.session.createTable(tournamentId, ownerId)`.

- [ ] **Step 1: `checkInvariants`가 테이블을 고를 수 있게 한다**

`backend/src/scenario/harness.ts`의 `checkInvariants`. 지금 좌석 비트맵 검사가
`h.tableId`로 고정돼 있다(`:298-299`).

```ts
export async function checkInvariants(
  h: Harness,
  label: string,
  expectedChips: number,
  tableId: string = h.tableId,
): Promise<TableState> {
  const state = await h.redisService.getSnapShot(tableId);
  if (!state) throw new Error(`${label}: 스냅샷 없음 (${tableId})`);
```

`h.snapshot()`을 쓰던 첫 줄을 위와 같이 바꾸고, 아래 비트맵 조회의
`h.tableId`를 `tableId`로 바꾼다.

```ts
  const bitmap = await h.redis.hget(
    `tournament:${h.tournamentId}:seat`, `table:${tableId}`,
  );
```

기본값이 `h.tableId`라 기존 호출자 전부가 그대로 돈다.

- [ ] **Step 2: 시나리오를 쓴다**

`backend/src/scenario/table-move.int-spec.ts`

```ts
import { GamePhase } from 'src/game-engine/types';
import { SCENARIO, checkInvariants, chipsOnTable, forceClose, setupTournament, Harness } from './harness';

/**
 * 테이블 간 인원 이동.
 *
 * 부품은 각각 옳은데 조립이 틀린 경우를 잡는 계층이다. 여기서 보는 이음매는
 * **칩이 좌석보다 오래 사는가**다 — 해제가 `TablePlayer`를 지우고, 사람이
 * 다른 테이블에 앉을 때 그 칩이 그대로 따라오는지.
 */
describe('시나리오: 두 테이블 사이의 이동', () => {
  let h: Harness;
  const PLAYERS = ['p1', 'p2', 'p3', 'p4'];

  afterAll(async () => { await forceClose(); });

  it('해제한 사람이 다른 테이블에 원래 칩으로 앉는다', async () => {
    h = await setupTournament(PLAYERS, {});
    const total = PLAYERS.length * SCENARIO.startStack;

    await checkInvariants(h, '1. 착석 직후', total);

    // 두 번째 테이블을 만든다. 상점의 조작이다.
    const table2 = await h.session.createTable(h.tournamentId, SCENARIO.owner);

    // p4의 칩을 옮기기 전에 바꿔 둔다 — startStack 그대로면 이사가 없어도
    // 통과해 버린다.
    await h.prisma.tournamentParticipation.update({
      where: { tournamentId_userId: { tournamentId: h.tournamentId, userId: 'p4' } },
      data: { currentStack: 17300 },
    });
    const state = await h.snapshot();
    const seat4 = h.seatOf(state, 'p4');
    state.players[seat4]!.stack = 17300;
    await h.saveSnapshot(state);

    const expected = total - SCENARIO.startStack + 17300;
    await checkInvariants(h, '2. 스택 조정 후', expected);

    // 쉬는 시간. 상점이 p4를 자리에서 뗀다.
    await h.session.releaseSeats(
      h.tournamentId, h.tableId, [{ seatIndex: seat4, userId: 'p4' }], SCENARIO.owner,
    );

    const afterRelease = await h.snapshot();
    expect(`해제 후 1번 테이블 인원 ${afterRelease.players.filter(p => p !== null).length}`)
      .toBe('해제 후 1번 테이블 인원 3');
    expect(`해제 후 1번 테이블 칩 ${chipsOnTable(afterRelease)}`)
      .toBe(`해제 후 1번 테이블 칩 ${total - SCENARIO.startStack}`);

    const p4 = await h.prisma.tournamentParticipation.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId: h.tournamentId, userId: 'p4' } },
    });
    expect(`해제된 사람 상태 ${p4.status} / 칩 ${p4.currentStack}`)
      .toBe('해제된 사람 상태 WAITING / 칩 17300');

    // 걸어가서 2번 테이블 0번 자리에 앉아 OTP를 넣는다.
    await h.seatPlayer(h.tournamentId, table2.id, 0, 'p4');

    const t2 = await h.redisService.getSnapShot(table2.id);
    expect(`2번 테이블 p4 칩 ${t2!.players[0]!.stack}`).toBe('2번 테이블 p4 칩 17300');

    await checkInvariants(h, '3. 이동 후 1번 테이블', total - SCENARIO.startStack);
    await checkInvariants(h, '4. 이동 후 2번 테이블', 17300, table2.id);
  });
});
```

`h.session.createTable`은 `insertTable`이 만든 `Table` 행을 그대로 돌려주므로
`.id`가 있다(`session.service.ts:344-357`).

- [ ] **Step 3: 돌린다**

Run: `npm run test:int -w backend -- --testPathPattern table-move`
Expected: PASS.

처음부터 통과하면 **의심한다.** Task 1의 이사를 되돌려야 빨간불이 나오는데
그건 큰 되돌림이므로, 대신 `checkInvariants`의 4단계 기대값을
`SCENARIO.startStack`(10000)으로 바꿔 실패 메시지가 `2번 테이블 p4 칩 10000`을
가리키는지 확인한다 — 이사가 없었다면 나왔을 값이다. 확인 후 되돌린다.

- [ ] **Step 4: `docs/tickets-next.md`에 T29를 적는다**

T27·T28과 같은 형식이다: 문제 / 결정 / 버린 선택지 / RED 확인 방법 / 작업 중
추가로 나온 것 / 테스트 / 남긴 것. T28 항목 뒤, 문서 맨 아래 템플릿 블록 앞에
넣는다.

반드시 담을 것:

- **칩의 집을 옮긴 이유.** `TablePlayer`는 좌석 배치표라 좌석을 뜨면 사라진다.
  칩이 거기 있으면 해제할 때마다 사라지고, 다시 앉을 때 `startStack`을 새로
  받아 **복제된다.**
- **트랜잭션을 락 안에 둔 것 — T28과 반대 방향이다.** 근거가 다르다는 것을
  적는다: T28은 대회 시작의 커넥션 풀 포화, T29는 운영자 한 명의 조작.
  그리고 이 리포의 실제 규칙이 "트랜잭션 금지"가 아니라 **"기다림이 무한정인
  일 금지"**라는 것을 `resolveWinners`의 2·3·4단계로 보인다.
- **레디스 락이 좌석의 DB 쓰기를 직렬화하지 않는다는 것.** T28이 입장의
  트랜잭션을 락 밖으로 뺀 결과다. 그래서 `deleteTable`의 `FOR UPDATE`가
  T29에도 필요해졌다 — T28의 결정이 T29의 제약을 만들었다.
- **`(seatIndex, userId)` 쌍 검증.** 상점 화면이 낡을 수 있고, T28이 핸드 도중
  착석을 허용하므로 그 창은 항상 열려 있다. 락 안에서 다시 검사한다는 원칙을
  API 경계까지 올린 것.
- **`GamePhase.WAITING` 가드가 T29에서 처음 실제로 쓰인다는 것.** T28은 쓰지
  않았고 그 이유(늦은 참가는 폴드 상태로 들어간다)도 함께.
- **`startSession`의 일괄 승격 삭제와 그것이 T30의 절반만 닫는다는 것.**
  우승자 오선정은 사라지지만 `activePlayers`는 여전히 결제 시점에 올라
  `activePlayerCount <= 1`이 안 걸린다.

- [ ] **Step 5: `docs/backlog.md`를 갱신한다**

- 완주 경로에서 T29를 지난 것으로 표시한다.
- B8 절의 티켓 표에서 T29 행의 "설계 문서"를 `미작성`에서
  `./superpowers/specs/2026-07-29-seat-release-design.md`로 바꾼다.
- "폐기한 설계에서 살아남는 판단 셋"의 `GamePhase.WAITING` 항목에 T29가 실제로
  썼다는 것을 한 줄 덧붙인다.
- "여기 남는 것"의 "시나리오 하네스가 테이블 하나만 돈다"를 완료로 고친다.
- T30 절에 `startSession` 부분이 T29에서 닫혔다는 것을 적고, 남은 것이
  `activePlayers` 카운터뿐임을 분명히 한다.
- B8 절을 완료로 표시한다 — T27·T28·T29로 닫혔다.

- [ ] **Step 6: `CLAUDE.md`의 기준선을 실제 출력으로 맞춘다**

```bash
npm run typecheck && npm run test && npm run test:int
```

`현재 기준선 (T28 완료 시점)` 블록의 라벨과 숫자를 실제 출력으로 바꾼다.
**추정하지 않는다.**

- [ ] **Step 7: 커밋**

```bash
git add backend/src/scenario docs CLAUDE.md
git commit -m "test: 두 테이블 사이의 이동을 시나리오로 고정한다"
```

---

## 검증

전부 끝난 뒤 루트에서:

```bash
npm run typecheck   # 0건
npm run test        # contract + 백엔드 단위 + 프론트 단위
npm run test:int    # 통합 + 시나리오
```
