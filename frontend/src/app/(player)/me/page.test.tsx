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
 * 응답 모양의 출처: `backend/src/user/user.service.ts:66-81`.
 * `tournamentParticipation.findMany`의 행에 `tournament` 관계를
 * `select: { id, name, status, entryFee, startedAt }`로 붙인 것이고,
 * `playerOtp`는 대회가 `FINISHED`면 서버가 `null`로 지운다(같은 함수 79행).
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

  it('참가가 없으면 빈 안내를 그린다', async () => {
    server.use(
      http.get('http://backend.test/user/me/participations', () =>
        HttpResponse.json([]),
      ),
    );

    render(await MyPage());

    expect(screen.getByText(/참가한 대회가 없습니다/)).toBeInTheDocument();
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
