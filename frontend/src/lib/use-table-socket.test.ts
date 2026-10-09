import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';
import {
  KEEPALIVE_EVENT,
  SERVER_OUTAGE_EVENT,
  SERVER_RECOVERING_MESSAGE,
  SESSION_REVOKED_CLOSE_CODE,
  SEAT_RELEASED_REASON,
} from '@playsync/contract';
import { SOCKET_SILENCE_MS, useTableSocket } from './use-table-socket';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send() {}
  // 죽은 연결에서는 브라우저가 onclose를 늦게(또는 영영) 부른다. 그래서 가짜도
  // close()에서 onclose를 부르지 않는다 — 훅이 그것에 기대면 이 테스트가 잡는다.
  close() { this.closed = true; }
  emit(event: string, data?: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify({ event, data }) }));
  }
  /**
   * M5. 실제 브라우저에서는 죽은 연결의 `close()` 뒤 `onclose`가 몇 초~몇 분
   * 뒤에 온다. `armWatchdog`가 재접속 전 옛 소켓의 핸들러를 떼 두지 않으면
   * 이 늦은 호출이 두 번째 `scheduleRetry`를 걸어 소켓 셋이 동시에 열린다.
   */
  fireClose(code: number, reason = '') {
    act(() => this.onclose?.({ code, reason }));
  }
}

beforeEach(() => {
  FakeSocket.instances.length = 0;
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  vi.spyOn(Math, 'random').mockReturnValue(0); // 좌석 재접속 지연 0
  server.use(http.post('*/api/ws-ticket', () => HttpResponse.json({ ticket: 't' })));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mount(onMessage = vi.fn()) {
  return renderHook(() =>
    useTableSocket({ tableId: 'tbl', role: 'seat', onMessage, defaultError: 'x' }),
  );
}

/**
 * 가짜 타이머 아래서는 `@testing-library`의 실타이머 폴링(`waitFor`)에 기댈 수
 * 없다 — 그것이 I1이 고치는 문제였다. 티켓 fetch(마이크로태스크)가 풀려 소켓이
 * 생길 때까지 시간을 진짜로 흘리지 않고 마이크로태스크만 반복해서 비운다.
 */
async function waitForInstances(n: number) {
  for (let i = 0; i < 20 && FakeSocket.instances.length < n; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
  expect(FakeSocket.instances.length).toBe(n);
}

describe('useTableSocket 침묵 감시 (T96)', () => {
  it('기본값은 25초다: 그 전에는 재접속하지 않고, 지난 뒤에는 옛 소켓을 버리고 새 소켓을 연다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    await waitForInstances(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SOCKET_SILENCE_MS - 1_000);
    });
    expect(FakeSocket.instances.length).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(FakeSocket.instances.length).toBe(2);
    expect(FakeSocket.instances[0].closed).toBe(true);
  });

  /**
   * **반대 입력.** 이것이 없으면 "일정 시간마다 무조건 다시 연다"도 위를 통과한다.
   */
  it('keepalive가 계속 오면 다시 열지 않는다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    await waitForInstances(1);
    const s = FakeSocket.instances[0];

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SOCKET_SILENCE_MS - 1_000);
      });
      s.emit(KEEPALIVE_EVENT);
    }
    expect(FakeSocket.instances.length).toBe(1);
  });

  it('keepalive는 화면 콜백으로 넘기지 않는다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onMessage = vi.fn();
    mount(onMessage);
    await waitForInstances(1);
    FakeSocket.instances[0].emit(KEEPALIVE_EVENT);
    FakeSocket.instances[0].emit('renderGame', { x: 1 });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith('renderGame', { x: 1 });
  });

  /** M5. */
  it('워치독 재접속 뒤 옛 소켓의 늦은 onclose는 소켓을 더 만들지 않는다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    await waitForInstances(1);
    const old = FakeSocket.instances[0];

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SOCKET_SILENCE_MS + 1_000);
    });
    await waitForInstances(2);

    old.fireClose(1006);
    // 방어가 없으면 `scheduleRetry`가 다시 걸린다 — 그 타이머가 실제로 울릴
    // 시간까지 흘려서 세 번째 소켓이 생기는지 본다.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(FakeSocket.instances.length).toBe(2);
  });
});

/**
 * 서버 장애(T97). Redis가 죽었다 돌아오는 동안 게이트웨이가 테이블 소켓
 * 전원에게 `serverOutage`를 뿌린다 — 좌석·딜러가 각자 판정하면 두 벌이 되므로
 * 이 훅이 값 하나(`outage`)로 들고 돌려준다.
 */
describe('useTableSocket 서버 장애(T97)', () => {
  it('down:true를 받으면 outage가 참이 되고, 이어서 down:false를 받으면 거짓이 된다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = mount();
    await waitForInstances(1);

    FakeSocket.instances[0].emit(SERVER_OUTAGE_EVENT, { down: true });
    expect(result.current.outage).toBe(true);

    FakeSocket.instances[0].emit(SERVER_OUTAGE_EVENT, { down: false });
    expect(result.current.outage).toBe(false);
  });

  /** 계약을 어긴 페이로드는 무시한다 — 값을 바꾸지 않고 콘솔에만 남긴다. */
  it('계약에 안 맞는 페이로드는 무시하고 콘솔에 남긴다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = mount();
    await waitForInstances(1);

    FakeSocket.instances[0].emit(SERVER_OUTAGE_EVENT, {});

    expect(result.current.outage).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  /**
   * `keepalive`와 같은 취급이다 — 화면이 그릴 것은 훅이 든 `outage` 값
   * 하나뿐이라, 좌석·딜러의 `onMessage`로 넘기면 두 화면이 각자 또 분기를
   * 만들게 된다.
   */
  it('serverOutage는 onMessage로 넘기지 않는다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onMessage = vi.fn();
    mount(onMessage);
    await waitForInstances(1);

    FakeSocket.instances[0].emit(SERVER_OUTAGE_EVENT, { down: true });

    expect(onMessage).not.toHaveBeenCalled();
  });

  /**
   * 티켓 요청이 503이면 서버가 장애를 복구하는 중이라는 뜻이다. 기존
   * 비-429 경로(`scheduleRetry(null)`)와 같은 재시도가 걸리고, 문구는
   * `api/ws-ticket`이 그대로 돌려준 백엔드 본문을 쓴다.
   */
  it('티켓 요청이 503이면 재시도를 예약하고 문구를 띄운다', async () => {
    server.use(
      http.post('*/api/ws-ticket', () =>
        HttpResponse.json({ message: SERVER_RECOVERING_MESSAGE }, { status: 503 }),
      ),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 재시도 지연을 0 ms에서 20 s로 고정한다. 지연이 0이면 부하 아래서 8번
    // 시도가 assertion 전에 모두 완료돼서 테스트가 깨진다.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { result } = renderHook(() =>
      useTableSocket({ tableId: 'tbl', role: 'seat', onMessage: vi.fn(), defaultError: 'x' }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.connectionError).toBe(SERVER_RECOVERING_MESSAGE);
    expect(result.current.reconnecting).toBe(true);
    // 503은 429가 아니다 — 지터만으로 재시도가 걸린다(바닥 없음). 소켓은
    // 한 번도 못 열렸으므로 인스턴스가 없다.
    expect(FakeSocket.instances.length).toBe(0);
  });

  /**
   * **결정 사항.** `outage`는 "새로 열린 소켓의 첫 프레임"에서만 false로
   * 되돌린다. 끊긴 동안은 서버가 알릴 수 없으니, 다시 붙어 `renderGame`만
   * 오면(= 지금은 정상) false로 본다.
   */
  it('down:true 뒤 재접속해 renderGame만 오면 outage가 false로 돌아온다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = mount();
    await waitForInstances(1);
    FakeSocket.instances[0].emit(SERVER_OUTAGE_EVENT, { down: true });
    expect(result.current.outage).toBe(true);

    // 침묵 감시로 재접속시킨다.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SOCKET_SILENCE_MS + 1_000);
    });
    await waitForInstances(2);

    FakeSocket.instances[1].emit('renderGame', { x: 1 });

    expect(result.current.outage).toBe(false);
  });

  /**
   * **반대 입력.** 같은 소켓에서 두 번째 `renderGame`이 와도(첫 프레임이
   * 아니다) `outage`는 그대로다 — 복구 중에도 서버는 `renderGame`을 보낼 수
   * 있으므로, 매 `renderGame`마다 되돌리면 장애 배너가 중간에 사라진다.
   */
  it('같은 소켓의 두 번째 renderGame은 outage를 건드리지 않는다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = mount();
    await waitForInstances(1);
    FakeSocket.instances[0].emit('renderGame', { x: 1 }); // 첫 프레임
    FakeSocket.instances[0].emit(SERVER_OUTAGE_EVENT, { down: true });
    expect(result.current.outage).toBe(true);

    FakeSocket.instances[0].emit('renderGame', { x: 2 }); // 같은 소켓의 다음 프레임

    expect(result.current.outage).toBe(true);
  });
});

/**
 * T110. 세대가 올라 서버가 신원을 끊으면(4001) 다시 붙어 봐야 티켓이 403이다.
 * 재시도를 태우지 않고 이유를 `revoked`로 돌려준다.
 */
describe('useTableSocket 세션 폐기(T110)', () => {
  it('4001로 닫히면 revoked가 그 이유이고 타이머를 끝까지 돌려도 소켓을 더 열지 않는다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = mount();
    await waitForInstances(1);

    FakeSocket.instances[0].fireClose(SESSION_REVOKED_CLOSE_CODE, SEAT_RELEASED_REASON);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });

    expect(result.current.revoked).toBe(SEAT_RELEASED_REASON);
    expect(FakeSocket.instances.length).toBe(1);
  });

  it('1006은 기존대로 재시도하고 revoked는 null이다(반대 입력)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = mount();
    await waitForInstances(1);

    FakeSocket.instances[0].fireClose(1006);
    await waitForInstances(2);

    expect(result.current.revoked).toBeNull();
  });

  it('1000은 조용히 멈추고 revoked는 null이다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = mount();
    await waitForInstances(1);

    FakeSocket.instances[0].fireClose(1000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(result.current.revoked).toBeNull();
    expect(FakeSocket.instances.length).toBe(1);
  });

  it('티켓이 403이면 재시도 없이 revoked에 응답 문구를 싣는다', async () => {
    let calls = 0;
    server.use(
      http.post('*/api/ws-ticket', () => {
        calls += 1;
        return HttpResponse.json({ message: '만료된 좌석입니다.' }, { status: 403 });
      }),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });

    expect(calls).toBe(1);
    expect(result.current.revoked).toBe('만료된 좌석입니다.');
    expect(FakeSocket.instances.length).toBe(0);
  });

  it('티켓이 500이면 기존대로 재시도하고 revoked는 null이다', async () => {
    let calls = 0;
    server.use(
      http.post('*/api/ws-ticket', () => {
        calls += 1;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(calls).toBeGreaterThan(1);
    expect(result.current.revoked).toBeNull();
  });
});

/**
 * T119. **기다리는 사람이 걸음을 건너뛸 수 있다.** 옆 태블릿은 붙었는데 내 화면은
 * 다음 걸음(최대 60초)을 기다리고 있으면 사람은 새로고침을 누른다 — 화면을 통째로
 * 다시 받는 무거운 길이다. 같은 일을 재시도 한 번으로 한다.
 */
describe('useTableSocket 지금 다시 연결 (T119)', () => {
  /** 티켓 요청을 세고, 처음 `failures`번은 서버 무응답으로 답한다. */
  function countTickets(failures: number) {
    let calls = 0;
    server.use(http.post('*/api/ws-ticket', () => {
      calls += 1;
      return calls <= failures
        ? HttpResponse.json({ message: SERVER_RECOVERING_MESSAGE }, { status: 503 })
        : HttpResponse.json({ ticket: 't' });
    }));
    return () => calls;
  }
  const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

  it('기다리는 중에 누르면 걸음을 건너뛰고 바로 시도한다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // 다음 걸음까지 20초
    const calls = countTickets(1);
    const { result } = mount();
    await flush();
    expect(`요청 ${calls()} 기다림 ${result.current.reconnecting}`).toBe('요청 1 기다림 true');

    act(() => result.current.retryNow());
    await waitForInstances(1);

    expect(calls()).toBe(2);
  });

  /** 반대 입력. 이게 없으면 「언제나 새로 접속」도 위를 통과하고 소켓이 둘 열린다. */
  it('붙어 있을 때 누르면 아무 일도 없다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = countTickets(0);
    const { result } = mount();
    await waitForInstances(1);

    act(() => result.current.retryNow());
    await flush();

    expect(`요청 ${calls()} 소켓 ${FakeSocket.instances.length}`).toBe('요청 1 소켓 1');
  });

  it('포기한 뒤에 누르면 다시 세고, 그 시도가 실패하면 첫 지터가 아니라 5초 걸음이다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // 첫 지터 20초 · 첫 걸음 5초
    const calls = countTickets(1000);
    const { result } = mount();
    // 걸음은 최대 60초다. 한 걸음씩 넘기면 상한까지 전부 실패하고 포기한다.
    for (let i = 0; i < 20 && !/새로고침/.test(result.current.connectionError ?? ''); i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    }
    expect(result.current.connectionError).toMatch(/새로고침/);
    const before = calls();

    act(() => result.current.retryNow());
    await flush();

    expect(`더한 요청 ${calls() - before} 기다림 ${result.current.reconnecting}`).toBe('더한 요청 1 기다림 true');
    // 5초 걸음이면 6초 뒤에 한 번 더 두드린다. 첫 지터(20초)로 돌아갔으면 아직이다.
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(calls() - before).toBe(2);
  });
});
