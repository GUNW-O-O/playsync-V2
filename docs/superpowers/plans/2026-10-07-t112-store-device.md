# T112 매장 태블릿 기기 토큰 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 입장(`/enter`)과 딜러 인증(`/dealer/auth`)을 매장이 등록한 태블릿만 부를 수 있게 하고, 요청율 상한을 IP가 아니라 기기로 갈라 공격자가 태블릿의 버킷을 채우지 못하게 한다.

**Architecture:** 상점 점주가 태블릿 대기 화면에서 등록하면 백엔드가 기기 토큰(JWT, 역할 `STORE_DEVICE`, 상점 단위 버전)을 발급하고 Next가 httpOnly 쿠키로 심는다. 백엔드의 `DeviceGuard`가 두 라우트 앞에서 서명·상점·버전을 대조하고, 전역 `DeviceThrottlerGuard`가 서명이 검증된 토큰이면 `device:<id>`로, 아니면 IP로 버킷을 가른다.

**Tech Stack:** NestJS 11 · `@nestjs/throttler` 6.5 · `@nestjs/jwt` · Prisma(PostgreSQL) · Next.js 16 서버 액션 · vitest · jest · k6 · Playwright

**Spec:** [`docs/superpowers/specs/2026-10-07-t112-store-device-design.md`](../specs/2026-10-07-t112-store-device-design.md)

## Global Constraints

- 하위 에이전트는 `docs/`와 `CLAUDE.md`를 **손대지 않는다.** 주석은 코드라 함께 간다.
- 코드 주석·문서는 한국어. 코드를 가리킬 때 **줄 번호가 아니라 이름**으로 적는다.
- 기기 토큰의 역할 문자열: `'STORE_DEVICE'`(contract의 `DEVICE_ROLE`). 수명: `'365d'`.
- 쿠키 이름: `deviceToken`. 헤더 이름: `x-device-token`. 둘 다 `@playsync/contract`에서 import한다 — 손으로 복사하지 않는다.
- 거절 문구: `DEVICE_UNREGISTERED_MESSAGE = '등록된 매장 태블릿이 아닙니다. 상점에 문의해주세요.'` (contract).
- `EntryService.enterSeat` · `DealerService.loginDealer`의 시그니처를 바꾸지 않는다(호출부 96곳).
- 새 테스트가 처음부터 통과하면 의심한다 — 제품 코드를 되돌려 빨간불을 본다(CLAUDE.md 「통과한 테스트를 믿지 않는다」).
- 루트에서: `npm run typecheck`, `npm run test`, `npm run test:int` (통합은 컨테이너 자동 기동).
- PR은 만들지 않는다. 커밋만 한다. 메인이 마지막에 기준선을 재고 문서를 얹는다.

## Review Focus

1. **위조 기기 토큰 문자열이 새 버킷을 얻는다** — 아무 문자열이나 보내도 IP 버킷으로 떨어져야 한다. Task 2 `device-throttler.guard.spec.ts`의 「위조 토큰은 429」가 못 박는다.
2. **다른 상점에 등록된 태블릿이 남의 대회 딜러 잠금 슬롯을 태운다** — 문이 서비스보다 먼저 막아야 한다. Task 2 `device-gate.spec.ts`의 「서비스가 한 번도 불리지 않는다」.
3. **기기 토큰을 Bearer로 넣어 `/ws/ticket`을 통과한다** — `JwtStrategy.validate`가 거절해야 한다. Task 1 `jwt.strategy.spec.ts`.
4. **등록이 태블릿에 점주 세션을 남긴다** — `registerDevice`가 `accessToken` 쿠키를 심으면 손님 앞 태블릿이 점주로 로그인된 상태다. Task 3 `device-action.test.ts`의 「`deviceToken`만 심는다」.
5. **해제한 뒤에도 옛 태블릿이 입장한다** — 버전 대조가 빠지면 「전체 해제」가 아무 일도 안 한다. Task 2 `device.guard.int-spec.ts`의 「해제된 버전은 401」.

---

### Task 1: 기기 토큰 발급 · 해제 (백엔드)

**Files:**
- Create: `packages/contract/src/device.ts`
- Modify: `packages/contract/src/index.ts`
- Modify: `backend/prisma/schema.prisma` (`model Store`)
- Create: `backend/prisma/migrations/20261007120000_store_device_token_version/migration.sql`
- Create: `backend/src/device/device-token.ts`
- Create: `backend/src/device/device-token.spec.ts`
- Create: `backend/src/device/device.service.ts`
- Create: `backend/src/device/device.controller.ts`
- Create: `backend/src/device/device.module.ts`
- Create: `backend/src/device/device.service.int-spec.ts`
- Modify: `backend/src/app.module.ts` (imports에 `DeviceModule`)
- Modify: `backend/src/auth/strategies/jwt.strategy.ts`
- Modify: `backend/src/auth/strategies/jwt.strategy.spec.ts`

**Interfaces:**
- Produces (contract): `DEVICE_UNREGISTERED_MESSAGE`, `DEVICE_TOKEN_COOKIE = 'deviceToken'`, `DEVICE_TOKEN_HEADER = 'x-device-token'`, `DEVICE_ROLE = 'STORE_DEVICE'`
- Produces (backend `src/device/device-token.ts`):
  - `DEVICE_ROLE` (contract의 것을 다시 내보낸다)
  - `type DevicePayload = { deviceId: string; storeId: string; ver: number }`
  - `signDeviceToken(jwt: JwtService, input: { storeId: string; ver: number }): string`
  - `verifyDeviceToken(jwt: JwtService, token: string | undefined): DevicePayload | null`
  - `deviceTokenFrom(req: { headers?: Record<string, unknown> }): string | undefined`
- Produces (HTTP): `POST /store/:storeId/devices` → `{ deviceToken: string }` (201) · `POST /store/:storeId/devices/revoke` → `{ ok: true }` (201). 둘 다 `STORE_ADMIN`이고 소유자가 아니면 403 `본인의 매장이 아닙니다.`

- [ ] **Step 1: contract 상수**

`packages/contract/src/device.ts`:

```ts
/**
 * 매장 태블릿의 기기 토큰(T112).
 *
 * 쿠키·헤더 이름이 경계를 넘는다 — Next 서버 액션이 쿠키를 읽어 헤더로 싣고,
 * 백엔드가 그 헤더(없으면 rewrite가 들고 온 쿠키)를 읽는다. 양쪽이 손으로
 * 적으면 한쪽만 바뀌는 날 조용히 갈라진다.
 */
export const DEVICE_TOKEN_COOKIE = "deviceToken" as const;
export const DEVICE_TOKEN_HEADER = "x-device-token" as const;

/**
 * 기기 토큰 페이로드의 `role`. 프론트가 쿠키를 해석해 등록 폼을 고를 때도 읽으므로
 * 경계를 넘는다. Prisma `Role` 밖의 값이다(`SEAT_ROLE`과 같은 이유).
 */
export const DEVICE_ROLE = "STORE_DEVICE" as const;

/**
 * 기기 토큰이 없거나, 다른 상점 것이거나, 해제된 버전일 때의 401 문구.
 * 프론트가 이 문구를 보고 쿠키를 지운다 — 다시 그리면 등록 폼이 뜬다.
 */
export const DEVICE_UNREGISTERED_MESSAGE =
  "등록된 매장 태블릿이 아닙니다. 상점에 문의해주세요." as const;
```

`packages/contract/src/index.ts` 끝에 `export * from "./device";`.

- [ ] **Step 2: 스키마와 마이그레이션**

`model Store`에 `createdAt` 위로 추가:

```prisma
  /// 매장 태블릿 기기 토큰의 세대(T112). 올리면 이 상점의 기기 토큰이 전부 죽는다.
  deviceTokenVersion Int @default(0)
```

`backend/prisma/migrations/20261007120000_store_device_token_version/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "Store" ADD COLUMN "deviceTokenVersion" INTEGER NOT NULL DEFAULT 0;
```

Run: `cd backend && npx prisma generate`
Expected: `Generated Prisma Client`

- [ ] **Step 3: 실패하는 단위 테스트 — 토큰 왕복과 추출**

`backend/src/device/device-token.spec.ts`:

```ts
import { JwtService } from '@nestjs/jwt';
import { SEAT_ROLE } from 'src/auth/seat-role';
import { deviceTokenFrom, signDeviceToken, verifyDeviceToken } from './device-token';

const jwt = new JwtService({ secret: 'device-spec-secret' });

describe('기기 토큰', () => {
  it('서명한 토큰을 검증하면 상점과 버전이 돌아온다', () => {
    const token = signDeviceToken(jwt, { storeId: 'store-1', ver: 3 });
    const payload = verifyDeviceToken(jwt, token);
    expect(`${payload?.storeId}/${payload?.ver}`).toBe('store-1/3');
    expect(payload?.deviceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('발급마다 기기 id가 다르다 — 버킷을 가르는 열쇠다', () => {
    const a = verifyDeviceToken(jwt, signDeviceToken(jwt, { storeId: 's', ver: 0 }));
    const b = verifyDeviceToken(jwt, signDeviceToken(jwt, { storeId: 's', ver: 0 }));
    expect(a?.deviceId).not.toBe(b?.deviceId);
  });

  it('깨진 문자열 · 없는 값은 null', () => {
    expect(verifyDeviceToken(jwt, 'garbage')).toBeNull();
    expect(verifyDeviceToken(jwt, undefined)).toBeNull();
  });

  it('다른 키로 서명한 토큰은 null', () => {
    const other = new JwtService({ secret: 'other' });
    expect(verifyDeviceToken(jwt, signDeviceToken(other, { storeId: 's', ver: 0 }))).toBeNull();
  });

  it('좌석 토큰 · 사용자 토큰은 기기 토큰이 아니다', () => {
    const seat = jwt.sign({ sub: 'u', role: SEAT_ROLE, storeId: 's', ver: 0 });
    const user = jwt.sign({ sub: 'u', role: 'STORE_ADMIN', storeId: 's', ver: 0 });
    expect(verifyDeviceToken(jwt, seat)).toBeNull();
    expect(verifyDeviceToken(jwt, user)).toBeNull();
  });

  it('헤더가 우선이고, 없으면 쿠키에서 읽는다', () => {
    expect(deviceTokenFrom({ headers: { 'x-device-token': 'h', cookie: 'deviceToken=c' } })).toBe('h');
    expect(deviceTokenFrom({ headers: { cookie: 'a=1; deviceToken=c; b=2' } })).toBe('c');
    expect(deviceTokenFrom({ headers: { cookie: 'xdeviceToken=nope' } })).toBeUndefined();
    expect(deviceTokenFrom({ headers: {} })).toBeUndefined();
    expect(deviceTokenFrom({})).toBeUndefined();
  });
});
```

- [ ] **Step 4: 실패 확인**

Run: `cd backend && npx jest src/device/device-token.spec.ts`
Expected: FAIL — `Cannot find module './device-token'`

- [ ] **Step 5: 구현**

`backend/src/device/device-token.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { DEVICE_ROLE, DEVICE_TOKEN_COOKIE, DEVICE_TOKEN_HEADER } from '@playsync/contract';

/**
 * 역할(`DEVICE_ROLE`)은 contract에 있다 — 프론트도 읽는다. `SEAT_ROLE`처럼
 * Prisma `Role` 밖의 값이라 어떤 `@Roles(...)`와도 맞지 않고, `JwtStrategy.validate`가
 * 이 역할을 거절한다. 기기 토큰은 Bearer가 아니라 「이 요청이 등록된 태블릿에서
 * 왔다」는 표지일 뿐이다.
 */
export { DEVICE_ROLE };

/** 매장 비품이라 대회가 아니라 기기에 묶인다. 폐기는 `Store.deviceTokenVersion`이 맡는다. */
const DEVICE_TOKEN_TTL = '365d';

export type DevicePayload = { deviceId: string; storeId: string; ver: number };

/**
 * ponytail: 기기 행을 만들지 않는다. `deviceId`는 서명 안의 난수라 버킷을 가르는
 * 열쇠로만 쓰고, 폐기는 상점 단위(전체 해제)다. 기기별 목록 · 개별 폐기가
 * 필요해지면 `StoreDevice` 행을 두고 `sub`를 그 id로 바꾼다.
 */
export function signDeviceToken(jwt: JwtService, input: { storeId: string; ver: number }): string {
  return jwt.sign(
    { sub: randomUUID(), storeId: input.storeId, ver: input.ver, role: DEVICE_ROLE },
    { expiresIn: DEVICE_TOKEN_TTL },
  );
}

/** 서명이 맞고 모양이 기기 토큰일 때만 돌려준다. 그 외는 전부 null. */
export function verifyDeviceToken(jwt: JwtService, token: string | undefined): DevicePayload | null {
  if (!token) return null;
  let payload: Record<string, unknown>;
  try {
    payload = jwt.verify(token);
  } catch {
    return null;
  }
  const { sub, storeId, ver, role } = payload;
  if (role !== DEVICE_ROLE) return null;
  if (typeof sub !== 'string' || typeof storeId !== 'string' || typeof ver !== 'number') return null;
  return { deviceId: sub, storeId, ver };
}

/**
 * 요청에서 기기 토큰을 꺼낸다.
 *
 * 헤더가 먼저다 — Next 서버 쪽 fetch(서버 액션 · `api/ws-ticket`)가 쿠키를 읽어
 * 싣는다. 헤더가 없으면 `Cookie`를 본다 — Next rewrite(`/api/*`)를 탄 클라이언트
 * fetch는 브라우저 쿠키를 그대로 들고 오므로, 헤더를 안 실어도 버킷이 갈린다.
 */
export function deviceTokenFrom(req: { headers?: Record<string, unknown> }): string | undefined {
  const header = req.headers?.[DEVICE_TOKEN_HEADER];
  if (typeof header === 'string' && header.length > 0) return header;

  const cookie = req.headers?.cookie;
  if (typeof cookie !== 'string') return undefined;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === DEVICE_TOKEN_COOKIE) return rest.join('=') || undefined;
  }
  return undefined;
}
```

- [ ] **Step 6: 통과 확인**

Run: `cd backend && npx jest src/device/device-token.spec.ts`
Expected: PASS (6)

- [ ] **Step 7: 실패하는 테스트 — Bearer로 넣은 기기 토큰을 거절한다**

`backend/src/auth/strategies/jwt.strategy.spec.ts`에 케이스를 더한다(파일의 기존 `describe`와 생성 방식을 따른다 — `new JwtStrategy()`, `JWT_SECRET`은 기존 스펙이 세우는 방식 그대로):

```ts
  // T112. 기기 토큰은 Bearer가 아니다. 통과시키면 `JwtAuthGuard`만 거는
  // 라우트(`/ws/ticket` · `/playsync/*`)가 기기 id를 userId로 받아 돈다.
  it('기기 토큰 페이로드는 거절한다', async () => {
    await expect(
      strategy.validate({ sub: 'device-1', storeId: 's', ver: 0, role: 'STORE_DEVICE' }),
    ).rejects.toThrow(UnauthorizedException);
  });
```

(`UnauthorizedException`은 `@nestjs/common`에서 import. 기존 스펙의 strategy 변수 이름이 다르면 그 이름을 쓴다.)

Run: `cd backend && npx jest src/auth/strategies/jwt.strategy.spec.ts`
Expected: FAIL — 기본 분기가 `{ userId: 'device-1', role: 'STORE_DEVICE' }`를 돌려준다

- [ ] **Step 8: 구현**

`JwtStrategy.validate`의 첫 문장으로:

```ts
    // T112. 기기 토큰은 「등록된 태블릿에서 왔다」는 표지지 신원이 아니다.
    // 여기서 받으면 기본 분기가 기기 id를 userId로 내보낸다.
    if (payload.role === DEVICE_ROLE) {
      throw new UnauthorizedException();
    }
```

import: `import { Injectable, UnauthorizedException } from '@nestjs/common';`, `import { DEVICE_ROLE } from '../../device/device-token';`

Run: `cd backend && npx jest src/auth/strategies/jwt.strategy.spec.ts`
Expected: PASS

- [ ] **Step 9: 실패하는 통합 테스트 — 등록 · 해제 · 소유권**

`backend/src/device/device.service.int-spec.ts`:

```ts
import { ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, Role } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';
import { verifyDeviceToken } from './device-token';
import { DeviceService } from './device.service';

describe('DeviceService', () => {
  let prisma: PrismaClient;
  let service: DeviceService;
  const jwt = new JwtService({ secret: 'device-int-secret' });

  beforeAll(() => {
    prisma = createTestPrisma();
    service = new DeviceService(prisma as unknown as PrismaService, jwt);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await prisma.user.create({ data: { id: 'owner-a', nickname: 'owner-a', password: 'x', role: Role.STORE_ADMIN } });
    await prisma.user.create({ data: { id: 'owner-b', nickname: 'owner-b', password: 'x', role: Role.STORE_ADMIN } });
    await prisma.store.create({ data: { id: 'store-a', name: 'A', ownerId: 'owner-a' } });
  });

  afterAll(async () => {
    await closeTestPrisma(prisma);
  });

  it('소유자는 등록하고, 토큰에 상점과 현재 버전이 실린다', async () => {
    await prisma.store.update({ where: { id: 'store-a' }, data: { deviceTokenVersion: 4 } });
    const { deviceToken } = await service.register('store-a', 'owner-a');
    const payload = verifyDeviceToken(jwt, deviceToken);
    expect(`${payload?.storeId}/${payload?.ver}`).toBe('store-a/4');
  });

  it('남의 점주는 등록할 수 없다', async () => {
    await expect(service.register('store-a', 'owner-b')).rejects.toThrow(ForbiddenException);
  });

  it('없는 상점은 403이다 — 존재를 가르지 않는다', async () => {
    await expect(service.register('no-store', 'owner-a')).rejects.toThrow(ForbiddenException);
  });

  it('해제는 버전을 하나 올린다', async () => {
    await service.revokeAll('store-a', 'owner-a');
    const store = await prisma.store.findUniqueOrThrow({ where: { id: 'store-a' } });
    expect(`버전 ${store.deviceTokenVersion}`).toBe('버전 1');
  });

  it('남의 점주는 해제할 수 없고, 버전도 안 움직인다', async () => {
    await expect(service.revokeAll('store-a', 'owner-b')).rejects.toThrow(ForbiddenException);
    const store = await prisma.store.findUniqueOrThrow({ where: { id: 'store-a' } });
    expect(`버전 ${store.deviceTokenVersion}`).toBe('버전 0');
  });
});
```

Run: `npm run test:int -w backend -- src/device/device.service.int-spec.ts`
Expected: FAIL — `Cannot find module './device.service'`

- [ ] **Step 10: 서비스 · 컨트롤러 · 모듈**

`backend/src/device/device.service.ts`:

```ts
import { ForbiddenException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from 'src/prisma/prisma.service';
import { signDeviceToken } from './device-token';

/**
 * 매장 태블릿 등록과 전체 해제(T112).
 *
 * 소유권 판정은 `SessionService`의 `assertStoreOwnership`과 같은 모양이다 —
 * 없는 상점과 남의 상점을 같은 403으로 내려 존재를 가르지 않는다.
 */
@Injectable()
export class DeviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(storeId: string, ownerId: string): Promise<{ deviceToken: string }> {
    const store = await this.ownedStore(storeId, ownerId);
    return { deviceToken: signDeviceToken(this.jwt, { storeId, ver: store.deviceTokenVersion }) };
  }

  /** 이 상점의 기기 토큰을 전부 죽인다. 남은 태블릿은 다시 등록한다. */
  async revokeAll(storeId: string, ownerId: string): Promise<{ ok: true }> {
    await this.ownedStore(storeId, ownerId);
    await this.prisma.store.update({
      where: { id: storeId },
      data: { deviceTokenVersion: { increment: 1 } },
    });
    return { ok: true };
  }

  private async ownedStore(storeId: string, ownerId: string) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { ownerId: true, deviceTokenVersion: true },
    });
    if (!store || store.ownerId !== ownerId) {
      throw new ForbiddenException('본인의 매장이 아닙니다.');
    }
    return store;
  }
}
```

`backend/src/device/device.controller.ts`:

```ts
import { Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/roles.guard';
import { DeviceService } from './device.service';

/**
 * 점주가 태블릿을 등록하고 해제한다. `PLATFORM_ADMIN`은 넣지 않는다 —
 * 상점 소유자가 아니라 소유권 판정을 통과할 수 없다.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.STORE_ADMIN)
@Controller('store/:storeId/devices')
export class DeviceController {
  constructor(private readonly deviceService: DeviceService) {}

  @Post()
  async register(@Req() req, @Param('storeId') storeId: string) {
    return await this.deviceService.register(storeId, req.user.userId);
  }

  @Post('revoke')
  async revokeAll(@Req() req, @Param('storeId') storeId: string) {
    return await this.deviceService.revokeAll(storeId, req.user.userId);
  }
}
```

`backend/src/device/device.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { DeviceController } from './device.controller';
import { DeviceService } from './device.service';

// PrismaModule · JwtModule이 전역이라 import할 것이 없다(`EntryModule`과 같다).
@Module({
  controllers: [DeviceController],
  providers: [DeviceService],
})
export class DeviceModule {}
```

`backend/src/app.module.ts`의 `imports` 배열 끝(`RecoveryModule` 뒤)에 `DeviceModule`, 상단에 `import { DeviceModule } from './device/device.module';`.

- [ ] **Step 11: 통과 확인 · 전체 확인**

Run: `npm run test:int -w backend -- src/device/device.service.int-spec.ts`
Expected: PASS (5)
Run: `npm run typecheck && npm run test`
Expected: 타입 에러 0, 전부 통과

- [ ] **Step 12: Commit**

```bash
git add packages/contract/src/device.ts packages/contract/src/index.ts backend/prisma backend/src/device backend/src/app.module.ts backend/src/auth/strategies
git commit -m "feat(T112): 매장 태블릿 기기 토큰 발급과 전체 해제"
```

---

### Task 2: 입장 · 딜러 인증의 문과 기기 단위 상한 (백엔드)

**Files:**
- Create: `backend/src/device/device.guard.ts`
- Create: `backend/src/device/device.guard.int-spec.ts`
- Create: `backend/src/device/device-throttler.guard.ts`
- Create: `backend/src/device/device-throttler.guard.spec.ts`
- Create: `backend/src/device/device-gate.spec.ts`
- Modify: `backend/src/entry/entry.controller.ts` (`EntryController.enter`)
- Modify: `backend/src/dealer/dealer.controller.ts` (`DealerController.loginDealer`)
- Modify: `backend/src/app.module.ts` (`APP_GUARD`)
- Modify: `backend/src/auth/throttle.ts` (주석의 「IP 하나가 뜻하는 것」 절에 기기 버킷 한 문단)

**Interfaces:**
- Consumes: `verifyDeviceToken`, `deviceTokenFrom`, `signDeviceToken`, `DEVICE_UNREGISTERED_MESSAGE` (Task 1)
- Produces: `DeviceGuard` (`CanActivate`, 성공 시 `req.device: DevicePayload`), `DeviceThrottlerGuard extends ThrottlerGuard`

- [ ] **Step 1: 실패하는 통합 테스트 — 문의 판정**

`backend/src/device/device.guard.int-spec.ts`:

```ts
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, Role } from '@prisma/client';
import { DEVICE_UNREGISTERED_MESSAGE } from '@playsync/contract';
import { PrismaService } from 'src/prisma/prisma.service';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';
import { signDeviceToken } from './device-token';
import { DeviceGuard } from './device.guard';

function ctx(req: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('DeviceGuard', () => {
  let prisma: PrismaClient;
  let guard: DeviceGuard;
  const jwt = new JwtService({ secret: 'device-guard-secret' });
  const token = (storeId: string, ver = 0) => signDeviceToken(jwt, { storeId, ver });

  beforeAll(() => {
    prisma = createTestPrisma();
    guard = new DeviceGuard(prisma as unknown as PrismaService, jwt);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await prisma.user.create({ data: { id: 'o', nickname: 'o', password: 'x', role: Role.STORE_ADMIN } });
    await prisma.store.create({ data: { id: 'store-a', name: 'A', ownerId: 'o' } });
    await prisma.store.create({ data: { id: 'store-b', name: 'B', ownerId: 'o' } });
    await prisma.blindStructure.create({ data: { id: 'blind', name: 'b', storeId: 'store-a', structure: [] } });
    await prisma.tournament.create({
      data: { id: 'trn-a', name: 'a', blindId: 'blind', storeId: 'store-a', dealerOtpHash: 'x' },
    });
  });

  afterAll(async () => {
    await closeTestPrisma(prisma);
  });

  async function rejectsWith(req: Record<string, unknown>) {
    await expect(guard.canActivate(ctx(req))).rejects.toThrow(
      new UnauthorizedException(DEVICE_UNREGISTERED_MESSAGE),
    );
  }

  it('경로의 대회가 토큰의 상점 것이면 통과하고 req.device를 채운다', async () => {
    const req: Record<string, any> = { headers: { 'x-device-token': token('store-a') }, params: { id: 'trn-a' } };
    await expect(guard.canActivate(ctx(req))).resolves.toBe(true);
    expect(req.device.storeId).toBe('store-a');
  });

  it('본문의 tournamentId도 읽는다(/dealer/auth)', async () => {
    const req = { headers: { 'x-device-token': token('store-a') }, params: {}, body: { tournamentId: 'trn-a' } };
    await expect(guard.canActivate(ctx(req))).resolves.toBe(true);
  });

  it('토큰이 없으면 401', () => rejectsWith({ headers: {}, params: { id: 'trn-a' } }));

  it('위조 토큰이면 401', () => rejectsWith({ headers: { 'x-device-token': 'garbage' }, params: { id: 'trn-a' } }));

  it('남의 상점 토큰이면 401', () =>
    rejectsWith({ headers: { 'x-device-token': token('store-b') }, params: { id: 'trn-a' } }));

  it('없는 대회도 같은 401 — 대회 id를 훑을 수 없다', () =>
    rejectsWith({ headers: { 'x-device-token': token('store-a') }, params: { id: 'nope' } }));

  it('해제된 버전은 401', async () => {
    const old = token('store-a', 0);
    await prisma.store.update({ where: { id: 'store-a' }, data: { deviceTokenVersion: 1 } });
    await rejectsWith({ headers: { 'x-device-token': old }, params: { id: 'trn-a' } });
  });

  it('본문의 tournamentId가 문자열이 아니면 401 — ValidationPipe 앞이다', () =>
    rejectsWith({ headers: { 'x-device-token': token('store-a') }, params: {}, body: { tournamentId: { not: 'x' } } }));
});
```

(`blindStructure`의 필수 필드가 위와 다르면 `schema.prisma`의 `model BlindStructure`를 보고 맞춘다.)

Run: `npm run test:int -w backend -- src/device/device.guard.int-spec.ts`
Expected: FAIL — `Cannot find module './device.guard'`

- [ ] **Step 2: 구현**

`backend/src/device/device.guard.ts`:

```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DEVICE_UNREGISTERED_MESSAGE } from '@playsync/contract';
import { PrismaService } from 'src/prisma/prisma.service';
import { deviceTokenFrom, verifyDeviceToken } from './device-token';

/**
 * 등록된 매장 태블릿만 지나간다(T112). `/enter`와 `/dealer/auth`에 건다.
 *
 * **상점 대조를 서비스가 아니라 여기서 한다.** 문이 핸들러보다 먼저 서므로
 * 두 순서가 구조로 보장된다 — OTP 조회보다 먼저(뒤면 남의 상점 기기가 「그
 * OTP가 유효하다」를 응답 차이로 읽는다), `OtpAttempts.reserveAttempt`보다
 * 먼저(뒤면 남의 상점 기기가 그 대회의 딜러 잠금 슬롯을 태운다).
 *
 * 없는 대회 · 남의 상점 · 해제된 버전 · 위조를 전부 같은 401로 내린다.
 * 가르면 대회 id를 훑을 수 있다.
 */
@Injectable()
export class DeviceGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const device = verifyDeviceToken(this.jwt, deviceTokenFrom(req));

    // `/enter`는 경로의 `:id`, `/dealer/auth`는 본문의 `tournamentId`다. 본문은
    // 아직 ValidationPipe를 안 지났으므로 문자열이 아니면 없는 대회로 친다.
    const tournamentId = req.params?.id ?? req.body?.tournamentId;

    if (device && typeof tournamentId === 'string') {
      const tournament = await this.prisma.tournament.findUnique({
        where: { id: tournamentId },
        select: { storeId: true, store: { select: { deviceTokenVersion: true } } },
      });
      if (tournament?.storeId === device.storeId && tournament.store.deviceTokenVersion === device.ver) {
        req.device = device;
        return true;
      }
    }
    throw new UnauthorizedException(DEVICE_UNREGISTERED_MESSAGE);
  }
}
```

Run: `npm run test:int -w backend -- src/device/device.guard.int-spec.ts`
Expected: PASS (8)

**빨간불 확인:** 버전 대조(`&& tournament.store.deviceTokenVersion === device.ver`)를 지우고 다시 돌려 「해제된 버전은 401」만 실패하는지 본다. 복원한다.

- [ ] **Step 3: 실패하는 단위 테스트 — 문이 진짜 컨트롤러 앞에 선다**

`backend/src/device/device-gate.spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DealerController } from 'src/dealer/dealer.controller';
import { DealerService } from 'src/dealer/dealer.service';
import { EntryController } from 'src/entry/entry.controller';
import { EntryService } from 'src/entry/entry.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { SessionService } from 'src/store/session/session.service';

/**
 * 문이 **배선**돼 있는가를 본다. 판정 자체는 `device.guard.int-spec.ts`가 본다.
 *
 * 「서비스가 한 번도 불리지 않는다」가 이 스펙의 값이다 — 딜러 인증에서
 * 서비스가 불리면 그 첫 줄(`reserveAttempt`)이 잠금 슬롯을 쓴다.
 */
describe('기기 문의 배선', () => {
  let app: INestApplication;
  const enterSeat = jest.fn(async () => ({ accessToken: 'seat' }));
  const loginDealer = jest.fn(async () => ({ accessToken: 'dealer' }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'gate-secret' })],
      controllers: [EntryController, DealerController],
      providers: [
        { provide: EntryService, useValue: { enterSeat } },
        { provide: DealerService, useValue: { loginDealer } },
        { provide: SessionService, useValue: {} },
        // 대회가 없다 — 토큰이 있어도 통과하지 못하는 상태다.
        { provide: PrismaService, useValue: { tournament: { findUnique: async () => null } } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('토큰 없는 입장은 401이고 EntryService가 불리지 않는다', async () => {
    const res = await request(app.getHttpServer())
      .post('/tournaments/trn-1/enter')
      .send({ otp: '00000000', tableId: 't', seatIndex: 0 });
    expect(res.status).toBe(401);
    expect(enterSeat).not.toHaveBeenCalled();
  });

  it('토큰 없는 딜러 인증은 401이고 DealerService가 불리지 않는다', async () => {
    const res = await request(app.getHttpServer())
      .post('/dealer/auth')
      .send({ tournamentId: 'trn-1', tableId: 't', otp: '000000' });
    expect(res.status).toBe(401);
    expect(loginDealer).not.toHaveBeenCalled();
  });
});
```

(`DealerController`가 생성자에서 더 받는 의존성이 있으면 같은 방식으로 `useValue: {}`를 더한다.)

Run: `cd backend && npx jest src/device/device-gate.spec.ts`
Expected: FAIL — 두 요청 모두 401이 아니다(입장은 서비스 목이 201, 딜러는 201)

- [ ] **Step 4: 문을 건다**

`EntryController.enter` 위에 `@UseGuards(DeviceGuard)`, 클래스 JSDoc의 「가드가 없다」 문장을 다음으로 고친다:

```ts
/**
 * 대회 입장. 사람의 자격 증명은 **OTP 자체**고, 그 앞에 **기기 문**이 선다
 * (`DeviceGuard`, T112) — 매장이 등록한 태블릿만 OTP를 넣을 수 있다.
 * 딜러 로그인(`POST /dealer/auth`)과 같은 자리다.
 */
```

`DealerController.loginDealer`의 `@Throttle(authThrottle())` 아래에 `@UseGuards(DeviceGuard)`. 그 메서드 JSDoc 끝에 한 문단:

```ts
   *
   * **기기 문이 잠금보다 먼저다**(T112). 등록 안 된 기기는 `reserveAttempt`에
   * 닿지 못하므로 남의 태블릿이 이 대회의 잠금을 걸 수 없다.
```

import: `import { DeviceGuard } from 'src/device/device.guard';` (`UseGuards`는 두 파일 모두 `@nestjs/common`에서; 엔트리 컨트롤러는 import에 추가).

Run: `cd backend && npx jest src/device/device-gate.spec.ts`
Expected: PASS (2)

- [ ] **Step 5: 실패하는 단위 테스트 — 기기 단위 상한**

`backend/src/device/device-throttler.guard.spec.ts`:

```ts
import { Controller, INestApplication, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { signDeviceToken } from './device-token';
import { DeviceThrottlerGuard } from './device-throttler.guard';

@Controller('probe')
class ProbeController {
  @Post()
  hit() {
    return { ok: true };
  }
}

/**
 * 태블릿이 Next 주소 버킷에서 빠지는가.
 *
 * supertest는 전부 같은 주소(루프백)에서 온다 — 이 리포의 실제 토폴로지(모든
 * 브라우저 요청이 Next 프로세스 하나의 주소)와 같은 모양이다.
 */
describe('DeviceThrottlerGuard', () => {
  let app: INestApplication;
  let deviceToken: string;
  const LIMIT = 3;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: 'throttle-secret' }),
        ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: LIMIT }] }),
      ],
      controllers: [ProbeController],
      providers: [{ provide: APP_GUARD, useClass: DeviceThrottlerGuard }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    deviceToken = signDeviceToken(moduleRef.get(JwtService), { storeId: 's', ver: 0 });

    // 토큰 없는 쪽(= Next 주소)이 버킷을 채운다.
    for (let i = 0; i < LIMIT; i++) {
      await request(app.getHttpServer()).post('/probe').expect(201);
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('토큰 없는 쪽은 상한에 걸린다', async () => {
    await request(app.getHttpServer()).post('/probe').expect(429);
  });

  it('등록된 기기는 같은 주소여도 통과한다 — 헤더', async () => {
    await request(app.getHttpServer()).post('/probe').set('x-device-token', deviceToken).expect(201);
  });

  it('등록된 기기는 같은 주소여도 통과한다 — 쿠키(rewrite 경로)', async () => {
    await request(app.getHttpServer()).post('/probe').set('Cookie', `deviceToken=${deviceToken}`).expect(201);
  });

  it('위조 토큰은 새 버킷을 못 얻는다', async () => {
    await request(app.getHttpServer()).post('/probe').set('x-device-token', 'forged-1').expect(429);
    await request(app.getHttpServer()).post('/probe').set('x-device-token', 'forged-2').expect(429);
  });

  it('다른 키로 서명한 토큰도 새 버킷을 못 얻는다', async () => {
    const foreign = signDeviceToken(new JwtService({ secret: 'other' }), { storeId: 's', ver: 0 });
    await request(app.getHttpServer()).post('/probe').set('x-device-token', foreign).expect(429);
  });
});
```

Run: `cd backend && npx jest src/device/device-throttler.guard.spec.ts`
Expected: FAIL — `Cannot find module './device-throttler.guard'`

- [ ] **Step 6: 구현**

`backend/src/device/device-throttler.guard.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { deviceTokenFrom, verifyDeviceToken } from './device-token';

/**
 * 요청율 상한의 버킷을 기기로 가른다(T112).
 *
 * 브라우저 요청은 전부 Next 프로세스 하나의 주소로 오므로(`auth/throttle.ts`),
 * IP로만 가르면 아무나 그 버킷을 채워 매장 태블릿 전체를 막는다. 서명이
 * 검증된 기기 토큰이면 `device:<id>`로 따로 센다.
 *
 * **검증 전에 가르지 않는다.** 토큰 문자열로 가르면 아무 문자열이나 보내는
 * 쪽이 요청마다 새 버킷을 얻는다. 버전 대조(DB)는 여기서 하지 않는다 —
 * 해제된 기기는 자기 버킷을 쓰다가 `DeviceGuard`에서 막히고, 그 버킷은
 * 아무에게도 피해가 없다.
 */
@Injectable()
export class DeviceThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwt: JwtService,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const device = verifyDeviceToken(this.jwt, deviceTokenFrom(req));
    return device ? `device:${device.deviceId}` : req.ip;
  }
}
```

Run: `cd backend && npx jest src/device/device-throttler.guard.spec.ts`
Expected: PASS (5)

**빨간불 확인:** `getTracker`를 `return deviceTokenFrom(req) ?? req.ip;`(검증 없이 문자열로 가르기)로 바꿔 「위조 토큰은 새 버킷을 못 얻는다」가 실패하는지 본다. 복원한다.

- [ ] **Step 7: 전역 가드를 바꾼다**

`backend/src/app.module.ts`: `{ provide: APP_GUARD, useClass: ThrottlerGuard }` → `{ provide: APP_GUARD, useClass: DeviceThrottlerGuard }`. 그 위 주석 끝에 한 줄: `// 버킷은 기기 토큰이 있으면 기기, 없으면 주소다(`DeviceThrottlerGuard`, T112).` `ThrottlerGuard` import가 남지 않게 정리하고 `import { DeviceThrottlerGuard } from './device/device-throttler.guard';`.

`backend/src/auth/throttle.ts`의 「이 토폴로지에서 IP 하나가 뜻하는 것」 절 끝에 문단을 더한다:

```ts
 *
 * **매장 태블릿은 이 버킷에서 빠진다**(T112). 기기 토큰이 있으면 전역 가드
 * (`DeviceThrottlerGuard`)가 기기 단위로 센다. 폰 라우트(로그인 · 가입)는
 * 여전히 Next 주소 하나를 같이 쓴다 — T111.
```

`app.module`을 등록 검사하는 기존 스펙이 `ThrottlerGuard`를 이름으로 찾으면(`grep -rn "ThrottlerGuard" backend/src --include=*.spec.ts`) `DeviceThrottlerGuard`로 고친다.

- [ ] **Step 8: 전체 확인**

Run: `npm run typecheck && npm run test && npm run test:int`
Expected: 타입 에러 0, 단위·통합 전부 통과. 통합에서 `/enter`·`/dealer/auth`를 HTTP로 부르는 스펙이 있어 깨지면, 그 스펙이 `signDeviceToken`으로 토큰을 만들어 `x-device-token`에 싣도록 고친다(서비스를 직접 부르는 스펙은 영향 없다).

- [ ] **Step 9: Commit**

```bash
git add backend/src
git commit -m "feat(T112): 입장·딜러 인증에 기기 문을 세우고 상한을 기기 단위로 가른다"
```

---

### Task 3: 태블릿 등록 화면 · 헤더 싣기 · 콘솔 해제 버튼 (프론트)

**Files:**
- Create: `frontend/src/lib/device-token.ts`
- Create: `frontend/src/lib/device-token.test.ts`
- Create: `frontend/src/app/(terminal)/device-action.ts`
- Create: `frontend/src/app/(terminal)/device-action.test.ts`
- Create: `frontend/src/app/(terminal)/DeviceRegistration.tsx`
- Modify: `frontend/src/app/(terminal)/table/page.tsx` · `page.test.tsx`
- Modify: `frontend/src/app/(terminal)/dealer/page.tsx` · `page.test.tsx`
- Modify: `frontend/src/app/(terminal)/table/action.ts` · `action.test.ts`
- Modify: `frontend/src/app/(terminal)/dealer/action.ts` · `action.test.ts`
- Modify: `frontend/src/app/api/ws-ticket/route.ts` (+ 같은 폴더에 테스트가 있으면 함께)
- Modify: `frontend/src/app/(console)/stores/[storeId]/tournaments/[tournamentId]/action.ts` · `action.test.ts`
- Modify: `.../[tournamentId]/ConsoleClient.tsx` · `ConsoleClient.test.tsx` · `page.tsx`

**Interfaces:**
- Consumes: `POST /auth/login` (`{ nickname, password }` → `{ accessToken }`), `POST /store/:storeId/devices` (Bearer → `{ deviceToken }`), `POST /store/:storeId/devices/revoke`, contract의 `DEVICE_TOKEN_COOKIE` · `DEVICE_TOKEN_HEADER` · `DEVICE_UNREGISTERED_MESSAGE`
- Produces:
  - `deviceStoreId(token: string | undefined): string | null` — 서명 검증 없이 페이로드의 `storeId`(화면을 고르는 용도뿐)
  - `deviceHeader(token: string | undefined): Record<string, string>` — 있으면 `{ 'x-device-token': token }`, 없으면 `{}`
  - `registerDevice(input: { storeId: string; nickname: string; password: string }): Promise<{ ok: true } | { error: string }>`
  - `revokeDevices(storeId: string): Promise<ActionResult>` (콘솔 `action.ts`의 기존 `ActionResult`)

- [ ] **Step 1: 실패하는 테스트 — 쿠키 해석**

`frontend/src/lib/device-token.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deviceHeader, deviceStoreId } from './device-token';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (payload: unknown) => `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`;

describe('deviceStoreId', () => {
  it('기기 토큰의 storeId를 읽는다', () => {
    expect(deviceStoreId(token({ role: 'STORE_DEVICE', storeId: 'store-1' }))).toBe('store-1');
  });
  it('기기 토큰이 아니면 null', () => {
    expect(deviceStoreId(token({ role: 'PLAYER', storeId: 'store-1' }))).toBeNull();
    expect(deviceStoreId('garbage')).toBeNull();
    expect(deviceStoreId(undefined)).toBeNull();
  });
});

describe('deviceHeader', () => {
  it('토큰이 있으면 헤더 하나, 없으면 빈 객체', () => {
    expect(deviceHeader('t')).toEqual({ 'x-device-token': 't' });
    expect(deviceHeader(undefined)).toEqual({});
  });
});
```

Run: `npm run test -w frontend -- src/lib/device-token.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 2: 구현**

`frontend/src/lib/device-token.ts`:

```ts
import { DEVICE_ROLE, DEVICE_TOKEN_HEADER } from '@playsync/contract';

/**
 * 매장 태블릿 기기 토큰(T112)의 프론트 쪽 해석.
 *
 * **서명을 검증하지 않는다.** 여기서 정하는 것은 「등록 폼을 그릴까」뿐이고,
 * 권한은 백엔드의 `DeviceGuard`가 매 요청 판정한다(`token-cookie.ts`와 같은 이유).
 */
export function deviceStoreId(token: string | undefined): string | null {
  const part = token?.split('.')[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return payload?.role === DEVICE_ROLE && typeof payload.storeId === 'string' ? payload.storeId : null;
  } catch {
    return null;
  }
}

/** Next 서버 쪽 fetch가 기기 토큰을 백엔드로 실어 나르는 헤더. */
export function deviceHeader(token: string | undefined): Record<string, string> {
  return token ? { [DEVICE_TOKEN_HEADER]: token } : {};
}
```

Run: `npm run test -w frontend -- src/lib/device-token.test.ts`
Expected: PASS

- [ ] **Step 3: 실패하는 테스트 — 등록 액션**

`frontend/src/app/(terminal)/device-action.test.ts` (`table/action.test.ts`의 msw · `next/headers` 목 방식을 그대로 따른다):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';

const cookieStore = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));

process.env.BACKEND_URL = 'http://backend.test';
const { registerDevice } = await import('./device-action');

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const DEVICE_TOKEN = `${b64({ alg: 'HS256' })}.${b64({ exp: Date.now() / 1000 + 3600, role: 'STORE_DEVICE', storeId: 'store-1' })}.sig`;

describe('registerDevice', () => {
  let seenAuth: string | null = null;

  beforeEach(() => {
    cookieStore.set.mockReset();
    seenAuth = null;
    server.use(
      http.post('http://backend.test/auth/login', () => HttpResponse.json({ accessToken: 'owner-token' })),
      http.post('http://backend.test/store/store-1/devices', ({ request }) => {
        seenAuth = request.headers.get('authorization');
        return HttpResponse.json({ deviceToken: DEVICE_TOKEN }, { status: 201 });
      }),
    );
  });

  it('점주 토큰으로 등록하고 deviceToken만 심는다', async () => {
    const result = await registerDevice({ storeId: 'store-1', nickname: 'owner', password: 'pw' });

    expect(result).toEqual({ ok: true });
    expect(seenAuth).toBe('Bearer owner-token');
    // 점주 세션이 태블릿에 남으면 손님 앞에 점주로 로그인된 기기가 놓인다.
    expect(cookieStore.set.mock.calls.map((c) => c[0])).toEqual(['deviceToken']);
    expect(cookieStore.set.mock.calls[0][2]).toMatchObject({ httpOnly: true, path: '/' });
  });

  it('로그인이 실패하면 백엔드 문구를 돌려주고 아무것도 안 심는다', async () => {
    server.use(
      http.post('http://backend.test/auth/login', () =>
        HttpResponse.json({ message: '아이디 또는 비밀번호가 틀렸습니다.' }, { status: 401 }),
      ),
    );
    const result = await registerDevice({ storeId: 'store-1', nickname: 'owner', password: 'x' });
    expect(result).toEqual({ error: '아이디 또는 비밀번호가 틀렸습니다.' });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it('남의 상점이면 403 문구를 돌려주고 아무것도 안 심는다', async () => {
    server.use(
      http.post('http://backend.test/store/store-1/devices', () =>
        HttpResponse.json({ message: '본인의 매장이 아닙니다.' }, { status: 403 }),
      ),
    );
    const result = await registerDevice({ storeId: 'store-1', nickname: 'owner', password: 'pw' });
    expect(result).toEqual({ error: '본인의 매장이 아닙니다.' });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });
});
```

Run: `npm run test -w frontend -- "src/app/(terminal)/device-action.test.ts"`
Expected: FAIL — 모듈 없음

- [ ] **Step 4: 구현**

`frontend/src/app/(terminal)/device-action.ts`:

```ts
'use server';

import { cookies } from 'next/headers';
import { DEVICE_TOKEN_COOKIE } from '@playsync/contract';
import { cookieMaxAgeFromToken } from '@/lib/token-cookie';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const DEFAULT_ERROR = '태블릿을 등록하지 못했습니다.';

function failureMessage(body: unknown): string {
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && message.length > 0) return message;
  if (Array.isArray(message) && message.length > 0) return message.join(' ');
  return DEFAULT_ERROR;
}

/**
 * 이 태블릿을 매장 태블릿으로 등록한다(T112).
 *
 * 점주가 태블릿 대기 화면에서 자기 계정을 넣는다. 로그인으로 받은 점주 토큰은
 * **등록 요청 하나에만 쓰고 버린다** — 쿠키에 남기면 손님 앞 태블릿이 점주로
 * 로그인된 채 놓인다. 심는 것은 기기 토큰 하나다.
 */
export async function registerDevice(input: {
  storeId: string;
  nickname: string;
  password: string;
}): Promise<{ ok: true } | { error: string }> {
  const login = await fetch(`${BACKEND_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: input.nickname, password: input.password }),
    cache: 'no-store',
  });
  const loginBody = await login.json().catch(() => null);
  if (!login.ok) return { error: failureMessage(loginBody) };
  const ownerToken = (loginBody as { accessToken: string }).accessToken;

  const res = await fetch(`${BACKEND_URL}/store/${input.storeId}/devices`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}` },
    cache: 'no-store',
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { error: failureMessage(body) };

  const deviceToken = (body as { deviceToken: string }).deviceToken;
  (await cookies()).set(DEVICE_TOKEN_COOKIE, deviceToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: cookieMaxAgeFromToken(deviceToken),
  });
  return { ok: true };
}
```

(`/auth/login` 본문의 키가 `nickname`이 아니면 `frontend/src/app/auth/action.ts`의 로그인 요청을 보고 맞춘다.)

Run: `npm run test -w frontend -- "src/app/(terminal)/device-action.test.ts"`
Expected: PASS (3)

- [ ] **Step 5: 등록 폼 컴포넌트**

`frontend/src/app/(terminal)/DeviceRegistration.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 등록 안 된 태블릿의 대기 화면(T112). 이 화면을 보는 사람은 태블릿을
 * 설치하는 직원이다 — 점주 계정을 넣으면 이 기기가 그 상점의 태블릿이 된다.
 */
export default function DeviceRegistration({
  storeId,
  register,
  notice,
}: {
  storeId: string;
  register: (input: { storeId: string; nickname: string; password: string }) => Promise<{ ok: true } | { error: string }>;
  notice?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(form: FormData) {
    setPending(true);
    setError(null);
    const result = await register({
      storeId,
      nickname: String(form.get('nickname') ?? ''),
      password: String(form.get('password') ?? ''),
    });
    setPending(false);
    if ('error' in result) setError(result.error);
    else router.refresh();
  }

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-4 bg-tb-bg p-8 text-tb-ink">
      <h1 className="text-xl font-semibold">매장 태블릿 등록</h1>
      <p>{notice ?? '이 기기는 아직 매장 태블릿으로 등록되지 않았습니다. 점주 계정으로 등록해 주세요.'}</p>
      <form action={onSubmit} className="flex flex-col gap-2">
        <input name="nickname" aria-label="점주 아이디" placeholder="점주 아이디" required className="border px-3 py-2" />
        <input name="password" aria-label="비밀번호" type="password" placeholder="비밀번호" required className="border px-3 py-2" />
        <button type="submit" disabled={pending} className="border px-3 py-2">
          {pending ? '등록 중…' : '이 기기 등록'}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
```

- [ ] **Step 6: 실패하는 테스트 — 대기 화면이 폼을 고른다**

`table/page.test.tsx`와 `dealer/page.test.tsx`에 각각 케이스 셋을 더한다(기존 파일의 렌더 · 목 방식을 따른다. `next/headers`를 아직 목하지 않으면 `vi.mock('next/headers', () => ({ cookies: async () => ({ get: (n: string) => (n === 'deviceToken' && current ? { value: current } : undefined) }) }))`로 `current`를 바꿔 가며 쓴다):

```ts
  it('기기 토큰이 없으면 등록 폼을 그린다', async () => {
    current = undefined;
    render(await SeatWaitingPage({ searchParams: Promise.resolve({ store: 'store-1' }) }));
    expect(screen.getByRole('heading', { name: '매장 태블릿 등록' })).toBeInTheDocument();
  });

  it('다른 상점의 기기 토큰이면 등록 폼을 그린다', async () => {
    current = token({ role: 'STORE_DEVICE', storeId: 'store-2' });
    render(await SeatWaitingPage({ searchParams: Promise.resolve({ store: 'store-1' }) }));
    expect(screen.getByRole('heading', { name: '매장 태블릿 등록' })).toBeInTheDocument();
  });

  it('이 상점의 기기 토큰이면 대기 화면을 그린다', async () => {
    current = token({ role: 'STORE_DEVICE', storeId: 'store-1' });
    render(await SeatWaitingPage({ searchParams: Promise.resolve({ store: 'store-1' }) }));
    expect(screen.queryByRole('heading', { name: '매장 태블릿 등록' })).not.toBeInTheDocument();
  });
```

(`dealer/page.test.tsx`에서는 `DealerWaitingPage`. `token()`은 Step 1과 같은 헬퍼를 파일 안에 둔다. 기존 케이스들은 `current`를 이 상점의 토큰으로 세운 상태에서 돌게 `beforeEach`에서 기본값을 준다.)

Run: `npm run test -w frontend -- "src/app/(terminal)"`
Expected: FAIL — 폼이 없다

- [ ] **Step 7: 두 페이지에 폼 분기**

`table/page.tsx`의 `if (!store) return ...` 바로 뒤에:

```tsx
  // T112. 이 상점에 등록된 태블릿만 입장 OTP를 넣을 수 있다. 쿠키가 없거나
  // 다른 상점 것이면 설치하는 직원에게 등록 폼을 보여 준다.
  const deviceToken = (await cookies()).get(DEVICE_TOKEN_COOKIE)?.value;
  const deviceStore = deviceStoreId(deviceToken);
  if (deviceStore !== store) {
    return (
      <DeviceRegistration
        storeId={store}
        register={registerDevice}
        notice={deviceStore ? '이 기기는 다른 매장에 등록되어 있습니다. 이 매장으로 다시 등록해 주세요.' : undefined}
      />
    );
  }
```

import: `cookies`(`next/headers`), `DEVICE_TOKEN_COOKIE`(`@playsync/contract`), `deviceStoreId`(`@/lib/device-token`), `DeviceRegistration`(`../DeviceRegistration`), `registerDevice`(`../device-action`). `dealer/page.tsx`의 `if (!store)` 뒤에 같은 블록.

Run: `npm run test -w frontend -- "src/app/(terminal)"`
Expected: PASS

- [ ] **Step 8: 실패하는 테스트 — 두 액션이 헤더를 싣고, 기기 거절이면 쿠키를 지운다**

`table/action.test.ts`에 (기존 `cookieStore.get`을 `deviceToken`에 값을 주도록 세운다):

```ts
  it('기기 토큰을 x-device-token으로 싣는다', async () => {
    cookieStore.get.mockImplementation((n: string) => (n === 'deviceToken' ? { value: 'dev-1' } : undefined));
    let seen: string | null = null;
    server.use(
      http.post('http://backend.test/tournaments/trnmt-1/enter', ({ request }) => {
        seen = request.headers.get('x-device-token');
        return HttpResponse.json({ accessToken: SEAT_TOKEN });
      }),
    );
    await enterSeat(INPUT);
    expect(seen).toBe('dev-1');
  });

  it('기기 거절이면 deviceToken 쿠키를 지운다 — 다시 그리면 등록 폼이다', async () => {
    server.use(
      http.post('http://backend.test/tournaments/trnmt-1/enter', () =>
        HttpResponse.json({ message: DEVICE_UNREGISTERED_MESSAGE }, { status: 401 }),
      ),
    );
    const result = await enterSeat(INPUT);
    expect(result).toEqual({ error: DEVICE_UNREGISTERED_MESSAGE });
    expect(cookieStore.delete).toHaveBeenCalledWith('deviceToken');
  });

  it('OTP가 틀린 401은 쿠키를 지우지 않는다', async () => {
    server.use(
      http.post('http://backend.test/tournaments/trnmt-1/enter', () =>
        HttpResponse.json({ message: '인증 정보가 올바르지 않습니다.' }, { status: 401 }),
      ),
    );
    await enterSeat(INPUT);
    expect(cookieStore.delete).not.toHaveBeenCalledWith('deviceToken');
  });
```

`dealer/action.test.ts`에 같은 세 케이스(`authenticateDealer`, `http://backend.test/dealer/auth`).
import: `DEVICE_UNREGISTERED_MESSAGE` from `@playsync/contract`.

Run: `npm run test -w frontend -- "src/app/(terminal)/table/action.test.ts" "src/app/(terminal)/dealer/action.test.ts"`
Expected: FAIL — 헤더가 null, 쿠키를 안 지운다

- [ ] **Step 9: 두 액션 구현**

`table/action.ts`의 `enterSeat`:

```ts
  const cookieStore = await cookies();
  const res = await fetch(`${BACKEND_URL}/tournaments/${input.tournamentId}/enter`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...deviceHeader(cookieStore.get(DEVICE_TOKEN_COOKIE)?.value),
    },
    body: JSON.stringify({ otp: input.otp, tableId: input.tableId, seatIndex: input.seatIndex }),
    cache: 'no-store',
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const error = failureMessage(body);
    // T112. 해제됐거나 다른 상점 기기다. 쿠키를 지워 두면 화면을 다시 그릴 때
    // 등록 폼이 뜬다 — 직원이 무엇을 해야 하는지가 화면에 나온다.
    if (error === DEVICE_UNREGISTERED_MESSAGE) cookieStore.delete(DEVICE_TOKEN_COOKIE);
    return { error };
  }
```

(함수 아래쪽에 있던 `const cookieStore = await cookies();`는 지운다 — 위에서 이미 얻었다.) `dealer/action.ts`의 `authenticateDealer`도 같은 모양으로. import: `DEVICE_TOKEN_COOKIE`, `DEVICE_UNREGISTERED_MESSAGE` (`@playsync/contract`), `deviceHeader` (`@/lib/device-token`).

Run: 같은 명령
Expected: PASS

- [ ] **Step 10: ws-ticket 라우트가 헤더를 싣는다**

`frontend/src/app/api/ws-ticket/route.ts`의 백엔드 fetch 헤더를 `{ Authorization: `Bearer ${token}`, ...deviceHeader(cookieStore.get(DEVICE_TOKEN_COOKIE)?.value) }`로. 파일 JSDoc 끝에 한 문단:

```ts
 *
 * 기기 토큰도 싣는다(T112). 재접속은 이 라우트를 지나는데, 싣지 않으면 태블릿이
 * Next 주소 버킷에 남아 누가 그 버킷을 채우는 동안 다시 붙지 못한다.
```

같은 폴더에 테스트(`route.test.ts`)가 있으면 「기기 토큰을 x-device-token으로 싣는다」 케이스를 Step 8과 같은 모양으로 더한다. 없으면 만들지 않는다.

- [ ] **Step 11: 실패하는 테스트 — 콘솔의 전체 해제**

콘솔 `action.test.ts`에 (기존 `callConsoleApi` 경유 액션 테스트의 모양을 따른다):

```ts
  it('revokeDevices는 점주 토큰으로 상점의 기기 토큰을 전부 해제한다', async () => {
    let seenAuth: string | null = null;
    server.use(
      http.post('http://backend.test/store/store-1/devices/revoke', ({ request }) => {
        seenAuth = request.headers.get('authorization');
        return HttpResponse.json({ ok: true }, { status: 201 });
      }),
    );
    const result = await revokeDevices('store-1');
    expect('ok' in result).toBe(true);
    expect(seenAuth).toMatch(/^Bearer /);
  });
```

`ConsoleClient.test.tsx`에: 「매장 태블릿 전체 등록 해제」 버튼을 누르면 `window.confirm`이 참일 때만 `revokeDevices(storeId)`가 불린다(거짓이면 안 불린다) — 기존 `reissueDealerOtp` 버튼 테스트의 모양을 따른다.

Run: `npm run test -w frontend -- "src/app/(console)"`
Expected: FAIL

- [ ] **Step 12: 구현**

콘솔 `action.ts`에 (기존 `reissueDealerOtp` 옆, `callConsoleApi` 사용):

```ts
/**
 * 이 상점의 매장 태블릿 등록을 전부 해제한다(T112). 태블릿을 잃어버렸을 때
 * 쓴다 — 남은 태블릿은 대기 화면에서 다시 등록한다.
 */
export async function revokeDevices(storeId: string): Promise<ActionResult> {
  return toActionResult(await callConsoleApi(`/store/${storeId}/devices/revoke`, { method: 'POST' }));
}
```

(`toActionResult`라는 이름이 없으면 같은 파일의 `startTournament`가 `callConsoleApi` 결과를 `ActionResult`로 바꾸는 방식을 그대로 쓴다.)

`ConsoleClient`는 액션을 prop으로 받는다 — `revokeDevices: (storeId: string) => Promise<ActionResult>` prop을 더하고, 딜러 OTP 재발급 버튼 근처에 버튼을 둔다:

```tsx
<button
  type="button"
  onClick={async () => {
    if (!window.confirm('이 상점의 매장 태블릿 등록을 전부 해제합니다. 남은 태블릿은 다시 등록해야 합니다.')) return;
    const result = await revokeDevices(storeId);
    // 결과 표시는 재발급 버튼과 같은 자리 · 같은 방식을 쓴다.
  }}
>
  매장 태블릿 전체 등록 해제
</button>
```

`page.tsx`가 `ConsoleClient`에 `revokeDevices={revokeDevices}`를 넘긴다.

Run: `npm run test -w frontend && npm run typecheck`
Expected: 전부 통과, 타입 에러 0

- [ ] **Step 13: Commit**

```bash
git add frontend/src
git commit -m "feat(T112): 태블릿 등록 화면과 기기 토큰 싣기, 콘솔 전체 해제"
```

---

### Task 4: 하네스가 기기 토큰을 싣는다 (부하 · e2e · 실제 kill)

**Files:**
- Modify: `load/lib/api.js` (`enterSeat`, 딜러 인증 함수, 새 `registerDevice`)
- Modify: `load/scenarios/*.js` 중 `enterSeat`·딜러 인증을 부르는 곳 (`grep -rn "enterSeat\|dealerAuth\|dealer/auth" load/scenarios load/lib`)
- Modify: `frontend/e2e/fixtures/backstage.ts` (입장 API 호출)
- Modify: `frontend/e2e/fixtures/wire.ts` (딜러 인증 API 호출)
- Modify: 태블릿 브라우저 컨텍스트를 여는 픽스처 (`grep -rn "newContext\|newPage" frontend/e2e/fixtures`)
- Modify: `backend/test/outage/backend-kill.outage-spec.ts`, `backend/test/outage/redis-kill.outage-spec.ts`

**Interfaces:**
- Consumes: `POST /auth/login`, `POST /store/:storeId/devices` (Task 1), 헤더 `x-device-token` · 쿠키 `deviceToken` (Task 1 contract)
- 시드의 점주: 개발 시드 `owner` / `password123`(`backend/prisma/seed.ts`의 `DEMO_PASSWORD`), 부하 시드 `loadowner`(`seed-load.ts`의 `OWNER_NICKNAME`, 비밀번호는 `LOAD_PASSWORD`, 매니페스트의 `ownerNickname`)

- [ ] **Step 1: 실제 kill 스펙**

두 outage 스펙은 `http(...)` 헬퍼로 빌드한 백엔드를 부른다. 스펙의 준비 단계(대회를 만드는 곳)에서 점주로 로그인해 기기 토큰을 한 번 받고, `/enter`와 `/dealer/auth` 호출에 `x-device-token`을 싣는다. `http` 헬퍼가 헤더를 못 받으면 선택 인자 `headers`를 더한다. 점주 자격은 그 스펙이 대회를 만들 때 이미 쓰는 계정을 쓴다.

Run: `npm run test:outage` (Docker 필요, 약 3분)
Expected: 26 통과. Docker가 없으면 이 단계를 건너뛰고 보고에 「미실행」으로 적는다 — **통과했다고 쓰지 않는다.**

- [ ] **Step 2: e2e 픽스처**

- `backstage.ts`의 입장, `wire.ts`의 딜러 인증: 요청 헤더에 `x-device-token`.
- 토큰은 픽스처 하나(`fixtures/backstage.ts`에 `deviceTokenFor(request, storeId)`)가 `owner`/`password123`으로 로그인해 `POST /store/:storeId/devices`로 받는다. 상점마다 한 번만 받아 메모한다.
- 태블릿 화면(`/table` · `/dealer`)을 여는 브라우저 컨텍스트에 `context.addCookies([{ name: 'deviceToken', value, url: <프론트 기준 URL> }])`. 등록 폼은 e2e가 거치지 않는다 — 회귀 대상은 봉투 · 키 이름 · 상태 전이다.

Run: `npm run seed && npm run test:e2e` (백엔드 · 프론트가 떠 있어야 한다 — `frontend/e2e/README.md`)
Expected: 13 통과. 띄울 수 없으면 「미실행」으로 보고한다.

- [ ] **Step 3: 부하 하네스**

`load/lib/api.js`에:

```js
/**
 * 매장 태블릿 기기 토큰을 받는다(T112). 봇은 태블릿 하나처럼 굴어 이 토큰
 * 하나를 모두가 쓴다 — 기기 단위 버킷 하나라, 예전의 「k6 주소 하나」와 같은
 * 몫이다(부하 프로파일은 env로 상한을 올린다).
 */
export function registerDevice(ownerNickname, password, storeId) {
  const token = login(ownerNickname, password);
  const res = http.post(`${BASE}/store/${storeId}/devices`, null, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { step: 'register_device' },
  });
  return must(res, 201, 'register_device').json('deviceToken');
}
```

(`login`이 토큰이 아니라 응답을 돌려주면 그 모양에 맞춘다. `must`의 실제 시그니처를 따른다.) `enterSeat`와 딜러 인증 함수가 `deviceToken` 인자를 받아 `headers: { ...JSON_HEADERS, 'x-device-token': deviceToken }`로 싣는다. 시나리오의 `setup()`이 매니페스트의 점주로 한 번 받아 VU들에게 넘긴다.

Run: `cd load && npm test`
Expected: 39 통과 (창 큐 측정기 — 이 변경과 무관해야 한다)

- [ ] **Step 4: 전체 확인 · Commit**

Run: `npm run typecheck && npm run test`
Expected: 타입 에러 0, 전부 통과

```bash
git add load frontend/e2e backend/test/outage
git commit -m "test(T112): 부하·e2e·실제 kill 하네스가 기기 토큰을 싣는다"
```
