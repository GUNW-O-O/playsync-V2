import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';

// 좌석 쪽 `page.test.tsx`와 같은 이유로 자리표시자를 세운다 —
// `DealerGameClient`는 'use client'고 브라우저 전용 의존성을 끌고 온다.
// `null`이 아니라 표식을 그리는 것은, 이 파일의 핵심이 **그려졌는가 아닌가**라서다.
vi.mock('./DealerGameClient', () => ({
  default: () => <div data-testid="dealer-game-client" />,
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
});
