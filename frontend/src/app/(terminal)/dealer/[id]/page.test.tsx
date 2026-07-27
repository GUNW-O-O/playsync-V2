import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

process.env.NEXT_PUBLIC_BACKEND_URL = 'http://backend.test';

// import는 vi.mock 호이스팅 뒤에 평가돼야 한다.
const DealerAuthPage = (await import('./page')).default;

// 인증 성공 후 딜러가 가야 할 곳은 게임 화면이다. 그 화면은 /table/[tableId]로
// 옮겨졌고 /playsync는 사라졌다.
describe('딜러 인증 화면', () => {
  beforeEach(() => {
    push.mockClear();
    vi.stubGlobal('alert', vi.fn());
    server.use(
      http.get('http://backend.test/dealer/:id', () =>
        HttpResponse.json({ name: '테스트 대회', tables: [{ id: 'tbl-7', tableOrder: 1 }] }),
      ),
      http.post('http://backend.test/dealer/auth', () =>
        HttpResponse.json({ accessToken: 'dealer-token' }),
      ),
    );
  });

  it('인증에 성공하면 그 테이블의 게임 화면으로 보낸다', async () => {
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

    await waitFor(() => expect(push).toHaveBeenCalledWith('/table/tbl-7'));
  });

  it('OTP를 숫자가 아니라 문자열로 보낸다', async () => {
    // 백엔드 DTO가 `@Matches(/^[0-9]{6}$/)`로 문자열만 받는다. 앞자리 0이
    // 유효한 값인데 숫자로 보내면 그 자리가 사라진다 — 이 케이스가 정확히
    // 그렇다. Number()로 보내던 예전 코드는 여기서 400을 받았다.
    let sentBody: unknown;
    server.use(
      http.post('http://backend.test/dealer/auth', async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json({ accessToken: 'dealer-token' });
      }),
    );

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

    await waitFor(() => expect(sentBody).toMatchObject({ otp: '012345' }));
    expect((sentBody as { otp: unknown }).otp).toBe('012345');
  });
});
