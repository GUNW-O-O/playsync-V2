# B1-A 딜러 인증 강화 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 딜러 OTP를 원격에서 무제한으로 추측할 수 있는 상태를 닫고, 딜러 토큰의 수명을 대회에 묶는다.

**Architecture:** OTP를 6자리 문자열로 바꿔 bcrypt 해시로만 저장하고, 실패 시도를 Redis 카운터로 대회 단위로 제한한다. 딜러 토큰은 1시간 만료를 유지하되 `/dealer/refresh`가 대회 상태와 세션 버전을 확인하고 갱신한다. 대회가 끝나거나 상점이 딜러를 내보내면 갱신이 실패해 토큰이 최대 1시간 안에 소멸한다.

**Tech Stack:** NestJS, Prisma(드라이버 어댑터), PostgreSQL, Redis(ioredis), bcrypt(이미 의존성에 있다), jest

## Global Constraints

- 위협 모델은 [`docs/threat-model.md`](../../threat-model.md)다. 이 계획은 그 문서의 관찰 3·4·8과 질문 Q2·Q5·Q6을 닫는다. Q1(WS)·Q3·Q4(테이블 배정·단말 신원)는 **이 계획 밖**이고 계획 B·C가 맡는다.
- **버그 수정은 실패하는 테스트로 재현한 뒤 고친다.** 새 테스트가 처음부터 통과하면 의심하고, 제품 코드를 되돌려 빨간불을 확인한다.
- 테스트 계층: 인프라 없는 것은 `*.spec.ts`(`npm run test`), Redis·PostgreSQL이 필요한 것은 `*.int-spec.ts`(`npm run test:int`).
- 통합 테스트에서 Prisma는 반드시 `closeTestPrisma()`로 닫는다. `$disconnect()`만 부르면 pg Pool이 남아 jest가 종료되지 않는다.
- 명령은 루트에서 실행한다. 백엔드 단독 실행은 `-w backend`를 붙인다.
- 기준선: 단위 122, 통합 199, 타입 에러 0. 이 계획이 끝나면 숫자가 늘어야 하고 줄어서는 안 된다.
- 커밋 메시지는 한국어. 기존 형식(`feat:`, `fix:`, `test:`, `refactor:`)을 따른다.
- 브랜치는 `main`이 아니라 티켓 브랜치에서 작업한다. 이 계획의 브랜치는 `feat/t23-dealer-auth`다.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `backend/src/dealer/dealer-otp.ts` | **생성** OTP 생성·해시·대조. 인프라 의존이 없는 순수 함수 |
| `backend/src/dealer/dealer-otp.spec.ts` | **생성** 위 모듈의 단위 테스트 |
| `backend/src/dealer/otp-attempts.ts` | **생성** Redis 실패 카운터. 잠금 판정만 하고 인증은 모른다 |
| `backend/src/dealer/dealer.service.ts` | **수정** 로그인 시 해시 대조 + 잠금 확인, 토큰 갱신, 내보내기 |
| `backend/src/dealer/dealer.controller.ts` | **수정** `POST /dealer/refresh` 추가, 죽은 OTP 구조분해 제거 |
| `backend/src/dealer/dealer.int-spec.ts` | **생성** 로그인·잠금·갱신의 통합 테스트 |
| `backend/src/store/session/session.service.int-spec.ts` | **생성** 지금은 `session.service.spec.ts`(단위)만 있다. 인프라가 필요한 검사는 새 파일에 넣는다 |
| `backend/src/auth/strategies/jwt.strategy.ts` | **수정** 딜러 페이로드에 `tokenVersion`을 실어 보낸다 |
| `backend/prisma/schema.prisma` | **수정** `Tournament.dealerOtp` 제거, `dealerOtpHash` 추가. `DealerSession.tokenVersion` 추가 |
| `backend/src/store/session/session.service.ts` | **수정** 대회 생성 시 OTP 생성·해시, 재발급, 내보내기 |
| `backend/src/store/session/session.controller.ts` | **수정** 재발급·내보내기 엔드포인트 |
| `backend/src/payment/payment.service.ts` | **수정** 죽은 OTP 구조분해 제거 |
| `backend/src/payment/payment.controller.ts` | **수정** 죽은 OTP 구조분해 제거 |
| `backend/shared/dto/dealer.dto.ts` | **수정** `otp`를 `number`에서 6자리 문자열로 |

**왜 `dealer-otp.ts`와 `otp-attempts.ts`를 가르나.** OTP 생성·대조는 인프라가 없어 단위 테스트로 빠르게 돈다. 실패 카운터는 Redis가 있어야 의미가 있다(TTL과 원자적 증가가 검증 대상이다). 한 파일에 두면 빠른 쪽이 느린 쪽에 끌려간다.

---

### Task 1: OTP 생성·해시·대조 모듈

**Files:**
- Create: `backend/src/dealer/dealer-otp.ts`
- Test: `backend/src/dealer/dealer-otp.spec.ts`

**Interfaces:**
- Consumes: 없음 (`node:crypto`, `bcrypt`)
- Produces:
  - `OTP_LENGTH: 6`
  - `generateDealerOtp(): string` — 항상 길이 6, 앞자리 0 허용
  - `hashDealerOtp(otp: string): Promise<string>`
  - `verifyDealerOtp(otp: string, hash: string): Promise<boolean>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/src/dealer/dealer-otp.spec.ts`:

```ts
import { OTP_LENGTH, generateDealerOtp, hashDealerOtp, verifyDealerOtp } from './dealer-otp';

describe('딜러 OTP', () => {
  it('항상 6자리이고 앞자리 0을 잃지 않는다', () => {
    // 숫자로 다루면 앞자리 0이 사라져 후보 공간이 10^6보다 작아진다.
    // 문자열로 뽑는 이유가 그것이므로 길이로 고정한다.
    for (let i = 0; i < 500; i++) {
      const otp = generateDealerOtp();
      expect(otp).toMatch(/^[0-9]{6}$/);
      expect(otp.length).toBe(OTP_LENGTH);
    }
  });

  it('같은 값을 두 번 뽑아도 해시가 다르다', async () => {
    const a = await hashDealerOtp('012345');
    const b = await hashDealerOtp('012345');
    expect(a).not.toBe(b);
  });

  it('해시에서 원본을 읽을 수 없다', async () => {
    const hash = await hashDealerOtp('012345');
    expect(hash).not.toContain('012345');
  });

  it('맞는 OTP만 통과한다', async () => {
    const hash = await hashDealerOtp('012345');
    await expect(verifyDealerOtp('012345', hash)).resolves.toBe(true);
    await expect(verifyDealerOtp('012346', hash)).resolves.toBe(false);
    await expect(verifyDealerOtp('12345', hash)).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm run test -w backend -- dealer-otp`
Expected: FAIL — `Cannot find module './dealer-otp'`

- [ ] **Step 3: 최소 구현**

`backend/src/dealer/dealer-otp.ts`:

```ts
import { randomInt } from 'node:crypto';
import * as bcrypt from 'bcrypt';

export const OTP_LENGTH = 6;

const SALT_ROUNDS = 10;

/**
 * OTP를 문자열로 다루는 이유.
 *
 * 이전 구현은 `Math.floor(1000 + Math.random() * 9000)`이었다. 두 가지가
 * 문제였다 — `Math.random()`은 암호학적 난수가 아니라 시드를 알면 예측되고,
 * `Int` 컬럼에 담느라 앞자리 0을 쓰지 못해 후보가 9000개뿐이었다.
 *
 * 문자열 + `randomInt`로 바꾸면 후보가 10^6이 되고 예측이 불가능해진다.
 */
export function generateDealerOtp(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

export function hashDealerOtp(otp: string): Promise<string> {
  return bcrypt.hash(otp, SALT_ROUNDS);
}

export function verifyDealerOtp(otp: string, hash: string): Promise<boolean> {
  return bcrypt.compare(otp, hash);
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm run test -w backend -- dealer-otp`
Expected: PASS, 4 tests

- [ ] **Step 5: 커밋**

```bash
git add backend/src/dealer/dealer-otp.ts backend/src/dealer/dealer-otp.spec.ts
git commit -m "feat: 딜러 OTP를 6자리 문자열과 bcrypt 해시로 다루는 모듈"
```

---

### Task 2: 스키마를 해시로 바꾸고 생성 경로를 옮긴다

**Files:**
- Modify: `backend/prisma/schema.prisma:126` (`dealerOtp Int` → `dealerOtpHash String`), `:193-200` (`DealerSession`에 `tokenVersion`)
- Modify: `backend/src/store/session/session.service.ts:151`
- Modify: `backend/src/dealer/dealer.controller.ts:16`, `backend/src/payment/payment.service.ts:45`, `backend/src/payment/payment.controller.ts:21`
- Modify: `backend/src/dealer/dealer.service.ts:48`
- Test: `backend/src/store/session/session.service.int-spec.ts` (기존 파일이 있으면 추가, 없으면 생성)

**Interfaces:**
- Consumes: Task 1의 `generateDealerOtp`, `hashDealerOtp`
- Produces:
  - `Tournament.dealerOtpHash: string` — 응답에 담아서는 안 되는 값
  - `DealerSession.tokenVersion: number` — Task 4가 쓴다
  - `SessionService.createSession(...)`의 반환에 `dealerOtp: string`이 **한 번만** 실린다 (평문. 이후로는 어디에도 남지 않는다)

**왜 이 셋을 한 태스크로 묶나.** 컬럼 이름이 바뀌면 그 컬럼을 구조분해로 빼던 세 곳이 컴파일되지 않는다. 나눠 커밋하면 중간 상태에서 타입 체크가 깨진다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/src/store/session/session.service.int-spec.ts`를 **새로 만든다.** 지금 이 디렉터리에는 `session.service.spec.ts`(단위)만 있고 통합 스펙이 없다. 단위 스펙은 그대로 두고, `test/helpers/prisma.ts`의 `createTestPrisma` / `closeTestPrisma`를 써서 다른 `*.int-spec.ts`와 같은 형태로 만든다.

```ts
it('대회를 만들면 평문 OTP는 반환에만 있고 DB에는 해시만 남는다', async () => {
  const created = await sessionService.createSession(makeCreateDto());

  expect(created.dealerOtp).toMatch(/^[0-9]{6}$/);

  const row = await prisma.tournament.findUniqueOrThrow({
    where: { id: created.id },
    select: { dealerOtpHash: true },
  });

  // 해시가 원본을 담고 있으면 저장한 의미가 없다.
  expect(row.dealerOtpHash).not.toContain(created.dealerOtp);
  expect(row.dealerOtpHash.startsWith('$2')).toBe(true);
});

it('대회 조회 응답에는 OTP도 해시도 실리지 않는다', async () => {
  const created = await sessionService.createSession(makeCreateDto());

  const fetched = await sessionService.getGameSession(created.id);

  expect(fetched).not.toHaveProperty('dealerOtp');
  expect(fetched).not.toHaveProperty('dealerOtpHash');
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm run test:int -w backend -- session.service`
Expected: FAIL — `dealerOtpHash` 필드가 없다는 Prisma 타입/런타임 에러

- [ ] **Step 3: 스키마를 바꾸고 마이그레이션을 만든다**

`backend/prisma/schema.prisma`의 `Tournament`에서 126번째 줄을 바꾼다:

```prisma
  // 평문은 생성·재발급 응답에 한 번만 실린다. 저장은 해시로만 한다.
  dealerOtpHash String
```

`DealerSession`에 필드를 추가한다:

```prisma
model DealerSession {
  id String @id @default(uuid())

  // 상점이 딜러를 내보내면 올라간다. 갱신이 이 값을 대조하므로 기존 토큰은
  // 남은 만료 시간(최대 1시간) 안에 소멸한다.
  tokenVersion Int @default(0)

  tournamentId String     @unique
  tournament   Tournament @relation(fields: [tournamentId], references: [id], onDelete: Cascade)
  tables       Table[]
}
```

마이그레이션을 만든다. **기존 개발 DB의 OTP 값은 버려진다** — 평문에서 해시로 옮길 방법이 없고, 개발 데이터라 문제되지 않는다.

```bash
cd backend && npx prisma migrate dev --name dealer_otp_hash
```

- [ ] **Step 4: 생성 경로를 바꾼다**

`backend/src/store/session/session.service.ts` — `dealerOtp: Math.floor(...)` 자리(151번째 줄 부근). 트랜잭션 **바깥**에서 미리 뽑아 둔다. bcrypt 해싱은 CPU 작업이라 트랜잭션 안에서 돌리면 커넥션을 잡은 채 기다린다:

```ts
// 트랜잭션 진입 전
const dealerOtp = generateDealerOtp();
const dealerOtpHash = await hashDealerOtp(dealerOtp);
```

`tournament.create`의 `data`에서:

```ts
          dealerOtpHash,
```

그리고 이 함수의 반환에 평문을 **한 번만** 실어 보낸다:

```ts
      return { ...session, dealerOtp };
```

- [ ] **Step 5: 죽은 구조분해 세 곳을 지운다**

컬럼이 사라졌으므로 아래 세 줄은 컴파일되지 않는다. 구조분해를 **제거**한다 — 이제 조회 결과에 OTP가 애초에 없다.

`backend/src/dealer/dealer.controller.ts:16-17`:

```ts
    return data;
```

`backend/src/payment/payment.service.ts:45`:

```ts
    const tournament = data;
```

`backend/src/payment/payment.controller.ts:21`:

```ts
    return data;
```

`backend/src/dealer/dealer.service.ts:48`의 대조는 이 태스크에서 임시로 컴파일만 되게 둔다. Task 3이 제대로 고친다:

```ts
      if (!tournament) {
        throw new UnauthorizedException('인증 정보가 올바르지 않습니다.');
      }
```

> **주의:** 이 상태에서는 **OTP 대조가 사라져 아무 값이나 통과한다.** Task 3이 곧바로 이어져야 한다. 커밋 메시지에 그 사실을 적는다.

- [ ] **Step 6: 프론트가 이 필드를 읽는지 확인한다**

Run: `git grep -n "dealerOtp" -- frontend packages` (루트에서)
Expected: 결과가 있으면 그 자리도 함께 고친다. 없으면 다음 단계로.

- [ ] **Step 7: 타입 체크와 테스트**

Run: `npm run typecheck`
Expected: 에러 0

Run: `npm run test:int -w backend -- session.service`
Expected: PASS

- [ ] **Step 8: 커밋**

```bash
git add backend/prisma backend/src/store/session backend/src/dealer backend/src/payment
git commit -m "refactor: 딜러 OTP를 해시 컬럼으로 옮기고 수동 제거 세 곳을 없앤다

컬럼이 dealerOtpHash로 바뀌어 조회 결과에 OTP가 아예 없다. 응답마다 손으로
빼던 세 곳이 필요 없어졌다.

대조 로직은 이 커밋에서 비어 있다. 다음 커밋이 해시 대조로 채운다."
```

---

### Task 3: 해시 대조와 실패 시도 제한

**Files:**
- Create: `backend/src/dealer/otp-attempts.ts`
- Modify: `backend/src/dealer/dealer.service.ts:39-87`
- Modify: `backend/shared/dto/dealer.dto.ts`
- Test: `backend/src/dealer/dealer.int-spec.ts` (생성)

**Interfaces:**
- Consumes: Task 1의 `verifyDealerOtp`, Task 2의 `Tournament.dealerOtpHash`
- Produces:
  - `OtpAttempts.assertNotLocked(tournamentId: string): Promise<void>` — 잠겨 있으면 던진다
  - `OtpAttempts.recordFailure(tournamentId: string): Promise<number>` — 증가 후 횟수 반환
  - `OtpAttempts.clear(tournamentId: string): Promise<void>`
  - 상수 `MAX_ATTEMPTS = 5`, `LOCK_SECONDS = 300`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/src/dealer/dealer.int-spec.ts`:

```ts
describe('딜러 로그인', () => {
  it('맞는 OTP는 통과하고 틀린 OTP는 거부된다', async () => {
    const { tournamentId, tableId, otp } = await seedTournament();

    await expect(
      dealerService.loginDealer({ tournamentId, tableId, otp: '000000' }),
    ).rejects.toThrow(UnauthorizedException);

    const result = await dealerService.loginDealer({ tournamentId, tableId, otp });
    expect(typeof result.accessToken).toBe('string');
  });

  it('5회 실패하면 맞는 OTP도 거부된다', async () => {
    const { tournamentId, tableId, otp } = await seedTournament();

    for (let i = 0; i < 5; i++) {
      await expect(
        dealerService.loginDealer({ tournamentId, tableId, otp: '000000' }),
      ).rejects.toThrow(UnauthorizedException);
    }

    // 여기가 핵심이다. 잠금이 없으면 이 줄이 통과해 버린다.
    await expect(
      dealerService.loginDealer({ tournamentId, tableId, otp }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('잠금은 대회 단위다 — 다른 대회는 영향받지 않는다', async () => {
    const a = await seedTournament();
    const b = await seedTournament();

    for (let i = 0; i < 5; i++) {
      await expect(
        dealerService.loginDealer({ tournamentId: a.tournamentId, tableId: a.tableId, otp: '000000' }),
      ).rejects.toThrow(UnauthorizedException);
    }

    const result = await dealerService.loginDealer({
      tournamentId: b.tournamentId,
      tableId: b.tableId,
      otp: b.otp,
    });
    expect(typeof result.accessToken).toBe('string');
  });

  it('성공하면 실패 카운터가 지워진다', async () => {
    const { tournamentId, tableId, otp } = await seedTournament();

    for (let i = 0; i < 4; i++) {
      await expect(
        dealerService.loginDealer({ tournamentId, tableId, otp: '000000' }),
      ).rejects.toThrow(UnauthorizedException);
    }

    await dealerService.loginDealer({ tournamentId, tableId, otp });

    // 카운터가 지워지지 않았다면 다음 실패 하나로 잠긴다.
    await expect(
      dealerService.loginDealer({ tournamentId, tableId, otp: '000000' }),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      dealerService.loginDealer({ tournamentId, tableId, otp }),
    ).resolves.toBeDefined();
  });
});
```

`seedTournament()`은 `createTestPrisma()`로 상점·블라인드·대회·딜러 세션·테이블을 만들고 평문 OTP를 함께 돌려주는 헬퍼다. `backend/src/scenario/harness.ts`에 이미 대회를 심는 코드가 있으므로 먼저 읽고 그 형태를 따른다.

- [ ] **Step 2: 실패를 확인한다**

Run: `npm run test:int -w backend -- dealer.int-spec`
Expected: FAIL — 잠금 테스트에서 `ForbiddenException`이 아니라 성공한다 (Task 2가 대조를 비워 뒀으므로 첫 테스트도 실패한다)

- [ ] **Step 3: 카운터를 만든다**

`backend/src/dealer/otp-attempts.ts`:

```ts
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';

export const MAX_ATTEMPTS = 5;
export const LOCK_SECONDS = 300;

/**
 * 잠금을 대회 단위로 거는 이유.
 *
 * IP 단위로 걸면 공격자가 주소를 바꿔가며 빠져나간다. 계정 단위로는 걸 수
 * 없다 — 딜러는 계정이 아니라 역할이고, OTP를 넣기 전에는 신원이 없다.
 *
 * 대가는 정상 딜러가 남의 오타로 5분 막힐 수 있다는 것이다. 대회당 한 번
 * 입력하는 값이라 그 5분이 반복되지 않고, 상점 콘솔의 재발급이 탈출구다.
 */
@Injectable()
export class OtpAttempts {
  // RedisService는 ioredis 인스턴스를 `private readonly redis`로 감추고 있어
  // 밖에서 명령을 직접 부를 수 없다. 카운터는 RedisService의 도메인 메서드와
  // 성격이 다르므로 그쪽에 메서드를 늘리지 않고 같은 토큰을 직접 주입한다.
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  private key(tournamentId: string) {
    return `dealer:otp:fail:${tournamentId}`;
  }

  async assertNotLocked(tournamentId: string): Promise<void> {
    const raw = await this.redis.get(this.key(tournamentId));
    if (raw !== null && Number(raw) >= MAX_ATTEMPTS) {
      throw new ForbiddenException(
        '인증 시도가 너무 많습니다. 잠시 후 다시 시도하거나 상점에 문의해주세요.',
      );
    }
  }

  async recordFailure(tournamentId: string): Promise<number> {
    const key = this.key(tournamentId);
    // INCR과 EXPIRE를 한 왕복으로 묶는다. 사이에 끼어들면 TTL 없는 키가 남아
    // 영영 잠긴다.
    const [count] = await this.redis
      .multi()
      .incr(key)
      .expire(key, LOCK_SECONDS)
      .exec() as [[Error | null, number], ...unknown[]];
    return count[1];
  }

  async clear(tournamentId: string): Promise<void> {
    await this.redis.del(this.key(tournamentId));
  }
}
```

`backend/src/dealer/dealer.module.ts`의 `providers`에 `OtpAttempts`를, `exports`에도 추가한다 — Task 5의 `SessionService`가 같은 인스턴스를 쓴다. `'REDIS_CLIENT'` 토큰을 제공하는 모듈(`backend/src/redis/redis.module.ts`)이 `DealerModule`에 import돼 있는지 확인한다.

- [ ] **Step 4: DTO를 문자열로 바꾼다**

`backend/shared/dto/dealer.dto.ts`:

```ts
import { IsString, Matches } from "class-validator";

export class DealerDto {

  @IsString()
  tournamentId: string;

  @IsString()
  tableId: string;

  // 앞자리 0이 유효한 값이므로 숫자로 받으면 안 된다.
  @Matches(/^[0-9]{6}$/, { message: 'OTP는 6자리 숫자입니다.' })
  otp: string;

}
```

- [ ] **Step 5: 대조를 채운다**

`backend/src/dealer/dealer.service.ts`의 `loginDealer`. 잠금 확인과 해시 대조는 **트랜잭션 밖**에서 한다 — bcrypt와 Redis 왕복을 트랜잭션 안에 넣을 이유가 없다:

```ts
  async loginDealer(dto: DealerDto) {
    await this.otpAttempts.assertNotLocked(dto.tournamentId);

    const tournament = await this.prisma.tournament.findUnique({
      where: { id: dto.tournamentId },
      include: { dealerSession: true },
    });

    // 대회가 없을 때와 OTP가 틀렸을 때의 응답을 가르지 않는다. 가르면
    // 존재하는 대회 id를 훑을 수 있다.
    const ok =
      tournament !== null &&
      (await verifyDealerOtp(dto.otp, tournament.dealerOtpHash));

    if (!ok) {
      await this.otpAttempts.recordFailure(dto.tournamentId);
      throw new UnauthorizedException('인증 정보가 올바르지 않습니다.');
    }

    // 끝난 대회의 OTP는 더 이상 유효하지 않다.
    if (tournament.status === TournamentStatus.COMPLETED) {
      throw new ForbiddenException('종료된 대회입니다.');
    }

    if (!tournament.dealerSession) {
      throw new ConflictException(
        '딜러 세션이 준비되지 않았습니다. 상점에 문의해주세요.',
      );
    }

    await this.otpAttempts.clear(dto.tournamentId);

    return this.prisma.$transaction(async (tx) => {
      // `tournament.status === 'ONGOING'`일 때 그 테이블의 참가자를 WAITING에서
      // PLAYING으로 올리는 분기(현재 dealer.service.ts:58-76)는 손대지 않는다.
      // 그대로 옮겨 온다.
      const accessToken = {
        sub: tournament.dealerSession!.id,
        tournamentId: dto.tournamentId,
        tableId: dto.tableId,
        role: Role.DEALER,
        tokenVersion: tournament.dealerSession!.tokenVersion,
      };
      return { accessToken: this.jwtService.sign(accessToken) };
    });
  }
```

- [ ] **Step 6: 통과를 확인한다**

Run: `npm run test:int -w backend -- dealer.int-spec`
Expected: PASS, 4 tests

- [ ] **Step 7: 초록이 거짓말인지 확인한다**

`otp-attempts.ts`의 `assertNotLocked` 본문을 임시로 `return;`으로 바꾼다.

Run: `npm run test:int -w backend -- dealer.int-spec`
Expected: FAIL — 잠금 테스트 둘이 빨간불

되돌린다: `git checkout backend/src/dealer/otp-attempts.ts`

- [ ] **Step 8: 커밋**

```bash
git add backend/src/dealer backend/shared/dto/dealer.dto.ts
git commit -m "feat: 딜러 OTP를 해시로 대조하고 실패 5회에 5분 잠근다

잠금은 대회 단위다. IP 단위는 주소를 바꾸면 빠져나가고, 계정 단위는 OTP를
넣기 전에 신원이 없어 걸 수 없다."
```

---

### Task 4: 딜러 토큰 갱신

**Files:**
- Modify: `backend/src/dealer/dealer.service.ts`
- Modify: `backend/src/dealer/dealer.controller.ts`
- Modify: `backend/src/auth/strategies/jwt.strategy.ts:33-40`
- Test: `backend/src/dealer/dealer.int-spec.ts`

**Interfaces:**
- Consumes: Task 2의 `DealerSession.tokenVersion`, Task 3이 토큰에 넣은 `tokenVersion` 클레임
- Produces:
  - `DealerService.refreshToken(payload: { sub: string; tournamentId: string; tableId: string; tokenVersion: number }): Promise<{ accessToken: string }>`
  - `POST /dealer/refresh` — `JwtAuthGuard` 뒤. 본문 없음, 현재 토큰이 자격이다

**왜 갱신인가.** 토큰 만료는 1시간인데 대회는 몇 시간이다. 만료를 대회 길이로 늘리면 유출된 토큰이 대회 내내 살고, 폐기하려면 요청마다 상태를 조회해야 한다. 갱신으로 두면 유출 토큰의 수명이 최대 1시간이고 상태 조회는 시간당 한 번이다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
describe('딜러 토큰 갱신', () => {
  it('진행 중인 대회는 갱신된다', async () => {
    const { tournamentId, tableId, otp } = await seedTournament({ status: 'ONGOING' });
    const { accessToken } = await dealerService.loginDealer({ tournamentId, tableId, otp });

    const payload = jwtService.verify(accessToken);
    const refreshed = await dealerService.refreshToken(payload);

    expect(jwtService.verify(refreshed.accessToken).sub).toBe(payload.sub);
  });

  it('종료된 대회는 갱신되지 않는다', async () => {
    const { tournamentId, tableId, otp } = await seedTournament({ status: 'ONGOING' });
    const { accessToken } = await dealerService.loginDealer({ tournamentId, tableId, otp });
    const payload = jwtService.verify(accessToken);

    await prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: 'COMPLETED' },
    });

    await expect(dealerService.refreshToken(payload)).rejects.toThrow(ForbiddenException);
  });

  it('세션 버전이 올라가면 갱신되지 않는다', async () => {
    const { tournamentId, tableId, otp, dealerSessionId } = await seedTournament({ status: 'ONGOING' });
    const { accessToken } = await dealerService.loginDealer({ tournamentId, tableId, otp });
    const payload = jwtService.verify(accessToken);

    await prisma.dealerSession.update({
      where: { id: dealerSessionId },
      data: { tokenVersion: { increment: 1 } },
    });

    await expect(dealerService.refreshToken(payload)).rejects.toThrow(ForbiddenException);
  });

  it('갱신된 토큰은 원래 토큰과 같은 테이블을 가리킨다', async () => {
    const { tournamentId, tableId, otp } = await seedTournament({ status: 'ONGOING' });
    const { accessToken } = await dealerService.loginDealer({ tournamentId, tableId, otp });
    const payload = jwtService.verify(accessToken);

    const refreshed = await dealerService.refreshToken(payload);

    // 갱신이 테이블을 바꿀 수 있으면 갱신 자체가 권한 상승 경로가 된다.
    expect(jwtService.verify(refreshed.accessToken).tableId).toBe(tableId);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm run test:int -w backend -- dealer.int-spec`
Expected: FAIL — `dealerService.refreshToken is not a function`

- [ ] **Step 3: 구현**

`backend/src/dealer/dealer.service.ts`:

```ts
  /**
   * 갱신은 새 권한을 만들지 않는다.
   *
   * tableId와 sub를 기존 토큰에서 그대로 옮긴다. 클라이언트가 보낸 값을 하나라도
   * 받으면 갱신이 "아무 테이블 딜러가 되는 경로"가 된다.
   */
  async refreshToken(payload: {
    sub: string;
    tournamentId: string;
    tableId: string;
    tokenVersion: number;
  }) {
    const session = await this.prisma.dealerSession.findUnique({
      where: { id: payload.sub },
      include: { tournament: { select: { status: true } } },
    });

    if (!session || session.tournamentId !== payload.tournamentId) {
      throw new ForbiddenException('갱신할 수 없는 세션입니다.');
    }
    if (session.tournament.status === TournamentStatus.COMPLETED) {
      throw new ForbiddenException('종료된 대회입니다.');
    }
    if (session.tokenVersion !== payload.tokenVersion) {
      throw new ForbiddenException('만료된 딜러 세션입니다.');
    }

    return {
      accessToken: this.jwtService.sign({
        sub: session.id,
        tournamentId: session.tournamentId,
        tableId: payload.tableId,
        role: Role.DEALER,
        tokenVersion: session.tokenVersion,
      }),
    };
  }
```

`backend/src/dealer/dealer.controller.ts`:

```ts
  @UseGuards(JwtAuthGuard)
  @Post('refresh')
  async refresh(@Req() req: any) {
    if (req.user.role !== Role.DEALER) {
      throw new ForbiddenException('딜러 토큰이 아닙니다.');
    }
    // JwtStrategy가 딜러 페이로드의 `sub`를 `id`로 바꿔 내보낸다.
    return this.dealerService.refreshToken({
      sub: req.user.id,
      tournamentId: req.user.tournamentId,
      tableId: req.user.tableId,
      tokenVersion: req.user.tokenVersion,
    });
  }
```

**`JwtStrategy`도 함께 고쳐야 한다.** 지금 딜러 분기는 네 필드만 골라 내보내고 `tokenVersion`이 빠져 있다. 빠진 채로 두면 `refreshToken`이 `undefined !== 0`으로 **모든 갱신을 거부한다.** `backend/src/auth/strategies/jwt.strategy.ts`의 `validate`:

```ts
    if(payload.role === Role.DEALER) {
      return {
        id : payload.sub,
        tournamentId: payload.tournamentId,
        tableId: payload.tableId,
        tokenVersion: payload.tokenVersion,
        role: Role.DEALER,
      }
    }
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm run test:int -w backend -- dealer.int-spec`
Expected: PASS, 8 tests

- [ ] **Step 5: 커밋**

```bash
git add backend/src/dealer
git commit -m "feat: 딜러 토큰 갱신을 대회 상태와 세션 버전에 묶는다

만료는 1시간을 유지한다. 대회 길이로 늘리면 유출 토큰이 대회 내내 살고
폐기하려면 요청마다 상태를 조회해야 한다."
```

---

### Task 5: OTP 재발급과 딜러 내보내기

**Files:**
- Modify: `backend/src/store/session/session.service.ts`
- Modify: `backend/src/store/session/session.controller.ts`
- Test: `backend/src/store/session/session.service.int-spec.ts`

**Interfaces:**
- Consumes: Task 1의 `generateDealerOtp`/`hashDealerOtp`, Task 3의 `OtpAttempts.clear`, Task 4의 `tokenVersion`
- Produces:
  - `SessionService.reissueDealerOtp(tournamentId: string): Promise<{ dealerOtp: string }>`
  - `SessionService.revokeDealerSession(tournamentId: string): Promise<void>`
  - `POST /session/:id/dealer-otp/reissue`, `POST /session/:id/dealer-session/revoke` — 둘 다 `JwtAuthGuard`, `RolesGuard` 뒤

**왜 둘이 다른 동작인가.** 재발급은 태블릿이 토큰을 잃었을 때 다시 들어오라는 뜻이고, **이미 붙어 있는 딜러는 끊지 않는다**(갱신이 계속 통과한다). 내보내기는 반대로 붙어 있는 쪽을 끊는다. 한 버튼으로 묶으면 태블릿 하나가 재부팅됐다고 나머지 테이블 딜러가 전부 튕긴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
it('OTP를 재발급하면 옛 OTP는 막히고 새 OTP가 통과한다', async () => {
  const { tournamentId, tableId, otp: oldOtp } = await seedTournament({ status: 'ONGOING' });

  const { dealerOtp: newOtp } = await sessionService.reissueDealerOtp(tournamentId);

  expect(newOtp).not.toBe(oldOtp);
  await expect(
    dealerService.loginDealer({ tournamentId, tableId, otp: oldOtp }),
  ).rejects.toThrow(UnauthorizedException);
  await expect(
    dealerService.loginDealer({ tournamentId, tableId, otp: newOtp }),
  ).resolves.toBeDefined();
});

it('재발급은 잠금을 푼다', async () => {
  const { tournamentId, tableId } = await seedTournament({ status: 'ONGOING' });

  for (let i = 0; i < 5; i++) {
    await expect(
      dealerService.loginDealer({ tournamentId, tableId, otp: '000000' }),
    ).rejects.toThrow(UnauthorizedException);
  }

  const { dealerOtp } = await sessionService.reissueDealerOtp(tournamentId);

  await expect(
    dealerService.loginDealer({ tournamentId, tableId, otp: dealerOtp }),
  ).resolves.toBeDefined();
});

it('재발급은 이미 붙어 있는 딜러를 끊지 않는다', async () => {
  const { tournamentId, tableId, otp } = await seedTournament({ status: 'ONGOING' });
  const { accessToken } = await dealerService.loginDealer({ tournamentId, tableId, otp });
  const payload = jwtService.verify(accessToken);

  await sessionService.reissueDealerOtp(tournamentId);

  await expect(dealerService.refreshToken(payload)).resolves.toBeDefined();
});

it('내보내기는 붙어 있는 딜러의 갱신을 막는다', async () => {
  const { tournamentId, tableId, otp } = await seedTournament({ status: 'ONGOING' });
  const { accessToken } = await dealerService.loginDealer({ tournamentId, tableId, otp });
  const payload = jwtService.verify(accessToken);

  await sessionService.revokeDealerSession(tournamentId);

  await expect(dealerService.refreshToken(payload)).rejects.toThrow(ForbiddenException);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm run test:int -w backend -- session.service`
Expected: FAIL — `reissueDealerOtp is not a function`

- [ ] **Step 3: 구현**

`backend/src/store/session/session.service.ts`:

```ts
  /**
   * 태블릿이 토큰을 잃었을 때 쓰는 탈출구다. 해시로 저장하므로 원본을 다시
   * 보여줄 방법이 없고, 대신 새로 발급한다.
   *
   * 이미 붙어 있는 딜러는 끊지 않는다 — 그들은 갱신으로 살아 있고, 갱신은
   * OTP가 아니라 tokenVersion을 본다.
   */
  async reissueDealerOtp(tournamentId: string): Promise<{ dealerOtp: string }> {
    const dealerOtp = generateDealerOtp();
    const dealerOtpHash = await hashDealerOtp(dealerOtp);

    await this.prismaService.tournament.update({
      where: { id: tournamentId },
      data: { dealerOtpHash },
    });

    // 재발급은 잠금을 푼다. 잠긴 원인이 남의 오타였다면 상점이 여기서 풀 수
    // 있어야 하고, 공격자였다면 값이 이미 바뀌어 카운터가 의미 없다.
    await this.otpAttempts.clear(tournamentId);

    return { dealerOtp };
  }

  /** 붙어 있는 딜러를 끊는다. 남은 토큰은 만료(최대 1시간)까지 살아 있다. */
  async revokeDealerSession(tournamentId: string): Promise<void> {
    await this.prismaService.dealerSession.update({
      where: { tournamentId },
      data: { tokenVersion: { increment: 1 } },
    });
  }
```

`backend/src/store/session/session.controller.ts` — 기존 가드·`@Roles` 사용 형태를 그대로 따른다:

```ts
  @Post(':id/dealer-otp/reissue')
  async reissueDealerOtp(@Param('id') tournamentId: string) {
    return this.sessionService.reissueDealerOtp(tournamentId);
  }

  @Post(':id/dealer-session/revoke')
  async revokeDealerSession(@Param('id') tournamentId: string) {
    await this.sessionService.revokeDealerSession(tournamentId);
    return { ok: true };
  }
```

`SessionService`의 생성자에 `OtpAttempts`를 주입하고, `session.module.ts`가 그것을 제공하는지 확인한다. `DealerModule`이 이미 제공한다면 `exports`에 넣고 `SessionModule`에서 import한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `npm run test:int -w backend -- session.service`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add backend/src/store/session
git commit -m "feat: OTP 재발급과 딜러 내보내기

재발급은 붙어 있는 딜러를 끊지 않고, 내보내기는 끊는다. 한 버튼으로 묶으면
태블릿 하나가 재부팅됐다고 나머지 테이블이 전부 튕긴다."
```

---

### Task 6: 전체 검증과 문서

**Files:**
- Modify: `docs/tickets-next.md` (T23 항목 추가, 진행 현황 표 갱신)
- Modify: `docs/threat-model.md` (관찰 3·4·8과 질문 Q2·Q5·Q6에 처리 상태 표시)
- Modify: `docs/backlog.md` (B1의 남은 범위를 계획 B·C로 명시)

- [ ] **Step 1: 전체 테스트**

Run: `npm run typecheck`
Expected: 에러 0

Run: `npm run test`
Expected: 기준선 122보다 늘어난 수, 실패 0

Run: `npm run test:int`
Expected: 기준선 199보다 늘어난 수, 실패 0

`tsc`가 지운 파일의 에러를 계속 보고하면 `backend/dist`를 지우고 다시 돌린다.

- [ ] **Step 2: 위협 모델을 갱신한다**

`docs/threat-model.md`의 "관찰된 사실" 표에서 3·4·8 행에 처리 표시를 하고, "B1이 답해야 할 질문"의 Q2·Q5·Q6에 결론을 적는다. Q6의 결론은 이렇게 적는다:

> **Q6 — 토큰 폐기가 필요한가.** 필요하다. 다만 폐기 목록을 두지 않고 갱신 시점에
> `DealerSession.tokenVersion`을 대조하는 방식으로 만들었다. 매 요청 조회 없이
> 폐기가 성립하고, 대가는 **이미 발급된 토큰이 최대 1시간 남는다**는 것이다.

- [ ] **Step 3: 티켓을 기록한다**

`docs/tickets-next.md`에 T23을 추가한다. 형식은 문서 하단 주석의 서술 형식을 따른다 — 문제 / 결정(버린 선택지 포함) / 작업 중 추가로 나온 것 / 테스트.

결정 절에 반드시 남길 것: **딜러 토큰 수명을 대회 길이로 늘리는 안을 버린 이유**(유출 토큰이 대회 내내 살고, 폐기하려면 매 요청 조회가 필요하다), 그리고 **리프레시 토큰을 따로 두지 않은 이유**(회전·저장·폐기 기계가 통째로 붙는데 대회가 몇 시간짜리라 실익이 없다).

- [ ] **Step 4: 커밋과 PR**

```bash
git add docs
git commit -m "docs: T23 딜러 인증 강화 기록과 위협 모델 갱신"
git push -u origin feat/t23-dealer-auth
```

PR 제목과 본문은 한국어로 쓴다.

---

## 이 계획이 닫지 않는 것

| 관찰 | 왜 여기 없나 |
|---|---|
| 1 · 2 · 10 (WS 쿼리스트링, Origin 우회, httpOnly 유출) | 계획 C. 프론트 변경이 함께 필요하다 |
| 5 · 6 · 7 (무검증 tableId, 테이블 선점 없음, `sub`가 세션 단위) | 계획 B. 딜러 배정 흐름을 정해야 답이 나온다 |
| 9 (플레이어 JWT 폐기) | 딜러 쪽만 이번에 다뤘다. 플레이어 토큰은 만료만으로 두고 위협 모델에 근거를 남긴다 |
| 레이트 리밋 전반 (`/auth/login` 등) | 관찰 4의 딜러 부분만 닫았다. 전역 Throttler는 별건 |
