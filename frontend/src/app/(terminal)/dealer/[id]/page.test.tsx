import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

// 서버 액션은 이 환경에서 실행할 수 없다. 화면이 보는 것은 액션의 반환값뿐이라
// 그 계약만 목으로 세운다 — 액션 자체는 action.test.ts가 본다.
const authenticateDealer = vi.fn();
vi.mock('./action', () => ({
  authenticateDealer: (...args: unknown[]) => authenticateDealer(...args),
}));

const alertMock = vi.fn();

process.env.NEXT_PUBLIC_BACKEND_URL = 'http://backend.test';

const DealerAuthPage = (await import('./page')).default;

async function fillAndSubmit() {
  await act(async () => {
    render(
      <Suspense>
        <DealerAuthPage params={Promise.resolve({ id: 'trnmt-1' })} />
      </Suspense>,
    );
  });

  await screen.findByText('테스트 대회');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'tbl-7' } });
  fireEvent.change(screen.getByPlaceholderText('6자리 OTP 입력'), { target: { value: '012345' } });
  fireEvent.click(screen.getByRole('button', { name: '인증' }));
}

describe('딜러 인증 화면', () => {
  beforeEach(() => {
    push.mockClear();
    alertMock.mockClear();
    authenticateDealer.mockReset();
    authenticateDealer.mockResolvedValue({ ok: true });
    vi.stubGlobal('alert', alertMock);
    server.use(
      http.get('http://backend.test/dealer/:id', () =>
        HttpResponse.json({ name: '테스트 대회', tables: [{ id: 'tbl-7', tableOrder: 1 }] }),
      ),
    );
  });

  it('인증에 성공하면 그 테이블의 게임 화면으로 보낸다', async () => {
    await fillAndSubmit();

    await waitFor(() => expect(push).toHaveBeenCalledWith('/table/tbl-7'));
  });

  it('고른 테이블과 입력한 OTP를 그대로 액션에 넘긴다', async () => {
    await fillAndSubmit();

    await waitFor(() =>
      expect(authenticateDealer).toHaveBeenCalledWith({
        tournamentId: 'trnmt-1',
        tableId: 'tbl-7',
        otp: '012345',
      }),
    );
  });

  it('실패 문구를 그대로 보여주고 화면을 옮기지 않는다', async () => {
    // 백엔드가 실패를 네 가지로 가른다 — 잠긴 딜러에게 "OTP를 확인하세요"라고
    // 하면 다시 넣어보게 되고 그 시도가 다음 잠금 창까지 태운다.
    authenticateDealer.mockResolvedValue({
      error: '인증 시도가 너무 많습니다. 잠시 후 다시 시도하거나 상점에 문의해주세요.',
    });

    await fillAndSubmit();

    await waitFor(() => expect(alertMock).toHaveBeenCalled());
    expect(String(alertMock.mock.calls[0][0])).toContain('인증 시도가 너무 많습니다');
    expect(push).not.toHaveBeenCalled();
  });
});
