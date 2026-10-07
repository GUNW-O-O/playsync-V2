# T110 좌석·딜러 토큰 폐기와 소켓 종료 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 좌석·딜러 토큰에 세대를 달아 입장·해제·내보내기가 옛 토큰을 죽이고 열린 소켓을 닫게 해, 맞힌 OTP 하나로 좌석이나 딜러 권한을 계속 쥐는 길을 끊는다.

**Architecture:** `TournamentParticipation.seatTokenVersion`을 입장 성공과 좌석 해제가 올리고, 좌석 토큰이 그 값을 싣는다. `/ws/ticket`과 `handleConnection`이 세대를 대조한다. 세대를 올리는 쪽이 이벤트를 쏘면 게이트웨이가 맞는 소켓을 코드 4001로 닫고, 단말은 4001이면 다시 붙지 않고 덮개를 그린다. 딜러는 기존 `tokenVersion`에 같은 「접속 시 재대조 + 내보내기 시 소켓 닫기」를 얹는다.

**Tech Stack:** NestJS 11 · `@nestjs/event-emitter` · `ws` · Prisma(PostgreSQL) · Next.js 16 · vitest · jest

**Spec:** [`docs/superpowers/specs/2026-10-07-t110-session-revoke-design.md`](../specs/2026-10-07-t110-session-revoke-design.md)

## Global Constraints

- 하위 에이전트는 `docs/`와 `CLAUDE.md`를 **손대지 않는다.** 주석은 코드라 함께 간다.
- 코드 주석은 한국어. 코드를 가리킬 때 **줄 번호가 아니라 이름**으로.
- 닫기 코드 `SESSION_REVOKED_CLOSE_CODE = 4001`. 이유: 좌석 `'다른 기기에서 이 좌석에 다시 들어왔습니다.'`, 딜러 `'상점이 딜러 연결을 해제했습니다.'` — 셋 다 `@playsync/contract`에 두고 양쪽이 import한다.
- 좌석 티켓 거절 문구: `'만료된 좌석입니다. OTP를 다시 입력해 주세요.'` (403).
- 이벤트 이름: `'SEAT_TOKENS_REVOKED'` `{ tournamentId: string; userIds: string[] }`, `'DEALER_SESSION_REVOKED'` `{ tournamentId: string }`.
- 세대를 올리는 시점: `enterSeat`은 `claimSeat` **성공 뒤**, `releaseSeats`는 `RELEASED`로 바꾸는 **같은 `updateMany`**. 이벤트는 세대를 올린 **뒤**에 쏜다.
- `ver`가 없는 좌석 토큰은 무효다.
- 새 테스트가 처음부터 통과하면 의심한다 — 제품 코드를 되돌려 빨간불을 본다.
- 루트에서 `npm run typecheck`, `npm run test`, `npm run test:int`(Docker로 컨테이너 자동 기동).
- PR은 만들지 않는다. 커밋만.

## Review Focus

1. **틀린 좌석으로 시도한 입장이 남의 세션을 끊는다** — `claimSeat`가 실패하면 세대가 오르면 안 된다. Task 1의 「409로 끝난 입장은 세대를 안 올린다」.
2. **해제와 접속 사이 30초 티켓 창** — 발급 때 맞던 세대가 접속 때 틀리면 `handleConnection`이 막아야 한다. Task 1·2의 「낡은 티켓은 접속에서 거절」.
3. **닫기가 남을 끊는다** — 같은 대회의 다른 사람, 다른 대회의 같은 사람, 같은 사람의 폰(USER 역할) 소켓은 그대로여야 한다. Task 1의 「맞는 소켓만 닫는다」.
4. **4001을 받은 단말이 계속 재접속한다** — 티켓이 403이라 8회를 태우고 「새로고침」에 멈춘다. Task 3의 「4001이면 재시도하지 않는다」.
5. **`rotateOtp`가 해제하지 않은 사람의 OTP까지 바꾼다** — Task 1의 「해제한 사람의 OTP만 바뀐다」.

---

### Task 1: 좌석 토큰 세대 · 대조 · 소켓 닫기 (백엔드)

**Files:**
- Create: `packages/contract/src/session-revoked.ts`; Modify: `packages/contract/src/index.ts`
- Modify: `backend/prisma/schema.prisma` (`model TournamentParticipation`)
- Create: `backend/prisma/migrations/20261007130000_participation_seat_token_version/migration.sql`
- Modify: `backend/src/auth/seat-role.ts` (`SeatTokenPayload`에 `ver: number`)
- Modify: `backend/src/auth/strategies/jwt.strategy.ts` (좌석 분기가 `ver`를 내보낸다)
- Create: `backend/src/entry/seat-token.ts` (`assertSeatTokenCurrent`)
- Modify: `backend/src/entry/entry.service.ts` (`EntryService.enterSeat`)
- Modify: `backend/src/store/session/session.service.ts` (`SessionService.releaseSeats`)
- Modify: `backend/src/store/session/session.controller.ts` (`releaseSeats`가 `dto.rotateOtp`를 넘긴다)
- Modify: `backend/shared/dto/seat-release.dto.ts` (`ReleaseSeatsDto.rotateOtp`)
- Modify: `backend/src/ws/ws-ticket.service.ts` (`WsIdentity`에 `seatTokenVersion?: number`, `tokenVersion?: number`)
- Modify: `backend/src/ws/ws-ticket.controller.ts` (`WsTicketController.issue`의 좌석 분기)
- Modify: `backend/src/ws/ws.gateway.ts` (`handleConnection` 좌석 재대조, `@OnEvent('SEAT_TOKENS_REVOKED')`, 닫기 도우미)
- Modify: `backend/src/auth/token-ttl.ts` (「폐기가 이미 구조로 돼 있다」 절을 사실대로)
- Tests: `entry/entry.service.int-spec.ts`, `store/session/session.service.int-spec.ts`, `ws/ws.gateway.int-spec.ts`, `ws/ws-ticket.controller.spec.ts`(또는 같은 자리의 int-spec), `auth/strategies/jwt.strategy.spec.ts`

**Interfaces:**
- Produces (contract): `SESSION_REVOKED_CLOSE_CODE`, `SEAT_REVOKED_REASON`, `DEALER_REVOKED_REASON`
- Produces (backend): `assertSeatTokenCurrent(prisma: PrismaService, input: { userId: string; tournamentId?: string; ver?: number }): Promise<void>` — 어긋나면 `ForbiddenException('만료된 좌석입니다. OTP를 다시 입력해 주세요.')`
- Produces (gateway): `private closeWhere(match: (socket: any) => boolean, reason: string): void` — Task 2가 쓴다
- Produces (HTTP): `PATCH`/`POST` 좌석 해제 본문에 `rotateOtp?: boolean` (라우트는 기존 그대로)

- [ ] **Step 1: contract**

`packages/contract/src/session-revoked.ts`:

```ts
/**
 * 세대가 올라 옛 토큰이 죽은 소켓을 서버가 닫을 때의 코드와 이유(T110).
 *
 * 단말은 이 코드면 다시 붙지 않는다 — 붙어 봐야 티켓이 403이다. 1000(정상 종료)과
 * 가르는 이유는, 1000은 「대회가 끝났다」라 덮개가 다르기 때문이다.
 * WS 닫기 이유는 123바이트까지라 한글 40자 안쪽으로 둔다.
 */
export const SESSION_REVOKED_CLOSE_CODE = 4001 as const;
export const SEAT_REVOKED_REASON = "다른 기기에서 이 좌석에 다시 들어왔습니다." as const;
export const DEALER_REVOKED_REASON = "상점이 딜러 연결을 해제했습니다." as const;
```

`index.ts`에 `export * from "./session-revoked";`.

- [ ] **Step 2: 스키마와 마이그레이션**

`model TournamentParticipation`에:

```prisma
  /// 좌석 토큰의 세대(T110). 입장이 성공할 때와 좌석을 해제할 때 오른다.
  seatTokenVersion Int @default(0)
```

`migration.sql`:

```sql
-- AlterTable
ALTER TABLE "TournamentParticipation" ADD COLUMN "seatTokenVersion" INTEGER NOT NULL DEFAULT 0;
```

Run: `cd backend && npx prisma generate`

- [ ] **Step 3: 실패하는 통합 테스트 — 입장이 세대를 올린다**

`entry/entry.service.int-spec.ts`에 (파일의 `participate` · `seedTournament` · `service`를 그대로 쓴다. 좌석 토큰 해석은 파일이 쓰는 `JwtService`(`entry-spec-secret`)로 `decode`):

```ts
  describe('좌석 토큰 세대(T110)', () => {
    it('입장마다 세대가 오르고 토큰의 ver가 그 값이다', async () => {
      // 앞선 테스트들과 같은 방식으로 대회 · 테이블 · 참가를 세운다.
      const first = await service.enterSeat(TOURNAMENT, { otp, tableId: TABLE, seatIndex: 0 });
      const again = await service.enterSeat(TOURNAMENT, { otp, tableId: TABLE, seatIndex: 0 });
      const v1 = jwt.decode(first.accessToken).ver;
      const v2 = jwt.decode(again.accessToken).ver;
      const row = await prisma.tournamentParticipation.findFirstOrThrow({ where: { tournamentId: TOURNAMENT } });
      expect(`${v1}/${v2}/${row.seatTokenVersion}`).toBe('1/2/2');
    });

    it('409로 끝난 입장은 세대를 안 올린다 — 틀린 좌석 시도로 남을 끊지 못한다', async () => {
      await service.enterSeat(TOURNAMENT, { otp, tableId: TABLE, seatIndex: 0 });
      await expect(service.enterSeat(TOURNAMENT, { otp, tableId: TABLE, seatIndex: 1 })).rejects.toThrow(ConflictException);
      const row = await prisma.tournamentParticipation.findFirstOrThrow({ where: { tournamentId: TOURNAMENT } });
      expect(`세대 ${row.seatTokenVersion}`).toBe('세대 1');
    });

    it('세대를 올린 뒤 SEAT_TOKENS_REVOKED를 쏜다', async () => {
      const seen: unknown[] = [];
      emitter.on('SEAT_TOKENS_REVOKED', (p) => seen.push(p));
      await service.enterSeat(TOURNAMENT, { otp, tableId: TABLE, seatIndex: 0 });
      expect(seen).toEqual([{ tournamentId: TOURNAMENT, userIds: [userId] }]);
    });
  });
```

(`jwt`·`emitter`는 `beforeAll`에서 `service`를 만들 때 넘긴 `JwtService`·`EventEmitter2` 인스턴스를 변수로 꺼내 쓴다. 대회 상태 · 테이블 · 스냅샷 준비는 같은 파일의 성공 입장 테스트를 그대로 따른다.)

Run: `npm run test:int -w backend -- src/entry/entry.service.int-spec.ts -t "세대"`
Expected: FAIL — `ver`가 undefined, 컬럼은 0

- [ ] **Step 4: 구현 — `enterSeat`**

`claimSeat(...)` 호출 바로 뒤, 반환 전에:

```ts
    // T110. **마지막 입장이 이긴다.** 세대를 올려 옛 좌석 토큰을 죽이고 그
    // 기기의 소켓을 닫는다. 재부팅·교체라면 옛 기기는 이미 없고, 탈취라면
    // 피해자 태블릿이 끊겨 현장에서 드러난다. `claimSeat` 뒤라야 한다 — 앞이면
    // OTP를 아는 사람이 틀린 좌석으로 시도하는 것만으로 남을 끊는다.
    const { seatTokenVersion } = await this.prisma.tournamentParticipation.update({
      where: { id: participation.id },
      data: { seatTokenVersion: { increment: 1 } },
      select: { seatTokenVersion: true },
    });
    this.eventEmitter.emit('SEAT_TOKENS_REVOKED', { tournamentId, userIds: [participation.userId] });
```

서명 페이로드에 `ver: seatTokenVersion`을 더한다. `SeatTokenPayload`(`auth/seat-role.ts`)에 `ver: number`. `JwtStrategy.validate`의 좌석 분기 반환에 `ver: payload.ver`.

Run: Step 3 명령 → PASS. `src/auth/token-ttl.spec.ts`처럼 `enterSeat`을 목 Prisma로 부르는 단위 스펙이 깨지면 목에 `tournamentParticipation.update`를 더한다.

- [ ] **Step 5: 실패하는 통합 테스트 — 해제가 세대를 올리고, `rotateOtp`는 해제한 사람 OTP만 바꾼다**

`store/session/session.service.int-spec.ts`의 기존 `releaseSeats` 테스트 준비를 따라 둘을 앉힌 뒤 한 사람만 해제한다:

```ts
  it('해제가 세대를 올리고 SEAT_TOKENS_REVOKED를 쏜다', async () => {
    // a, b 착석 → a만 해제
    const before = await participationOf('a');
    await service.releaseSeats(TOURNAMENT, TABLE, [{ seatIndex: 0, userId: 'a' }], OWNER);
    const after = await participationOf('a');
    expect(after.seatTokenVersion - before.seatTokenVersion).toBe(1);
    expect(revokedEvents).toEqual([{ tournamentId: TOURNAMENT, userIds: ['a'] }]);
  });

  it('rotateOtp면 해제한 사람의 OTP만 바뀐다', async () => {
    const [a0, b0] = [await otpOf('a'), await otpOf('b')];
    await service.releaseSeats(TOURNAMENT, TABLE, [{ seatIndex: 0, userId: 'a' }], OWNER, true);
    const [a1, b1] = [await otpOf('a'), await otpOf('b')];
    expect(a1).not.toBe(a0);
    expect(a1).toMatch(/^\d{8}$/);
    expect(b1).toBe(b0);
  });

  it('rotateOtp가 없으면 OTP는 그대로다', async () => {
    const a0 = await otpOf('a');
    await service.releaseSeats(TOURNAMENT, TABLE, [{ seatIndex: 0, userId: 'a' }], OWNER);
    expect(await otpOf('a')).toBe(a0);
  });
```

(`otpOf`는 `prisma.tournamentParticipation.findFirstOrThrow({ where: { tournamentId, userId }, omit: { playerOtp: false } })`로 OTP를 읽는다 — 기본 감춤이라 명시해야 한다. `revokedEvents`는 `EventEmitter2`에 단 수신기.)

Run: `npm run test:int -w backend -- src/store/session/session.service.int-spec.ts -t "해제가 세대|rotateOtp"`
Expected: FAIL

- [ ] **Step 6: 구현 — `releaseSeats`**

- 시그니처 끝에 `rotateOtp = false`.
- `RELEASED`로 바꾸는 `updateMany`의 `data`를 `{ status: PlayerStatus.RELEASED, seatTokenVersion: { increment: 1 } }`로.
- 같은 트랜잭션 안, 그 `updateMany` 뒤에:

```ts
        // T110. 탈취를 의심해 해제할 때만 참가 OTP도 바꾼다. 쉬는 시간의 테이블
        // 합치기마다 바꾸면 옮기는 사람 전원이 폰을 다시 봐야 한다.
        // ponytail: 대회 안 유일 제약에 걸리면 트랜잭션째 409로 끝나고 상점이 다시
        // 누른다 — 10^8 공간에 참가자 수백이라 사실상 안 난다. 재시도가 필요해지면
        // `PaymentService`의 생성 재시도와 같은 고리를 둔다.
        if (rotateOtp) {
          for (const userId of userIds) {
            await tx.tournamentParticipation.update({
              where: { tournamentId_userId: { tournamentId, userId } },
              data: { playerOtp: generatePlayerOtp() },
            });
          }
        }
```

- 락을 놓고 브로드캐스트하는 자리(함수 끝)에서 `this.eventEmitter.emit('SEAT_TOKENS_REVOKED', { tournamentId, userIds: seats.map((s) => s.userId) });`.
- `ReleaseSeatsDto`에 `@IsOptional() @IsBoolean() rotateOtp?: boolean;`. `SessionController.releaseSeats`가 `dto.rotateOtp === true`를 넘긴다.
- import: `generatePlayerOtp` from `src/payment/player-otp`.

Run: Step 5 명령 → PASS.

- [ ] **Step 7: 실패하는 테스트 — 티켓과 접속이 세대를 대조한다**

`ws/ws.gateway.int-spec.ts`(가짜 소켓 · `tickets.issue` · `gateway.handleConnection` 방식을 그대로):

```ts
  describe('좌석 세대 재대조(T110)', () => {
    it('티켓의 세대가 참가 행과 같으면 붙는다', async () => {
      // 참가 행 seatTokenVersion = 3, 스냅샷에 착석
      const client = await connectSeat({ userId: 'u1', tournamentId: TOURNAMENT, seatTokenVersion: 3 });
      expect(client.close).not.toHaveBeenCalled();
    });

    it('티켓 발급 뒤 세대가 오르면 접속에서 거절한다', async () => {
      const client = await connectSeat({ userId: 'u1', tournamentId: TOURNAMENT, seatTokenVersion: 2 });
      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });

    it('세대가 없는 좌석 티켓은 거절한다', async () => {
      const client = await connectSeat({ userId: 'u1', tournamentId: TOURNAMENT });
      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });
  });

  describe('SEAT_TOKENS_REVOKED(T110)', () => {
    it('그 대회 · 그 사람 · 좌석 역할의 소켓만 4001로 닫는다', async () => {
      // 붙인다: (u1, 대회 A, 좌석) 테이블 방 · (u1, 대회 A, 좌석) 대회 방 ·
      //        (u2, 대회 A, 좌석) · (u1, 대회 B, 좌석) · (u1, 대회 A, USER 폰)
      gateway.handleSeatTokensRevoked({ tournamentId: 'A', userIds: ['u1'] });
      expect(u1TableA.close).toHaveBeenCalledWith(4001, '다른 기기에서 이 좌석에 다시 들어왔습니다.');
      expect(u1RoomA.close).toHaveBeenCalledWith(4001, '다른 기기에서 이 좌석에 다시 들어왔습니다.');
      for (const other of [u2A, u1B, u1PhoneA]) expect(other.close).not.toHaveBeenCalled();
    });
  });
```

(`connectSeat`는 이 describe 안의 도우미다: 참가 행을 세우고 `tickets.issue({ sub, role: SEAT_ROLE, tournamentId, seatTokenVersion })`로 티켓을 받아 `handleConnection`을 부른 가짜 소켓을 돌려준다. 1008은 `handleConnection`의 기존 거절 코드다 — 파일에서 다른 값이면 그 값을 쓴다.)

`ws-ticket.controller`의 스펙에: 좌석 토큰의 `ver`가 참가 행과 다르면 403 `만료된 좌석입니다. OTP를 다시 입력해 주세요.`, 같으면 티켓 identity에 `tournamentId`·`seatTokenVersion`이 실린다(기존 스펙이 목 방식이면 `assertSeatTokenCurrent`가 쓰는 Prisma를 목으로, 아니면 통합으로).

Run: `npm run test:int -w backend -- src/ws/ws.gateway.int-spec.ts -t "세대|SEAT_TOKENS"` 와 ticket 스펙
Expected: FAIL

- [ ] **Step 8: 구현 — 대조와 닫기**

`backend/src/entry/seat-token.ts`:

```ts
import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * 좌석 토큰의 세대가 지금 참가 행의 세대와 같은지(T110).
 *
 * `/ws/ticket` 발급과 `handleConnection` 두 자리가 같은 판정을 쓴다 — 두 벌이
 * 되면 한쪽만 고쳐지는 날 폐기된 좌석이 다른 쪽 문으로 들어온다.
 * `ver`가 없는 토큰(배포 전에 나간 것)은 무효다.
 */
export async function assertSeatTokenCurrent(
  prisma: PrismaService,
  input: { userId: string; tournamentId?: string; ver?: number },
): Promise<void> {
  if (!input.tournamentId || typeof input.ver !== 'number') throw stale();
  const row = await prisma.tournamentParticipation.findUnique({
    where: { tournamentId_userId: { tournamentId: input.tournamentId, userId: input.userId } },
    select: { seatTokenVersion: true },
  });
  if (row?.seatTokenVersion !== input.ver) throw stale();
}

function stale() {
  return new ForbiddenException('만료된 좌석입니다. OTP를 다시 입력해 주세요.');
}
```

`WsIdentity`에 `seatTokenVersion?: number; tokenVersion?: number;`.

`WsTicketController.issue`: 딜러 분기 뒤, 기본 분기 앞에:

```ts
    // T110. 좌석 토큰은 세대를 대조한다. 입장·해제가 세대를 올리면 옛 토큰은
    // 여기서 막히고, 이미 붙어 있던 소켓은 게이트웨이가 닫는다.
    if (req.user.role === SEAT_ROLE) {
      await assertSeatTokenCurrent(this.prisma, {
        userId: req.user.userId,
        tournamentId: req.user.tournamentId,
        ver: req.user.ver,
      });
      return {
        ticket: await this.tickets.issue({
          sub: req.user.userId,
          role: SEAT_ROLE,
          tournamentId: req.user.tournamentId,
          seatTokenVersion: req.user.ver,
        }),
      };
    }
```

(컨트롤러 생성자에 `PrismaService` 주입. 딜러 분기 주석의 「이미 붙어 있는 소켓을 끊는 것은 계획 B의 몫」은 Task 2가 고친다.)

`WsGateway.handleConnection`: `tickets.consume` 직후, 신원을 소켓에 싣기 전에:

```ts
      // T110. 티켓은 30초 산다. 그 사이 세대가 오르면 발급 때 맞던 것이 지금은
      // 틀리다 — 세대를 올리는 쪽이 소켓을 닫는 것은 「이미 붙은」 것뿐이라
      // 여기서 한 번 더 본다.
      if (payload.role === SEAT_ROLE) {
        await assertSeatTokenCurrent(this.prisma, {
          userId: payload.sub,
          tournamentId: payload.tournamentId,
          ver: payload.seatTokenVersion,
        });
      }
```

(거절은 기존 바깥 `catch`가 1008로 닫는다.)

닫기 도우미와 수신기:

```ts
  /**
   * 세대가 오른 신원의 열린 소켓을 닫는다(T110). 테이블 방과 대회 방을 다 본다.
   * `close`가 던져도 나머지를 닫는다 — `closeTable`과 같은 이유다. 실제 정리는
   * 뒤이어 오는 `handleDisconnect`가 한다.
   */
  private closeWhere(match: (socket: any) => boolean, reason: string) {
    for (const map of [this.tableSessions, this.tournamentSessions]) {
      for (const sessions of map.values()) {
        for (const socket of sessions) {
          if (!match(socket)) continue;
          try {
            socket.close(SESSION_REVOKED_CLOSE_CODE, reason);
          } catch {
            // 이미 닫힌 소켓.
          }
        }
      }
    }
  }

  @OnEvent('SEAT_TOKENS_REVOKED')
  handleSeatTokensRevoked(payload: { tournamentId: string; userIds: string[] }) {
    const users = new Set(payload.userIds);
    this.closeWhere(
      (s) => s.role === SEAT_ROLE && s.tournamentId === payload.tournamentId && users.has(s.userId),
      SEAT_REVOKED_REASON,
    );
  }
```

`token-ttl.ts`의 「좌석 토큰의 수명을 늘려도 폐기 수단이 필요 없다」 절을 고친다 — 권한 판정은 여전히 스냅샷이지만, **해제된 사람이 다시 앉으면 옛 토큰이 되살아나므로** 세대(`seatTokenVersion`)를 단다는 것, 대조 자리 둘(`/ws/ticket` · `handleConnection`)과 닫기(`SEAT_TOKENS_REVOKED`)를 이름으로 적는다. 「딜러만 `tokenVersion`을 갖는 이유」 문단도 이제 둘 다 갖는다는 사실에 맞춘다.

Run: Step 7 명령 → PASS.

**빨간불 확인:** `handleConnection`의 재대조 블록을 지우고 「티켓 발급 뒤 세대가 오르면」이 실패하는지 본다. `enterSeat`의 세대 올리기를 `claimSeat` 앞으로 옮겨 「409로 끝난 입장은」이 실패하는지 본다. 둘 다 복원.

- [ ] **Step 9: 전체 확인 · 커밋**

Run: `npm run typecheck && npm run test && npm run test:int`
Expected: 0 에러, 전부 통과. 시나리오 스펙(`src/scenario/*`)이 **같은 사람을 두 번 입장시키고 첫 토큰을 계속 쓰면** 깨진다 — 그건 이번 변경이 의도한 결과다. 마지막 입장의 토큰을 쓰도록 고친다.

```bash
git add packages/contract/src backend/prisma backend/src backend/shared
git commit -m "feat(T110): 좌석 토큰에 세대를 달고 입장·해제가 옛 토큰과 소켓을 끊는다"
```

---

### Task 2: 딜러 — 접속 재대조와 내보내기의 소켓 닫기 (백엔드)

**Files:**
- Modify: `backend/src/ws/ws-ticket.controller.ts` (딜러 티켓에 `tokenVersion`)
- Modify: `backend/src/ws/ws.gateway.ts` (`handleConnection` 딜러 재대조, `@OnEvent('DEALER_SESSION_REVOKED')`)
- Modify: `backend/src/store/session/session.service.ts` (`SessionService.revokeDealerSession`이 이벤트를 쏜다)
- Tests: `ws/ws.gateway.int-spec.ts`, `store/session/session.service.int-spec.ts`

**Interfaces:**
- Consumes: `closeWhere`, `DEALER_REVOKED_REASON`, `WsIdentity.tokenVersion` (Task 1), `DealerService.assertDealerSessionValid({ sub, tournamentId, tableId, tokenVersion })` (기존)

- [ ] **Step 1: 실패하는 테스트**

`session.service.int-spec.ts`: `revokeDealerSession`이 버전을 올린 뒤 `DEALER_SESSION_REVOKED { tournamentId }`를 쏜다. 딜러 세션이 없는 대회(P2025 경로)는 쏘지 않는다.

`ws.gateway.int-spec.ts`:

```ts
  describe('딜러 폐기(T110)', () => {
    it('DEALER_SESSION_REVOKED는 그 대회의 딜러 소켓만 4001로 닫는다', async () => {
      // 붙인다: 대회 A 딜러 · 대회 B 딜러 · 대회 A 좌석
      gateway.handleDealerSessionRevoked({ tournamentId: 'A' });
      expect(dealerA.close).toHaveBeenCalledWith(4001, '상점이 딜러 연결을 해제했습니다.');
      for (const other of [dealerB, seatA]) expect(other.close).not.toHaveBeenCalled();
    });

    it('딜러 티켓도 접속에서 세션을 다시 본다 — 30초 창에 내보내졌으면 거절', async () => {
      dealer.assertDealerSessionValid.mockRejectedValueOnce(new Error('만료된 딜러 세션입니다.'));
      const client = await connectDealer({ tournamentId: 'A', tableId: TABLE, tokenVersion: 0 });
      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });
  });
```

(`dealer` 목에 `assertDealerSessionValid: jest.fn().mockResolvedValue(undefined)`를 더한다. 기존 딜러 접속 테스트들은 그 기본값으로 계속 통과해야 한다.)

Run: 두 파일 `-t "딜러 폐기|DEALER_SESSION"` → FAIL

- [ ] **Step 2: 구현**

- `WsTicketController.issue` 딜러 분기의 `tickets.issue`에 `tokenVersion: req.user.tokenVersion`. 그 주석의 「이미 붙어 있는 소켓을 끊는 것은 계획 B의 몫이다」를 「붙어 있는 소켓은 내보내기가 닫는다(`DEALER_SESSION_REVOKED`, T110)」로.
- `handleConnection`의 Task 1 재대조 블록 옆에:

```ts
      if (payload.role === Role.DEALER) {
        await this.dealer.assertDealerSessionValid({
          sub: payload.sub,
          tournamentId: payload.tournamentId!,
          tableId: payload.tableId!,
          tokenVersion: payload.tokenVersion!,
        });
      }
```

- 수신기:

```ts
  @OnEvent('DEALER_SESSION_REVOKED')
  handleDealerSessionRevoked(payload: { tournamentId: string }) {
    this.closeWhere(
      (s) => s.role === Role.DEALER && s.tournamentId === payload.tournamentId,
      DEALER_REVOKED_REASON,
    );
  }
```

- `revokeDealerSession`: `dealerSession.update` 성공 뒤 `this.eventEmitter.emit('DEALER_SESSION_REVOKED', { tournamentId });`. 그 함수 JSDoc의 「남은 토큰은 만료(최대 1시간)까지 살아 있다」를 사실대로 — 토큰은 갱신·티켓에서 막히고 열린 소켓은 닫힌다.

Run: Step 1 명령 → PASS. **빨간불 확인:** 딜러 재대조 블록을 지우고 「30초 창」 테스트가 실패하는지 본다. 복원.

- [ ] **Step 3: 전체 확인 · 커밋**

Run: `npm run typecheck && npm run test && npm run test:int`

```bash
git add backend/src
git commit -m "feat(T110): 딜러 내보내기가 열린 소켓을 닫고 접속이 세션을 다시 본다"
```

---

### Task 3: 단말의 4001 처리와 콘솔의 탈취 의심 해제 (프론트)

**Files:**
- Modify: `frontend/src/lib/use-table-socket.ts` · `use-table-socket.test.ts`
- Create: `frontend/src/app/(terminal)/SessionRevokedOverlay.tsx` (+ 테스트)
- Modify: 좌석 게임 클라이언트(`(terminal)/table/[tableId]/SeatGameClient.tsx`)와 딜러 게임 클라이언트(`(terminal)/dealer/table/[tableId]/DealerGameClient.tsx`) · 각 테스트
- Modify: 콘솔 `action.ts`의 `releaseSeats`(인자 `rotateOtp`) · `ConsoleClient.tsx`(좌석 해제 UI에 체크박스) · 각 테스트

**Interfaces:**
- Consumes: contract `SESSION_REVOKED_CLOSE_CODE`, `SEAT_REVOKED_REASON`, `DEALER_REVOKED_REASON`; 백엔드 좌석 해제 본문 `{ seats, rotateOtp?: boolean }`
- Produces: `useTableSocket(...)`의 반환에 `revoked: string | null` (닫기 이유, 없으면 null)

- [ ] **Step 1: 실패하는 테스트 — 훅**

`use-table-socket.test.ts`에 (기존 가짜 WebSocket · 타이머 방식 그대로):
- 코드 4001로 닫히면 `revoked`가 그 이유이고, 타이머를 끝까지 돌려도 `/api/ws-ticket`을 다시 부르지 않는다.
- 코드 1006으로 닫히면 기존대로 재시도한다(반대 입력).
- 코드 1000은 기존대로 조용히 멈추고 `revoked`는 null이다.

Run: `npm run test -w frontend -- src/lib/use-table-socket.test.ts` → FAIL

- [ ] **Step 2: 구현 — 훅**

`socket.onclose`에서 1000 검사 바로 뒤:

```ts
        // T110. 세대가 올라 서버가 이 신원을 끊었다. 다시 붙어 봐야 티켓이
        // 403이라 재시도 8회를 태우고 「새로고침」에 멈춘다 — 멈추고 이유를 그린다.
        if (event.code === SESSION_REVOKED_CLOSE_CODE) {
          setRevoked(event.reason || null);
          return;
        }
```

`const [revoked, setRevoked] = useState<string | null>(null);`, 반환에 `revoked`. 연결이 다시 성공하면(첫 프레임) `setRevoked(null)`.

Run: → PASS

- [ ] **Step 3: 덮개**

`SessionRevokedOverlay`: props `{ reason: string; href: string; hint: string }`. 이유 문장, 힌트(좌석: 「내 자리라면 대기 화면에서 OTP를 다시 넣으세요.」 / 딜러: 「대기 화면에서 딜러 OTP를 다시 넣으세요.」), `href`로 가는 링크(「대기 화면으로」). 모양은 같은 폴더의 기존 덮개(`TournamentClosedOverlay` 등)를 따른다.

좌석 클라이언트는 `revoked`이면 `href={`/table?store=${storeId}`}`로, 딜러 클라이언트는 `/dealer?store=${storeId}`로 그린다(두 클라이언트가 `storeId`를 이미 받는다 — 없으면 페이지가 넘기는 값을 따라가 넘긴다). 각 클라이언트 테스트에: 훅이 `revoked`를 돌려주면 덮개와 링크가 보인다.

- [ ] **Step 4: 콘솔 체크박스**

- `releaseSeats(tournamentId, tableId, seats, rotateOtp = false)`: 본문에 `rotateOtp`.
- `ConsoleClient`의 좌석 해제 UI에 체크박스 「탈취 의심 — 참가 OTP도 새로 발급」(기본 해제). 체크하면 `rotateOtp: true`.
- 테스트: 체크 안 하면 `rotateOtp: false`, 체크하면 `true`로 액션이 불린다. 액션 테스트는 본문에 `rotateOtp`가 실리는지.

- [ ] **Step 5: 전체 확인 · 커밋**

Run: `npm run typecheck && npm run test`

```bash
git add frontend/src
git commit -m "feat(T110): 세대가 끊은 단말은 다시 붙지 않고 덮개를 그린다, 콘솔에 탈취 의심 해제"
```

---

### Task 4: 이음매 시나리오와 하네스

**Files:**
- Create: `backend/src/scenario/seat-takeover.int-spec.ts`
- Modify (필요할 때만): `frontend/e2e/fixtures/*`, `backend/test/outage/*`, `load/lib/*` · `load/scenarios/*`

- [ ] **Step 1: 시나리오 (스텁 없이)**

`src/scenario/harness.ts`의 배선으로 진짜 `EntryService` · `SessionService` · `WsGateway` · `WsTicketService` · `EventEmitter2`를 묶는다(하네스에 게이트웨이가 없으면 `ws.gateway.int-spec.ts`의 가짜 소켓 방식으로 게이트웨이만 붙인다 — 이벤트는 진짜 `EventEmitter2`를 타야 한다). 단계마다 이름을 문자열로 남긴다.

1. 피해자 V가 좌석 0에 입장하고, 그 토큰으로 받은 티켓으로 소켓 `vSocket`을 붙인다.
2. 공격자가 V의 OTP로 같은 좌석에 다시 입장한다. **`vSocket`이 4001로 닫힌다.**
3. 공격자가 그 토큰으로 소켓 `aSocket`을 붙인다.
4. 상점이 `releaseSeats(..., rotateOtp: true)`를 부른다. **`aSocket`이 4001로 닫힌다.**
5. 공격자의 토큰으로 티켓을 요청하면 403이다(`assertSeatTokenCurrent`). **옛 OTP로 입장하면 401이다.**
6. V가 새 OTP(DB에서 읽는다)로 입장하고 붙는다. 칩은 해제 전과 같다(장부 보존).

Run: `npm run test:int -w backend -- src/scenario/seat-takeover.int-spec.ts` → PASS. **빨간불 확인:** Task 1의 `releaseSeats` 이벤트 발사를 지우고 4단계에서 멈추는지 본다. 복원.

- [ ] **Step 2: 하네스**

같은 사람을 두 번 입장시키고 첫 토큰을 계속 쓰는 하네스가 있으면 마지막 입장의 토큰을 쓰도록 고친다. Docker가 떠 있으면:
- `npm run test:outage` (26 기대)
- e2e(`frontend/e2e/README.md` 절차: `cd backend && docker compose up -d`, `npm run dev:backend` 띄우고 `npm run test:e2e`, 13 기대 — 띄운 프로세스는 끝나면 내린다)
- `cd load && npm test` (39 기대)

못 돌린 것은 「미실행」으로 보고한다.

- [ ] **Step 3: 커밋**

```bash
git add backend/src/scenario frontend/e2e backend/test/outage load
git commit -m "test(T110): 좌석 탈취와 대응의 이음매 시나리오, 하네스 정렬"
```
