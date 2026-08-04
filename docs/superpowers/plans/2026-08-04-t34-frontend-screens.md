# T34 화면 구현 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 와이어프레임(`frontend/wireframes/2026-08-02-screens.html`)이 확정한 면 다섯 · 화면 열하나를 Next.js 화면으로 만든다.

**Architecture:** 세 시각 체계(Carbon / 태블릿 / 전광판)를 CSS 변수로 갈라 두고, 그 위에 라우트를 얹는다. 태블릿 둘은 WS(`renderGame`)로 살아 움직이고, 전광판은 REST 폴링만 한다 — 폴링이 곧 블라인드 시계를 미는 유일한 경로이기 때문이다. 태블릿은 사용자 로그인을 하지 않고 OTP로 진입한다.

**Tech Stack:** Next.js 15 App Router (RSC + 서버 액션), Tailwind v4 (`@theme inline`), vitest + @testing-library/react + msw, NestJS(엔드포인트 하나 추가), zod(`@playsync/contract`)

## Global Constraints

- 설계 문서: [`docs/superpowers/specs/2026-08-04-frontend-screens-build-design.md`](../specs/2026-08-04-frontend-screens-build-design.md). 요구사항의 최종 근거는 이 문서다.
- 도면: [`frontend/wireframes/2026-08-02-screens.html`](../../../frontend/wireframes/2026-08-02-screens.html). **마크업과 CSS를 여기서 옮긴다. 색·간격·타이포를 새로 정하지 않는다.**
- 브랜치는 `feat/t34-frontend-screens` 하나. **태스크마다 커밋 하나**로 끊는다 — 화면 열하나가 한 diff로 오면 리뷰가 성립하지 않는다.
- 커밋 메시지·주석·문서는 한국어. PR 제목과 본문도 한국어.
- 기준선을 내리지 않는다: 타입 에러 0건, contract 60 / 백엔드 단위 177 / 프론트 단위 52 / 통합 328. 프론트 단위는 이 티켓에서 늘어난다.
- **시각을 단언하는 테스트를 쓰지 않는다.** 색·간격·클래스 이름을 테스트에 박으면 화면을 고칠 때마다 빨개진다.
- 태블릿 화면(`.tbl`)은 16:9 안에서 끝난다. **스크롤이 생기면 그 화면은 틀린 것이다.**
- 보드는 장수만 그린다(채운 칸 = 깔린 카드, 점선 칸 = 아직). 무늬는 서버에 없다.
- 검증 명령(루트에서): `npm run typecheck`, `npm run test`, `npm run test -w frontend`
- 통합 테스트 반복 실행: `cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json --testPathPatterns <스펙>`

## File Structure

| 파일 | 책임 |
|---|---|
| `frontend/src/app/wireframe-tokens.css` | 와이어프레임 `:root` 변수. 세 세계의 색·폰트 |
| `frontend/src/component/felt/seatOrder.ts` | 좌석 번호 → 화면 배치. 방향만 인자로 받는 순수 함수 |
| `frontend/src/component/felt/Felt.tsx` | 좌석 아홉 · 보드 · 팟 · 사이드팟. 좌석/딜러 화면이 공유 |
| `frontend/src/component/Keypad.tsx` | OTP 숫자 키패드. 좌석 대기 · 딜러 대기가 공유 |
| `frontend/src/app/(terminal)/table/page.tsx` | `/table?store=` 좌석 대기 |
| `frontend/src/app/(terminal)/table/WaitingClient.tsx` | 대회·테이블·좌석·OTP 상태 |
| `frontend/src/app/(terminal)/table/action.ts` | `enterSeat` 서버 액션. 좌석 토큰을 쿠키로 심는다 |
| `frontend/src/app/(terminal)/table/[tableId]/SeatGameClient.tsx` | 좌석 게임 화면. WS · 오버레이 둘 |
| `frontend/src/app/(terminal)/dealer/page.tsx` | `/dealer?store=` 딜러 대기 |
| `frontend/src/app/(terminal)/dealer/table/[tableId]/DealerGameClient.tsx` | 딜러 게임 화면. WS · 승자 결정 |
| `frontend/src/app/(console)/stores/[storeId]/tournaments/[tournamentId]/display/DisplayClient.tsx` | 전광판. 폴링 · 세 상태 |
| `frontend/src/app/(console)/stores/[storeId]/tournaments/[tournamentId]/page.tsx` | 상점 콘솔 대회 상세 |
| `frontend/src/app/(player)/tournaments/[id]/page.tsx` · `(player)/me/page.tsx` | 참가자 폰 |
| `packages/contract/src/dashboard.ts` | 전광판 응답 스키마 |
| `backend/src/entry/entry.controller.ts` | `GET /tournaments/:id/seats` 추가 |

---

### Task 1: CSS 토큰과 공유 펠트

**Files:**
- Create: `frontend/src/app/wireframe-tokens.css`
- Modify: `frontend/src/app/globals.css`
- Create: `frontend/src/component/felt/seatOrder.ts`
- Create: `frontend/src/component/felt/Felt.tsx`
- Create: `frontend/src/component/Keypad.tsx`
- Test: `frontend/src/component/felt/seatOrder.test.ts`

**Interfaces:**
- Consumes: 없음(첫 태스크)
- Produces:
  - `seatOrder(orientation: 'player' | 'dealer'): number[]` — 화면 위쪽부터 시계방향으로 그릴 좌석 인덱스 순서
  - `<Felt state={TableState | null} orientation={'player'|'dealer'} mySeatIndex={number|null} onSeatClick?={(seatIndex:number)=>void} />`
  - `<Keypad onDigit={(d:string)=>void} onClear={()=>void} />`

- [ ] **Step 1: 좌석 순서의 실패하는 테스트를 쓴다**

와이어프레임이 정한 것: **같은 테이블을 180° 돌린 것이고 좌석 번호는 그대로다.** 좌석 태블릿은 딜러가 위(건너편), 딜러 태블릿은 딜러가 아래(자기 앞). 도면 근거는 와이어프레임 724–845행(좌석 게임)과 940–1045행(딜러 게임)이다.

`frontend/src/component/felt/seatOrder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { seatOrder } from './seatOrder';

describe('seatOrder', () => {
  it('좌석 아홉을 하나도 빠뜨리지 않는다', () => {
    for (const o of ['player', 'dealer'] as const) {
      expect([...seatOrder(o)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    }
  });

  it('두 방향은 서로의 역순이다 — 같은 테이블을 180도 돌린 것이다', () => {
    expect(seatOrder('dealer')).toEqual([...seatOrder('player')].reverse());
  });

  it('좌석 번호 자체는 방향에 따라 바뀌지 않는다', () => {
    // 4번 자리는 어느 화면에서도 4번이다. 고개를 들면 진짜 테이블이 있다.
    expect(seatOrder('player')).toContain(4);
    expect(seatOrder('dealer')).toContain(4);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd frontend && npx vitest run src/component/felt/seatOrder.test.ts`
Expected: FAIL — `Failed to resolve import "./seatOrder"`

- [ ] **Step 3: `seatOrder.ts`를 쓴다**

```ts
/**
 * 좌석 인덱스를 화면에 그릴 순서로 준다.
 *
 * 테이블은 회전하지 않는다. 좌석 태블릿은 딜러가 위(건너편), 딜러 태블릿은
 * 딜러가 아래(자기 앞)라서 같은 테이블을 180° 돌린 것이 되고, **좌석 번호는
 * 그대로다.** 고개를 들면 진짜 테이블이 있으므로 화면이 눈과 어긋나는 순간
 * 그게 곧 오조작이다.
 */
export type FeltOrientation = 'player' | 'dealer';

const PLAYER_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 8];

export function seatOrder(orientation: FeltOrientation): number[] {
  return orientation === 'player' ? [...PLAYER_ORDER] : [...PLAYER_ORDER].reverse();
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd frontend && npx vitest run src/component/felt/seatOrder.test.ts`
Expected: PASS 3건

- [ ] **Step 5: 와이어프레임 CSS 변수를 옮긴다**

`frontend/wireframes/2026-08-02-screens.html`의 2–355행 중 `:root` 블록(대략 10–60행)에 있는 변수를 `frontend/src/app/wireframe-tokens.css`로 그대로 옮긴다. 값을 바꾸지 않는다.

옮길 것: Carbon 계열(`--canvas` `--surface` `--ink` `--ink-subtle` `--hairline` `--blue`), 전광판(`--sb-*`), 태블릿(`--tb-*` `--felt` `--felt-edge` `--felt-rail` `--card-face`), 상태색(`--ok` `--warn` `--err`), 폰트(`--sans` `--mono` `--cond`).

`globals.css` 최상단(`@import "tailwindcss";` 바로 아래)에 `@import "./wireframe-tokens.css";`를 넣고, `@theme inline` 블록에 Tailwind가 쓸 이름을 붙인다:

```css
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-felt: var(--felt);
  --color-felt-edge: var(--felt-edge);
  --color-felt-rail: var(--felt-rail);
  --color-card-face: var(--card-face);
  --color-tb-bg: var(--tb-bg);
  --color-tb-panel: var(--tb-panel);
  --color-tb-line: var(--tb-line);
  --color-tb-ink: var(--tb-ink);
  --color-tb-muted: var(--tb-muted);
  --color-tb-sub: var(--tb-sub);
  --color-tb-act: var(--tb-act);
  --color-sb-bg: var(--sb-bg);
  --color-sb-ink: var(--sb-ink);
  --color-sb-dim: var(--sb-dim);
  --color-sb-live: var(--sb-live);
  --color-sb-break: var(--sb-break);
  --font-sans: var(--sans);
  --font-mono: var(--mono);
  --font-cond: var(--cond);
}
```

- [ ] **Step 6: `Felt.tsx`를 쓴다**

와이어프레임 724–845행(좌석 게임 화면)의 펠트 마크업을 옮긴다. 좌석 아홉 · 보드 칸 다섯 · 팟 · 사이드팟까지가 이 컴포넌트다. 조작 버튼은 들어오지 않는다.

```tsx
'use client';

import { TableState } from '@/app/types/game';
import { seatOrder, type FeltOrientation } from './seatOrder';

/** 페이즈가 곧 깔린 카드 장수다. 무늬는 서버에 없고 앞으로도 없다. */
const BOARD_COUNT: Record<number, number> = { 0: 0, 1: 0, 2: 3, 3: 4, 4: 5, 5: 5, 6: 5 };

export default function Felt({
  state,
  orientation,
  mySeatIndex,
  onSeatClick,
}: {
  state: TableState | null;
  orientation: FeltOrientation;
  mySeatIndex: number | null;
  onSeatClick?: (seatIndex: number) => void;
}) {
  const dealt = BOARD_COUNT[state?.phase ?? 0] ?? 0;

  return (
    <div className="relative h-full w-full bg-felt-rail p-[2%]">
      <div className="relative h-full w-full rounded-full border-4 border-felt-edge bg-felt">
        {/* 보드 — 장수만 보여준다 */}
        <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 gap-2">
          {Array.from({ length: 5 }, (_, i) => (
            <div
              key={i}
              data-testid={`board-card-${i}`}
              data-dealt={i < dealt}
              className={
                i < dealt
                  ? 'h-14 w-10 rounded bg-card-face'
                  : 'h-14 w-10 rounded border border-dashed border-tb-sub'
              }
            />
          ))}
        </div>

        {/* 좌석 아홉 */}
        {seatOrder(orientation).map((seatIndex, slot) => {
          const player = state?.players[seatIndex] ?? null;
          return (
            <button
              key={seatIndex}
              type="button"
              data-testid={`seat-${seatIndex}`}
              data-slot={slot}
              data-me={seatIndex === mySeatIndex}
              disabled={!onSeatClick}
              onClick={() => onSeatClick?.(seatIndex)}
              className="absolute rounded border border-tb-line bg-tb-panel px-3 py-2 text-tb-ink"
              style={seatPosition(slot)}
            >
              <span className="block font-mono text-xs text-tb-muted">{seatIndex + 1}</span>
              <span className="block text-sm">{player?.nickname ?? '빈 자리'}</span>
              <span className="block font-mono text-sm">{player ? player.stack.toLocaleString() : ''}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 타원 위 아홉 자리. slot 0이 화면 위 한가운데다. */
function seatPosition(slot: number): React.CSSProperties {
  const angle = (Math.PI * 2 * slot) / 9 - Math.PI / 2;
  return {
    left: `${50 + 42 * Math.cos(angle)}%`,
    top: `${50 + 38 * Math.sin(angle)}%`,
    transform: 'translate(-50%, -50%)',
  };
}
```

- [ ] **Step 7: `Keypad.tsx`를 쓴다**

와이어프레임 646–723행의 OTP 키패드 마크업을 옮긴다. 좌석 대기와 딜러 대기가 같은 것을 쓴다.

```tsx
'use client';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

export default function Keypad({
  onDigit,
  onClear,
}: {
  onDigit: (digit: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {KEYS.map((k) => (
        <button key={k} type="button" onClick={() => onDigit(k)}
          className="rounded border border-tb-line bg-tb-panel py-4 font-mono text-2xl text-tb-ink">
          {k}
        </button>
      ))}
      <button type="button" onClick={onClear}
        className="rounded border border-tb-line bg-tb-panel py-4 text-tb-muted">
        지우기
      </button>
      <button type="button" onClick={() => onDigit('0')}
        className="rounded border border-tb-line bg-tb-panel py-4 font-mono text-2xl text-tb-ink">
        0
      </button>
    </div>
  );
}
```

- [ ] **Step 8: 타입 체크와 전체 프론트 테스트**

Run: `npm run typecheck && npm run test -w frontend`
Expected: 타입 에러 0건, 기존 52건 + 새 3건 = 55건 통과

- [ ] **Step 9: 커밋**

```bash
git add frontend/src/app/wireframe-tokens.css frontend/src/app/globals.css frontend/src/component
git commit -m "chore: 와이어프레임 CSS를 토큰으로 옮기고 공유 펠트를 만든다"
```

---

### Task 2: 좌석 대기 화면과 좌석 현황 API

**Files:**
- Modify: `backend/src/entry/entry.controller.ts`
- Modify: `backend/src/entry/entry.service.ts`
- Test: `backend/src/entry/entry.service.int-spec.ts` (기존 파일이 없으면 생성)
- Create: `frontend/src/app/(terminal)/table/page.tsx`
- Create: `frontend/src/app/(terminal)/table/WaitingClient.tsx`
- Create: `frontend/src/app/(terminal)/table/action.ts`
- Test: `frontend/src/app/(terminal)/table/WaitingClient.test.tsx`

**Interfaces:**
- Consumes: `Keypad` (Task 1)
- Produces:
  - `GET /tournaments/:id/seats` → `{ tableId: string; seatStatus: boolean[] }[]`
  - `enterSeat(input: { tournamentId: string; tableId: string; seatIndex: number; otp: string }): Promise<{ ok: true } | { error: string }>` — 성공 시 `accessToken` 쿠키를 심는다

- [ ] **Step 1: 백엔드 통합 테스트를 먼저 쓴다**

`backend/src/entry/entry.service.int-spec.ts`에 붙인다(파일이 없으면 `src/scenario/harness.ts`가 아니라 기존 `*.int-spec.ts` 하나를 열어 셋업 방식을 그대로 따른다):

```ts
it('좌석 비트맵이 없는 대회는 빈 배열이다', async () => {
  const result = await entryService.getSeatMap('없는-대회-id');
  expect(result).toEqual([]);
});

it('앉은 자리만 true로 나온다', async () => {
  await redis.updateSeatBitmap(tournamentId, tableId, 3, true);
  const result = await entryService.getSeatMap(tournamentId);
  expect(result).toEqual([
    { tableId, seatStatus: [false, false, false, true, false, false, false, false, false] },
  ]);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json --testPathPatterns entry.service`
Expected: FAIL — `entryService.getSeatMap is not a function`

**실패한 단언의 expected/received를 보고서에 그대로 옮긴다.**

- [ ] **Step 3: 서비스와 컨트롤러를 쓴다**

`EntryService`에 추가한다. `redis.getTournamentTables`가 이미 `{ tableId, seatStatus }[]`를 만들므로 통과시키기만 한다:

```ts
  /**
   * 좌석 점유 현황.
   *
   * 가드가 없다 — 좌석 대기 화면은 **앉기 전**에 이걸 읽어야 하는데, 그
   * 시점의 태블릿은 자격 증명이 하나도 없다. 같은 화면이 부르는
   * `POST /tournaments/:id/enter`가 이미 공개인 것과 같은 이유다(OTP 자체가
   * 자격 증명이라 그 앞에 가드를 세울 수 없다).
   *
   * WS(`renderSeatList`)로 하지 않은 이유: 대회 스코프 구독도 티켓을 요구하고
   * (`ws.gateway.ts` handleConnection), 티켓은 JWT를 보고 발급된다. 게이트웨이의
   * "신뢰의 출처가 티켓 소비다"에 예외를 내는 값이 "좌석 도식이 1초 빠르다"뿐이라
   * 폴링을 택했다. 동시 지정의 최종 판정은 그대로 `enter`의 409다.
   */
  async getSeatMap(tournamentId: string) {
    return await this.redis.getTournamentTables(tournamentId);
  }
```

`EntryController`에 추가한다:

```ts
  @Get(':id/seats')
  async seats(@Param('id') tournamentId: string) {
    return await this.entryService.getSeatMap(tournamentId);
  }
```

`@nestjs/common`의 `Get` import를 추가한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `cd backend && KEEP_TEST_CONTAINERS=1 npx jest --config ./test/jest-int.json --testPathPatterns entry.service`
Expected: PASS

- [ ] **Step 5: 서버 액션의 실패하는 테스트를 쓴다**

`frontend/src/app/(terminal)/table/WaitingClient.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WaitingClient from './WaitingClient';

const TOURNAMENTS = [{ id: 't1', name: '데모 토너먼트', status: 'ONGOING' }];
const TABLES = [{ id: 'tb1', tableOrder: 1 }, { id: 'tb2', tableOrder: 2 }];

describe('WaitingClient', () => {
  it('점유된 자리는 누를 수 없다', async () => {
    render(
      <WaitingClient
        storeId="s1"
        tournaments={TOURNAMENTS}
        tables={TABLES}
        seatMap={[{ tableId: 'tb1', seatStatus: [false, false, true, false, false, false, false, false, false] }]}
        enterSeat={vi.fn()}
      />,
    );
    expect(screen.getByTestId('pick-seat-2')).toBeDisabled();
    expect(screen.getByTestId('pick-seat-3')).not.toBeDisabled();
  });

  it('409를 받으면 그 문구가 화면에 뜬다', async () => {
    const enterSeat = vi.fn().mockResolvedValue({ error: '이미 다른 참가자가 앉은 좌석입니다.' });
    render(
      <WaitingClient
        storeId="s1"
        tournaments={TOURNAMENTS}
        tables={TABLES}
        seatMap={[{ tableId: 'tb1', seatStatus: Array(9).fill(false) }]}
        enterSeat={enterSeat}
      />,
    );
    await userEvent.click(screen.getByTestId('pick-seat-3'));
    for (const d of ['1', '2', '3', '4', '5', '6']) {
      await userEvent.click(screen.getByRole('button', { name: d }));
    }
    await userEvent.click(screen.getByRole('button', { name: /참가/ }));
    await waitFor(() => {
      expect(screen.getByText('이미 다른 참가자가 앉은 좌석입니다.')).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 6: 실패를 확인한다**

Run: `cd frontend && npx vitest run "src/app/(terminal)/table/WaitingClient.test.tsx"`
Expected: FAIL — `Failed to resolve import "./WaitingClient"`

- [ ] **Step 7: 서버 액션을 쓴다**

`frontend/src/app/(terminal)/table/action.ts`. `dealer/[id]/action.ts`의 `failureMessage`와 같은 모양을 쓴다 — NestJS 예외 본문의 `message`가 문자열이거나 배열이다:

```ts
'use server';

import { cookies } from 'next/headers';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const DEFAULT_ENTER_ERROR = 'OTP를 확인하세요.';

function failureMessage(body: unknown): string {
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && message.length > 0) return message;
  if (Array.isArray(message) && message.length > 0) return message.join(' ');
  return DEFAULT_ENTER_ERROR;
}

/**
 * 참가 OTP로 좌석을 확정하고 좌석 토큰을 httpOnly 쿠키로 심는다.
 *
 * 응답 키가 `accessToken`이고 안에 든 것은 `role: SEAT_ROLE`인 **좌석 토큰**이다
 * (`entry.service.ts`). 쿠키 이름을 그대로 재사용한다 — 태블릿은 사용자
 * 로그인을 하지 않으므로 실제 기기에서 두 값이 한 브라우저에 같이 있을 일이 없다.
 *
 * 토큰은 이 함수 밖으로 나가지 않는다. 반환값에도 없다.
 */
export async function enterSeat(input: {
  tournamentId: string;
  tableId: string;
  seatIndex: number;
  otp: string;
}): Promise<{ ok: true; tableId: string } | { error: string }> {
  const res = await fetch(`${BACKEND_URL}/tournaments/${input.tournamentId}/enter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ otp: input.otp, tableId: input.tableId, seatIndex: input.seatIndex }),
    cache: 'no-store',
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) return { error: failureMessage(body) };

  const cookieStore = await cookies();
  cookieStore.set('accessToken', (body as { accessToken: string }).accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    // 백엔드 JWT 만료가 1시간이다. 더 길게 잡으면 죽은 토큰으로 붙으려다
    // 티켓 발급에서 401을 받는다(`dealer/[id]/action.ts`와 같은 근거).
    maxAge: 60 * 60,
  });

  return { ok: true, tableId: input.tableId };
}
```

- [ ] **Step 8: `WaitingClient.tsx`와 `page.tsx`를 쓴다**

마크업은 와이어프레임 646–723행을 옮긴다. 좌석 도식의 각 자리에 `data-testid={`pick-seat-${i}`}`를 붙이고, 점유된 자리는 `disabled`로 둔다(도면의 점선이 그것이다).

`page.tsx`는 서버 컴포넌트다. `?store=`를 읽어 세 번 조회한다:

```tsx
import WaitingClient from './WaitingClient';
import { enterSeat } from './action';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

async function json(path: string) {
  const res = await fetch(`${BACKEND_URL}${path}`, { cache: 'no-store' });
  return res.ok ? res.json() : null;
}

export default async function SeatWaitingPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string }>;
}) {
  const { store } = await searchParams;
  if (!store) return <main className="p-8 text-tb-ink">?store= 가 필요합니다.</main>;

  const tournaments = (await json(`/tournaments/stores/${store}`)) ?? [];
  const current = tournaments[0] ?? null;
  const session = current ? await json(`/dealer/${current.id}`) : null;
  const seatMap = current ? ((await json(`/tournaments/${current.id}/seats`)) ?? []) : [];

  return (
    <main className="h-screen overflow-hidden bg-tb-bg">
      <WaitingClient
        storeId={store}
        tournaments={tournaments}
        tables={session?.tables ?? []}
        seatMap={seatMap}
        enterSeat={enterSeat}
      />
    </main>
  );
}
```

`WaitingClient`는 좌석 현황을 5초마다 다시 읽는다(`/api/tournaments/${id}/seats` — `next.config.ts`의 rewrite가 백엔드로 넘긴다). 성공하면 `router.push(\`/table/${tableId}\`)`.

- [ ] **Step 9: 통과를 확인한다**

Run: `cd frontend && npx vitest run "src/app/(terminal)/table/WaitingClient.test.tsx"`
Expected: PASS 2건

- [ ] **Step 10: 타입 체크와 전체 테스트**

Run: `npm run typecheck && npm run test -w frontend`
Expected: 타입 에러 0건, 57건 통과

- [ ] **Step 11: 커밋**

```bash
git add backend/src/entry frontend/src/app/\(terminal\)/table
git commit -m "feat: 좌석 대기 화면과 좌석 현황 조회를 만든다"
```

---

### Task 3: 좌석 게임 화면과 오버레이 둘

**Files:**
- Modify: `frontend/src/app/(terminal)/table/[tableId]/page.tsx`
- Create: `frontend/src/app/(terminal)/table/[tableId]/SeatGameClient.tsx`
- Create: `frontend/src/app/(terminal)/table/[tableId]/RebuyOverlay.tsx`
- Create: `frontend/src/app/(terminal)/table/[tableId]/EliminatedOverlay.tsx`
- Create: `frontend/src/app/(terminal)/table/[tableId]/SeatActionPanel.tsx`
- Delete: `frontend/src/app/(terminal)/table/[tableId]/GameClient.tsx`, `PokerTable.tsx`, `ActionPanel.tsx`, `ActionPanel.test.tsx`
- Modify: `frontend/src/app/(terminal)/table/[tableId]/GameClient.test.tsx` → `SeatGameClient.test.tsx`
- Modify: `frontend/src/app/(terminal)/table/[tableId]/page.test.tsx`

**Interfaces:**
- Consumes: `Felt`, `seatOrder` (Task 1)
- Produces: `<SeatGameClient tableId initialData seatIndex />` — 딜러 분기가 없다

- [ ] **Step 1: 살릴 테스트를 먼저 옮긴다**

`GameClient.test.tsx`의 세 건(티켓 네트워크 실패 · 403 배너 · 기본 문구)과 `page.test.tsx`의 두 건(`accessToken`·`dealerToken`이 클라이언트 prop 어디에도 없다)은 **T24가 심은 것이다.** 컴포넌트 이름만 바꿔 그대로 살린다. 지우지 않는다.

`page.test.tsx`는 `initIsDealer` prop이 사라지므로 그 부분만 고친다.

- [ ] **Step 2: 탈락 트리거의 실패하는 테스트를 쓴다**

`SeatGameClient.test.tsx`에 추가:

```tsx
it('리바인을 거절하면 탈락 오버레이가 뜬다', async () => {
  const { socket } = renderWithSocket();
  socket.emitServerEvent('REBUY_PROMPT', { deadline: Date.now() + 30_000 });
  await userEvent.click(await screen.findByRole('button', { name: /거절/ }));
  expect(await screen.findByText(/폰에서 확인/)).toBeInTheDocument();
});

it('내 좌석이 스냅샷에서 사라지면 탈락 오버레이가 뜬다', async () => {
  const { socket } = renderWithSocket({ seatIndex: 3 });
  const players = Array(9).fill(null);
  socket.emitServerEvent('renderGame', { ...BASE_STATE, players });
  expect(await screen.findByText(/폰에서 확인/)).toBeInTheDocument();
});

it('리바인 프롬프트 중에는 탈락 오버레이가 뜨지 않는다', async () => {
  const { socket } = renderWithSocket({ seatIndex: 3 });
  socket.emitServerEvent('REBUY_PROMPT', { deadline: Date.now() + 30_000 });
  socket.emitServerEvent('renderGame', { ...BASE_STATE, players: Array(9).fill(null) });
  expect(screen.queryByText(/폰에서 확인/)).not.toBeInTheDocument();
});
```

세 번째가 중요하다. **두 트리거가 서로를 가리지 않게** 하는 검사다 — 리바인 구간에도 좌석이 잠깐 비므로, 첫 두 검사만 있으면 "좌석 소멸" 하나로 둘 다 초록이 된다.

WS는 `vi.stubGlobal('WebSocket', FakeSocket)`으로 세운다. `renderWithSocket` 헬퍼를 같은 파일 위쪽에 둔다.

- [ ] **Step 3: 실패를 확인한다**

Run: `cd frontend && npx vitest run "src/app/(terminal)/table/[tableId]"`
Expected: FAIL — `Failed to resolve import "./SeatGameClient"`

- [ ] **Step 4: `SeatGameClient.tsx`를 쓴다**

기존 `GameClient.tsx`에서 딜러 분기(`isDealer`, `DEALER_ACTION`)를 걷어내고 오버레이 둘을 더한다. WS 배선(티켓 요청 · `cancelled` 정리 · `connectionError` 배너)은 **그대로 옮긴다** — T24가 세운 규칙이고 살릴 테스트가 그것을 본다.

탈락 판정:

```tsx
// 서버는 "너 탈락했다"를 보내지 않는다. 클라가 받는 것은 renderGame과
// REBUY_PROMPT 둘뿐이라 프론트가 유추한다. 틀려도 잃는 것은 화면 전환
// 타이밍뿐이고 순위·상금은 폰이 들고 있다.
const [rebuyData, setRebuyData] = useState<RebuyPrompt | null>(null);
const [eliminated, setEliminated] = useState(false);

// renderGame이 올 때:
if (!rebuyData && mySeatIndex !== null && data.players[mySeatIndex] === null) {
  setEliminated(true);
}
```

리바인 거절(`REBUY_RESPONSE { accept: false }`)을 보낸 직후에도 `setEliminated(true)`.

레이아웃은 와이어프레임 724–845행. `<Felt orientation="player" />`가 화면 대부분을 차지하고, 아래에 `SeatActionPanel`(폴드·체크/콜·레이즈 슬라이더)이 붙는다. **스크롤이 없어야 한다** — `h-screen overflow-hidden`.

- [ ] **Step 5: 오버레이 둘을 쓴다**

`RebuyOverlay.tsx`는 와이어프레임 846–884행, `EliminatedOverlay.tsx`는 885–922행.

탈락 오버레이는 "폰에서 확인하세요" 한 줄과 카운트다운을 띄우고, 끝나면 `router.push(\`/table?store=${storeId}\`)`로 대기 화면으로 돌아간다 — 그 자리는 다음 사람이 앉을 자리다. `storeId`는 `page.tsx`가 prop으로 내린다.

- [ ] **Step 6: 통과를 확인한다**

Run: `cd frontend && npx vitest run "src/app/(terminal)/table/[tableId]"`
Expected: PASS — 살린 5건 + 새 3건

- [ ] **Step 7: 지운 파일이 어디서도 import되지 않는지 확인한다**

Run: `npm run typecheck`
Expected: 타입 에러 0건

- [ ] **Step 8: 커밋**

```bash
git add -A frontend/src/app/\(terminal\)/table
git commit -m "feat: 좌석 게임 화면과 리바인·탈락 오버레이를 만든다"
```

---

### Task 4: 딜러 태블릿

**Files:**
- Create: `frontend/src/app/(terminal)/dealer/page.tsx`
- Create: `frontend/src/app/(terminal)/dealer/DealerWaitingClient.tsx`
- Move: `frontend/src/app/(terminal)/dealer/[id]/action.ts` → `frontend/src/app/(terminal)/dealer/action.ts`
- Move: `frontend/src/app/(terminal)/dealer/[id]/action.test.ts` → `frontend/src/app/(terminal)/dealer/action.test.ts`
- Delete: `frontend/src/app/(terminal)/dealer/[id]/` 전체
- Create: `frontend/src/app/(terminal)/dealer/table/[tableId]/page.tsx`
- Create: `frontend/src/app/(terminal)/dealer/table/[tableId]/DealerGameClient.tsx`
- Create: `frontend/src/app/(terminal)/dealer/table/[tableId]/WinnerOverlay.tsx`
- Test: `frontend/src/app/(terminal)/dealer/table/[tableId]/WinnerOverlay.test.tsx`

**Interfaces:**
- Consumes: `Felt`, `seatOrder`, `Keypad` (Task 1), `authenticateDealer` (이동한 서버 액션)
- Produces: 없음(마지막 태블릿 면)

- [ ] **Step 1: 보드 하이의 실패하는 테스트를 쓴다**

`WinnerOverlay.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WinnerOverlay from './WinnerOverlay';

const PLAYERS = [
  { id: 'u1', nickname: 'A', hasFolded: false },
  { id: 'u2', nickname: 'B', hasFolded: true },
  { id: 'u3', nickname: 'C', hasFolded: false },
];

describe('WinnerOverlay', () => {
  it('보드 하이는 폴드하지 않은 전원을 한 그룹으로 보낸다', async () => {
    const onSubmit = vi.fn();
    render(<WinnerOverlay players={PLAYERS} onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /보드 하이/ }));
    expect(onSubmit).toHaveBeenCalledWith([['u1', 'u3']]);
  });

  it('폴드한 사람은 승자로 고를 수 없다', () => {
    render(<WinnerOverlay players={PLAYERS} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('winner-pick-u2')).toBeDisabled();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd frontend && npx vitest run "src/app/(terminal)/dealer"`
Expected: FAIL — `Failed to resolve import "./WinnerOverlay"`

- [ ] **Step 3: `WinnerOverlay.tsx`를 쓴다**

와이어프레임 1046–1102행. 승자를 순위 그룹의 배열(`string[][]`)로 모아 `onSubmit`에 넘긴다 — 동점이면 한 그룹에 여럿이다.

**보드 하이 버튼**은 폴드하지 않은 전원을 한 그룹으로 채워 보낸다. 서버에 별도 엔드포인트를 만들지 않는다 — 돈이 나가는 경로를 하나로 유지하기 위해서다.

```tsx
const boardHigh = () => onSubmit([players.filter((p) => !p.hasFolded).map((p) => p.id)]);
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd frontend && npx vitest run "src/app/(terminal)/dealer"`
Expected: PASS 2건

- [ ] **Step 5: 딜러 대기 화면을 만든다**

`/dealer?store=`. **좌석 대기 화면(Task 2)의 배치를 그대로 쓰되 누르는 대상만 자리에서 테이블로 바꾼다** — 와이어프레임에 그림이 없는 유일한 화면이라, 명세가 안 그린 것을 명세가 그린 문법으로 메운다.

읽기는 `GET /tournaments/stores/:storeId` → `GET /dealer/:tournamentId`. 쓰기는 이동해 온 `authenticateDealer` 서버 액션이다(내용을 고치지 않는다 — `dealerToken`을 httpOnly로 심는 지금 동작 그대로). 성공하면 `router.push(\`/dealer/table/${tableId}\`)`.

`(terminal)/dealer/[id]/`를 통째로 지운다. URL에 대회가 박히면 그게 곧 기기별 설정이라 대회마다 딜러 태블릿을 손으로 고쳐야 한다.

- [ ] **Step 6: 딜러 게임 화면을 만든다**

와이어프레임 940–1045행. `<Felt orientation="dealer" onSeatClick={...} />` — **9행 좌석 표를 만들지 않는다.** 도면이 그 표를 없애고 펠트의 자리를 직접 누르게 바꾼 이유가 스크롤이다.

- 자리를 누르면 내보내기 확인
- 핸드 시작 버튼 → `DEALER_ACTION`
- 쇼다운이면 승자 결정 오버레이

`DEALER_ACTION` 페이로드는 `@playsync/contract`의 `dealer-action.ts` 스키마를 따른다. 스키마에 없는 키를 실으면 인바운드 `.strict()`가 거부한다.

- [ ] **Step 7: 타입 체크와 전체 테스트**

Run: `npm run typecheck && npm run test -w frontend`
Expected: 타입 에러 0건, 전건 통과

- [ ] **Step 8: 커밋**

```bash
git add -A frontend/src/app/\(terminal\)/dealer
git commit -m "feat: 딜러 태블릿을 대기 화면부터 다시 만든다"
```

---

### Task 5: 전광판

**Files:**
- Create: `packages/contract/src/dashboard.ts`
- Modify: `packages/contract/src/index.ts`
- Test: `packages/contract/src/dashboard.spec.ts`
- Modify: `frontend/src/app/(console)/stores/[storeId]/tournaments/[tournamentId]/display/page.tsx`
- Create: `.../display/DisplayClient.tsx`
- Modify: `.../display/page.test.tsx`
- Test: `.../display/DisplayClient.test.tsx`

**Interfaces:**
- Consumes: 없음
- Produces: `FullTournamentInfoSchema`, `type FullTournamentInfo` (contract)

- [ ] **Step 1: contract 스키마의 실패하는 테스트를 쓴다**

`packages/contract/src/dashboard.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FullTournamentInfoSchema } from './dashboard';

const VALID = {
  dashboard: {
    isRegistrationOpen: true, totalPlayer: 20, activePlayer: 7,
    totalBuyinAmount: 350000, rebuyUntil: 0, avgStack: 50000,
    tournamentName: '데모 토너먼트', entryFee: 50000, startStack: 30000,
    itmCount: 3, prizePool: 350000,
    prizes: [{ place: 1, percent: 50, amount: 175000 }],
  },
  blindField: {
    isBreak: false, startedAt: 0, currentBlindLv: 0,
    nextLevelAt: 1000, serverTime: 0,
    blindStructure: [{ lv: 1, sb: 100, ante: false, duration: 10 }],
  },
};

describe('FullTournamentInfoSchema', () => {
  it('아웃바운드는 스키마에 없는 키를 조용히 지운다', () => {
    const parsed = FullTournamentInfoSchema.parse({
      ...VALID,
      dashboard: { ...VALID.dashboard, dealerOtpHash: '새면-안-되는-값' },
    });
    expect(parsed.dashboard).not.toHaveProperty('dealerOtpHash');
  });

  it('휴식 레벨을 그대로 통과시킨다', () => {
    const parsed = FullTournamentInfoSchema.parse({
      ...VALID,
      blindField: { ...VALID.blindField, isBreak: true },
    });
    expect(parsed.blindField.isBreak).toBe(true);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd packages/contract && npx vitest run src/dashboard.spec.ts`
Expected: FAIL — `Failed to resolve import "./dashboard"`

- [ ] **Step 3: 스키마를 쓴다**

`backend/shared/types/tournamentMeta.ts`의 `Dashboard`·`BlindField`·`FullTournamentInfo`를 zod로 옮긴다. **아웃바운드라 `.strict()`를 붙이지 않는다** — 기본 스트립이 곧 그물이다(CLAUDE.md의 contract 규칙). `index.ts`에 `export * from "./dashboard";`를 더한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `cd packages/contract && npx vitest run src/dashboard.spec.ts`
Expected: PASS 2건

- [ ] **Step 5: 세 상태의 실패하는 테스트를 쓴다**

`DisplayClient.test.tsx`. **셋이 서로를 가리지 않게** 각각 다른 입력을 먹인다:

```tsx
it('응답이 null이면 대기 중을 그린다', async () => {
  server.use(http.get('*/playsync/dashboard/:id', () => HttpResponse.json(null)));
  render(<DisplayClient tournamentId="t1" />);
  expect(await screen.findByText('대기 중')).toBeInTheDocument();
});

it('isBreak면 화면을 통째로 휴식으로 바꾼다', async () => {
  server.use(http.get('*/playsync/dashboard/:id', () =>
    HttpResponse.json({ ...VALID, blindField: { ...VALID.blindField, isBreak: true } })));
  render(<DisplayClient tournamentId="t1" />);
  expect(await screen.findByText('휴식')).toBeInTheDocument();
  // 배지 하나로는 담배 피우러 나간 사람이 못 본다. 남은 시간만 남기고 지운다.
  expect(screen.queryByText('데모 토너먼트')).not.toBeInTheDocument();
});

it('평상시에는 프라이즈풀과 남은 인원이 보인다', async () => {
  server.use(http.get('*/playsync/dashboard/:id', () => HttpResponse.json(VALID)));
  render(<DisplayClient tournamentId="t1" />);
  expect(await screen.findByText('350,000')).toBeInTheDocument();
  expect(screen.getByText('7')).toBeInTheDocument();
});
```

- [ ] **Step 6: 실패를 확인한다**

Run: `cd frontend && npx vitest run "src/app/(console)"`
Expected: FAIL — `Failed to resolve import "./DisplayClient"`

- [ ] **Step 7: `DisplayClient.tsx`를 쓴다**

와이어프레임 537–603행(평상시)과 604–627행(휴식).

```tsx
'use client';

// 조회가 곧 블라인드 시계를 미는 일이다 — getFullTournamentInfo가 안에서
// checkAndSyncBlindLevel을 부른다(redis.service.ts). 서버에 별도 타이머를 두지
// 않는 이유는 상태를 미는 코드가 한 곳뿐이라야 레벨과 마감이 두 갈래로 자라지
// 않기 때문이다. **그래서 전광판은 대회 내내 틀어 둔다.**
//
// 갈라지는 구간이 휴식이다. 그때는 startPreFlop이 거부되므로 미는 것이 이
// 폴링뿐이다.
const POLL_MS = 3000;
```

세 상태로 가른다.

- 응답이 `null`(200에 빈 몸통) → **"대기 중"**. 시작 전에는 Redis 스냅샷이 없어 없는 대회와 구별되지 않는다. 에러로 그리지 않는다
- `blindField.isBreak` → 휴식. 남은 시간 하나만 남기고 나머지를 지운다
- 그 외 → 평상시

카운트다운은 `nextLevelAt - serverTime`을 기준으로 클라이언트 시계를 보정해서 센다. 브라우저 시계를 그대로 믿으면 태블릿마다 다른 숫자가 뜬다.

응답은 `FullTournamentInfoSchema.parse()`를 통과시킨다.

- [ ] **Step 8: 통과를 확인한다**

Run: `cd frontend && npx vitest run "src/app/(console)"`
Expected: PASS 3건 + 기존 page.test.tsx

- [ ] **Step 9: 전체 테스트**

Run: `npm run typecheck && npm run test`
Expected: 타입 에러 0건, contract 62건, 프론트 전건 통과

- [ ] **Step 10: 커밋**

```bash
git add packages/contract frontend/src/app/\(console\)
git commit -m "feat: 전광판을 평상시·휴식·대기 중 셋으로 그린다"
```

---

### Task 6: 상점 콘솔 대회 상세

**Files:**
- Create: `frontend/src/app/(console)/stores/[storeId]/tournaments/[tournamentId]/page.tsx`
- Create: `.../[tournamentId]/ConsoleClient.tsx`
- Create: `.../[tournamentId]/action.ts`
- Modify: `frontend/src/middleware.ts`
- Modify: `frontend/src/middleware.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: 없음

- [ ] **Step 1: 404 본문의 실패하는 테스트를 쓴다**

지금은 역할 불일치에 빈 본문 404가 나가 백지가 뜬다. 상태 코드는 맞아 정보 노출 요건은 충족한다 — **본문만 채운다.**

`middleware.test.ts`에 추가:

```ts
it('역할이 맞지 않으면 404를 유지하되 not-found 화면으로 rewrite한다', () => {
  const res = middleware(requestWithRole('/stores/s1/tournaments/t1', 'USER'));
  expect(res.status).toBe(404);
  expect(res.headers.get('x-middleware-rewrite')).toContain('/_not-found');
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd frontend && npx vitest run src/middleware.test.ts`
Expected: FAIL — `expected null to contain '/_not-found'`

- [ ] **Step 3: 미들웨어를 고친다**

```ts
  // 역할이 맞지 않으면 404다. 403은 그 자원이 존재한다는 사실을 알려준다.
  // 상태 코드는 그대로 두고 본문만 채운다 — 빈 본문이면 백지가 뜬다.
  if (rule && !rule.allow.includes(session.role)) {
    return NextResponse.rewrite(new URL('/_not-found', request.url), { status: 404 });
  }
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd frontend && npx vitest run src/middleware.test.ts`
Expected: PASS

- [ ] **Step 5: 콘솔 화면을 만든다**

와이어프레임 393–520행. **이 면은 Carbon 그대로다**(`--canvas` `--surface` `--ink` `--hairline` `--blue`).

읽기: `GET /tournaments/:id`, `GET /playsync/dashboard/:tournamentId`, `GET /dealer/:tournamentId`(테이블+좌석 도식), `GET /tournaments/:id/seats`(Task 2).

쓰기(전부 서버 액션 → `action.ts`):

| 조작 | 엔드포인트 |
|---|---|
| 대회 시작 | `PATCH /store/sessions/:id/start` |
| 테이블 열기 | `POST /store/sessions/:id/tables` |
| 테이블 닫기 | `DELETE /store/sessions/:id/tables/:tableId` |
| 좌석 해제 | `POST /store/sessions/:id/tables/:tableId/seats/release` |
| 딜러 OTP 재발급 | `POST /store/sessions/:id/dealer-otp/reissue` |

전광판은 이 화면에서 **새 창으로** 연다(`target="_blank"`). 전체화면은 F11이다 — 크롬 없는 전용 레이아웃을 만들지 않는다.

- [ ] **Step 6: 타입 체크와 전체 테스트**

Run: `npm run typecheck && npm run test -w frontend`
Expected: 타입 에러 0건, 전건 통과

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/middleware.ts frontend/src/middleware.test.ts frontend/src/app/\(console\)
git commit -m "feat: 상점 콘솔 대회 상세를 만들고 역할 불일치 404의 백지를 없앤다"
```

---

### Task 7: 참가자 폰과 인증 경로 통일

**Files:**
- Create: `frontend/src/app/(player)/tournaments/[id]/page.tsx`
- Create: `frontend/src/app/(player)/tournaments/[id]/action.ts`
- Create: `frontend/src/app/(player)/me/page.tsx`
- Modify: `frontend/src/app/auth/action.ts`
- Modify: `frontend/src/mocks/handlers.ts`
- Test: `frontend/src/app/(player)/me/page.test.tsx`

**Interfaces:**
- Consumes: 없음
- Produces: 없음

- [ ] **Step 1: 참가 OTP가 화면에 뜨는 실패하는 테스트를 쓴다**

`/me`가 참가 OTP를 읽는 **유일한 곳**이다(T27). 데모의 핵심 경로다.

```tsx
it('내 참가에 참가 OTP가 보인다', async () => {
  server.use(http.get('*/user/me/participations', () =>
    HttpResponse.json([{ id: 'p1', tournamentName: '데모 토너먼트', playerOtp: '482913', status: 'REGISTERED' }])));
  render(await MyPage());
  expect(await screen.findByText('482913')).toBeInTheDocument();
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd frontend && npx vitest run "src/app/(player)"`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 폰 화면 둘을 만든다**

와이어프레임 1121–1157행(`/tournaments/[id]`)과 1158–1196행(`/me`). Carbon의 톤을 따른다.

- `/tournaments/[id]` — 읽기 `GET /tournaments/:id`, 쓰기 `POST /tournaments/payment` 몸통은 `{ tournamentId }` **하나뿐이다**(T28이 좌석 확정을 결제에서 입장으로 옮겼다). 좌석 선택도 경합 모달도 없다
- `/me` — 읽기 `GET /user/me/participations`. **포인트 잔고와 거래 내역은 넣지 않는다**(T32). 데모가 보여줄 것은 참여와 OTP 흐름이고 잔고는 시드가 세운다

- [ ] **Step 4: 인증 경로를 하나로 합친다**

지금 규약이 둘이다 — 목업 핸들러는 `/api/auth/login`을 가로채고 `next.config.ts`가 그걸 백엔드로 rewrite하는데, 실존 로그인 코드(`auth/action.ts`)는 `${BACKEND_URL}/auth/login`으로 rewrite를 통째로 우회한다. `apiFetch`는 프로덕션 호출자가 0개다.

**서버 액션은 `BACKEND_URL` 직통을 유지하고, 클라이언트 fetch는 `apiFetch`로 모은다.** 서버 컴포넌트/액션은 브라우저를 거치지 않으므로 rewrite를 탈 이유가 없고, 목업 핸들러를 `${BACKEND_URL}` 패턴에도 맞게 넓힌다. `mocks/handlers.ts`의 경로를 `*/auth/login` 같은 와일드카드로 바꾸면 둘 다 잡힌다.

- [ ] **Step 5: 통과를 확인한다**

Run: `cd frontend && npx vitest run "src/app/(player)"`
Expected: PASS

- [ ] **Step 6: 전체 검증**

Run: `npm run typecheck && npm run test && npm run build`
Expected: 타입 에러 0건, 전건 통과, 빌드 성공

- [ ] **Step 7: 데모 하네스로 실제 화면을 확인한다**

Run: `cd backend && docker compose up -d`, 그다음 루트에서 `npm run test:e2e`
Expected: 3건 통과. 하네스는 화면을 단언하지 않으므로 **빨개지면 그건 라우트가 깨진 것이다.**

- [ ] **Step 8: 커밋**

```bash
git add frontend/src
git commit -m "feat: 참가자 폰 화면 둘을 만들고 인증 경로 규약을 하나로 합친다"
```

---

## 마무리

- [ ] `docs/tickets-next.md`에 T34를 기존 서술 형식(문서 끝 주석)대로 적는다. **버린 선택지를 남긴다** — `renderSeatList` WS 대신 공개 REST를 택한 근거, 탈락을 프론트가 유추하는 근거
- [ ] `docs/backlog.md`의 B7을 완료로 표시하고, B7 절에 나열된 미룬 항목 다섯의 현재 상태를 갱신한다
- [ ] `CLAUDE.md`의 기준선 숫자를 갱신한다
- [ ] 최종 전체 리뷰를 opus로 돌린다. **자르지 않는다** — fix는 sonnet
- [ ] PR을 연다. 제목·본문 한국어
