import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';
import { SERVER_RECOVERING_MESSAGE } from '@playsync/contract';

// 좌석 쪽 `page.test.tsx`와 같은 이유로 자리표시자를 세운다 —
// `DealerGameClient`는 'use client'고 브라우저 전용 의존성을 끌고 온다.
// `null`이 아니라 표식을 그리는 것은, 이 파일의 핵심이 **그려졌는가 아닌가**라서다.
vi.mock('./DealerGameClient', () => ({
  default: () => <div data-testid="dealer-game-client" />,
}));

// 닫힌 대회 덮개도 자리표시자로 둔다. 실제 덮개는 `useRouter`를 끌고 오고,
// 여기서 보려는 것은 **무엇을 넘겨 그렸는가**다.
vi.mock('@/component/TournamentClosedOverlay', () => ({
  default: ({ status, storeId }: { status: string; storeId?: string }) => (
    <div data-testid="tournament-closed">{`${status} ${storeId}`}</div>
  ),
}));

const cookieStore = { get: vi.fn() };
vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
}));

process.env.BACKEND_URL = 'http://backend.test';

const { default: DealerGamePage } = await import('./page');

const LEAKED_DEALER_TOKEN = 'leaked-dealer-jwt-value';

describe('DealerGamePage', () => {
  beforeEach(() => {
    cookieStore.get.mockReset();
    cookieStore.get.mockImplementation((name: string) =>
      name === 'dealerToken' ? { value: LEAKED_DEALER_TOKEN } : undefined,
    );
    server.use(
      http.get('http://backend.test/playsync/tbl-1', () =>
        HttpResponse.json({ seatIndex: -1, tableState: { pot: 0 } }),
      ),
    );
  });

  it('딜러 토큰이 DealerGameClient props 어디에도 실리지 않는다', async () => {
    // 이 토큰이 곧 승자 지정 권한이다 — 새면 돈이다. 좌석 화면의 같은
    // 단언(`table/[tableId]/page.test.tsx`)과 짝이다.
    const element = await DealerGamePage({ params: Promise.resolve({ tableId: 'tbl-1' }) });

    expect(JSON.stringify(element)).not.toContain(LEAKED_DEALER_TOKEN);
  });

  /**
   * T67-3. 좌석 화면과 같은 결함이 딜러 화면에도 있었다 —
   * `getInitialGameData`가 `res.ok`를 안 보고 `res.json()`을 돌려주므로
   * NestJS 예외 본문이 truthy로 통과해 `initialData.tableState`가
   * `undefined`인 채 빈 펠트가 그려졌다. 딜러 화면에서는 그 상태로
   * "핸드 시작"이 눌리지 않아 테이블 전체가 멈춘다.
   */
  it.each([
    ['403', 403, { statusCode: 403, message: '토큰에 없는 테이블입니다.' }],
    ['500', 500, { statusCode: 500, message: 'Internal Server Error' }],
  ])('%s이면 딜러 화면 대신 안내를 그린다', async (_label, status, body) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    server.use(
      http.get('http://backend.test/playsync/tbl-1', () => HttpResponse.json(body, { status })),
    );

    const element = await DealerGamePage({ params: Promise.resolve({ tableId: 'tbl-1' }) });
    render(element);

    expect(screen.queryByTestId('dealer-game-client')).not.toBeInTheDocument();
    expect(screen.getByText(/불러오지 못했습니다/)).toBeInTheDocument();
    errorSpy.mockRestore();
  });

  it('정상 응답이면 딜러 화면을 그린다', async () => {
    // 위와 짝을 이루는 반대 입력. 없으면 "언제나 폴백"으로 고쳐도 초록이다.
    const element = await DealerGamePage({ params: Promise.resolve({ tableId: 'tbl-1' }) });
    render(element);

    expect(screen.getByTestId('dealer-game-client')).toBeInTheDocument();
  });

  /**
   * 서버 장애(T97). 좌석 화면의 같은 검사(`table/[tableId]/page.test.tsx`)와
   * 짝이다.
   */
  it('503이면 복구 문구를 그린다', async () => {
    server.use(
      http.get('http://backend.test/playsync/tbl-1', () =>
        HttpResponse.json(
          { statusCode: 503, message: SERVER_RECOVERING_MESSAGE, error: 'Service Unavailable' },
          { status: 503 },
        ),
      ),
    );

    const element = await DealerGamePage({ params: Promise.resolve({ tableId: 'tbl-1' }) });
    render(element);

    expect(screen.queryByTestId('dealer-game-client')).not.toBeInTheDocument();
    expect(screen.getByText(SERVER_RECOVERING_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(/테이블 정보를 불러오지 못했습니다/)).not.toBeInTheDocument();
  });

  /**
   * 대회가 닫힌 직후 단말이 다시 뜬다. 닫는 트랜잭션이 스냅샷도 `Table` 행도
   * 지웠으므로 테이블로는 대회를 찾을 수 없다 — 토큰에 실린 대회 id로 찾는다.
   */
  describe('닫힌 대회의 테이블', () => {
    const TOKEN = `h.${Buffer.from(JSON.stringify({ tournamentId: 't-1' })).toString('base64url')}.s`;

    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      cookieStore.get.mockImplementation((name: string) =>
        name === 'dealerToken' ? { value: TOKEN } : undefined,
      );
      server.use(
        http.get('http://backend.test/playsync/tbl-1', () =>
          HttpResponse.json({ statusCode: 500, message: 'not found' }, { status: 500 }),
        ),
      );
    });

    it('대회가 끝났으면 종료 덮개를 그린다', async () => {
      server.use(
        http.get('http://backend.test/tournaments/t-1', () =>
          HttpResponse.json({ tournament: { status: 'FINISHED', storeId: 'store-1' } }),
        ),
      );

      render(await DealerGamePage({ params: Promise.resolve({ tableId: 'tbl-1' }) }));

      expect(screen.getByTestId('tournament-closed')).toHaveTextContent('FINISHED store-1');
      expect(screen.queryByText(/불러오지 못했습니다/)).not.toBeInTheDocument();
    });

    it('대회가 진행 중이면 그대로 실패 안내다', async () => {
      // 반대 입력. 없으면 「실패하면 언제나 종료 덮개」로 고쳐도 초록이다.
      server.use(
        http.get('http://backend.test/tournaments/t-1', () =>
          HttpResponse.json({ tournament: { status: 'PLAYING', storeId: 'store-1' } }),
        ),
      );

      render(await DealerGamePage({ params: Promise.resolve({ tableId: 'tbl-1' }) }));

      expect(screen.queryByTestId('tournament-closed')).not.toBeInTheDocument();
      expect(screen.getByText(/불러오지 못했습니다/)).toBeInTheDocument();
    });
  });
});
