# T28 좌석 확정을 입장 시점으로 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 참가비 결제에서 좌석을 떼어내고, 참가 OTP를 태블릿에 입력하는 순간 좌석이 확정되게 한다.

**Architecture:** 새 모듈 `src/entry/`가 OTP를 검증하고 좌석을 확정한 뒤 좌석 토큰을 발급한다. 좌석 토큰의 `role`은 Prisma `Role` enum 밖의 `'PLAYER'`라, 기존 `@Roles(...)` 배치가 그대로 권한 범위를 만든다 — 게임 경로와 WS 티켓만 통과한다. 결제는 돈과 참가 확정만 남기고, 좌석 예매용 Redis 락은 삭제한다.

**Tech Stack:** NestJS · Prisma 7.8(driver adapter) · Redis(ioredis) · JWT · Jest

**설계 문서:** [`../specs/2026-07-29-seat-on-enter-design.md`](../specs/2026-07-29-seat-on-enter-design.md)

## Global Constraints

- 좌석 토큰 페이로드는 정확히 `{ sub: userId, tournamentId, tableId, seatIndex, role: 'PLAYER' }`. `sub`는 반드시 `userId`다 — 게이트웨이가 `state.players.some(p => p.id === payload.sub)`로 좌석을 대조한다(`ws.gateway.ts:87`).
- `'PLAYER'`는 Prisma `Role` enum에 **추가하지 않는다.** 마이그레이션 금지.
- 입장에 시도 제한(잠금·카운터)을 붙이지 않는다. T27의 결정이다.
- 입장은 `omit: { playerOtp: false }`를 쓰지 않는다. OTP로 **찾을** 뿐 돌려받지 않는다.
- 입장 경로에 `phase` 가드를 넣지 않는다. 핸드 도중 착석은 허용이다(늦은 참가).
- 버그 수정·새 검사는 **실패를 먼저 본다.** 사후에 추가한 검사는 제품 코드를 되돌려 빨간불을 확인한다.
- 커밋 메시지·주석·문서는 한국어. 기존 파일의 어조를 따른다.
- 각 태스크 끝에서 `npm run typecheck`와 해당 테스트가 통과해야 한다.

## 파일 구조

| 파일 | 책임 |
|---|---|
| `backend/src/auth/seat-role.ts` (신규) | 좌석 토큰 역할 상수 하나 |
| `backend/src/auth/strategies/jwt.strategy.ts` | 좌석 토큰 분기 추가 |
| `backend/shared/dto/entry.dto.ts` (신규) | `EnterTournamentDto` |
| `backend/src/entry/entry.service.ts` (신규) | OTP 검증 · 좌석 확정 · 토큰 발급 |
| `backend/src/entry/entry.controller.ts` (신규) | `POST /tournaments/:id/enter` |
| `backend/src/entry/entry.module.ts` (신규) | 배선 |
| `backend/src/payment/payment.service.ts` | 좌석 관련 전부 제거, 이름 변경 |
| `backend/shared/dto/payment.dto.ts` | `PayMentDto`에서 좌석 제거 |
| `backend/src/redis/redis.service.ts` | 좌석 락 두 메서드 삭제 |
| `backend/src/scenario/harness.ts` | 착석을 결제 + 입장 두 단계로 |

---

### Task 1: 좌석 토큰의 역할과 JwtStrategy 분기

좌석 토큰이 무엇을 할 수 있고 무엇을 할 수 없는지가 **여기서만** 결정된다. Task 2가 이 상수로 서명한다.

권한 범위를 라우트 단위로 확인하려면 앱을 띄우는 e2e가 필요하고, 이 리포에는 그 계층이 없다(컨트롤러 spec이 `@UseGuards` 배선을 검증하지 못하는 것은 T27이 이월로 남긴 사실이다). 대신 **판정을 내리는 한 줄**(`roles.guard.ts:21`)을 직접 고정한다. 라우트에 `@Roles`가 붙어 있다는 사실은 T27이 `payment.controller.spec.ts`·`user.controller.spec.ts`로 이미 고정해 두었다.

**Files:**
- Create: `backend/src/auth/seat-role.ts`
- Modify: `backend/src/auth/strategies/jwt.strategy.ts`
- Test: `backend/src/auth/strategies/jwt.strategy.spec.ts` (추가), `backend/src/auth/guard/roles.guard.spec.ts` (신규)

**Interfaces:**
- Produces: `SEAT_ROLE`(값 `'PLAYER'`)와 `SeatTokenPayload` 타입. Task 2가 둘 다 쓴다.
- Produces: `JwtStrategy.validate`가 좌석 토큰에 대해 `{ userId, tournamentId, tableId, seatIndex, role: SEAT_ROLE }`를 돌려준다.

- [ ] **Step 1: 실패하는 테스트를 쓴다 — `roles.guard.spec.ts`**

`RolesGuard`가 좌석 토큰을 거부하는지 본다. 이 파일이 없으므로 새로 만든다.

```ts
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RolesGuard } from './roles.guard';
import { SEAT_ROLE } from '../seat-role';

/**
 * 좌석 토큰(T28)의 권한 범위는 화이트리스트가 아니라 **이 가드의 귀결**이다.
 * `role: 'PLAYER'`가 Prisma Role enum 밖의 값이라 어떤 `@Roles(...)` 목록과도
 * 맞지 않고, 그래서 돈·신원 라우트가 전부 자동으로 막힌다.
 *
 * 근거가 한 줄(`requiredRoles.includes(user.role)`)에 걸려 있으므로 그 줄이
 * 바뀌면 즉시 알아야 한다.
 */
describe('RolesGuard — 좌석 토큰', () => {
  function contextWith(role: string): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
  }

  function guardRequiring(roles: Role[] | undefined) {
    const reflector = { getAllAndOverride: () => roles } as unknown as Reflector;
    return new RolesGuard(reflector);
  }

  it('@Roles(USER) 라우트를 좌석 토큰으로 통과하지 못한다', () => {
    expect(guardRequiring([Role.USER]).canActivate(contextWith(SEAT_ROLE))).toBe(false);
  });

  it('@Roles(STORE_ADMIN) 라우트도 마찬가지다', () => {
    const guard = guardRequiring([Role.STORE_ADMIN, Role.PLATFORM_ADMIN]);
    expect(guard.canActivate(contextWith(SEAT_ROLE))).toBe(false);
  });

  it('역할 요구가 없는 라우트(JwtAuthGuard만)는 통과한다 — 게임 경로가 여기 있다', () => {
    expect(guardRequiring(undefined).canActivate(contextWith(SEAT_ROLE))).toBe(true);
  });

  it('진짜 USER는 여전히 통과한다', () => {
    expect(guardRequiring([Role.USER]).canActivate(contextWith(Role.USER))).toBe(true);
  });
});
```

- [ ] **Step 2: 실패하는 테스트를 쓴다 — `jwt.strategy.spec.ts`에 추가**

기존 `describe('JwtStrategy', ...)` 안, 마지막 `it` 뒤에 넣는다. `loadStrategy()`는 이미 그 파일에 있다.

```ts
  /**
   * 좌석 토큰(T28)은 딜러와 달리 `userId` 키를 그대로 쓴다.
   * `/playsync/*`가 `req.user.userId`로 플레이어를 찾기 때문이다 —
   * 딜러처럼 `id`로 개명하면 게임 경로 전체가 `undefined`를 받는다.
   */
  it('좌석 토큰을 userId와 좌석 정보가 담긴 모양으로 내보낸다', async () => {
    const strategy = loadStrategy();

    const user = await strategy.validate({
      sub: 'user-1',
      tournamentId: 'tour-1',
      tableId: 'table-1',
      seatIndex: 3,
      role: 'PLAYER',
    });

    expect(user).toEqual({
      userId: 'user-1',
      tournamentId: 'tour-1',
      tableId: 'table-1',
      seatIndex: 3,
      role: 'PLAYER',
    });
  });

  it('좌석 토큰의 역할을 USER로 승격시키지 않는다', async () => {
    const strategy = loadStrategy();

    const user = await strategy.validate({ sub: 'user-1', role: 'PLAYER', seatIndex: 0 });

    expect(user.role).not.toBe(Role.USER);
  });
```

- [ ] **Step 3: 빨간불을 확인한다**

```bash
npm run test -w backend -- roles.guard.spec jwt.strategy.spec
```

기대: `roles.guard.spec`은 `Cannot find module '../seat-role'`로 죽는다. `jwt.strategy.spec`의 새 두 건은 `validate`가 `{ userId, nickname, role }`만 돌려줘 `toEqual` 불일치로 실패한다.

- [ ] **Step 4: `seat-role.ts`를 만든다**

```ts
/**
 * 좌석 토큰의 역할.
 *
 * Prisma `Role` enum에 넣지 않는다. `Role`은 `User` 행의 속성이라 "이 사람은
 * 플레이어다"를 적는 곳이고, 여기 적을 것은 "이 토큰은 좌석 하나짜리다"라는
 * 토큰의 성질이다.
 *
 * enum 밖에 두는 것이 곧 권한 경계다. `RolesGuard`는
 * `requiredRoles.includes(user.role)`로 판정하므로(`guard/roles.guard.ts`),
 * 이 값은 어떤 `@Roles(...)` 목록과도 맞지 않아 돈·신원 라우트에서 전부
 * 거부된다. 좌석 토큰이 지나갈 수 있는 곳은 역할을 요구하지 않는 라우트
 * — 게임 경로(`/playsync/*`)와 WS 티켓 발급뿐이다.
 */
export const SEAT_ROLE = 'PLAYER';

export type SeatTokenPayload = {
  sub: string;
  tournamentId: string;
  tableId: string;
  seatIndex: number;
  role: typeof SEAT_ROLE;
};
```

- [ ] **Step 5: `jwt.strategy.ts`에 분기를 넣는다**

`validate`의 DEALER 분기 **뒤**, 마지막 `return` 앞에 넣는다. 파일 상단에 `import { SEAT_ROLE } from '../seat-role';`를 추가한다.

```ts
    // 좌석 토큰(T28). `userId` 키를 그대로 두는 이유는 `/playsync/*`가
    // `req.user.userId`로 플레이어를 찾기 때문이다. 딜러처럼 `id`로 개명하면
    // 게임 경로가 전부 undefined를 받는다.
    if (payload.role === SEAT_ROLE) {
      return {
        userId: payload.sub,
        tournamentId: payload.tournamentId,
        tableId: payload.tableId,
        seatIndex: payload.seatIndex,
        role: SEAT_ROLE,
      };
    }
```

- [ ] **Step 6: 초록불을 확인한다**

```bash
npm run test -w backend -- roles.guard.spec jwt.strategy.spec
npm run typecheck
```

- [ ] **Step 7: 커밋**

```bash
git add backend/src/auth
git commit -m "feat: 좌석 토큰의 역할을 Role enum 밖에 둔다"
```

---

### Task 2: 입장 엔드포인트

**Files:**
- Create: `backend/shared/dto/entry.dto.ts`, `backend/src/entry/entry.service.ts`, `backend/src/entry/entry.controller.ts`, `backend/src/entry/entry.module.ts`
- Modify: `backend/src/app.module.ts`
- Test: `backend/src/entry/entry.service.int-spec.ts`

**Interfaces:**
- Consumes: Task 1의 `SEAT_ROLE`.
- Produces: `EntryService.enterSeat(tournamentId: string, dto: EnterTournamentDto): Promise<{ accessToken: string }>`. Task 3의 하네스가 이 시그니처로 부른다.
- Produces: `EnterTournamentDto { otp: string; tableId: string; seatIndex: number }`.

`PrismaService` · `RedisService` · `JwtService` · `EventEmitter2`는 전부 전역 모듈이 제공하므로 `EntryModule`에 `imports`가 필요 없다.

- [ ] **Step 1: DTO를 만든다**

```ts
// backend/shared/dto/entry.dto.ts
import { IsInt, IsString, Matches, Max, Min } from 'class-validator';
import { PLAYER_OTP_LENGTH } from 'src/payment/player-otp';

export class EnterTournamentDto {
  // 길이만 재면 "abcdefgh"가 통과해 DB 조회까지 내려간다. 형식으로 막는다.
  @Matches(new RegExp(`^\\d{${PLAYER_OTP_LENGTH}}$`), {
    message: '참가 OTP 형식이 올바르지 않습니다.',
  })
  otp: string;

  @IsString()
  tableId: string;

  @IsInt()
  @Min(0)
  @Max(8)
  seatIndex: number;
}
```

- [ ] **Step 2: 실패하는 테스트를 쓴다 — `entry.service.int-spec.ts`**

진짜 Prisma와 진짜 Redis를 쓴다. 검증 대상 중 하나가 "좌석 경합이 락이 아니라 `@@unique([tableId, seatPosition])`로 갈린다"이고, 그건 진짜 제약이 있어야만 의미가 있다.

```ts
import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, PlayerStatus, TournamentStatus } from '@prisma/client';
import Redis from 'ioredis';
import { GamePhase, TableState } from 'src/game-engine/types';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';
import { EntryService } from './entry.service';

describe('EntryService.enterSeat', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let redisService: RedisService;
  let service: EntryService;

  const TOURNAMENT = 'entry-tournament-1';
  const TABLE = 'entry-table-1';
  const OTHER_TABLE = 'entry-table-2';

  /** 참가 하나를 만들고 그 OTP를 돌려준다. */
  async function participate(userId: string, otp: string, tournamentId = TOURNAMENT) {
    await prisma.user.create({ data: { id: userId, nickname: userId, password: 'x' } });
    await prisma.tournamentParticipation.create({
      data: { userId, tournamentId, playerOtp: otp, status: PlayerStatus.WAITING },
    });
    return otp;
  }

  /** `Table.dealerId`가 필수라 대회마다 딜러 세션이 하나 있어야 한다. */
  async function seedTournament(id: string, status: TournamentStatus, tableIds: string[]) {
    await prisma.tournament.create({
      data: {
        id, name: id, blindId: 'entry-blind', storeId: 'entry-store',
        dealerOtpHash: 'unused', entryFee: 1000, startStack: 10000,
        status, isRegistrationOpen: true,
      },
    });
    const dealerSession = await prisma.dealerSession.create({ data: { tournamentId: id } });
    for (const [order, tableId] of tableIds.entries()) {
      await prisma.table.create({
        data: {
          id: tableId, tournamentId: id, tableOrder: order + 1,
          dealerId: dealerSession.id,
        },
      });
    }
  }

  beforeAll(() => {
    prisma = createTestPrisma();
    redis = createTestRedis();
    redisService = new RedisService(redis);
    service = new EntryService(
      prisma as unknown as PrismaService,
      redisService,
      new JwtService({ secret: 'entry-spec-secret' }),
      new EventEmitter2(),
    );
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await flushTestRedis(redis);
    await prisma.user.create({
      data: { id: 'entry-owner', nickname: 'owner', password: 'x', role: 'STORE_ADMIN' },
    });
    await prisma.store.create({ data: { id: 'entry-store', name: '상점', ownerId: 'entry-owner' } });
    await prisma.blindStructure.create({
      data: {
        id: 'entry-blind', name: '기본', storeId: 'entry-store',
        structure: [{ lv: 1, sb: 100, ante: false, duration: 600 }],
      },
    });
    await seedTournament(TOURNAMENT, TournamentStatus.PENDING, [TABLE, OTHER_TABLE]);
  });

  afterAll(async () => {
    await closeTestPrisma(prisma);
    await redis.quit();
  });

  async function snapshot(tableId = TABLE): Promise<TableState | null> {
    return await redisService.getSnapShot(tableId);
  }

  it('OTP가 맞으면 좌석이 확정되고 토큰이 나온다', async () => {
    await participate('u1', '00000001');

    const { accessToken } = await service.enterSeat(TOURNAMENT, {
      otp: '00000001', tableId: TABLE, seatIndex: 3,
    });

    expect(accessToken).toEqual(expect.any(String));

    const row = await prisma.tablePlayer.findFirstOrThrow({ where: { userId: 'u1' } });
    expect(row.seatPosition).toBe(3);
    expect(row.currentStack).toBe(10000);

    const state = await snapshot();
    expect(state!.players[3]).toMatchObject({ id: 'u1', seatIndex: 3, stack: 10000 });

    const participation = await prisma.tournamentParticipation.findFirstOrThrow({
      where: { userId: 'u1' },
    });
    expect(participation.status).toBe(PlayerStatus.PLAYING);
  });

  it('좌석 토큰의 sub가 스냅샷의 플레이어 id와 같다 — 게이트웨이 좌석 대조의 근거', async () => {
    await participate('u1', '00000001');

    const { accessToken } = await service.enterSeat(TOURNAMENT, {
      otp: '00000001', tableId: TABLE, seatIndex: 0,
    });

    const payload = new JwtService({ secret: 'entry-spec-secret' }).verify(accessToken);
    const state = await snapshot();
    expect(state!.players.some((p) => p?.id === payload.sub)).toBe(true);
    expect(payload).toMatchObject({
      tournamentId: TOURNAMENT, tableId: TABLE, seatIndex: 0, role: 'PLAYER',
    });
  });

  it('틀린 OTP는 401이다', async () => {
    await participate('u1', '00000001');

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '99999999', tableId: TABLE, seatIndex: 0 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('없는 대회도 같은 401이다 — 존재하는 대회 id를 훑을 수 없어야 한다', async () => {
    await expect(
      service.enterSeat('no-such-tournament', { otp: '00000001', tableId: TABLE, seatIndex: 0 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('다른 대회의 OTP는 통하지 않는다', async () => {
    await seedTournament('entry-tournament-2', TournamentStatus.PENDING, []);
    await participate('u1', '00000001', 'entry-tournament-2');

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 0 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('끝난 대회는 403이다', async () => {
    await participate('u1', '00000001');
    await prisma.tournament.update({
      where: { id: TOURNAMENT }, data: { status: TournamentStatus.FINISHED },
    });

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 0 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('탈락한 참가자는 다시 앉지 못한다', async () => {
    await participate('u1', '00000001');
    await prisma.tournamentParticipation.updateMany({
      where: { userId: 'u1' }, data: { status: PlayerStatus.ELIMINATED },
    });

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 0 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('이 대회에 속하지 않은 테이블은 403이다', async () => {
    await seedTournament('entry-tournament-2', TournamentStatus.PENDING, ['foreign-table']);
    await participate('u1', '00000001');

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: 'foreign-table', seatIndex: 0 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('이미 다른 자리에 앉아 있으면 409다 — 이동은 T29다', async () => {
    await participate('u1', '00000001');
    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: OTHER_TABLE, seatIndex: 2 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('같은 좌석에 다시 넣으면 토큰만 새로 나오고 좌석은 하나다', async () => {
    await participate('u1', '00000001');
    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    expect(await prisma.tablePlayer.count({ where: { userId: 'u1' } })).toBe(1);
  });

  it('재입장이 진행 중인 핸드의 상태를 덮지 않는다', async () => {
    await participate('u1', '00000001');
    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    const live = (await snapshot())!;
    live.phase = GamePhase.FLOP;
    live.players[1]!.bet = 500;
    live.players[1]!.totalContributed = 500;
    await redisService.saveSnapShot(TABLE, live);

    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    const after = (await snapshot())!;
    expect(after.players[1]).toMatchObject({ bet: 500, totalContributed: 500 });
  });

  it('DB에는 있는데 스냅샷에서 사라진 좌석을 재입장이 되살린다', async () => {
    await participate('u1', '00000001');
    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    // DB를 쓰고 스냅샷을 쓰기 전에 죽은 상태를 그대로 만든다.
    const broken = (await snapshot())!;
    broken.players[1] = null;
    await redisService.saveSnapShot(TABLE, broken);

    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    expect((await snapshot())!.players[1]).toMatchObject({ id: 'u1' });
  });

  it('핸드 도중에 앉으면 이번 핸드는 폴드 상태로 들어간다 — 늦은 참가', async () => {
    await participate('u1', '00000001');
    await participate('u2', '00000002');
    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 0 });

    const live = (await snapshot())!;
    live.phase = GamePhase.FLOP;
    await redisService.saveSnapShot(TABLE, live);

    await service.enterSeat(TOURNAMENT, { otp: '00000002', tableId: TABLE, seatIndex: 4 });

    expect((await snapshot())!.players[4]).toMatchObject({ id: 'u2', hasFolded: true });
  });

  it('같은 좌석을 동시에 노리면 한 명만 앉는다', async () => {
    await participate('u1', '00000001');
    await participate('u2', '00000002');

    const results = await Promise.allSettled([
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 2 }),
      service.enterSeat(TOURNAMENT, { otp: '00000002', tableId: TABLE, seatIndex: 2 }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.tablePlayer.count({ where: { tableId: TABLE, seatPosition: 2 } })).toBe(1);
  });

  it('다른 좌석에 동시에 앉으면 서로를 지우지 않는다', async () => {
    for (const [i, id] of ['u1', 'u2', 'u3'].entries()) {
      await participate(id, String(i + 1).padStart(8, '0'));
    }

    await Promise.all(
      ['u1', 'u2', 'u3'].map((_, i) =>
        service.enterSeat(TOURNAMENT, {
          otp: String(i + 1).padStart(8, '0'), tableId: TABLE, seatIndex: i,
        }),
      ),
    );

    const state = (await snapshot())!;
    expect(state.players.filter(Boolean)).toHaveLength(3);
  });

  it('좌석 비트맵에 반영된다', async () => {
    await participate('u1', '00000001');
    await redisService.setSeatBitmap(TOURNAMENT, TABLE);

    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 5 });

    const bitmap = await redis.hget(`tournament:${TOURNAMENT}:seat`, `table:${TABLE}`);
    expect(bitmap![5]).toBe('1');
  });
});
```

- [ ] **Step 3: 빨간불을 확인한다**

```bash
npm run test:int -w backend -- entry.service.int-spec
```

기대: `Cannot find module './entry.service'`.

- [ ] **Step 4: `entry.service.ts`를 구현한다**

```ts
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { PlayerStatus, TournamentStatus } from '@prisma/client';
import { EnterTournamentDto } from 'shared/dto/entry.dto';
import { SEAT_ROLE } from 'src/auth/seat-role';
import { GamePhase, TableState } from 'src/game-engine/types';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';

/** 좌석을 확정할 때 필요한 것만 추린 값. 조회 결과를 그대로 끌고 다니지 않는다. */
type Claimant = {
  userId: string;
  participationId: string;
  nickname: string;
  stack: number;
  /** 이미 이 좌석의 `TablePlayer`가 있는가(재입장). */
  alreadySeated: boolean;
};

/**
 * 참가 OTP로 좌석을 확정하고 좌석 토큰을 발급한다.
 *
 * 결제 서비스가 아니라 별도 모듈인 이유: 결제는 돈이고 입장은 인증과 좌석이다.
 * 한 파일에 두면 참가비 차감과 JWT 서명이 같은 클래스에 앉는다.
 */
@Injectable()
export class EntryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async enterSeat(tournamentId: string, dto: EnterTournamentDto) {
    // OTP로 **찾을** 뿐 돌려받지 않으므로 `omit: { playerOtp: false }`가 필요
    // 없다. 클라이언트 수준 omit은 출력만 가린다 — 참가 OTP를 읽는 유일한
    // 곳은 여전히 마이페이지다(T27).
    const participation = await this.prisma.tournamentParticipation.findUnique({
      where: { tournamentId_playerOtp: { tournamentId, playerOtp: dto.otp } },
      include: {
        user: { select: { nickname: true } },
        tournament: { select: { status: true, startStack: true } },
      },
    });

    // 대회가 없을 때와 OTP가 틀렸을 때를 가르지 않는다. 가르면 존재하는 대회
    // id를 훑을 수 있다 — 딜러 로그인과 같은 이유(`dealer.service.ts:53`).
    if (!participation) {
      throw new UnauthorizedException('인증 정보가 올바르지 않습니다.');
    }
    if (participation.tournament.status === TournamentStatus.FINISHED) {
      throw new ForbiddenException('종료된 대회입니다.');
    }
    if (
      participation.status === PlayerStatus.ELIMINATED ||
      participation.status === PlayerStatus.AWARDED
    ) {
      throw new ConflictException('이미 끝난 참가입니다.');
    }

    // 좌석은 대회 안에서 하나다. `@@unique([tableId, userId])`는 같은 테이블만
    // 막으므로 테이블을 건너뛴 중복은 여기서 본다.
    const seated = await this.prisma.tablePlayer.findFirst({
      where: { tournamentId, userId: participation.userId },
    });
    const sameSeat =
      seated !== null &&
      seated.tableId === dto.tableId &&
      seated.seatPosition === dto.seatIndex;
    if (seated && !sameSeat) {
      throw new ConflictException('이미 다른 좌석에 앉아 있습니다. 상점에 문의해주세요.');
    }

    await this.claimSeat(tournamentId, dto, {
      userId: participation.userId,
      participationId: participation.id,
      nickname: participation.user.nickname ?? '',
      // 재입장이면 스냅샷이 없을 수 있고, 그때는 DB의 스택이 유일한 출처다.
      stack: seated?.currentStack ?? participation.tournament.startStack,
      alreadySeated: seated !== null,
    });

    return {
      accessToken: this.jwt.sign({
        sub: participation.userId,
        tournamentId,
        tableId: dto.tableId,
        seatIndex: dto.seatIndex,
        role: SEAT_ROLE,
      }),
    };
  }

  /**
   * 좌석을 DB와 스냅샷에 반영한다.
   *
   * 락을 잡는 이유는 좌석 예매가 아니라 스냅샷이다 — JSON 통째로 덮어쓰므로
   * 다른 의자에 앉는 두 사람이 겹치면 나중에 쓴 쪽이 앞선 착석을 지운다.
   * 같은 의자를 노리는 경합의 최종 판정은 `@@unique([tableId, seatPosition])`가
   * 한다. 락은 만료가 있고 제약은 없다.
   */
  private async claimSeat(
    tournamentId: string,
    dto: EnterTournamentDto,
    who: Claimant,
  ) {
    await this.redis.withTableLock(dto.tableId, async () => {
      // 락 밖에서 미리 보지 않는다. 검사와 쓰기가 같은 락 안에 있어야
      // check-then-act가 생기지 않는다(T25의 deleteTable이 걸렸던 자리다).
      const table = await this.prisma.table.findUnique({
        where: { tournamentId_id: { tournamentId, id: dto.tableId } },
        select: { id: true },
      });
      if (!table) {
        throw new ForbiddenException('이 대회에 속하지 않은 테이블입니다.');
      }

      const state =
        (await this.redis.getSnapShot(dto.tableId)) ?? this.emptyTableState(tournamentId);
      const occupant = state.players[dto.seatIndex];
      if (occupant && occupant.id !== who.userId) {
        throw new ConflictException('이미 다른 참가자가 앉은 좌석입니다.');
      }

      if (!who.alreadySeated) {
        try {
          await this.prisma.$transaction(async (tx) => {
            await tx.tablePlayer.create({
              data: {
                tournamentId,
                tableId: dto.tableId,
                userId: who.userId,
                nickname: who.nickname,
                seatPosition: dto.seatIndex,
                currentStack: who.stack,
              },
            });
            await tx.tournamentParticipation.update({
              where: { id: who.participationId },
              data: { status: PlayerStatus.PLAYING },
            });
          });
        } catch (e) {
          if ((e as { code?: string }).code === 'P2002') {
            throw new ConflictException('이미 다른 참가자가 앉은 좌석입니다.');
          }
          throw e;
        }
      }

      // 이 사람이 이미 스냅샷에 있으면 손대지 않는다. 덮어쓰면 진행 중인
      // 핸드의 bet·hasFolded·totalContributed가 날아간다. 비어 있는 경우만
      // 채우는 것이 곧 "DB는 썼는데 스냅샷을 못 쓰고 죽은" 상태의 복구다.
      if (!occupant) {
        state.players[dto.seatIndex] = {
          id: who.userId,
          tableId: dto.tableId,
          nickname: who.nickname,
          seatIndex: dto.seatIndex,
          stack: who.stack,
          bet: 0,
          // 핸드 도중 착석은 허용이다(늦은 참가). 폴드로 넣으면 팟·차례·
          // 사이드팟 어디에도 끼어들지 않고, 핸드가 끝날 때 resetStatus()가
          // 풀어 준다(`table-engine.ts:281`).
          hasFolded: state.phase !== GamePhase.WAITING,
          isAllIn: false,
          hasChecked: false,
          totalContributed: 0,
        };
        await this.redis.saveSnapShot(dto.tableId, state);
      }
    });

    await this.redis.setUserContext(
      tournamentId, who.userId, dto.tableId, dto.seatIndex, 'ACTIVE',
    );
    await this.redis.updateSeatBitmap(tournamentId, dto.tableId, dto.seatIndex, true);
    const tableStatus = await this.redis.getTournamentTables(tournamentId);
    this.eventEmitter.emit('SEAT_LIST_UPDATED', { tournamentId, state: tableStatus });
  }

  /**
   * 스냅샷이 아직 없는 테이블의 초기 상태.
   *
   * 스냅샷을 만드는 유일한 지점이다(예전에는 결제가 했다). `smallBlind`는
   * `startPreFlop`이 블라인드 구조에서 덮어쓰므로 여기 값은 자리 채움이다.
   */
  private emptyTableState(tournamentId: string): TableState {
    return {
      phase: GamePhase.WAITING,
      players: Array(9).fill(null),
      pot: 0,
      currentBet: 0,
      buttonUser: 0,
      currentTurnSeatIndex: -1,
      sidePots: [],
      ante: false,
      tournamentId,
      smallBlind: 100,
    };
  }
}
```

- [ ] **Step 5: 컨트롤러와 모듈을 만든다**

```ts
// backend/src/entry/entry.controller.ts
import { Body, Controller, Param, Post } from '@nestjs/common';
import { EnterTournamentDto } from 'shared/dto/entry.dto';
import { EntryService } from './entry.service';

/**
 * 대회 입장. 가드가 없다 — **OTP 자체가 자격 증명**이다. 딜러 로그인
 * (`POST /dealer/auth`)과 같은 자리다.
 */
@Controller('tournaments')
export class EntryController {
  constructor(private readonly entryService: EntryService) {}

  @Post(':id/enter')
  async enter(@Param('id') tournamentId: string, @Body() dto: EnterTournamentDto) {
    return await this.entryService.enterSeat(tournamentId, dto);
  }
}
```

```ts
// backend/src/entry/entry.module.ts
import { Module } from '@nestjs/common';
import { EntryController } from './entry.controller';
import { EntryService } from './entry.service';

// PrismaModule · RedisModule · JwtModule · EventEmitterModule이 전부 전역이라
// import할 것이 없다.
@Module({
  controllers: [EntryController],
  providers: [EntryService],
  exports: [EntryService],
})
export class EntryModule {}
```

`app.module.ts`의 `imports` 배열에 `EntryModule`을 추가하고 상단에 import를 넣는다.

- [ ] **Step 6: 초록불을 확인한다**

```bash
npm run test:int -w backend -- entry.service.int-spec
npm run typecheck
```

- [ ] **Step 7: RED를 사후 확인한다**

핵심 주장 둘이 진짜로 검증되는지 제품 코드를 되돌려 본다.

1. `if (!occupant)` 조건을 지우고 항상 덮어쓰게 한다 → "재입장이 진행 중인 핸드의 상태를 덮지 않는다"가 빨간불이어야 한다.
2. `hasFolded: state.phase !== GamePhase.WAITING`를 `hasFolded: false`로 바꾼다 → "핸드 도중에 앉으면 이번 핸드는 폴드 상태로 들어간다"가 빨간불이어야 한다.

확인 후 원복한다.

- [ ] **Step 8: 커밋**

```bash
git add backend/src/entry backend/shared/dto/entry.dto.ts backend/src/app.module.ts
git commit -m "feat: 참가 OTP로 좌석을 확정하는 입장 경로를 만든다"
```

---

### Task 3: 결제에서 좌석을 뺀다

가장 큰 태스크다. 좌석이 결제에서 빠지면 **모든 착석 셋업이 두 단계가 된다.**

**Files:**
- Modify: `backend/shared/dto/payment.dto.ts`, `backend/src/payment/payment.service.ts`, `backend/src/payment/payment.controller.ts`
- Modify(test): `backend/src/payment/payment.service.int-spec.ts`, `backend/src/scenario/harness.ts`, `backend/src/scenario/full-flow.int-spec.ts`, `backend/src/scenario/full-tournament.int-spec.ts`

**Interfaces:**
- Consumes: Task 2의 `EntryService.enterSeat`.
- Produces: `PaymentService.joinSession(dto: PayMentDto, userId: string)` — 이름이 바뀐다(`joinSessionWithSeat` → `joinSession`). 좌석을 만들지 않는데 이름에 `WithSeat`이 남으면 거짓말이 된다.
- Produces: 하네스의 `seatPlayer(tournamentId, tableId, seatIndex, userId)`.

- [ ] **Step 1: DTO를 줄인다**

```ts
// backend/shared/dto/payment.dto.ts
export class PayMentDto {
  @IsString()
  tournamentId: string;
}
```

`IsInt` · `Max` · `Min` import가 `RebuyDto`에서도 안 쓰이면 함께 지운다.

- [ ] **Step 2: `payment.service.ts`의 `joinSessionWithSeat`를 `joinSession`으로 바꾼다**

`redisService.acquireSeatLock` 호출부터 `finally`의 `releaseSeatLock`까지 감싸던 구조를 걷어낸다. 최종 형태:

```ts
  // 참가비 결제. **좌석은 여기서 정하지 않는다**(T28) — 오프라인에서 돈은
  // 미리 내고 의자는 현장에서 정해진다. 좌석 확정은 EntryService가 참가
  // OTP를 받는 순간에 한다.
  async joinSession(dto: PayMentDto, userId: string) {
    const user = await this.user.findByUUID(userId);
    if (!user) {
      throw new ConflictException('잘못된 유저 ID 입니다.');
    }
    const session = await this.prismaService.tournament.findUnique({
      where: { id: dto.tournamentId },
    });
    if (!session) throw new ConflictException('잘못된 세션 ID 입니다.');
    if (session.status === TournamentStatus.FINISHED || !session.isRegistrationOpen) {
      throw new ConflictException('이미 종료된 세션입니다.');
    }
    if (user.points < session.entryFee) {
      throw new ConflictException('포인트가 부족합니다.');
    }

    // OTP가 대회 안에서 겹치면 다시 뽑는다. 8자리라 드물지만 드문 것은 안 나는
    // 것이 아니다. 트랜잭션 전체를 다시 도는 이유는 참가비 차감과 참가 생성이
    // 같은 트랜잭션 안이라 OTP만 따로 바꿀 수 없기 때문이다.
    let participation: { id: string; status: PlayerStatus } | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        participation = await this.prismaService.$transaction(async (tx) => {
          await this.user.paymentPoint(
            tx, userId, dto.tournamentId, session.name, session.entryFee,
          );
          // 착석 여부와 무관하게 WAITING이다. PLAYING으로 올리는 것은
          // 입장(EntryService)의 몫이다 — PlayerStatus의 주석이 원래
          // 그렇게 적혀 있다("바이인 완료 후 대기" / "테이블 착석 중").
          const created = await tx.tournamentParticipation.create({
            data: {
              userId,
              tournamentId: dto.tournamentId,
              status: PlayerStatus.WAITING,
              playerOtp: playerOtp.generatePlayerOtp(),
            },
          });
          await tx.tournament.update({
            where: { id: dto.tournamentId },
            data: {
              totalPlayers: { increment: 1 },
              activePlayers: { increment: 1 },
              totalBuyinAmount: { increment: session.entryFee },
            },
          });
          return { id: created.id, status: created.status };
        });
        break;
      } catch (e) {
        // 지금 `payment.service.ts:143-163`에 있는 catch 블록을 **한 글자도
        // 바꾸지 말고** 그대로 옮긴다. 드라이버 어댑터 구성이라 P2002 메타에
        // `target`이 없고 위반 컬럼이
        // `meta.driverAdapterError.cause.constraint.fields`에 따옴표째 들어온다는
        // 사실이 그 블록에 담겨 있다. 다시 쓰면 그 사실을 잃는다.
      }
    }
    if (!participation) {
      throw new ConflictException('참가 OTP를 만들지 못했습니다. 다시 시도해 주세요.');
    }

    // 대회 카운터의 Redis 미러다. 방금 DB에 올린 세 필드와 같은 값이라
    // 좌석과 무관하고, 그래서 여기 남는다.
    await this.redisService.joinPlayer(dto.tournamentId, session.entryFee);

    return participation;
  }
```

응답에 `playerOtp`를 싣지 않는다. 볼 수 있는 곳은 마이페이지 하나라는 T27의 결정이 그대로 유효하다 — 결제 응답에 실으면 노출 표면이 하나 늘고, 그 화면은 어차피 폰이라 마이페이지와 같은 기기다.

`GamePhase` · `TablePlayer` · `TableState` import가 더 이상 안 쓰이면 지운다. `PlayerStatus`를 `@prisma/client`에서 가져온다.

- [ ] **Step 3: 컨트롤러의 호출 이름을 바꾼다**

`payment.controller.ts:43`의 `joinSessionWithSeat` → `joinSession`.

- [ ] **Step 4: 하네스를 두 단계로 만든다**

`harness.ts` 상단 import에 `EntryService`와 `JwtService`(이미 있다)를 추가하고, 서비스 배선에 한 줄을 넣는다.

```ts
  const entry = new EntryService(
    prismaService, redisService,
    new JwtService({ secret: 'scenario-secret' }),
    emitter,
  );
```

`harness.ts:155`의 착석 루프를 바꾼다.

```ts
  for (const [seat, id] of players.entries()) {
    await seatPlayer(created.id, table.id, seat, id);
  }
```

`setupTournament` 안에 헬퍼를 둔다.

```ts
  /**
   * 결제 후 입장까지. T28에서 착석이 두 단계가 됐다 — 돈은 미리 내고 의자는
   * 현장에서 정해진다. 테스트는 그 사이의 "OTP를 폰에서 확인한다"를 DB 조회로
   * 대신한다.
   */
  async function seatPlayer(
    tournamentId: string, tableId: string, seatIndex: number, userId: string,
  ) {
    await payment.joinSession({ tournamentId }, userId);
    const participation = await prisma.tournamentParticipation.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId, userId } },
    });
    await entry.enterSeat(tournamentId, {
      otp: participation.playerOtp, tableId, seatIndex,
    });
  }
```

`Harness` 인터페이스에 `entry: EntryService`와 `seatPlayer` 시그니처를 추가하고, 반환 객체에도 넣는다. `full-flow.int-spec.ts`와 `full-tournament.int-spec.ts`가 도중에 사람을 더 앉히므로 그쪽에서도 쓴다.

`createTestPrisma()`는 클라이언트 수준 `omit`이 없는 맨 `PrismaClient`라 `playerOtp`가 그대로 나온다. 테스트에서만 성립하는 사실이니 헬퍼 주석에 남긴다.

- [ ] **Step 5: 시나리오 스펙의 직접 호출을 바꾼다**

`full-flow.int-spec.ts:276`, `:298`, `full-tournament.int-spec.ts:230`의 `payment.joinSessionWithSeat({ tournamentId, tableId, seatIndex }, id)`를 `h.seatPlayer(tournamentId, tableId, seatIndex, id)`로 바꾼다. `:298`은 `Promise` 배열 안이므로 형태를 유지한다.

- [ ] **Step 6: `payment.service.int-spec.ts`의 좌석 테스트를 걷어낸다**

첫 `describe('PaymentService.joinSessionWithSeat', ...)`(26~255행)는 전부 좌석·스냅샷·비트맵·좌석 경합이다. Task 2의 `entry.service.int-spec.ts`가 같은 것을 진짜 제약 위에서 검증하므로 **이 describe를 통째로 지운다.** 스텁 배선(`makeService`)도 함께 사라진다.

남는 두 describe는 유지하되 좌석을 뺀다.

- `describe('PaymentService — 참가 OTP 발급')`: `dto(0)` 같은 호출을 `{ tournamentId: TOURNAMENT }`로 바꾸고 메서드 이름을 `joinSession`으로 바꾼다. "같은 사람이 두 번 참가하면 재시도하지 않고 그대로 실패한다"는 이제 `@@unique([tournamentId, userId])`만 근거로 남는다(좌석 제약이 먼저 걸릴 여지가 없어졌다) — 그대로 통과해야 한다.
- `describe('PaymentService.getTournamentInfo — 테이블이 없는 대회')`: 손대지 않는다.

- [ ] **Step 7: 전부 돌린다**

```bash
npm run typecheck
npm run test
npm run test:int
```

시나리오가 전부 초록이어야 한다. 여기서 깨지면 착석 두 단계화가 틀린 것이므로, 실패한 시나리오의 첫 불변식 위반 단계를 보고 고친다.

- [ ] **Step 8: 커밋**

```bash
git add backend/src backend/shared
git commit -m "fix: 결제가 좌석을 정하지 않게 한다"
```

---

### Task 4: 좌석 락을 지우고 기록을 남긴다

**Files:**
- Modify: `backend/src/redis/redis.service.ts`
- Modify: `docs/tickets-next.md`, `docs/backlog.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: Task 3까지 끝나 `acquireSeatLock`·`releaseSeatLock` 호출자가 0인 상태.

- [ ] **Step 1: 호출자가 없는지 확인한다**

```bash
grep -rn "acquireSeatLock\|releaseSeatLock" backend/src backend/test
```

`redis.service.ts`의 정의 두 개만 남아야 한다. 남은 것이 있으면 Task 3이 덜 끝난 것이다.

- [ ] **Step 2: 두 메서드를 지운다**

`redis.service.ts:68-82`의 `acquireSeatLock`과 `releaseSeatLock`을 삭제한다. `PayMentDto` import가 이 파일에서 더 안 쓰이면 함께 지운다.

같은 파일 `updateSeatBitmap`의 독스트링에 "좌석 락은 좌석**별**이라…"로 시작하는 문단이 있다. 없는 것을 근거로 설명하게 되므로 고친다 — 지금의 근거는 "비트 갱신은 필드끼리 독립이라 락이 아니라 원자 연산이 맞다"는 뒷부분이고, 앞의 좌석 락 이야기는 "예전에는 좌석 락이 있었고 그것으로는 부족했다"가 아니라 그냥 삭제한다.

- [ ] **Step 3: 타입 체크와 전체 테스트**

```bash
npm run typecheck && npm run test && npm run test:int
```

- [ ] **Step 4: `docs/tickets-next.md`에 T27과 같은 형식으로 T28을 적는다**

문제 / 결정 / 버린 선택지 / RED 확인 방법 / 작업 중 추가로 나온 것 / 테스트 / 남긴 것.

반드시 담을 것:

- **왜 결제에서 좌석을 뗐는가** — 오프라인에서 돈과 의자가 같은 순간이 아니다. 붙여 두면 사람이 옮길 때 기록이 안 따라가고, 좌석 예매가 필요해지고, 오지 않은 사람의 의자가 막힌다.
- **`'PLAYER'`를 Prisma `Role` enum 밖에 둔 것.** 권한 범위가 화이트리스트가 아니라 기존 `@Roles` 배치의 귀결로 성립한다. 근거가 `roles.guard.ts`의 한 줄에 걸려 있어 단위 테스트로 고정했다.
- **`WAITING` 가드를 T28에 넣지 않은 이유.** 폐기한 재배치 설계에서 살렸던 판단인데, 그건 이미 앉은 사람을 옮길 때의 조건이다. 신규 착석은 팟에도 차례에도 얽혀 있지 않고, 늦은 참가가 핸드 도중에 들어오는 것이 홀덤의 정상 흐름이다. 가드는 T29로 넘겼다.
- **락을 제약으로 바꾼 것.** T25가 `tableOrder`에서 한 것과 같은 자리다.
- **같은 좌석 재입장이 스냅샷 복구 경로가 된 것.** DB를 먼저 쓰고 스냅샷을 나중에 쓰므로 사이에 죽으면 DB에만 있는 사람이 남는데, 자기 `TablePlayer` 때문에 신규 착석 경로로도 못 간다.

- [ ] **Step 5: `docs/backlog.md`를 갱신한다**

- 완주 경로에서 T28을 지난 것으로 표시한다.
- B8 절의 티켓 표에서 T28 행의 "설계 문서"를 `미작성`에서 실제 경로로 바꾼다.
- "폐기한 설계에서 살아남는 판단 셋" 중 `GamePhase.WAITING` 항목에, T28이 아니라 **T29가 쓰는 조건**이라는 것을 한 줄로 명시한다.
- "좌석 락은 폐기된다(T28)"를 완료형으로 고친다.

- [ ] **Step 6: `CLAUDE.md`의 기준선 숫자를 실제 출력으로 맞춘다**

`npm run test`와 `npm run test:int`의 실제 출력을 보고 적는다. 추정하지 않는다.

- [ ] **Step 7: 커밋**

```bash
git add backend/src/redis docs CLAUDE.md
git commit -m "refactor: 좌석 락을 지우고 T28의 판단을 기록한다"
```

---

## 검증

전부 끝난 뒤 루트에서:

```bash
npm run typecheck   # 0건
npm run test        # contract + 백엔드 단위 + 프론트 단위
npm run test:int    # 통합 + 시나리오
```
