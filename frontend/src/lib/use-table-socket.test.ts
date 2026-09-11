import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
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
}

const SILENCE = 60;

beforeEach(() => {
  FakeSocket.instances.length = 0;
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  vi.spyOn(Math, 'random').mockReturnValue(0); // 좌석 재접속 지연 0
  server.use(http.post('*/api/ws-ticket', () => HttpResponse.json({ ticket: 't' })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mount(onMessage = vi.fn()) {
  return renderHook(() =>
    useTableSocket({ tableId: 'tbl', role: 'seat', onMessage, defaultError: 'x', silenceMs: SILENCE }),
  );
}

describe('useTableSocket 침묵 감시 (T96)', () => {
  it('기본값은 25초다', () => {
    expect(SOCKET_SILENCE_MS).toBe(25_000);
  });

  it('침묵이 길어지면 그 소켓을 버리고 새 소켓을 연다', async () => {
    mount();
    await waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 1000 });
    expect(FakeSocket.instances[0].closed).toBe(true);
  });

  /**
   * **반대 입력.** 이것이 없으면 "일정 시간마다 무조건 다시 연다"도 위를 통과한다.
   */
  it('keepalive가 계속 오면 다시 열지 않는다', async () => {
    mount();
    await waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    const s = FakeSocket.instances[0];
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, SILENCE / 2));
      s.emit(KEEPALIVE_EVENT);
    }
    expect(FakeSocket.instances.length).toBe(1);
  });

  it('keepalive는 화면 콜백으로 넘기지 않는다', async () => {
    const onMessage = vi.fn();
    mount(onMessage);
    await waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    FakeSocket.instances[0].emit(KEEPALIVE_EVENT);
    FakeSocket.instances[0].emit('renderGame', { x: 1 });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith('renderGame', { x: 1 });
  });
});
