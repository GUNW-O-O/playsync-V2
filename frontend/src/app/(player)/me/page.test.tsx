import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

describe('/me — 내 참가', () => {
  beforeEach(() => {
    cookieStore.get.mockReturnValue({ value: 'jwt-value' });
  });

  it('진행 중 참가의 참가 OTP가 보인다', async () => {
    // 두 행을 같이 먹인다. 하나만 주면 "OTP 칸과 지난 참가 칸"이 서로를
    // 가려서, 둘 중 하나를 통째로 지워도 초록이 된다.
    server.use(
      http.get('http://backend.test/user/me/participations', () =>
        HttpResponse.json([ONGOING, FINISHED]),
      ),
    );

    render(await MyPage());

    expect(screen.getByText('52527006')).toBeInTheDocument();
    expect(screen.getByText(/데모 토너먼트/)).toBeInTheDocument();
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
