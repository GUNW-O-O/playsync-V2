import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WaitingClient from './WaitingClient';

const TOURNAMENTS = [{ id: 't1', name: '데모 토너먼트', status: 'ONGOING' }];
const TABLES = [{ id: 'tb1', tableOrder: 1 }, { id: 'tb2', tableOrder: 2 }];

/** 키패드를 눌러 참가 OTP를 채운다. 자리 버튼과 겹치지 않게 이름으로 짚는다. */
async function typeOtp(digits: string) {
  for (const d of digits) {
    await userEvent.click(screen.getByRole('button', { name: d }));
  }
}

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

  /**
   * 좌석 도식의 자리는 **아홉 개로 그려져 있다**(`SEAT_POSITIONS`). 비트맵이
   * 그보다 길게 오면 `SEAT_POSITIONS[i].left`에서 던져 화면이 통째로 죽는다 —
   * 대기 화면이라 그 순간 그 태블릿은 참가 자체를 못 한다.
   *
   * 좌석 수는 지금 어디서나 9지만, 그 사실이 **이 파일 어디에도 적혀 있지
   * 않다.** 백엔드가 한 자리를 늘리는 날 화면이 죽는 것보다 아홉만 그리는
   * 편이 낫다.
   */
  it('비트맵이 도식보다 길어도 죽지 않는다', async () => {
    render(
      <WaitingClient
        storeId="s1"
        tournaments={TOURNAMENTS}
        tables={TABLES}
        seatMap={[{ tableId: 'tb1', seatStatus: Array(12).fill(false) }]}
        enterSeat={vi.fn()}
      />,
    );

    expect(screen.getByTestId('pick-seat-8')).toBeInTheDocument();
    // 자리가 없는 인덱스는 그리지 않는다.
    expect(screen.queryByTestId('pick-seat-9')).toBeNull();
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
    await typeOtp('12345678');
    await userEvent.click(screen.getByRole('button', { name: /참가/ }));
    await waitFor(() => {
      expect(screen.getByText('이미 다른 참가자가 앉은 좌석입니다.')).toBeInTheDocument();
    });
  });

  /**
   * 참가 OTP는 여덟 자리다(백엔드 `PLAYER_OTP_LENGTH`). 제출 버튼이
   * `otp.length === 0`만 봐서, 한 자리만 눌러도 백엔드까지 왕복하고
   * 실패로 돌아왔다 — 태블릿에서 오타는 흔하고, 왕복은 그만큼 느리다.
   */
  it('참가 OTP가 여덟 자리가 아니면 제출되지 않는다', async () => {
    const enterSeat = vi.fn();
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
    await typeOtp('1234567'); // 한 자리 모자란다

    expect(screen.getByRole('button', { name: /참가/ })).toBeDisabled();

    // 여덟 번째를 채우면 열린다 — 짝을 이루는 반대 입력이 없으면
    // "언제나 비활성"으로 고쳐도 위 단언이 초록이다.
    await typeOtp('8');
    expect(screen.getByRole('button', { name: /참가/ })).not.toBeDisabled();
    expect(enterSeat).not.toHaveBeenCalled();
  });
});

// 대회 전환은 `page.tsx`가 미리 읽어 온 첫 대회를 넘어 클라이언트에서
// `/api/dealer/:id`·`/api/tournaments/:id/seats`를 다시 읽는 경로다(리뷰
// Important 1·2). 이 두 테스트는 서로 다른 입력으로 서로 다른 버그를 잡는다:
// 레이스 테스트는 응답 순서를 뒤집어야만 실패하고, 정상 전환 테스트는 응답이
// 제때 와도 상태가 안 바뀌면 실패한다 — 하나만 있으면 다른 하나가 깨져도
// 모른다.
describe('WaitingClient — 대회 전환', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const TOURNAMENTS_MULTI = [
    { id: 't1', name: '데모 토너먼트', status: 'ONGOING' },
    { id: 't2', name: '두 번째 대회', status: 'ONGOING' },
    { id: 't3', name: '세 번째 대회', status: 'ONGOING' },
  ];

  /**
   * `fetch`를 손으로 조종할 수 있게 목한다. `respond`를 부르기 전까지는
   * 어떤 fetch도 resolve되지 않는다 — 두 요청의 응답 순서를 테스트가
   * 직접 정하기 위해서다(msw는 순서를 이 정도로 세밀하게 못 다룬다).
   */
  function stubControlledFetch() {
    const pending: Record<string, ((value: unknown) => void)[]> = {};
    const fetchMock = vi.fn(
      (url: string) =>
        new Promise((resolve) => {
          // 클라이언트 조회는 `apiFetch`를 지나므로 오리진이 앞에 붙어
          // 나간다(`lib/api.ts` + `vitest.setup.ts`). 테스트는 경로로만
          // 응답을 짚는다 — 오리진은 이 테스트가 보려는 것이 아니다.
          const path = url.replace(process.env.NEXT_PUBLIC_API_BASE ?? '', '');
          (pending[path] ??= []).push(resolve);
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    return {
      respond(url: string, body: unknown) {
        const resolve = pending[url]?.shift();
        if (!resolve) throw new Error(`${url}로 온 대기 중인 fetch가 없다`);
        resolve({ ok: true, json: async () => body });
      },
    };
  }

  it('빠르게 두 번 전환하면 먼저 고른 대회의 늦은 응답이 화면을 덮지 않는다', async () => {
    const { respond } = stubControlledFetch();

    render(
      <WaitingClient
        storeId="s1"
        tournaments={TOURNAMENTS_MULTI}
        tables={TABLES}
        seatMap={[{ tableId: 'tb1', seatStatus: Array(9).fill(false) }]}
        enterSeat={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByTestId('pick-tournament-t2'));
    await userEvent.click(screen.getByTestId('pick-tournament-t3'));

    // 나중에 고른 t3의 응답이 먼저 도착한다.
    respond('/api/dealer/t3', { tables: [{ id: 'tb-t3', tableOrder: 9 }] });
    respond('/api/tournaments/t3/seats', [{ tableId: 'tb-t3', seatStatus: Array(9).fill(false) }]);
    await waitFor(() => expect(screen.getByTestId('pick-table-tb-t3')).toBeInTheDocument());

    // 먼저 고른(이미 버려진) t2의 응답이 나중에 도착한다.
    respond('/api/dealer/t2', { tables: [{ id: 'tb-t2', tableOrder: 5 }] });
    respond('/api/tournaments/t2/seats', [{ tableId: 'tb-t2', seatStatus: Array(9).fill(false) }]);

    // 화면은 여전히 마지막으로 고른 t3여야 한다 — t2의 낡은 응답이 덮으면 안 된다.
    await waitFor(() => {
      expect(screen.queryByTestId('pick-table-tb-t2')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('pick-table-tb-t3')).toBeInTheDocument();
  });

  it('두 번째 대회를 고르면 그 대회의 테이블과 좌석 도식으로 바뀐다', async () => {
    const { respond } = stubControlledFetch();

    render(
      <WaitingClient
        storeId="s1"
        tournaments={TOURNAMENTS_MULTI}
        tables={TABLES}
        seatMap={[{ tableId: 'tb1', seatStatus: Array(9).fill(false) }]}
        enterSeat={vi.fn()}
      />,
    );

    expect(screen.getByTestId('pick-table-tb1')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('pick-tournament-t2'));
    respond('/api/dealer/t2', { tables: [{ id: 'tb-second', tableOrder: 3 }] });
    respond('/api/tournaments/t2/seats', [
      { tableId: 'tb-second', seatStatus: [true, false, false, false, false, false, false, false, false] },
    ]);

    await waitFor(() => expect(screen.getByTestId('pick-table-tb-second')).toBeInTheDocument());
    expect(screen.queryByTestId('pick-table-tb1')).not.toBeInTheDocument();
    expect(screen.getByTestId('pick-seat-0')).toBeDisabled();
  });

  /**
   * T67 잔여. `try`/`catch`가 없어서 프록시가 끊기면 `selectTournament`가
   * 던졌다. 남는 것은 처리되지 않은 프라미스 거부 하나뿐이고, 화면은
   * **앞 대회의 테이블 목록을 그대로 든 채** 아무 안내도 띄우지 않는다 —
   * 앉을 사람은 없어진 자리를 고르고 있는다.
   *
   * `ConsoleClient.run`이 T70에서 같은 모양으로 고쳐졌다(`NETWORK_ERROR`
   * 상수 + try/catch). 그 처리 방식을 그대로 따른다.
   */
  it('대회 전환이 네트워크 실패로 던져도 안내가 뜬다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );

    render(
      <WaitingClient
        storeId="s1"
        tournaments={TOURNAMENTS_MULTI}
        tables={TABLES}
        seatMap={[{ tableId: 'tb1', seatStatus: Array(9).fill(false) }]}
        enterSeat={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByTestId('pick-tournament-t2'));

    expect(
      await screen.findByText('요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'),
    ).toBeInTheDocument();
  });
});

/**
 * 좌석 폴링(5초)은 화면에 안내를 띄우지 않는다 — **다음 주기에 낫는** 것이라
 * 5초마다 뜨는 배너가 오히려 방해다. 그래서 여기서 볼 수 있는 것은
 * "거부가 새어 나가지 않는가" 하나뿐이고, 그것을 직접 본다.
 */
describe('WaitingClient — 좌석 폴링', () => {
  /** `WaitingClient.tsx`의 `SEAT_POLL_INTERVAL_MS`와 같은 값. */
  const SEAT_POLL_INTERVAL_MS = 5000;

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('폴링이 네트워크 실패로 거부돼도 처리되지 않은 거부가 새어 나가지 않는다', async () => {
    const leaked: unknown[] = [];
    const onUnhandled = (reason: unknown) => leaked.push(reason);
    process.on('unhandledRejection', onUnhandled);

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    vi.useFakeTimers();

    render(
      <WaitingClient
        storeId="s1"
        tournaments={TOURNAMENTS}
        tables={TABLES}
        seatMap={[{ tableId: 'tb1', seatStatus: Array(9).fill(false) }]}
        enterSeat={vi.fn()}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEAT_POLL_INTERVAL_MS * 2);
    });

    // 거부가 "처리되지 않았다"는 판정은 마이크로태스크 큐가 빈 뒤에
    // 내려간다. 진짜 타이머로 한 틱을 돌려 그 판정을 받는다.
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 10));

    process.off('unhandledRejection', onUnhandled);
    expect(leaked).toEqual([]);
  });
});
