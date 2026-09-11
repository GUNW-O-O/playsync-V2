'use client';

import { useEffect, useRef, useState } from 'react';
import { KEEPALIVE_EVENT } from '@playsync/contract';
import { apiFetch } from '@/lib/api';
import { type SocketRole, retryAfterMs, waitFor } from '@/lib/reconnect-policy';

/**
 * 이만큼 아무것도 못 받으면 연결이 죽은 것으로 본다(T96).
 *
 * 서버가 10초마다 `keepalive`를 보낸다(`WsGateway.sweepSockets`). **두 틱을
 * 놓치고도 남는 값**이라 GC나 망 흔들림 한 번으로 끊지 않는다.
 *
 * 필요한 이유: 서버가 좀비를 치워도 태블릿은 모른다. 브라우저 JS는 프로토콜
 * ping을 볼 수 없고 태블릿은 사람이 누를 때만 보내므로 `onclose`가 안 뜬다 —
 * 그러면 아래 재접속이 영영 시작되지 않는다.
 */
export const SOCKET_SILENCE_MS = 25_000;

/**
 * 테이블 소켓 하나를 들고, 끊기면 **스스로 다시 붙는다**(T93).
 *
 * 좌석 화면과 딜러 화면이 같은 배선을 두 벌로 들고 있었다. 둘 다 `onclose`가
 * 하는 일이 `setConnectionError` 하나였고, effect 의존성이 테이블 id라 다시
 * 돌지도 않았다 — **서버를 재시작하면 행사장의 모든 태블릿이 에러 문구에서
 * 멈추고 사람이 한 대씩 새로고침해야 했다.**
 *
 * 두 화면이 다른 것은 받은 메시지로 무엇을 하느냐뿐이라, 그 부분만 콜백으로
 * 받는다. 재접속 규칙을 한 벌로 두는 것이 이 훅의 목적이다 — 두 벌이면 한쪽만
 * 고쳐지는 날이 온다.
 *
 * ## 성공의 정의가 "열렸다"가 아니다
 *
 * **첫 프레임을 받아야 성공이다.** 게이트웨이가 테이블 접속자에게 `renderGame`을
 * 한 번 보내므로(`WsGateway.handleConnection`) 그 프레임이 곧 "열렸고 등록됐다"의
 * 증거다. `open`에서 시도 횟수를 되돌리면, 서버가 받아 놓고 곧바로 1008로 끊는
 * 경우(만료된 티켓)에 횟수가 영영 0이라 무한히 두드린다. e2e가 "눌렀다"가 아니라
 * "상태가 바뀌었다"를 성공으로 삼는 것과 같은 자리다.
 */
export function useTableSocket({
  tableId,
  role,
  onMessage,
  defaultError,
  silenceMs = SOCKET_SILENCE_MS,
}: {
  tableId: string;
  role: SocketRole;
  /** 서버 이벤트 하나를 받는다. 신원이 매 렌더 바뀌어도 소켓을 다시 열지 않는다. */
  onMessage: (event: string, data: unknown) => void;
  defaultError: string;
  /** 테스트가 줄인다. */
  silenceMs?: number;
}) {
  const socketRef = useRef<WebSocket | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  /** 다시 붙는 중인가. 화면이 "연결 중"과 "포기했다"를 가르는 근거다. */
  const [reconnecting, setReconnecting] = useState(false);

  // 콜백은 매 렌더 새 함수다. 의존성에 넣으면 렌더마다 소켓을 다시 연다.
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    /**
     * 수신이 있을 때마다 다시 건다. 울리면 그 소켓을 **버리고** 재접속한다.
     *
     * `close()`만 부르고 `onclose`를 기다리지 않는다 — 죽은 연결에서는 닫는
     * 핸드셰이크가 오지 않아 브라우저가 그 이벤트를 한참 뒤에야(또는 영영)
     * 낸다. 핸들러를 먼저 떼어 늦게 오는 `onclose`가 두 번째 예약을 걸지 않게
     * 한다.
     */
    function armWatchdog(target: WebSocket) {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (cancelled || socket !== target) return;
        target.onmessage = null;
        target.onclose = null;
        target.onerror = null;
        target.close();
        setConnectionError(defaultError);
        scheduleRetry(null);
      }, silenceMs);
    }

    /**
     * 다음 시도를 예약한다. 더 시도하지 않기로 하면 문구를 남기고 멈춘다 —
     * 그 자리에서 참가자가 할 수 있는 일은 새로고침뿐이라 그것을 적는다.
     */
    function scheduleRetry(floorMs: number | null) {
      if (cancelled) return;
      const wait = waitFor(attempt, role, floorMs);
      attempt += 1;

      if (wait === null) {
        setReconnecting(false);
        setConnectionError('연결이 계속 실패합니다. 화면을 새로고침해 주세요.');
        return;
      }

      setReconnecting(true);
      timer = setTimeout(() => {
        void connect();
      }, wait);
    }

    async function connect() {
      if (cancelled) return;

      let res: Response;
      try {
        res = await apiFetch('/api/ws-ticket', { method: 'POST' });
      } catch (err) {
        // fetch 자체가 reject하는 경우(네트워크 단절, 확장 차단). 감싸지 않으면
        // 이 async 함수는 어디서도 await되지 않아 처리되지 않은 거부로 샌다.
        if (cancelled) return;
        console.error('WS 티켓 요청 중 오류가 발생했습니다.', err);
        setConnectionError(defaultError);
        scheduleRetry(null);
        return;
      }
      if (cancelled) return;

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const message = (body as { message?: unknown } | null)?.message;
        if (cancelled) return;
        console.error('WS 티켓을 받지 못했습니다.');
        setConnectionError(typeof message === 'string' && message ? message : defaultError);
        // 429면 서버가 "언제 다시 오라"를 숫자로 말해 준 것이다. 그 값을
        // 무시하고 우리 지터만 쓰면 아직 닫힌 문을 때려 블록이 갱신된다.
        scheduleRetry(res.status === 429 ? retryAfterMs(res.headers) : null);
        return;
      }

      const { ticket } = await res.json();
      if (cancelled) return;

      const wsUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL?.replace('http', 'ws')}/playsync?tableId=${tableId}&ticket=${ticket}`;
      socket = new WebSocket(wsUrl);
      socketRef.current = socket;
      armWatchdog(socket);

      socket.onmessage = (event) => {
        if (cancelled) return;
        let parsed: { event?: string; data?: unknown };
        try {
          parsed = JSON.parse(event.data);
        } catch {
          console.error('WS 메시지를 읽지 못했습니다.');
          return;
        }
        armWatchdog(socket!);
        // 첫 프레임이 성공의 증거다. 여기서만 횟수와 문구를 되돌린다.
        attempt = 0;
        setReconnecting(false);
        setConnectionError(null);
        // keepalive는 연결 확인일 뿐 화면이 그릴 것이 없다.
        if (parsed.event && parsed.event !== KEEPALIVE_EVENT) {
          onMessageRef.current(parsed.event, parsed.data);
        }
      };

      socket.onclose = (event) => {
        // cleanup(언마운트)이 close()를 부르면 이 핸들러도 불린다. `cancelled`로
        // 그 정상 종료를 구분한다.
        if (cancelled) return;
        if (watchdog) clearTimeout(watchdog);
        // 코드 1000은 서버가 정상적으로 닫은 것이다. 대회가 끝나 닫힌 경우가
        // 그것이라, 다시 붙으면 끝난 대회에 계속 매달린다.
        if (event.code === 1000) return;
        setConnectionError(event.reason && event.reason.trim() ? event.reason : defaultError);
        scheduleRetry(null);
      };

      socket.onerror = () => {
        if (cancelled) return;
        setConnectionError(defaultError);
        // `onerror` 뒤에는 `onclose`가 따라온다. 여기서 예약하면 두 번 걸린다.
      };
    }

    void connect();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (watchdog) clearTimeout(watchdog);
      socket?.close();
    };
    // `onMessage`는 ref로 들어가므로 의존성에 없다 — 넣으면 렌더마다 재연결한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, role, defaultError, silenceMs]);

  return { socketRef, connectionError, reconnecting };
}
