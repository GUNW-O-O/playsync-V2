# 참가 OTP(T27) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 참가자마다 다른 8자리 참가 OTP를 참가 확정 시 발급하고, 본인 마이페이지에서만 조회할 수 있게 한다.

**Architecture:** `TournamentParticipation`에 평문 `playerOtp` 컬럼을 두고 `@@unique([tournamentId, playerOtp])`로 대회 안 유일성을 보장한다. 평문 노출은 `PrismaService`의 클라이언트 수준 `omit`으로 기본 감춤이 되게 하고, 읽는 단 한 곳만 `omit: false`를 준다. 발급은 참가비 차감과 같은 트랜잭션 안이다.

**Tech Stack:** NestJS, Prisma(드라이버 어댑터 + `omit`), PostgreSQL, `node:crypto`, jest.

## Global Constraints

- 설계 문서는 [`docs/superpowers/specs/2026-07-28-player-otp-design.md`](../specs/2026-07-28-player-otp-design.md)다. 이 계획과 어긋나면 스펙이 정본이다.
- **새 검사는 실패하는 테스트를 먼저 만들어 확인한다.** 새 테스트가 처음부터 통과하면 의심한다 — 제품 코드를 일부러 되돌려 빨간불을 본 뒤 복원한다.
- OTP 길이는 **8**이다. 생성은 `randomInt(0, 10 ** 8)` + `padStart(8, '0')`. `Math.random()`을 쓰지 않는다 — 예측 가능하다. `padStart`가 없으면 앞자리 0이 사라져 텍스트 공간이 명목값에 못 미친다.
- **평문이다.** 해시하지 않는다. 근거는 스펙의 "평문으로 저장한다"에 있다.
- **시도 제한을 만들지 않는다.** 대회 단위 잠금은 이미 알려진 DoS 원시함수다(`backlog.md` B1 이월).
- 커밋 메시지·주석·문서는 한국어. 타입 접두사(`feat:`, `fix:`, `test:`, `docs:`)는 그대로.
- 명령은 리포 루트에서. 통합은 `npm run test:int -w backend`, 반복 실행은 `KEEP_TEST_CONTAINERS=1`.
- 통합 테스트에서 Prisma는 `closeTestPrisma()`로 닫는다. `$disconnect()`는 pg Pool을 닫지 않아 jest가 종료되지 않는다.

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| `backend/src/payment/player-otp.ts` | **신규.** 생성 함수 하나. `src/dealer/dealer-otp.ts`와 같은 자리 |
| `backend/prisma/schema.prisma` | `TournamentParticipation.playerOtp` + 유니크 |
| `backend/prisma/migrations/*/migration.sql` | 컬럼 추가 · 기존 행 백필 · NOT NULL · 유니크 인덱스 |
| `backend/src/prisma/prisma.service.ts` | `super()`에 클라이언트 수준 `omit` |
| `backend/src/payment/payment.service.ts` | 참가 확정 트랜잭션에서 발급, P2002 재시도 |
| `backend/src/user/user.service.ts` | 본인 참여 목록 조회 |
| `backend/src/user/user.controller.ts` | `GET user/me/participations` |

경로 접두사는 기존 `@Controller('user')`를 따른다. 스펙이 `/users/me/...`로 적었지만 이 리포의 컨트롤러는 `user`다 — **스펙이 아니라 코드를 따른다.**

---

### Task 1: OTP 생성기

**Files:**
- Create: `backend/src/payment/player-otp.ts`
- Test: `backend/src/payment/player-otp.spec.ts`

**Interfaces:**
- Produces: `PLAYER_OTP_LENGTH = 8`, `generatePlayerOtp(): string`

- [ ] **Step 1: 실패하는 단위 테스트를 쓴다**

```ts
import { generatePlayerOtp, PLAYER_OTP_LENGTH } from './player-otp';

describe('generatePlayerOtp', () => {
  it('항상 8자다', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePlayerOtp()).toHaveLength(PLAYER_OTP_LENGTH);
    }
  });

  it('숫자만 담는다', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePlayerOtp()).toMatch(/^\d{8}$/);
    }
  });

  // padStart가 없으면 randomInt가 뽑은 작은 수가 짧은 문자열이 되어
  // "8자리"라는 말이 거짓이 된다. 약 10%가 7자 이하로 나온다.
  it('앞자리 0을 지운 값을 만들지 않는다', () => {
    const spy = jest.spyOn(require('node:crypto'), 'randomInt').mockReturnValue(617 as never);
    expect(generatePlayerOtp()).toBe('00000617');
    spy.mockRestore();
  });

  it('매번 같은 값을 주지 않는다', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePlayerOtp()));
    expect(seen.size).toBeGreaterThan(400);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm run test -w backend -- player-otp`
Expected: FAIL — `Cannot find module './player-otp'`

- [ ] **Step 3: 구현한다**

`backend/src/payment/player-otp.ts`:

```ts
import { randomInt } from 'node:crypto';

export const PLAYER_OTP_LENGTH = 8;

/**
 * 참가 OTP를 만든다. 참가자마다, 대회마다 다르다.
 *
 * **딜러 OTP(`src/dealer/dealer-otp.ts`)와 달리 해시하지 않는다.** 마이페이지에서
 * 언제든 다시 볼 수 있어야 하는 값이고, 권한이 자기 좌석 하나뿐이다. 근거는
 * `docs/superpowers/specs/2026-07-28-player-otp-design.md`에 있다.
 *
 * 딜러 OTP보다 두 자 길다. **시도 제한을 걸지 않기로 했기 때문**이다 — 대회
 * 단위 잠금은 그대로 DoS 원시함수라 대회 진행 자체를 멈춘다. 참가자 200명이면
 * 유효한 값이 200개이므로, 6자리는 적중 확률이 1/5,000이고 8자리는 1/500,000이다.
 *
 * `Math.random()`을 쓰지 않는 이유: 암호학적 난수가 아니라 출력 몇 개로 내부
 * 상태를 복원해 다음 값을 계산할 수 있다.
 *
 * `padStart`가 필요한 이유: `randomInt`가 주는 것은 숫자라 617이 "617"이 된다.
 * 그대로 두면 약 10%가 7자 이하로 나와 텍스트 공간이 명목값에 못 미친다 —
 * 위협 모델 관찰 3이 딜러 OTP에서 지적한 그 문제다.
 */
export function generatePlayerOtp(): string {
  return String(randomInt(0, 10 ** PLAYER_OTP_LENGTH)).padStart(PLAYER_OTP_LENGTH, '0');
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm run test -w backend -- player-otp`
Expected: PASS

- [ ] **Step 5: `padStart` 테스트가 진짜인지 확인한다**

`padStart(...)` 호출을 지우고 다시 돌린다.

Run: `npm run test -w backend -- player-otp`
Expected: FAIL — `Expected: "00000617" / Received: "617"`. 확인 후 복원한다.

- [ ] **Step 6: 커밋**

```bash
git add backend/src/payment/player-otp.ts backend/src/payment/player-otp.spec.ts
git commit -m "feat: 참가 OTP 생성기를 추가한다"
```

---

### Task 2: 스키마와 클라이언트 수준 omit

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/<timestamp>_add_player_otp/migration.sql`
- Modify: `backend/src/prisma/prisma.service.ts`

**Interfaces:**
- Produces: `TournamentParticipation.playerOtp: string`, 기본 조회에서 제외됨

- [ ] **Step 1: 스키마를 고친다**

`TournamentParticipation`에 추가한다:

```prisma
  /// 참가 OTP. 평문이다 — 마이페이지에서 다시 볼 수 있어야 하고 권한이
  /// 좌석 하나뿐이다. 노출은 PrismaService의 클라이언트 수준 omit이 막는다.
  playerOtp String

  @@unique([tournamentId, playerOtp])
```

- [ ] **Step 2: 마이그레이션을 만들고 손으로 고친다**

Run: `npx prisma migrate dev --name add_player_otp --create-only -w backend`

Prisma가 만든 SQL은 기존 행이 있으면 실패한다(NOT NULL 컬럼에 기본값이 없다). **파일을 아래로 바꾼다.**

```sql
-- 1) 먼저 nullable로 붙인다
ALTER TABLE "TournamentParticipation" ADD COLUMN "playerOtp" TEXT;

-- 2) 기존 행을 대회 안에서 유일한 값으로 채운다.
--    난수가 아니라 순번이다 — 이미 있는 행은 개발·테스트 데이터뿐이고,
--    난수로 채우면 충돌 재시도를 SQL로 구현해야 한다.
UPDATE "TournamentParticipation" p
SET "playerOtp" = lpad(s.rn::text, 8, '0')
FROM (
  SELECT id, row_number() OVER (PARTITION BY "tournamentId" ORDER BY "createdAt") AS rn
  FROM "TournamentParticipation"
) s
WHERE p.id = s.id;

-- 3) 이제 NOT NULL로 조인다
ALTER TABLE "TournamentParticipation" ALTER COLUMN "playerOtp" SET NOT NULL;

-- 4) 대회 안 유일성. 입장이 (대회, OTP)로 사람을 찾으므로 겹치면 조회가
--    성립하지 않는다. 재시도 코드가 아니라 제약이 최종 방어다.
CREATE UNIQUE INDEX "TournamentParticipation_tournamentId_playerOtp_key"
  ON "TournamentParticipation"("tournamentId", "playerOtp");
```

- [ ] **Step 3: 적용하고 클라이언트를 다시 만든다**

Run: `npx prisma migrate dev -w backend && npx prisma generate -w backend`
Expected: 적용 성공

- [ ] **Step 4: 클라이언트 수준 omit을 건다**

`backend/src/prisma/prisma.service.ts`의 `super({ adapter })`를 바꾼다:

```ts
    super({
      adapter,
      // 참가 OTP는 평문이고 참가자 전원의 값이 한 테이블에 있다. 상점 콘솔의
      // 참가자 목록 한 번이면 대회 전체가 샌다.
      //
      // 호출부마다 `omit`을 쓰는 규율로는 막지 못한다 — T23이 딜러 OTP 해시에
      // 대해 정확히 그 방식이었고 두 곳을 빠뜨려 실제로 누출됐다. 기본을
      // 감춤으로 두면 빠뜨림이 조용한 누출이 아니라 **컴파일 에러**가 된다.
      //
      // 읽는 곳은 마이페이지 조회 단 하나이고 거기서만 `omit: { playerOtp: false }`를 준다.
      omit: { tournamentParticipation: { playerOtp: true } },
    });
```

- [ ] **Step 5: 타입 체크로 확인한다**

Run: `npm run typecheck`
Expected: 에러 0

- [ ] **Step 6: 기존 테스트가 깨지지 않았는지 본다**

Run: `npm run test && npm run test:int`
Expected: 전부 통과. `payment.service.int-spec.ts`가 `tournamentParticipation.create`를 부르는 자리는 아직 `playerOtp`를 주지 않아 **여기서 빨개진다.** Task 3이 고칠 자리이므로, 빨간 목록을 적어 두고 다음 태스크로 간다.

- [ ] **Step 7: 커밋**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations backend/src/prisma/prisma.service.ts
git commit -m "feat: 참가 OTP 컬럼을 두고 기본 조회에서 감춘다"
```

---

### Task 3: 참가 확정 시 발급

**Files:**
- Modify: `backend/src/payment/payment.service.ts`
- Test: `backend/src/payment/payment.service.int-spec.ts`

**Interfaces:**
- Consumes: `generatePlayerOtp()` (Task 1)
- Produces: `joinSessionWithSeat`가 `TournamentParticipation`을 만들 때 `playerOtp`를 채운다

- [ ] **Step 1: 실패하는 통합 테스트를 쓴다**

`payment.service.int-spec.ts`에 붙인다. 이 파일의 기존 setup을 그대로 쓴다.

```ts
describe('참가 OTP 발급', () => {
  it('참가하면 8자리 OTP가 발급된다', async () => {
    await service.joinSessionWithSeat(
      { tournamentId, tableId, seatIndex: 0 }, 'u1',
    );
    const [row] = await prisma.$queryRaw<{ playerOtp: string }[]>`
      SELECT "playerOtp" FROM "TournamentParticipation" WHERE "userId" = 'u1'
    `;
    expect(row.playerOtp).toMatch(/^\d{8}$/);
  });

  it('참가자마다 다른 값이다', async () => {
    await service.joinSessionWithSeat({ tournamentId, tableId, seatIndex: 0 }, 'u1');
    await service.joinSessionWithSeat({ tournamentId, tableId, seatIndex: 1 }, 'u2');
    const rows = await prisma.$queryRaw<{ playerOtp: string }[]>`
      SELECT "playerOtp" FROM "TournamentParticipation" WHERE "tournamentId" = ${tournamentId}
    `;
    expect(new Set(rows.map(r => r.playerOtp)).size).toBe(2);
  });

  it('충돌하면 다시 뽑는다', async () => {
    // 첫 두 번은 같은 값을 주고, 세 번째부터 다른 값을 준다
    const otp = jest.spyOn(playerOtp, 'generatePlayerOtp');
    otp.mockReturnValueOnce('00000001').mockReturnValueOnce('00000001');

    await service.joinSessionWithSeat({ tournamentId, tableId, seatIndex: 0 }, 'u1');
    await expect(
      service.joinSessionWithSeat({ tournamentId, tableId, seatIndex: 1 }, 'u2'),
    ).resolves.toBeDefined();

    const rows = await prisma.$queryRaw<{ playerOtp: string }[]>`
      SELECT "playerOtp" FROM "TournamentParticipation" WHERE "tournamentId" = ${tournamentId}
    `;
    expect(new Set(rows.map(r => r.playerOtp)).size).toBe(2);
    otp.mockRestore();
  });

  it('같은 사람이 두 번 참가하면 재시도하지 않고 그대로 실패한다', async () => {
    await service.joinSessionWithSeat({ tournamentId, tableId, seatIndex: 0 }, 'u1');
    // 좌석을 바꿔도 (tournamentId, userId) 유니크에 걸린다.
    // 이건 OTP 충돌이 아니므로 재시도 대상이 아니다.
    await expect(
      service.joinSessionWithSeat({ tournamentId, tableId, seatIndex: 2 }, 'u1'),
    ).rejects.toThrow();
  });

  it('리바인은 OTP를 다시 발급하지 않는다', async () => {
    await service.joinSessionWithSeat({ tournamentId, tableId, seatIndex: 0 }, 'u1');
    const before = await prisma.$queryRaw<{ playerOtp: string }[]>`
      SELECT "playerOtp" FROM "TournamentParticipation" WHERE "userId" = 'u1'
    `;
    await playsync.rebuy(tableId, 'u1');   // 기존 리바인 경로
    const after = await prisma.$queryRaw<{ playerOtp: string }[]>`
      SELECT "playerOtp" FROM "TournamentParticipation" WHERE "userId" = 'u1'
    `;
    expect(after[0].playerOtp).toBe(before[0].playerOtp);
  });
});
```

`$queryRaw`로 읽는 이유: Task 2의 클라이언트 수준 `omit` 때문에 Prisma 조회로는 이 필드가 나오지 않는다. **그게 이 설계가 의도한 바다.**

- [ ] **Step 2: 실패를 확인한다**

Run: `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- payment.service`
Expected: FAIL — `playerOtp` 컬럼이 NOT NULL인데 `create`가 주지 않아 Prisma가 거부한다

- [ ] **Step 3: 발급을 구현한다**

`payment.service.ts`에 import를 추가한다:

```ts
import * as playerOtp from './player-otp';
```

`tournamentParticipation.create`를 바꾼다:

```ts
        await tx.tournamentParticipation.create({
          data: {
            userId: userId,
            tournamentId: dto.tournamentId,
            status: isOngoing ? 'PLAYING' : 'WAITING',
            playerOtp: playerOtp.generatePlayerOtp(),
          }
        });
```

그리고 **트랜잭션 전체**를 재시도로 감싼다. 참가비 차감과 좌석 생성이 같은
트랜잭션 안이라 OTP만 다시 뽑을 수 없다.

`const result = await this.prismaService.$transaction(...)` 를 아래로 바꾼다:

```ts
      // OTP가 대회 안에서 겹치면 다시 뽑는다. 8자리라 드물지만 드문 것은
      // 안 나는 것이 아니다. 트랜잭션 전체를 다시 도는 이유는 참가비 차감과
      // 좌석 생성이 같은 트랜잭션 안이라 OTP만 따로 바꿀 수 없기 때문이다.
      let result: { success: boolean } | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          result = await this.prismaService.$transaction(async (tx) => {
            /* 기존 본문 그대로 */
          });
          break;
        } catch (e) {
          // 같은 사람이 두 번 참가한 경우(tournamentId, userId)는 재시도해도
          // 같은 결과다. OTP 충돌만 다시 뽑는다.
          const target = (e as { code?: string; meta?: { target?: string[] } });
          const isOtpCollision =
            target.code === 'P2002' &&
            Array.isArray(target.meta?.target) &&
            target.meta!.target.includes('playerOtp');
          if (!isOtpCollision) throw e;
        }
      }
      if (!result) {
        throw new ConflictException('참가 OTP를 만들지 못했습니다. 다시 시도해 주세요.');
      }
```

- [ ] **Step 4: 통과를 확인한다**

Run: `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- payment.service`
Expected: PASS

- [ ] **Step 5: 재시도가 진짜인지 확인한다**

`if (!isOtpCollision) throw e;`를 `throw e;`로 바꿔 재시도를 없앤다.

Run: `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- payment.service`
Expected: FAIL — "충돌하면 다시 뽑는다"가 P2002로 죽는다. 확인 후 복원한다.

- [ ] **Step 6: 커밋**

```bash
git add backend/src/payment/payment.service.ts backend/src/payment/payment.service.int-spec.ts
git commit -m "feat: 참가 확정 시 참가 OTP를 발급한다"
```

---

### Task 4: 마이페이지 조회

**Files:**
- Modify: `backend/src/user/user.service.ts`
- Modify: `backend/src/user/user.controller.ts`
- Test: `backend/src/user/user.service.int-spec.ts` (신규)

**Interfaces:**
- Consumes: `PrismaService`(Task 2의 omit)
- Produces: `UserService.getMyParticipations(userId: string)`, `GET user/me/participations`

- [ ] **Step 1: 실패하는 통합 테스트를 쓴다**

`backend/src/user/user.service.int-spec.ts`:

```ts
describe('getMyParticipations', () => {
  it('본인 참여만 준다', async () => {
    const mine = await service.getMyParticipations('u1');
    expect(mine.map(p => p.tournamentId)).toEqual([tournamentId]);
  });

  it('진행 중·대기 중 대회는 OTP를 담는다', async () => {
    const [row] = await service.getMyParticipations('u1');
    expect(row.playerOtp).toMatch(/^\d{8}$/);
  });

  it('끝난 대회는 OTP를 빼고 준다', async () => {
    await prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: 'FINISHED' },
    });
    const [row] = await service.getMyParticipations('u1');
    expect(row.playerOtp).toBeNull();
  });

  // omit 회귀. 이 검사가 없으면 새 조회 경로가 하나 늘 때마다
  // 참가자 전원의 평문 OTP가 조용히 새는 길이 생긴다.
  it('다른 조회 경로에는 playerOtp가 실리지 않는다', async () => {
    const rows = await prisma.tournamentParticipation.findMany({
      where: { tournamentId },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty('playerOtp');
    }
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- user.service`
Expected: FAIL — `service.getMyParticipations is not a function`

- [ ] **Step 3: 서비스를 구현한다**

`user.service.ts`:

```ts
  /**
   * 내가 참여한 대회 목록. 마이페이지가 쓴다.
   *
   * **참가 OTP를 읽는 유일한 곳이다.** `PrismaService`가 이 필드를 기본으로
   * 감추므로 여기서만 `omit: { playerOtp: false }`를 준다. 다른 경로가
   * 이 값을 실으려면 같은 한 줄을 명시해야 하고, 그 순간 리뷰에 걸린다.
   *
   * 끝난 대회의 OTP는 쓸 데가 없다. 목록에 남겨 두면 유출 표면만 넓어지므로
   * 응답에서 뺀다.
   */
  async getMyParticipations(userId: string) {
    const rows = await this.prisma.tournamentParticipation.findMany({
      where: { userId },
      omit: { playerOtp: false },
      include: {
        tournament: {
          select: { id: true, name: true, status: true, entryFee: true, startAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map(row => ({
      ...row,
      playerOtp:
        row.tournament.status === 'PENDING' || row.tournament.status === 'ONGOING'
          ? row.playerOtp
          : null,
    }));
  }
```

`startAt` 필드명은 `schema.prisma`의 `Tournament`를 보고 실제 이름으로 맞춘다.

- [ ] **Step 4: 컨트롤러에 붙인다**

`user.controller.ts`:

```ts
  /**
   * 내 참여 대회 목록. 경로에 userId를 받지 않는다 — 받는 순간 남의 것을
   * 조회할 수 있는지 검사하는 코드가 필요해지고, 그 검사가 빠질 자리가 생긴다.
   */
  @UseGuards(JwtAuthGuard)
  @Get('me/participations')
  async getMyParticipations(@Req() req) {
    return await this.userService.getMyParticipations(req.user.userId);
  }
```

import를 추가한다: `UseGuards`(`@nestjs/common`), `JwtAuthGuard`(`src/auth/guard/jwt-auth.guard`).

- [ ] **Step 5: 통과를 확인한다**

Run: `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- user.service`
Expected: PASS

- [ ] **Step 6: omit 회귀 테스트가 진짜인지 확인한다**

`prisma.service.ts`의 `omit: { tournamentParticipation: { playerOtp: true } }` 줄을 지운다.

Run: `KEEP_TEST_CONTAINERS=1 npm run test:int -w backend -- user.service`
Expected: FAIL — "다른 조회 경로에는 playerOtp가 실리지 않는다"가 깨진다. 확인 후 복원한다.

- [ ] **Step 7: 커밋**

```bash
git add backend/src/user backend/src/user/user.service.int-spec.ts
git commit -m "feat: 마이페이지가 본인 참가 OTP만 조회한다"
```

---

### Task 5: 문서와 베이스라인

**Files:**
- Modify: `docs/tickets-next.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: 전체 검증을 돌리고 숫자를 받는다**

Run: `npm run typecheck && npm run test && npm run test:int`
Expected: 타입 에러 0, 전부 통과. 각 스위트의 테스트 수를 적어 둔다.

- [ ] **Step 2: `docs/tickets-next.md`에 T27을 쓴다**

파일 끝 주석의 형식을 따른다. 반드시 담을 것:

- **좌석 재배치 설계를 폐기하고 여기로 온 경위.** 서버가 좌석을 옮겨도 새 자리에 앉을 사람을 인증할 방법이 없었다는 것
- **딜러 OTP(T23)와 네 칸이 전부 반대인 이유** — 참가자별 / 평문 / 8자리 / 시도 제한 없음
- **8자리를 고른 계산** — 참가자 200명 기준 1/5,000 → 1/500,000
- **시도 제한을 안 거는 근거와 잔여 위험** — 대회 단위 잠금이 DoS 원시함수라는 것, 같은 망 단말의 조용한 브루트포스에는 현장 감지 루프가 닿지 않는다는 것
- **클라이언트 수준 `omit`으로 옮긴 이유**와 T23이 규율 방식으로 두 번 실패했다는 사실
- **마이그레이션을 손으로 고친 이유** — NOT NULL 컬럼을 기존 행이 있는 테이블에 붙이려면 백필이 필요하고, 백필을 난수로 하면 충돌 재시도를 SQL로 구현해야 한다
- **RED 확인 결과** — 처음부터 통과한 테스트가 있었다면 그것과 원인

- [ ] **Step 3: `CLAUDE.md`의 베이스라인을 갱신한다**

"현재 기준선 (T25 완료 시점)"을 "(T27 완료 시점)"으로 바꾸고 Step 1의 숫자를 넣는다.

- [ ] **Step 4: 커밋**

```bash
git add docs/tickets-next.md CLAUDE.md
git commit -m "docs: T27로 참가 OTP를 넣은 기록을 남긴다"
```

---

## 자체 점검 결과

**스펙 대조** — 결정 여덟 개(참가자별 / 평문 / 8자리 / 대회 안 유일 / 시도 제한 없음 / 클라이언트 omit / 발급 시점 / 조회 제한)가 전부 태스크에 있다. 테스트 표의 네 줄도 Task 1·3·4에 나뉘어 들어갔다.

**스펙과 어긋나 계획이 고친 것 하나** — 조회 경로를 `/users/me/participations`가 아니라 `user/me/participations`로 한다. 이 리포의 컨트롤러 접두사가 `@Controller('user')`다. 스펙 문구는 T27 구현 시 함께 고친다.

**작업 중 손대지 않고 넘기는 것 하나** — `user.controller.ts`의 기존 `@Get('/add')`에 `JwtAuthGuard`가 없다. `req.user.userId`를 읽으므로 지금도 터진다. 이 티켓 범위 밖이라 고치지 않고 `tickets-next.md`의 "작업 중 추가로 나온 것"에 적는다.
