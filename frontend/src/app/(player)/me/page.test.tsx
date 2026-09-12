import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';

const cookieStore = { get: vi.fn() };
vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
}));

process.env.BACKEND_URL = 'http://backend.test';

const { default: MyPage } = await import('./page');

/**
 * 응답 모양의 출처: `backend/src/user/user.service.ts`의 `getMyParticipations`.
 * `tournamentParticipation.findMany`의 행에 `tournament` 관계를
 * `select: { id, name, status, entryFee, startedAt }`로 붙인 것이고,
 * `playerOtp`는 대회가 닫히면(`isClosedTournament` — `FINISHED` 또는
 * `CANCELLED`) 서버가 `null`로 지운다(같은 함수의 `getMyParticipations`).
 *
 * 지어내지 않는다 — 예전에 목이 봉투를 안 벗겨 그 경로에 닿지도 못한 적이 있다.
 */
const ONGOING = {
  id: 'p1',
  tournamentId: 't1',
  userId: 'u1',
  status: 'WAITING',
  buyInCount: 1,
  finalPlace: null,
  prizeAmount: 0,
  currentStack: 5000,
  playerOtp: '52527006',
  createdAt: '2026-08-05T09:00:00.000Z',
  tournament: {
    id: 't1',
    name: '데모 토너먼트',
    status: 'ONGOING',
    entryFee: 50000,
    startedAt: '2026-08-05T10:00:00.000Z',
  },
};

const FINISHED = {
  id: 'p0',
  tournamentId: 't0',
  userId: 'u1',
  status: 'ELIMINATED',
  buyInCount: 1,
  finalPlace: 3,
  prizeAmount: 70000,
  currentStack: 0,
  playerOtp: null,
  createdAt: '2026-07-28T09:00:00.000Z',
  tournament: {
    id: 't0',
    name: '목요일 딥스택',
    status: 'FINISHED',
    entryFee: 50000,
    startedAt: '2026-07-28T10:00:00.000Z',
  },
};

/**
 * 대회는 아직 도는데 이 사람만 나간 경우. 탈락은 대회가 끝나기 훨씬 전에
 * 일어나고(`prize.ts`의 `awardPrize`가 그 자리에서 `finalPlace`를 박는다),
 * 좌석 태블릿은 "폰의 「지난 참가」에서 확인하세요"라고 적고 대기 화면으로
 * 돌아간다(`EliminatedOverlay.tsx`).
 */
const ELIMINATED_MIDWAY = {
  id: 'p2',
  tournamentId: 't1',
  userId: 'u1',
  status: 'ELIMINATED',
  buyInCount: 1,
  finalPlace: 5,
  prizeAmount: 0,
  currentStack: 0,
  playerOtp: '31280401',
  createdAt: '2026-08-05T09:00:00.000Z',
  tournament: {
    id: 't1',
    name: '데모 토너먼트',
    status: 'ONGOING',
    entryFee: 50000,
    startedAt: '2026-08-05T10:00:00.000Z',
  },
};

/**
 * 대회가 중단된 경우(`abortSession`). 참가 행 자신의 `status`는 원장이라
 * 손대지 않고 그대로 `PLAYING`으로 남지만(`session.service.ts`), 대회
 * 쪽은 `CANCELLED`이고 서버가 `isClosedTournament`로 `playerOtp`를 이미
 * `null`로 지운다(`user.service.ts`의 `getMyParticipations`). 등수도 없다
 * — 탈락이 아니라 환불이라 매길 등수가 없다.
 */
const ABORTED = {
  id: 'p3',
  tournamentId: 't2',
  userId: 'u1',
  status: 'PLAYING',
  buyInCount: 1,
  finalPlace: null,
  prizeAmount: 0,
  currentStack: 3000,
  playerOtp: null,
  createdAt: '2026-08-10T09:00:00.000Z',
  tournament: {
    id: 't2',
    name: '중단된 토너먼트',
    status: 'CANCELLED',
    entryFee: 50000,
    startedAt: '2026-08-10T10:00:00.000Z',
  },
};

/**
 * 대회는 살아 있는데(ONGOING) 이 참가만 등수 없이 지난 참가로 넘어간 경우.
 * `finalPlace: null`인 픽스처가 ABORTED(취소된 대회) 하나뿐이면 `'중단' :
 * '탈락'`을 `'중단'` 하나로 접어도 초록이다 — 「탈락」이 그려지는 경로 자체가
 * 검사에 없기 때문이다. 이 픽스처와 ABORTED를 같은 화면에 먹여야 두 문구가
 * 서로를 증명한다(T29, 검사가 둘이면 어긋나는 입력이 있어야 각각이 증명된다).
 */
const ELIMINATED_NO_PLACE = {
  id: 'p4',
  tournamentId: 't3',
  userId: 'u1',
  status: 'ELIMINATED',
  buyInCount: 1,
  finalPlace: null,
  prizeAmount: 0,
  currentStack: 0,
  playerOtp: null,
  createdAt: '2026-08-12T09:00:00.000Z',
  tournament: {
    id: 't3',
    name: '금요일 프리즈아웃',
    status: 'ONGOING',
    entryFee: 50000,
    startedAt: '2026-08-12T10:00:00.000Z',
  },
};

/**
 * 서버 복구 중(T96). `SYNCING`은 닫힌 상태가 아니라 「진행 중」에 남아야
 * 한다 — 예전 `statusLabel`(리터럴 `if` 분기)은 모르는 상태를 전부
 * 「종료」 폴백으로 떨어뜨렸다. 참가자가 아직 도는 대회를 「종료」로 보고
 * OTP를 다시 확인할 이유가 없다고 오해하면 안 된다.
 *
 * 이름에 「복구 중」을 넣지 않는다 — 대회명이 `h3`로도 그려지므로 그 부분
 * 문자열이 들어가면 `getByText(/복구 중/)`가 상태 줄이 아니라 이름을 잡아
 * 실패해야 할 자리에서 조용히 통과한다.
 */
const SYNCING_ONGOING = {
  id: 'p5',
  tournamentId: 't5',
  userId: 'u1',
  status: 'WAITING',
  buyInCount: 1,
  finalPlace: null,
  prizeAmount: 0,
  currentStack: 5000,
  playerOtp: '12345678',
  createdAt: '2026-09-01T09:00:00.000Z',
  tournament: {
    id: 't5',
    name: '가을 토너먼트',
    status: 'SYNCING',
    entryFee: 50000,
    startedAt: '2026-09-01T10:00:00.000Z',
  },
};

describe('/me — 내 참가', () => {
  beforeEach(() => {
    cookieStore.get.mockReturnValue({ value: 'jwt-value' });
  });

  it('진행 중 참가는 OTP를 감춘 채로 뜬다', async () => {
    // 두 행을 같이 먹인다. 하나만 주면 "OTP 칸과 지난 참가 칸"이 서로를
    // 가려서, 둘 중 하나를 통째로 지워도 초록이 된다.
    server.use(
      http.get('http://backend.test/user/me/participations', () =>
        HttpResponse.json([ONGOING, FINISHED]),
      ),
    );

    render(await MyPage());

    expect(screen.getByText(/데모 토너먼트/)).toBeInTheDocument();
    // 홀은 사람이 붙어 앉는 곳이다. 조회를 누르기 전에는 값이 DOM에도
    // 없어야 한다 — `hidden`으로 가리면 화면 캡처나 개발자 도구에 남는다.
    expect(screen.queryByTestId('player-otp')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '참가 OTP 조회' })).toBeInTheDocument();
  });

  it('조회를 누르면 참가 OTP가 자릿수만큼 칸으로 뜬다', async () => {
    server.use(
      http.get('http://backend.test/user/me/participations', () =>
        HttpResponse.json([ONGOING, FINISHED]),
      ),
    );

    render(await MyPage());
    await userEvent.click(screen.getByRole('button', { name: '참가 OTP 조회' }));

    // 태블릿 키패드가 한 자리씩 받으므로 폰도 자리마다 칸을 나눈다. 값이
    // 한 덩어리가 아니라서 `getByText(otp)`로는 잡히지 않는다.
    const slots = screen.getByTestId('player-otp');
    expect(slots).toHaveTextContent('52527006');
    expect(slots.children).toHaveLength(ONGOING.playerOtp.length);
  });

  it('끝난 대회는 OTP 대신 순위와 상금이 남는다', async () => {
    server.use(
      http.get('http://backend.test/user/me/participations', () =>
        HttpResponse.json([ONGOING, FINISHED]),
      ),
    );

    render(await MyPage());

    expect(screen.getByText('목요일 딥스택')).toBeInTheDocument();
    expect(screen.getByText('3위')).toBeInTheDocument();
    expect(screen.getByText('+70,000')).toBeInTheDocument();
  });

  it('대회가 도는 중에 탈락했으면 OTP가 아니라 순위가 남는다', async () => {
    // 대회 상태로만 가르면 이 사람은 "진행 중"에 남아, 다시 앉을 수 없는데도
    // 참가 OTP를 계속 들고 있게 된다. 태블릿이 폰을 가리키는데 폰에는
    // 순위가 없는 상태이기도 하다.
    server.use(
      http.get('http://backend.test/user/me/participations', () =>
        HttpResponse.json([ELIMINATED_MIDWAY]),
      ),
    );

    render(await MyPage());

    expect(screen.getByText('5위')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '참가 OTP 조회' })).not.toBeInTheDocument();
  });

  it('중단된 대회는 「지난 참가」로 간다', async () => {
    server.use(
      http.get('http://backend.test/user/me/participations', () =>
        HttpResponse.json([ABORTED]),
      ),
    );

    render(await MyPage());

    // 이름 단언만으로는 이 행이 어느 섹션에 들어갔는지 간접적으로만 보인다.
    // 「지난 참가」 헤더를 직접 보는 편이 읽는 사람에게 더 분명하다.
    expect(screen.getByText('지난 참가')).toBeInTheDocument();
    expect(screen.getByText('중단된 토너먼트')).toBeInTheDocument();
    expect(screen.queryByText('진행 중')).not.toBeInTheDocument();
    expect(
      screen.queryByText('참가 OTP가 없습니다. 상점에 문의하세요.'),
    ).not.toBeInTheDocument();
  });

  it('중단된 대회는 「탈락」이 아니라 「중단」으로 적는다', async () => {
    server.use(
      http.get('http://backend.test/user/me/participations', () =>
        HttpResponse.json([ABORTED]),
      ),
    );

    render(await MyPage());

    expect(screen.getByText('중단')).toBeInTheDocument();
    expect(screen.queryByText('탈락')).not.toBeInTheDocument();
  });

  it('중단(대회 취소)과 탈락(대회는 살아 있음)이 같은 화면에서 갈린다', async () => {
    // 대회가 CANCELLED인 것과 참가자가 ELIMINATED인 것은 서로 다른 이유로
    // 「지난 참가」에 들어간다 — 하나만 먹이면 다른 쪽 문구가 그려지는 길이
    // 검사에 없어, `'중단' : '탈락'`을 한쪽으로 접어도 들키지 않는다.
    server.use(
      http.get('http://backend.test/user/me/participations', () =>
        HttpResponse.json([ABORTED, ELIMINATED_NO_PLACE]),
      ),
    );

    render(await MyPage());

    expect(screen.getByText('중단')).toBeInTheDocument();
    expect(screen.getByText('탈락')).toBeInTheDocument();
  });

  it('참가가 없으면 빈 안내를 그린다', async () => {
    server.use(
      http.get('http://backend.test/user/me/participations', () =>
        HttpResponse.json([]),
      ),
    );

    render(await MyPage());

    expect(screen.getByText(/참가한 대회가 없습니다/)).toBeInTheDocument();
  });

  it('SYNCING인 대회는 「진행 중」에 남고 「복구 중」이 보인다', async () => {
    server.use(
      http.get('http://backend.test/user/me/participations', () =>
        HttpResponse.json([SYNCING_ONGOING]),
      ),
    );

    render(await MyPage());

    expect(screen.getByText('진행 중')).toBeInTheDocument();
    expect(screen.getByText(/복구 중/)).toBeInTheDocument();
    expect(screen.queryByText(/종료/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '참가 OTP 조회' })).toBeInTheDocument();
  });

  it('조회가 실패해도 백지가 되지 않는다', async () => {
    // 미들웨어가 로그인은 이미 막았으므로 여기서 401이 오는 것은 토큰 만료다.
    server.use(
      http.get('http://backend.test/user/me/participations', () =>
        HttpResponse.json({ message: '유효한 사용자가 아닙니다.' }, { status: 401 }),
      ),
    );

    render(await MyPage());

    expect(screen.getByText(/불러오지 못했습니다/)).toBeInTheDocument();
  });
});
