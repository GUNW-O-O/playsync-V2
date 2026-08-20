# T64 — 대회 입력이 검증을 지나가지 않는다

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대회 생성·수정 경로에 들어오는 값이 **경계에서** 거부되게 해서, 지금 한참 뒤에 터지는 여섯 결함(전광판 정지 · 포인트 발행 · 500 · 무한 무료 리바인)을 입구에서 끝낸다.

**Architecture:** 방어 코드를 흩뿌리지 않고 **입구 하나**를 막는다. (1) 컨트롤러의 `any`를 DTO 타입으로 바꿔 전역 `ValidationPipe`가 실제로 돌게 하고, (2) `Create`/`Update` 두 DTO가 **같은 상수**를 쓰게 해서 갈라지지 못하게 하며, (3) 생성에만 있던 소유권 검사를 함수로 뽑아 수정도 같은 함수를 지나가게 하고, (4) 전역이던 이름 유니크를 상점 스코프로 좁힌다. 이 리포의 규칙("방어 코드보다 구조로 막는다")에 따라 `getCurrentBlindLevel`에는 방어를 두지 않는다 — 대신 DB→메모리 경계인 `parseBlindStructure`에서 한 번 거른다.

**Tech Stack:** NestJS · class-validator / class-transformer · Prisma(PostgreSQL) · Jest(단위 · 통합)

**Spec:** [`docs/tickets-audit.md`](../../tickets-audit.md)의 **T64** 절. 여섯 결함의 재현 경로와 근거가 거기 있다.

## Global Constraints

- **`entryFee: 0`은 막는다.** 사람이 정한 결정이다(2026-08-20). 허용하면 `recalculateAvgStack`의 `0 / 0 = NaN`과 `processRebuy`의 무한 무료 리바인을 계산식 두 곳을 고쳐 막아야 하는데, 그쪽이 더 넓다.
- **부하 무대가 함께 움직인다.** `prisma/seed-load.ts`가 `entryFee: 0`을 쓰고 그 근거를 머리말 주석에 적어 뒀다. 값과 주석을 같이 고친다(Task 5).
- **줄 번호로 가리키지 않는다.** 문서·주석은 함수 이름으로 적는다(`CLAUDE.md`의 작업 규칙).
- **새 테스트가 처음부터 통과하면 의심한다.** 각 Task의 Step 2에서 **반드시 실패를 먼저 본다.** 사후에 추가하는 검사는 제품 코드를 일부러 되돌려 빨간불을 확인한다.
- 검증 명령: `npm run test -w backend` (단위) · `npm run test:int -w backend` (통합) · `npm run typecheck` (루트).
- 브랜치: `fix/t64-input-validation`. 커밋 메시지·주석·문서는 한국어.

## 파일 구조

| 파일 | 책임 | Task |
|---|---|---|
| `backend/shared/dto/tournament.dto.ts` | 대회 입력의 경계. **상수를 여기 두고 두 DTO가 같이 쓴다** | 1 |
| `backend/shared/dto/tournament.dto.spec.ts` (신규) | 두 DTO가 **같은 값을 같이 거부하는지** | 1 |
| `backend/shared/dto/blind-structure.dto.ts` | 블라인드 구조의 경계. 빈 배열 거부 | 2 |
| `backend/shared/dto/blind-structure.dto.spec.ts` (신규) | 구조 DTO 단위 검증 | 2 |
| `backend/src/store/session/session.controller.ts` | `any`를 DTO로 | 2 |
| `backend/shared/util/util.ts` | `parseBlindStructure`가 DB→메모리 경계에서 빈 배열을 거른다 | 2 |
| `backend/shared/util/util.spec.ts` (신규) | `parseBlindStructure`의 경계. **지금 이 함수를 덮는 테스트가 0건이다** | 2 |
| `backend/src/store/session/session.service.ts` | `assertBlindBelongsToStore` 추출 · `updateSession`이 그것을 지나간다 · 진행 중 `entryFee` 잠금 | 3 |
| `backend/src/store/session/session.service.int-spec.ts` | 수정 경로의 소유권·잠금 통합 검증 | 3 |
| `backend/prisma/schema.prisma` + 마이그레이션 | `BlindStructure.name`·`Store.name` 유니크를 스코프로 | 4 |
| `backend/prisma/seed-load.ts` | 부하 무대를 새 규칙에 맞춘다 | 5 |

---

### Task 1: 두 DTO의 경계를 하나의 상수로 묶는다 (6-3 · 6-4 · 잔여 `@Max`)

지금 `CreateTournamentDto`에는 `@Min(0)`이 있고 `UpdateTournamentDto`에는 아무것도 없다. **갈라진 것 자체가 원인**이므로, 값을 상수로 뽑아 둘이 같은 것을 쓰게 한다. `@nestjs/mapped-types`는 이 리포에 없고, 그것 하나를 위해 의존성을 늘리지 않는다.

`@Max`가 필요한 이유는 잔여 목록에 있다 — class-validator의 `@IsInt()`는 `2^31`을 넘는 안전 정수를 통과시키는데 Prisma `Int`는 postgres `integer`라 22003이 예외 필터 없이 500으로 나가고, `totalBuyinAmount` 쪽은 **대회 도중에** 터진다.

**Files:**
- Modify: `backend/shared/dto/tournament.dto.ts`
- Test: `backend/shared/dto/tournament.dto.spec.ts` (신규)

**Interfaces:**
- Produces: `ENTRY_FEE_MIN` · `ENTRY_FEE_MAX` · `START_STACK_MIN` · `START_STACK_MAX` · `REBUY_UNTIL_MIN` · `REBUY_UNTIL_MAX` (모두 `number`, `tournament.dto.ts`에서 export). Task 5가 `ENTRY_FEE_MIN`을 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/shared/dto/tournament.dto.spec.ts`:

```ts
// 이 스펙은 Nest 부트스트랩(main.ts)을 거치지 않고 DTO를 직접 로드한다.
// `seat-release.dto.spec.ts`와 같은 이유로 reflect-metadata를 먼저 불러온다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CreateTournamentDto,
  UpdateTournamentDto,
  ENTRY_FEE_MAX,
  START_STACK_MAX,
  REBUY_UNTIL_MAX,
} from './tournament.dto';

/** ValidationPipe가 하는 것과 같은 순서. */
function validate(cls: any, payload: unknown) {
  return validateSync(plainToInstance(cls, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

const validCreate = {
  name: '주말 딥스택',
  type: 'TOURNAMENT',
  storeId: 's1',
  blindId: 'b1',
  startStack: 30000,
  entryFee: 50000,
  rebuyUntil: 5,
  prizePayouts: [{ place: 1, percent: 100 }],
};

const has = (errs: unknown[]) => `오류 ${errs.length > 0 ? '있음' : '없음'}`;

describe('대회 DTO의 경계', () => {
  // 아래 표가 이 티켓의 요점이다. **두 DTO가 같은 값을 같이 거부해야** 한다 —
  // 지금은 Update 쪽에 하한이 없어서 PATCH로 음수를 넣을 수 있고, 그것이
  // `paymentPoint`의 `decrement: -50000`으로 포인트를 찍어낸다.
  const cases: { 필드: 'entryFee' | 'startStack' | 'rebuyUntil'; 값: number; 왜: string }[] = [
    { 필드: 'entryFee', 값: 0, 왜: 'recalculateAvgStack이 0으로 나눠 NaN이 되고 전광판이 멎는다' },
    { 필드: 'entryFee', 값: -50000, 왜: 'paymentPoint의 decrement가 음수라 포인트를 발행한다' },
    { 필드: 'entryFee', 값: ENTRY_FEE_MAX + 1, 왜: 'postgres integer를 넘겨 22003이 500으로 나간다' },
    { 필드: 'startStack', 값: -1, 왜: 'currentStack이 음수가 되어 칩 보존이 깨진다' },
    { 필드: 'startStack', 값: START_STACK_MAX + 1, 왜: '같은 22003' },
    { 필드: 'rebuyUntil', 값: -1, 왜: '레벨 번호와 비교되는 값이라 음수가 뜻을 갖지 않는다' },
    { 필드: 'rebuyUntil', 값: REBUY_UNTIL_MAX + 1, 왜: '휴식 센티널 99를 넘는 레벨은 없다' },
  ];

  for (const { 필드, 값, 왜 } of cases) {
    it(`Create는 ${필드}=${값}을 거부한다 — ${왜}`, () => {
      expect(has(validate(CreateTournamentDto, { ...validCreate, [필드]: 값 }))).toBe('오류 있음');
    });

    it(`Update도 ${필드}=${값}을 거부한다 — 두 DTO가 갈라지면 수정 경로만 뚫린다`, () => {
      expect(has(validate(UpdateTournamentDto, { [필드]: 값 }))).toBe('오류 있음');
    });
  }

  it('정상값은 Create·Update 둘 다 통과한다', () => {
    expect(has(validate(CreateTournamentDto, validCreate))).toBe('오류 없음');
    expect(has(validate(UpdateTournamentDto, { entryFee: 50000, startStack: 30000, rebuyUntil: 5 })))
      .toBe('오류 없음');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
npm run test -w backend -- tournament.dto.spec
```

기대: 상수 셋이 없어서 **import 단계에서 죽는다.** 상수를 먼저 넣고 다시 돌리면 `Update` 쪽 케이스 일곱이 전부 "오류 없음"으로 빨개진다 — 그게 6-4의 재현이다.

- [ ] **Step 3: 상수를 넣고 두 DTO에 같이 건다**

`backend/shared/dto/tournament.dto.ts`:

```ts
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';

/**
 * 두 DTO가 **같은 상수**를 쓴다. 예전에는 `Create`에만 `@Min(0)`이 있고
 * `Update`에는 아무것도 없어서, `PATCH /store/sessions/:id`로 `entryFee: -50000`을
 * 넣으면 `paymentPoint`의 `decrement: -50000`이 포인트를 찍어냈다. 값이 한 곳에
 * 있으면 한쪽만 고쳐지는 날이 오지 않는다.
 *
 * 상한이 있는 이유는 Prisma `Int`가 postgres `integer`이기 때문이다.
 * class-validator의 `@IsInt()`는 `2^31`을 넘는 안전 정수를 통과시키고, 리포에
 * 예외 필터가 없어 22003이 그대로 500으로 나간다. `totalBuyinAmount`처럼
 * 누적되는 값은 **대회 도중에** 터진다.
 */
export const ENTRY_FEE_MIN = 1;
export const ENTRY_FEE_MAX = 10_000_000;
export const START_STACK_MIN = 1;
export const START_STACK_MAX = 1_000_000_000;
export const REBUY_UNTIL_MIN = 0;
/** 휴식 레벨의 센티널이 `lv: 99`라 그 위의 레벨 번호는 없다. */
export const REBUY_UNTIL_MAX = 99;
```

`CreateTournamentDto`의 세 필드를 바꾼다:

```ts
  @IsInt()
  @Min(START_STACK_MIN)
  @Max(START_STACK_MAX)
  startStack: number;

  // 0을 막는 이유: `recalculateAvgStack`이 `totalBuyinAmount / entryFee`로
  // 바이인 건수를 역산한다. 0이면 `0 / 0 = NaN`이 해시에 들어가고,
  // `DashboardSchema.avgStack`이 `safeParse`에서 거부해 전광판이 "대기 중"에
  // 영구히 머문다. 같은 값이 `processRebuy`의 포인트 게이트도 무력화한다.
  @IsInt()
  @Min(ENTRY_FEE_MIN)
  @Max(ENTRY_FEE_MAX)
  entryFee: number;

  @IsInt()
  @Min(REBUY_UNTIL_MIN)
  @Max(REBUY_UNTIL_MAX)
  rebuyUntil: number;
```

`UpdateTournamentDto`의 같은 세 필드에 **똑같은 데코레이터**를 건다(`@IsOptional()`은 유지).

- [ ] **Step 4: 통과를 확인한다**

```bash
npm run test -w backend -- tournament.dto.spec
```

기대: PASS.

- [ ] **Step 5: 검사가 진짜인지 되돌려 본다**

`UpdateTournamentDto.entryFee`의 `@Min(ENTRY_FEE_MIN)` 한 줄을 지우고 다시 돌린다. `Update는 entryFee=0을 거부한다`와 `-50000` 케이스가 **빨개져야** 한다. 확인했으면 되돌린다.

- [ ] **Step 6: 커밋**

```bash
git add backend/shared/dto/tournament.dto.ts backend/shared/dto/tournament.dto.spec.ts
git commit -m "fix: 대회 입력의 상·하한을 두 DTO가 같은 상수로 든다"
```

---

### Task 2: 블라인드 구조가 실제로 검증되게 한다 (6-1 · 6-2)

`SessionController.create`가 블라인드 구조를 `any`로 받는다. 전역 `ValidationPipe`는 **파라미터의 메타타입**으로 검증할 DTO를 고르므로, `any`면 고를 것이 없어 `CreateBlindStructureDto`와 `BlindLevelDto`의 규칙이 **하나도 안 돈다.** 같은 핸들러의 `@Body('dto')`는 정상 검증된다 — 한 핸들러 안에서 한쪽만 뚫려 있다.

증거가 리포 안에 있다. `seed.ts`의 `BLIND_STRUCTURE`는 `duration`이 2~3분이라 `BlindLevelDto`의 `@Min(10)`을 정면으로 위반하는데 아무도 알아채지 못했다.

**그래서 `@Min(10)` 자체를 다시 본다.** 한 번도 실행되지 않은 값을 그대로 켜면 **없던 정책이 오늘 생긴다.** 그 값이 옳다는 증거는 어디에도 없고, 반대 증거는 리포 안에 있다 — 시드가 3분 레벨을 쓰고 이름이 `'데모 (짧은 구조)'`다. 터보·하이퍼 구조는 실제 홀덤에서 3~5분 레벨을 쓴다. `@Min(1)`로 내린다. 막아야 하는 것은 "짧은 레벨"이 아니라 **0과 음수**다(0이면 `getCurrentBlindLevel`의 `accumulatedMs`가 안 늘어 그 레벨을 영영 못 벗어난다).

시드는 `prisma.blindStructure.create`로 직접 쓰므로 DTO를 지나지 않는다. 값을 내리는 판단의 근거가 시드일 뿐, **이 Task는 `seed.ts`를 건드리지 않는다.**

**Files:**
- Modify: `backend/src/store/session/session.controller.ts`
- Modify: `backend/shared/dto/blind-structure.dto.ts`
- Modify: `backend/shared/util/util.ts` (`parseBlindStructure`)
- Test: `backend/shared/dto/blind-structure.dto.spec.ts` (신규)
- Test: `backend/shared/util/util.spec.ts` (신규)
- Test: `backend/src/store/session/session.controller.spec.ts` (기존에 추가)

**Interfaces:**
- Consumes: 없음
- Produces: `SessionController.create`의 세 번째 파라미터 타입이 `CreateBlindStructureDto | undefined`가 된다. `SessionService.createSession`의 시그니처는 그대로다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/shared/dto/blind-structure.dto.spec.ts`:

```ts
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateBlindStructureDto } from './blind-structure.dto';

function validate(payload: unknown) {
  return validateSync(plainToInstance(CreateBlindStructureDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

const has = (errs: unknown[]) => `오류 ${errs.length > 0 ? '있음' : '없음'}`;
const 정상 = { name: '표준', storeId: 's1', structure: [{ lv: 1, sb: 100, ante: false, duration: 10 }] };

describe('CreateBlindStructureDto', () => {
  // 빈 배열이 통과하면 `getCurrentBlindLevel`이 `structure[-1]`을 읽어
  // "Cannot read properties of undefined (reading 'lv')"로 죽는다. 터지는 자리가
  // **대회 시작**이라, 참가자가 다 앉은 뒤에 500이 난다.
  it('빈 구조를 거부한다', () => {
    expect(has(validate({ ...정상, structure: [] }))).toBe('오류 있음');
  });

  // 막아야 하는 것은 "짧은 레벨"이 아니라 0이다. 0이면
  // `getCurrentBlindLevel`의 `accumulatedMs`가 안 늘어 그 레벨을 영영 못
  // 벗어난다. 3분짜리 터보 레벨은 실제로 쓰는 값이고, 시드가 이미 쓴다.
  it('duration 0을 거부한다', () => {
    expect(has(validate({ ...정상, structure: [{ lv: 1, sb: 100, ante: false, duration: 0 }] }))).toBe('오류 있음');
  });

  it('3분짜리 터보 레벨은 통과한다', () => {
    expect(has(validate({ ...정상, structure: [{ lv: 1, sb: 100, ante: false, duration: 3 }] }))).toBe('오류 없음');
  });

  it('레벨의 sb 하한을 본다', () => {
    expect(has(validate({ ...정상, structure: [{ lv: 1, sb: 50, ante: false, duration: 10 }] }))).toBe('오류 있음');
  });

  it('ante가 boolean이 아니면 거부한다', () => {
    expect(has(validate({ ...정상, structure: [{ lv: 1, sb: 100, ante: 'yes', duration: 10 }] }))).toBe('오류 있음');
  });

  it('정상 구조는 통과한다', () => {
    expect(has(validate(정상))).toBe('오류 없음');
  });
});
```

`backend/shared/util/util.spec.ts` — **이 함수를 덮는 테스트가 지금 0건이다.** DB에 이미 있는 행이 들어오는 경계라 DTO와 별개로 증명해야 한다:

```ts
import { getCurrentBlindLevel, parseBlindStructure } from './util';

describe('parseBlindStructure', () => {
  it('배열이 아니면 거부한다', () => {
    expect(() => parseBlindStructure({ lv: 1 })).toThrow('Invalid blind structure');
  });

  it('빈 배열을 거부한다', () => {
    // 통과시키면 `getCurrentBlindLevel`이 마지막 레벨을 읽는 대목에서
    // `structure[-1]`이 되어 `undefined.lv`로 죽는다. 그 자리가 **대회
    // 시작**이라 참가자가 다 앉은 뒤에 500이 난다.
    expect(() => parseBlindStructure([])).toThrow('Invalid blind structure');
  });

  it('레벨 모양이 어긋나면 거부한다', () => {
    expect(() => parseBlindStructure([{ lv: 1, sb: 100, ante: 'yes', duration: 10 }]))
      .toThrow('Invalid blind level format');
  });

  it('정상 구조는 그대로 돌려준다', () => {
    const 구조 = [{ lv: 1, sb: 100, ante: false, duration: 3 }];
    expect(parseBlindStructure(구조)).toEqual(구조);
  });
});

describe('getCurrentBlindLevel — 빈 구조가 도달할 수 없음을 확인한다', () => {
  it('마지막 레벨을 지난 뒤에도 마지막 원소를 읽는다', () => {
    // 방어를 여기 두지 않는 근거다. 입구(DTO)와 `parseBlindStructure`가
    // 빈 배열을 막으므로, 이 함수는 **비어 있지 않은 구조만** 받는다.
    const 구조 = [{ lv: 1, sb: 100, ante: false, duration: 1 }];
    const 결과 = getCurrentBlindLevel(구조, Date.now() - 10 * 60 * 1000);
    expect(결과.currentIndex).toBe(0);
    expect(결과.isBreak).toBe(false);
  });
});
```

`backend/src/store/session/session.controller.spec.ts`에 추가한다. **컨트롤러가 그 DTO를 실제로 태우는지**가 6-1의 본체다:

```ts
import 'reflect-metadata';
import { CreateBlindStructureDto } from 'shared/dto/blind-structure.dto';
import { SessionController } from './session.controller';

it('create의 blindStructure 파라미터가 검증 가능한 타입이다', () => {
  // ValidationPipe는 **파라미터의 메타타입**으로 검증할 DTO를 고른다. `any`면
  // 고를 것이 없어 CreateBlindStructureDto의 규칙이 하나도 안 돈다 — 같은
  // 핸들러의 `@Body('dto')`는 정상 검증되므로, 한 핸들러 안에서 한쪽만 뚫린다.
  const types = Reflect.getMetadata('design:paramtypes', SessionController.prototype, 'create');
  expect(types[2]).toBe(CreateBlindStructureDto);
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
npm run test -w backend -- blind-structure.dto.spec util.spec session.controller.spec
```

기대:
- `빈 구조를 거부한다`(DTO·`parseBlindStructure` 둘 다) → FAIL(`@ArrayNotEmpty()`가 없어 "오류 없음")
- `3분짜리 터보 레벨은 통과한다` → FAIL(`@Min(10)`이 막는다 — **한 번도 실행되지 않아 아무도 몰랐던 정책이다**)
- `create의 blindStructure 파라미터가 검증 가능한 타입이다` → FAIL(메타타입이 `Object`다 — `any`의 런타임 표현)
- `duration 0을 거부한다`·`sb 하한`·`ante가 boolean`은 이미 PASS다. `BlindLevelDto`의 그 규칙들은 옳다 — **안 돌아갔을 뿐이다.**

- [ ] **Step 3: 구현한다**

`blind-structure.dto.ts`:

```ts
import { IsString, IsArray, IsNotEmpty, ValidateNested, IsInt, Min, IsBoolean, ArrayNotEmpty } from 'class-validator';
```

```ts
  // 빈 배열을 여기서 막는다. 통과시키면 `getCurrentBlindLevel`이 모든 레벨을
  // 지난 경우에 읽는 `structure[structure.length - 1]`이 `structure[-1]`이 되어
  // `undefined.lv`로 죽는데, 그 자리가 **대회 시작**이라 참가자가 다 앉은
  // 뒤에 500이 난다.
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => BlindLevelDto)
  structure: BlindLevelDto[];
```

`session.controller.ts`:

```ts
import { CreateBlindStructureDto } from 'shared/dto/blind-structure.dto';
```

```ts
  // 타입이 `any`가 아니어야 한다. 전역 ValidationPipe는 **파라미터의
  // 메타타입**으로 검증할 DTO를 고르므로, `any`면 고를 것이 없어
  // `CreateBlindStructureDto`와 `BlindLevelDto`의 규칙이 하나도 안 돈다.
  // Prisma가 이 값을 Json 컬럼에 넣는 것은 **저장 타입의 문제지 입력 타입의
  // 문제가 아니다** — 저장 쪽은 서비스에서 `as any`로 이미 넘긴다.
  @Post()
  async create(
    @Req() req,
    @Body('dto') dto: CreateTournamentDto,
    @Body('blindStructure') blindStructure?: CreateBlindStructureDto,
  ) {
    return await this.sessionService.createSession(dto, req.user.userId, blindStructure);
  }
```

`shared/util/util.ts`의 `parseBlindStructure` — **DB에서 메모리로 들어오는 경계**다. 입구(DTO)를 막아도 이미 저장된 행과 시드가 지나가므로, 이 한 곳에서 거른다. `getCurrentBlindLevel`에는 **방어를 두지 않는다**(리포 규칙: 방어 코드보다 구조로 막는다 — 검사가 둘이 되면 한쪽만 고쳐지는 날이 온다):

```ts
export function parseBlindStructure(data: unknown): BlindLevelDto[] {
  if (!Array.isArray(data)) {
    throw new Error("Invalid blind structure");
  }
  // 빈 구조를 여기서 끊는다. 통과시키면 `getCurrentBlindLevel`이 마지막 레벨을
  // 읽는 대목에서 `structure[-1]`이 되어 `undefined.lv`로 죽는다. 입구(DTO)와
  // 여기가 둘인 것은 **검사가 둘**이라서가 아니라 경계가 둘이기 때문이다 —
  // DTO는 요청을, 여기는 DB에 이미 있는 행을 받는다.
  if (data.length === 0) {
    throw new Error("Invalid blind structure");
  }
  ...
```

같은 파일의 `BlindLevelDto.duration`을 내린다:

```ts
  // `@Min(10)`이었다. **한 번도 실행되지 않은 값이라** 그것이 옳다는 증거가
  // 없고, 반대 증거는 리포 안에 있다 — `seed.ts`의 `BLIND_STRUCTURE`가 3분
  // 레벨을 쓰고 이름이 '데모 (짧은 구조)'다. 터보·하이퍼는 실제로 3~5분
  // 레벨을 쓴다. 막아야 하는 것은 짧은 레벨이 아니라 0이다 — 0이면
  // `getCurrentBlindLevel`의 `accumulatedMs`가 안 늘어 그 레벨을 영영 못
  // 벗어난다.
  @IsInt()
  @Min(1)
  duration: number; // 분 단위
```

- [ ] **Step 4: 통과를 확인한다**

```bash
npm run test -w backend -- blind-structure.dto.spec util.spec session.controller.spec
npm run typecheck
```

기대: 전부 PASS, 타입 에러 0. `createSession`의 `blindStructure!.structure as any`가 그대로 컴파일되는지 확인한다(타입이 좁아졌으므로 `as any`가 필요 없어질 수 있다 — 그러면 지운다).

- [ ] **Step 5: 검사가 진짜인지 되돌려 본다**

`session.controller.ts`의 파라미터 타입을 `any`로 되돌리고 컨트롤러 스펙을 다시 돌린다. `create의 blindStructure 파라미터가 검증 가능한 타입이다`가 **빨개져야** 한다. 확인했으면 되돌린다.

`parseBlindStructure`의 `data.length === 0` 두 줄도 같은 방식으로 확인한다.

- [ ] **Step 6: 커밋**

```bash
git add backend/src/store/session/session.controller.ts backend/shared/dto/blind-structure.dto.ts backend/shared/dto/blind-structure.dto.spec.ts backend/src/store/session/session.controller.spec.ts backend/shared/util/util.ts backend/shared/util/util.spec.ts
git commit -m "fix: 블라인드 구조가 검증을 지나가게 한다"
```

---

### Task 3: 수정 경로가 생성과 같은 검사를 지나가게 한다 (6-5 · 진행 중 `entryFee` 잠금)

`createSession`은 `blindStructure.findUnique` → `blind.storeId !== dto.storeId`면 403으로 막는다. `updateSession`은 `updateData.blindId = dto.blindId`를 그대로 쓴다. 그래서 **남의 상점 블라인드 구조 id를 자기 대회에 붙일 수 있고**, 그 대회가 다른 테넌트의 구조로 돈다. 없는 id면 외래키 위반(P2003)이 예외 필터 없이 500으로 나간다.

그리고 `updateSession`은 `isClosedTournament`만 막으므로 **진행 중(ONGOING) 대회의 `entryFee`도 바꿀 수 있다.** `recalculateAvgStack`이 `totalBuyinAmount / entryFee`로 건수를 역산하고 `cancelSession`이 `참가자 수 × entryFee === totalBuyinAmount`를 요구하므로, 한 번 바꾸면 그 대회는 **취소도 종료도 불가능한 상태로 굳는다.**

**Files:**
- Modify: `backend/src/store/session/session.service.ts`
- Test: `backend/src/store/session/session.service.int-spec.ts` (기존 파일에 describe 추가)

**Interfaces:**
- Consumes: Task 1의 상수(직접 쓰지는 않는다)
- Produces: `private async assertBlindBelongsToStore(blindId: string, storeId: string): Promise<void>` — 없으면 404, 다른 상점이면 403. `createSession`과 `updateSession`이 **둘 다** 부른다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`session.service.int-spec.ts`에 추가한다. 통합인 이유는 **실제 외래키와 실제 행**이 있어야 P2003과 소유권이 의미를 갖기 때문이다:

```ts
describe('SessionService.updateSession — 수정 경로의 검사', () => {
  // 배선은 이 파일의 기존 describe와 같다(createTestPrisma / createTestRedis /
  // truncateAll). 두 상점과 각각의 블라인드 구조를 세워 둔다.

  it('남의 상점 블라인드 구조로 바꿀 수 없다', async () => {
    await expect(
      sessionService.updateSession(myTournamentId, { blindId: otherStoreBlindId }, ownerId),
    ).rejects.toThrow(ForbiddenException);
  });

  it('없는 블라인드 구조 id는 404다 — 외래키 위반이 500으로 나가지 않는다', async () => {
    await expect(
      sessionService.updateSession(myTournamentId, { blindId: '존재하지-않는-id' }, ownerId),
    ).rejects.toThrow(NotFoundException);
  });

  it('진행 중인 대회의 entryFee는 바꿀 수 없다', async () => {
    // 한 번 바꾸면 `recalculateAvgStack`의 역산과 `cancelSession`의
    // `참가자 수 × entryFee === totalBuyinAmount`가 영영 어긋나, 그 대회는
    // 취소도 종료도 못 하는 상태로 굳는다.
    await prisma.tournament.update({
      where: { id: myTournamentId },
      data: { status: TournamentStatus.ONGOING },
    });
    await expect(
      sessionService.updateSession(myTournamentId, { entryFee: 99000 }, ownerId),
    ).rejects.toThrow(ConflictException);
  });

  it('진행 중이어도 이름은 바꿀 수 있다 — 돈에 닿지 않는 값이다', async () => {
    await prisma.tournament.update({
      where: { id: myTournamentId },
      data: { status: TournamentStatus.ONGOING },
    });
    const updated = await sessionService.updateSession(myTournamentId, { name: '새 이름' }, ownerId);
    expect(updated.name).toBe('새 이름');
  });

  it('자기 상점 구조로는 바꿀 수 있다', async () => {
    const updated = await sessionService.updateSession(myTournamentId, { blindId: myOtherBlindId }, ownerId);
    expect(updated.blindId).toBe(myOtherBlindId);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
npm run test:int -w backend -- session.service.int-spec
```

기대:
- `남의 상점 블라인드 구조로 바꿀 수 없다` → FAIL(그냥 저장된다)
- `없는 블라인드 구조 id는 404다` → FAIL(P2003이 `PrismaClientKnownRequestError`로 던져진다 — `NotFoundException`이 아니다)
- `진행 중인 대회의 entryFee는 바꿀 수 없다` → FAIL(그냥 바뀐다)
- 나머지 둘은 PASS(**둘이 어긋나는 입력이 있어야 각각이 증명된다** — 막는 것만 있으면 다 막아도 초록이다)

- [ ] **Step 3: 구현한다**

`session.service.ts`에 검사를 하나로 뽑는다:

```ts
  /**
   * 블라인드 구조가 그 상점의 것인지 본다.
   *
   * 생성에만 있던 검사다. 수정(`updateSession`)이 `blindId`를 그대로 저장해서,
   * 남의 상점 구조를 자기 대회에 붙일 수 있었고 그 대회가 다른 테넌트의
   * 구조로 돌았다. 없는 id는 외래키 위반(P2003)이 되어 예외 필터가 없는 이
   * 리포에서 500으로 나갔다.
   *
   * **판정이 한 곳이어야 한다.** 두 벌이 되면 한쪽만 고쳐지는 날이 온다.
   */
  private async assertBlindBelongsToStore(blindId: string, storeId: string) {
    const blind = await this.prismaService.blindStructure.findUnique({
      where: { id: blindId },
      select: { storeId: true },
    });
    if (!blind) throw new NotFoundException('블라인드 구조를 찾을 수 없습니다.');
    if (blind.storeId !== storeId) {
      throw new ForbiddenException('본인의 매장이 아닙니다.');
    }
  }
```

`createSession`의 `if (dto.blindId) { ... }` 블록을 이 호출로 바꾼다.

`updateSession`에서는 대회의 `storeId`가 필요하다. `getGameSession(id)`가 이미 대회를 읽으므로 그 결과의 `storeId`를 쓴다(없으면 `select`에 더한다):

```ts
    const session = await this.getGameSession(id);
    if (session && isClosedTournament(session.status)) {
      throw new ConflictException('닫힌 세션은 수정할 수 없습니다.');
    }

    // 진행 중에 참가비를 바꾸면 그 대회는 취소도 종료도 못 하게 굳는다.
    // `recalculateAvgStack`은 `totalBuyinAmount / entryFee`로 바이인 건수를
    // 역산하고, `cancelSession`은 `참가자 수 × entryFee === totalBuyinAmount`를
    // 요구한다. 이미 걷은 돈으로 계산된 값들이라, 나눗셈의 분모만 바꾸면
    // 둘 다 영영 안 맞는다. 시작 스택도 같은 성질이다.
    if (session && session.status === TournamentStatus.ONGOING) {
      if (dto.entryFee !== undefined || dto.startStack !== undefined) {
        throw new ConflictException('진행 중인 대회의 참가비와 시작 스택은 바꿀 수 없습니다.');
      }
    }

    if (dto.blindId) {
      await this.assertBlindBelongsToStore(dto.blindId, session!.storeId);
    }
```

- [ ] **Step 4: 통과를 확인한다**

```bash
npm run test:int -w backend -- session.service.int-spec
npm run test -w backend
npm run typecheck
```

기대: 전부 PASS, 타입 에러 0.

- [ ] **Step 5: 검사가 진짜인지 되돌려 본다**

`updateSession`의 `if (dto.blindId) { await this.assertBlindBelongsToStore(...) }` 두 줄을 지우고 다시 돌린다. 위 테스트 둘이 **빨개져야** 한다. `createSession` 쪽 기존 테스트는 초록으로 남아야 한다 — 그래야 이 검사가 **수정 경로에서** 증명된 것이다. 확인했으면 되돌린다.

- [ ] **Step 6: 커밋**

```bash
git add backend/src/store/session/session.service.ts backend/src/store/session/session.service.int-spec.ts
git commit -m "fix: 수정 경로가 생성과 같은 블라인드 구조 검사를 지나간다"
```

---

### Task 4: 이름 유니크를 상점 스코프로 좁힌다 (6-6)

`schema.prisma`의 `BlindStructure.name String @unique`가 **상점 스코프가 아니라 전역**이다. `createSession`의 `blindStructure.create`는 트랜잭션 밖이고 P2002를 잡는 코드가 없어서, 두 상점이 각각 `"주말 딥스택"`을 쓰면 두 번째 상점의 `POST /store/sessions`가 500이다. 응답 차이로 다른 상점이 어떤 이름을 쓰는지 떠볼 수도 있다. `seed-load.ts`가 상점마다 이름에 인덱스를 붙이며 **이미 이 사실에 부딪혔다.**

`Store.name @unique`도 같은 모양이다. 상점 생성 라우트가 지금 없어서 드러나지 않을 뿐이라 함께 좁힌다 — 소유자 스코프다.

전역 유니크를 스코프 유니크로 바꾸는 것은 **제약을 느슨하게** 하는 방향이라 기존 행이 위반할 수 없다.

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/<timestamp>_scope_name_unique/migration.sql` (`prisma migrate dev`가 만든다)
- Test: `backend/src/store/session/tenant-isolation.int-spec.ts` (기존 파일에 추가)

**Interfaces:**
- Consumes: Task 3의 `assertBlindBelongsToStore`(직접 쓰지는 않는다)
- Produces: `BlindStructure`에 `@@unique([storeId, name])`, `Store`에 `@@unique([ownerId, name])`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tenant-isolation.int-spec.ts`에 추가한다:

```ts
it('두 상점이 같은 이름의 블라인드 구조를 쓸 수 있다', async () => {
  // 전역 유니크였을 때는 두 번째 상점의 `POST /store/sessions`가 P2002로
  // 500이었다. 응답 차이로 다른 상점이 어떤 이름을 쓰는지 떠볼 수도 있었다.
  // `seed-load.ts`가 상점마다 이름에 인덱스를 붙인 것이 이 사실의 흔적이다.
  await sessionService.createSession(
    { ...baseDto, storeId: storeA }, ownerA,
    { name: '주말 딥스택', storeId: storeA, structure: [{ lv: 1, sb: 100, ante: false, duration: 10 }] },
  );

  await expect(
    sessionService.createSession(
      { ...baseDto, storeId: storeB }, ownerB,
      { name: '주말 딥스택', storeId: storeB, structure: [{ lv: 1, sb: 100, ante: false, duration: 10 }] },
    ),
  ).resolves.toBeDefined();
});

it('같은 상점 안에서는 이름이 겹치지 않는다', async () => {
  await sessionService.createSession(
    { ...baseDto, storeId: storeA }, ownerA,
    { name: '중복 이름', storeId: storeA, structure: [{ lv: 1, sb: 100, ante: false, duration: 10 }] },
  );

  await expect(
    sessionService.createSession(
      { ...baseDto, storeId: storeA }, ownerA,
      { name: '중복 이름', storeId: storeA, structure: [{ lv: 1, sb: 100, ante: false, duration: 10 }] },
    ),
  ).rejects.toThrow();
});
```

**두 검사가 어긋나는 입력이다** — 첫째는 스코프가 좁아져야 통과하고, 둘째는 스코프가 아예 없어지면 실패한다. 하나만 두면 `@unique`를 통째로 지워도 초록이 된다(T29에서 데인 자리).

- [ ] **Step 2: 실패를 확인한다**

```bash
npm run test:int -w backend -- tenant-isolation.int-spec
```

기대: `두 상점이 같은 이름의 블라인드 구조를 쓸 수 있다` → FAIL(P2002). 둘째는 PASS.

- [ ] **Step 3: 스키마를 고치고 마이그레이션을 만든다**

`schema.prisma`:

```prisma
model Store {
  id      String @id @default(uuid())
  name    String
  ownerId String
  owner   User   @relation(fields: [ownerId], references: [id])

  tournaments     Tournament[]
  blindStructures BlindStructure[]

  createdAt DateTime @default(now())

  // 이름은 소유자 안에서만 유일하다. 전역 유니크였을 때는 남이 먼저 쓴
  // 이름을 못 쓰고, 그 실패가 다른 테넌트의 이름을 떠보는 통로가 됐다.
  @@unique([ownerId, name])
}

model BlindStructure {
  id   String @id @default(uuid())
  name String

  structure Json // [{lv:1, sb:100, ante:false, duration:10}, ...]

  storeId String
  store   Store  @relation(fields: [storeId], references: [id], onDelete: Cascade)

  // Store.name과 같은 이유. 상점 안에서만 유일하다.
  @@unique([storeId, name])
}
```

```bash
cd backend && npx prisma migrate dev --name scope_name_unique
```

생성된 SQL을 **읽는다.** `DROP INDEX` 다음에 `CREATE UNIQUE INDEX ... (storeId, name)`이 오는지 확인한다. 전역 → 스코프는 느슨해지는 방향이라 기존 행이 위반할 수 없다.

- [ ] **Step 4: 통과를 확인한다**

```bash
npm run test:int -w backend -- tenant-isolation.int-spec
npm run typecheck
```

기대: 둘 다 PASS.

- [ ] **Step 5: 커밋**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations backend/src/store/session/tenant-isolation.int-spec.ts
git commit -m "fix: 상점·블라인드 구조 이름의 유니크를 스코프로 좁힌다"
```

---

### Task 5: 부하 무대를 새 규칙에 맞춘다

`prisma/seed-load.ts`가 `entryFee: 0`을 쓰고 그 근거를 머리말에 적어 뒀다 — "회원가입이 포인트를 주지 않고 충전 경로도 없어서, `joinSession`의 게이트가 `user.points < session.entryFee`라 0원이면 통과한다."

**그 우회가 실제 결함 위에 서 있었다.** `entryFee: 0`이면 `recalculateAvgStack`이 `0 / 0 = NaN`을 해시에 넣으므로, 지금까지의 부하 실행은 전광판이 죽은 상태에서 잰 것이다. 참가비를 1로 올리고, 봇 계정에 포인트를 미리 실어 게이트를 정직하게 지나가게 한다.

`seed-load.ts`는 DTO를 지나지 않고 Prisma로 직접 쓰므로 Task 1이 이것을 막지는 않는다. **그래서 더 고쳐야 한다** — 규칙이 문서로만 남는 자리다.

**Files:**
- Modify: `backend/prisma/seed-load.ts`
- Modify: `load/README.md` (참가비 전제가 적혀 있으면)

**Interfaces:**
- Consumes: `ENTRY_FEE_MIN` (Task 1)

- [ ] **Step 1: 값과 근거를 함께 고친다**

머리말 주석의 "**참가비가 0이다**" 문단을 바꾼다:

```ts
/**
 * **참가비가 1이다.** 회원가입이 포인트를 주지 않고(`schema.prisma`의
 * `points @default(0)`) 충전 경로도 없다 — 실제 PG 결제가 아직 판단하지 않은
 * 항목이라 포인트 차감이 결제를 대신하고 있다. 예전에는 참가비를 0으로 두어
 * `joinSession`의 `user.points < session.entryFee` 게이트를 비껴갔는데,
 * **그 값이 `recalculateAvgStack`의 분모라 `0 / 0 = NaN`이 되어 전광판이
 * 죽은 상태로 부하를 쟀다**(T64 6-3). 지금은 참가비를 `ENTRY_FEE_MIN`으로 두고
 * 풀 계정에 포인트를 미리 실어, 결제 경로가 게이트까지 정직하게 지나간다.
 */
```

풀 계정 생성에 포인트를 싣는다:

```ts
      await prisma.user.createMany({
        data: Array.from({ length: ACCOUNT_POOL }, (_, i) => ({
          nickname: `${ACCOUNT_PREFIX}${String(i).padStart(4, '0')}`,
          password,
          role: Role.USER,
          // 참가와 리바인이 전부 이 잔고에서 나간다. 램프가 한 계정으로 여러
          // 대회에 들어가고 리바인도 돌므로 넉넉히 준다 — 부하 무대의 관심은
          // 잔고가 아니라 처리량이다.
          points: BOT_POINTS,
        })),
      });
```

대회 생성:

```ts
          // 0이 아니다 — 위 머리말 참고. 분모로 쓰이는 값이라 0이면
          // `recalculateAvgStack`이 NaN을 만든다.
          entryFee: ENTRY_FEE_MIN,
```

파일 상단에 `const BOT_POINTS = 100_000_000;`과 `import { ENTRY_FEE_MIN } from 'shared/dto/tournament.dto';`를 더한다(경로 별칭이 시드에서 안 풀리면 상대경로).

- [ ] **Step 2: 시드를 돌려 확인한다**

```bash
npm run seed:load
```

기대: 끝까지 돈다. 매니페스트가 나온다.

- [ ] **Step 3: 부하 무대가 실제로 도는지 본다**

```bash
npm run load:up && npm run load:ramp-a
```

기대: 봇이 참가에 실패하지 않는다(포인트 게이트 통과). `npm run load:metrics`에서 `avgStack`이 `NaN`이 아니라 숫자다 — **이 값이 예전엔 죽어 있었다는 것이 이 Task의 증거다.**

```bash
npm run load:down
```

- [ ] **Step 4: 커밋**

```bash
git add backend/prisma/seed-load.ts load/README.md
git commit -m "fix: 부하 무대의 참가비를 0에서 떼어 낸다"
```

---

## 마무리

- [ ] **전체 검증**

```bash
npm run typecheck
npm run test
npm run test:int
```

기대: 타입 에러 0. 기준선(contract 62 · 백엔드 단위 208 + 새 스펙 · 프론트 117 · 통합 417 + 새 케이스)에서 **줄어든 것이 없어야 한다.**

- [ ] **`docs/tickets-audit.md`의 T64 상태를 바꾼다**

우선순위 표의 `대기`를 `완료 (#PR번호)`로. 서술은 옮기지 않는다 — `CLAUDE.md`의 「티켓을 어디에 기록하나」에 따라 판단 과정은 `chat-log`, 바뀐 규칙은 `domain.md`에 간다.

- [ ] **`domain.md`에 규칙을 반영한다**

「등록 마감」 절 근처에 대회 입력의 경계(참가비는 1 이상 · 블라인드 구조는 비어 있을 수 없다 · 진행 중에는 참가비와 시작 스택이 잠긴다)를 적는다. 이것이 **살아 있는 판**이다.

- [ ] **PR을 만든다.** 제목·본문 한국어. 2파(T58 · T60 · T66 · T70)가 이 위에서 갈라진다는 사실을 적는다.
