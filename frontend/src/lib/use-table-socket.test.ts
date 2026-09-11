import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';
import { KEEPALIVE_EVENT } from '@playsync/contract';
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
  fireClose(code: number) {
    act(() => this.onclose?.({ code, reason: '' }));
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
