import { APIRequestContext, Page } from '@playwright/test';

/**
 * 카메라에 잡히지 않는 손. 백엔드 API를 직접 친다.
 *
 * 촬영에서 화면으로 해야 하는 것과 그렇지 않은 것이 갈린다. 상점이 대회를
 * 시작하는 것, 사람이 OTP를 넣고 앉는 것, 딜러가 액션을 받는 것은 **장면 자체**라
 * 브라우저로 해야 한다. 반면 "나머지 참가자를 자리에 앉혀 놓는다" 같은 준비는
 * 장면이 아니라 배경이고, 태블릿 여섯 대를 띄워 여섯 번 찍는 것은 영상에
 * 아무것도 더하지 않으면서 실행 시간만 늘린다.
 *
 * 그 경계를 **여기 있느냐 없느냐로** 표시한다. 이 파일에 들어온 동작은
 * 화면 없이 일어난다고 선언한 것이다.
 */

export const BACKEND_URL = 'http://localhost:3001';

/** 시드가 만든 계정으로 토큰을 받는다. 실패하면 그 자리에서 멈춘다. */
export async function login(
  request: APIRequestContext,
  nickname: string,
  password: string,
): Promise<string> {
  const res = await request.post(`${BACKEND_URL}/auth/login`, {
    data: { nickname, password },
  });
  if (!res.ok()) {
    throw new Error(`로그인 실패 (${nickname}): ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { accessToken?: string };
  if (!body.accessToken) {
    throw new Error(`로그인 응답에 accessToken이 없다 (${nickname}): ${JSON.stringify(body)}`);
  }
  return body.accessToken;
}

export function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * 딜러 태블릿의 쿠키 창고에서 `dealerToken`을 꺼낸다.
 *
 * `GET /playsync/:tableId`(아래 `tableState`)는 T66부터 REST에도 WS와 같은
 * 판정(`PlaysyncService.assertTableAccess`)을 건다 — 그 테이블의 딜러이거나
 * 실제로 앉은 플레이어여야 한다. 촬영이 원본 스냅샷을 관찰하려고 상점
 * 소유자의 로그인 토큰을 썼던 것은 그 판정이 없던 시절의 지름길이었다 —
 * 소유자는 그 테이블의 딜러도 좌석의 주인도 아니라서 지금은 거부된다.
 *
 * `authenticateDealer`(`(terminal)/dealer/action.ts`)가 심는 `dealerToken`은
 * httpOnly라 페이지 JS는 못 읽지만, Playwright는 `document.cookie`를 거치지
 * 않고 브라우저의 쿠키 창고를 직접 본다 — 자동화 API라 httpOnly의 적용
 * 대상이 아니다. 그 값을 그대로 쓰면 딜러가 실제로 로그인해 얻은, 그
 * 테이블에만 유효한 진짜 토큰을 재사용하는 것이다.
 */
export async function dealerBearerToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const token = cookies.find((c) => c.name === 'dealerToken')?.value;
  if (!token) {
    throw new Error('딜러 토큰 쿠키를 찾지 못했다 — enterDealer가 먼저 끝났는지 확인할 것.');
  }
  return token;
}

/**
 * 사람 하나를 자리에 앉힌다. `POST /tournaments/:id/enter`.
 *
 * 가드가 없는 라우트다 — **참가 OTP 자체가 자격 증명**이다
 * (`entry.controller.ts`). 그래서 토큰 없이 부른다.
 *
 * 이것이 여기 있는 이유: 촬영에서 자리에 앉는 것은 장면이지만, **한 번만**
 * 장면이다. 태블릿 넷을 띄워 네 번 찍는 것은 영상에 아무것도 더하지 않으면서
 * 실행 시간과 메모리만 늘린다 — 녹화 컨텍스트는 하나가 수백 MB를 쓴다.
 * 카메라 앞에 서는 착석은 데모 스펙이 브라우저로 하고, 나머지 배경은 여기로
 * 온다.
 *
 * 몇 개까지 띄울 수 있는지는 **그때 재서 판단한다.** 기계마다 다르고, 숫자를
 * 박아 두면 다른 기계에서 거짓이 된다.
 */
export async function seat(
  request: APIRequestContext,
  tournamentId: string,
  seat: { tableId: string; seatIndex: number; otp: string },
): Promise<void> {
  const res = await request.post(`${BACKEND_URL}/tournaments/${tournamentId}/enter`, {
    data: seat,
  });
  if (!res.ok()) {
    throw new Error(
      `착석 실패 (${seat.tableId} ${seat.seatIndex}번): ${res.status()} ${await res.text()}`,
    );
  }
}

/**
 * 지금 테이블에 놓인 칩의 총합. 촬영이 단계마다 이 값을 확인한다.
 *
 * 시나리오 계층이 단계마다 불변식을 검사하는 것과 같은 이유다 — 마지막에
 * 한 번만 보면 "어딘가에서 칩이 사라졌다"까지만 알 수 있고, **틀어진 첫
 * 순간**을 놓친다. 촬영은 여러 판을 돌리므로 특히 그렇다.
 */
export type DemoPlayer = {
  id: string;
  nickname: string;
  seatIndex: number;
  stack: number;
  bet: number;
  hasFolded: boolean;
  isAllIn: boolean;
};

export type DemoTableState = {
  phase: number;
  players: (DemoPlayer | null)[];
  currentTurnSeatIndex: number;
  pot: number;
  sidePots: { amount: number; relevantPlayerIds: string[] }[];
  currentBet: number;
  smallBlind: number;
};

/** 촬영이 다음 동작을 정하려면 지금 상태를 알아야 한다. 화면을 긁지 않는다. */
export async function tableState(
  request: APIRequestContext,
  tableId: string,
  token: string,
): Promise<DemoTableState> {
  const res = await request.get(`${BACKEND_URL}/playsync/${tableId}`, {
    headers: bearer(token),
  });
  if (!res.ok()) {
    throw new Error(`테이블 상태 조회 실패 (${tableId}): ${res.status()}`);
  }
  const body = (await res.json()) as { tableState?: DemoTableState };
  if (!body.tableState) throw new Error(`테이블 상태가 비었다 (${tableId})`);
  return body.tableState;
}

/**
 * 지금 테이블에 놓인 칩의 총합. **스택의 합 + 팟**이다.
 *
 * `bet`을 더하지 않는다. 앞에 내놓은 금액은 `pot`이 이미 갖고 있고, `bet`은
 * 이번 라운드에 누가 얼마를 냈는지를 따로 들고 있는 값이다. 셋을 다 더하면
 * 낸 돈을 두 번 센다 — 실제로 그렇게 짰다가 블라인드와 레이즈만큼(4,300)
 * 총량이 부풀어 촬영이 멈췄다.
 *
 * 계산은 `backend/src/scenario/harness.ts`의 같은 이름 함수와 맞춘다. 촬영이
 * 보는 불변식과 시나리오 테스트가 보는 불변식이 갈리면, 둘 중 어느 쪽이
 * 사실인지 아무도 모르게 된다.
 *
 * 단계마다 확인한다 — 마지막에 한 번만 보면 "어딘가에서 사라졌다"까지만
 * 알 수 있고 **틀어진 첫 순간**을 놓친다.
 */
export function chipsOnTable(state: DemoTableState): number {
  return state.players.reduce((sum, p) => sum + (p?.stack ?? 0), 0) + state.pot;
}

/**
 * 전광판이 읽는 대회 대시보드. `GET /playsync/dashboard/:tournamentId`.
 *
 * 촬영이 **등록 마감을 기다릴 때** 쓴다. 화면으로 판정하지 않는 이유는
 * 「마감 전 · 예상」이 사라졌는지를 `toBeHidden`으로 보면 **없는 요소에도
 * 통과하기** 때문이다 — 전광판은 주기적으로 다시 그리므로 그 틈이 실제로
 * 열린다. 실측에서 12분짜리 레벨이 3분 25초 만에 「마감됐다」로 통과했다.
 *
 * 마감은 컬럼이 아니라 파생값이다(`registration-gate.ts`). 컬럼은 누군가
 * 그 대회를 건드릴 때 게으르게 닫히므로 DB를 봐도 답이 아니다. 이 응답이
 * 게이트가 실제로 읽는 값과 같은 규칙에서 나온다.
 */
export type DemoDashboard = {
  isRegistrationOpen: boolean;
  /** 남은 인원. **단수형이다** — 전광판이 읽는 이름 그대로 쓴다. */
  activePlayer: number;
  entryCount: number;
  itmCount: number;
  prizePool: number;
};

export async function dashboard(
  request: APIRequestContext,
  tournamentId: string,
): Promise<DemoDashboard> {
  const res = await request.get(`${BACKEND_URL}/playsync/dashboard/${tournamentId}`);
  if (!res.ok()) {
    throw new Error(`대시보드 조회 실패 (${tournamentId}): ${res.status()}`);
  }
  // **봉투를 벗긴다.** 응답은 `{ dashboard, blindField }`이고 앤티가 금액이
  // 되는 자리가 `blindField` 쪽이다(`getFullTournamentInfo`). 벗기지 않으면
  // 모든 필드가 `undefined`가 되는데, `expect.poll`은 그것을 「아직 아니다」로
  // 읽어 제한시간을 다 쓴다 — 실제로 15분을 그렇게 썼다.
  const body = (await res.json()) as { dashboard?: DemoDashboard } | null;
  if (!body?.dashboard) {
    throw new Error(`대시보드가 비었다 (${tournamentId}) — 대회가 시작됐는지 확인할 것.`);
  }
  return body.dashboard;
}
