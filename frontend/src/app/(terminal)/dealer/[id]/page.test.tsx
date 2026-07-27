import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

// 실패 안내를 단언하려면 alert 스텁의 핸들이 필요하다. beforeEach가 매번
// 다시 심되 같은 목을 쓴다.
const alertMock = vi.fn();

process.env.NEXT_PUBLIC_BACKEND_URL = 'http://backend.test';

// import는 vi.mock 호이스팅 뒤에 평가돼야 한다.
const DealerAuthPage = (await import('./page')).default;

// 인증 성공 후 딜러가 가야 할 곳은 게임 화면이다. 그 화면은 /table/[tableId]로
// 옮겨졌고 /playsync는 사라졌다.
describe('딜러 인증 화면', () => {
  beforeEach(() => {
    push.mockClear();
    alertMock.mockClear();
    vi.stubGlobal('alert', alertMock);
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

  /**
   * 백엔드는 실패를 네 가지로 가른다 — 401 자격 오류, 403 시도 초과(5분 잠금),
   * 403 종료된 대회, 409 딜러 세션 미준비. 단말이 이걸 전부 "OTP를 확인하세요"로
   * 뭉개면 잠긴 딜러에게 **정확히 틀린 안내**를 하게 된다. 다시 넣어봐야 카운터만
   * 늘고, 실제로 해야 할 일(상점에 재발급 요청)은 화면 어디에도 없다.
   */
  async function authWith(status: number, body: unknown) {
    server.use(
      http.post('http://backend.test/dealer/auth', () =>
        HttpResponse.json(body as Record<string, unknown>, { status }),
      ),
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
  }

  it('잠금 안내를 OTP 오류로 뭉개지 않고 백엔드 문구를 그대로 보여준다', async () => {
    await authWith(403, {
      statusCode: 403,
      message: '인증 시도가 너무 많습니다. 잠시 후 다시 시도하거나 상점에 문의해주세요.',
      error: 'Forbidden',
    });

    await waitFor(() => expect(alertMock).toHaveBeenCalled());
    const shown = String(alertMock.mock.calls[0][0]);
    expect(shown).toContain('인증 시도가 너무 많습니다');
    expect(shown).toContain('상점에 문의');
    // 잠긴 딜러에게 OTP를 확인하라고 말하면 다음 창까지 태운다.
    expect(shown).not.toContain('OTP를 확인하세요');
  });

  it('본문에 message가 없으면 기본 문구로 떨어진다', async () => {
    // 백엔드가 아니라 프록시·게이트웨이가 끊은 경우다. 안내가 사라지면 안 된다.
    await authWith(502, {});

    await waitFor(() => expect(alertMock).toHaveBeenCalled());
    expect(String(alertMock.mock.calls[0][0])).toContain('OTP를 확인하세요');
  });
});
