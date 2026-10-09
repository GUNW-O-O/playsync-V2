'use client';

import { useEffect, useRef, useState } from 'react';
import {
  KEEPALIVE_EVENT,
  SERVER_OUTAGE_EVENT,
  SESSION_REVOKED_CLOSE_CODE,
  ServerOutageSchema,
} from '@playsync/contract';
import { apiFetch } from '@/lib/api';
import { type SocketRole, retryAfterMs, waitFor } from '@/lib/reconnect-policy';

/**
 * 이만큼 아무것도 못 받으면 연결이 죽은 것으로 본다(T96).
 *
 * 서버가 10초마다 `keepalive`를 보낸다(`WsGateway.sweepSockets`). **틱
 * 하나를 놓쳐도 끊지 않는 값**이라 GC나 망 흔들림 한 번으로 끊지 않는다 —
 * 마지막 수신 뒤 두 틱을 놓치면 30초가 되어서야 이 값(25초)을 넘는다.
 *
 * 필요한 이유: 서버가 좀비를 치워도 태블릿은 모른다. 브라우저 JS는 프로토콜
 * ping을 볼 수 없고 태블릿은 사람이 누를 때만 보내므로 `onclose`가 안 뜬다 —
 * 그러면 아래 재접속이 영영 시작되지 않는다.
 */
export const SOCKET_SILENCE_MS = 25_000;

/** 닫기 이유나 403 본문에 문장이 없을 때 덮개가 그릴 말(T110). */
const REVOKED_FALLBACK = '이 기기의 접속이 해제되었습니다.';

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
}: {
  tableId: string;
  role: SocketRole;
  /** 서버 이벤트 하나를 받는다. 신원이 매 렌더 바뀌어도 소켓을 다시 열지 않는다. */
  onMessage: (event: string, data: unknown) => void;
  defaultError: string;
}) {
  const socketRef = useRef<WebSocket | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  /** 다시 붙는 중인가. 화면이 "연결 중"과 "포기했다"를 가르는 근거다. */
  const [reconnecting, setReconnecting] = useState(false);
  // 재시도를 다 쓰고 멈췄다. 여기서부터는 사람이 눌러야 돌아온다 — 화면이 모달로 바꿔 그린다.
  const [stalled, setStalled] = useState(false);
  /**
   * 서버가 Redis 장애를 복구하는 중인가(T97). 좌석·딜러가 각자 판정하면
   * 두 벌이 되므로 이 훅이 값 하나로 들고 돌려준다.
   */
  const [outage, setOutage] = useState(false);
  /**
   * 서버가 이 신원을 폐기해 끊었나(T110). 닫기 이유 문장이 곧 값이다 — 없으면 null.
   * 4001 닫기와 티켓 403(끊긴 사이 이미 폐기된 경우) 둘 다 이 값으로 모인다.
   */
  const [revoked, setRevoked] = useState<string | null>(null);

  // 콜백은 매 렌더 새 함수다. 의존성에 넣으면 렌더마다 소켓을 다시 연다.
  const onMessageRef = useRef(onMessage);
  const retryNowRef = useRef<() => void>(() => {});
  onMessageRef.current = onMessage;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let gaveUp = false;
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
      }, SOCKET_SILENCE_MS);
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
        gaveUp = true;
        setStalled(true);
        setReconnecting(false);
        setConnectionError('연결이 계속 실패합니다.');
        return;
      }

      setReconnecting(true);
      timer = setTimeout(() => {
        timer = null;
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
        // T110. 소켓이 다른 이유로 끊긴 사이 신원이 폐기됐으면 4001을 못 보고
        // 티켓에서 403을 받는다. 4001과 같게 멈추고 이유를 그린다 — 429·5xx는
        // 낫는 것이라 아래 재시도 길에 둔다.
        if (res.status === 403) {
          setRevoked(typeof message === 'string' && message ? message : REVOKED_FALLBACK);
          setReconnecting(false);
          return;
        }
        console.error('WS 티켓을 받지 못했습니다.');
        setConnectionError(typeof message === 'string' && message ? message : defaultError);
        // 429면 서버가 "언제 다시 오라"를 숫자로 말해 준 것이다. 그 값을
        // 무시하고 우리 지터만 쓰면 아직 닫힌 문을 때려 헛 429로 시도를 태운다.
        scheduleRetry(res.status === 429 ? retryAfterMs(res.headers) : null);
        return;
      }

      const { ticket } = await res.json();
      if (cancelled) return;

      const wsUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL?.replace('http', 'ws')}/playsync?tableId=${tableId}&ticket=${ticket}`;
      socket = new WebSocket(wsUrl);
      socketRef.current = socket;
      armWatchdog(socket);
      // 이 소켓의 첫 프레임을 아직 못 받았나(T97). 끊긴 동안은 서버가
      // `outage`를 알릴 길이 없다 — 다시 붙어 첫 프레임이 오면 그것이 곧
      // "지금은 서버에 닿았다"의 증거라 여기서만 `outage`를 false로 되돌린다.
      // 복구 중이면 게이트웨이가 이 프레임 바로 뒤에 `down:true`를 다시
      // 보낸다. 매 `renderGame`마다 되돌리면 장애 배너가 복구 중에도
      // 중간중간 사라진다.
      let firstFrame = true;

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
        setRevoked(null);
        if (firstFrame) {
          firstFrame = false;
          setOutage(false);
        }
        // 서버 장애(T97). 화면이 그릴 것은 이 값 하나라 훅이 들고 돌려준다 —
        // 좌석·딜러가 각자 받으면 두 벌이 된다. keepalive와 같은 취급이라
        // `onMessage`로 넘기지 않는다.
        if (parsed.event === SERVER_OUTAGE_EVENT) {
          const outageEvent = ServerOutageSchema.safeParse(parsed.data);
          if (outageEvent.success) setOutage(outageEvent.data.down);
          else console.error('serverOutage 계약 위반 — 무시한다.', outageEvent.error);
          return;
        }
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
        // T110. 세대가 올라 서버가 이 신원을 끊었다. 다시 붙어 봐야 티켓이
        // 403이라 재시도를 다 태우고 「새로고침」에 멈춘다 — 멈추고 이유를 그린다.
        if (event.code === SESSION_REVOKED_CLOSE_CODE) {
          setRevoked(event.reason || REVOKED_FALLBACK);
          setReconnecting(false);
          return;
        }
        setConnectionError(event.reason && event.reason.trim() ? event.reason : defaultError);
        scheduleRetry(null);
      };

      socket.onerror = () => {
        if (cancelled) return;
        setConnectionError(defaultError);
        // `onerror` 뒤에는 `onclose`가 따라온다. 여기서 예약하면 두 번 걸린다.
      };
    }

    /**
     * **기다리는 걸음을 건너뛴다**(T119, 띠의 「지금 다시 연결」). 옆 태블릿은 붙었는데
     * 내 화면이 다음 걸음(최대 60초)을 기다리면 사람은 새로고침을 누른다 — 화면을
     * 통째로 다시 받는 무거운 길이다. 사람이 누르는 시각은 저절로 흩어지므로 지터를
     * 다시 걸지 않는다.
     *
     * **기다리는 중이거나 포기한 뒤에만 듣는다.** 붙어 있거나 이미 시도 중일 때
     * 받으면 같은 자리에 소켓이 둘 열린다. 포기한 뒤라면 횟수를 다시 센다 — **1부터다.**
     * 0으로 돌리면 이 시도가 실패했을 때 다음 대기가 첫 지터(좌석 최대 40초, 딜러
     * 40~50초)가 된다. 방금 기다리기 싫어 누른 사람에게 그 대기를 다시 준다.
     */
    retryNowRef.current = () => {
      if (cancelled || (timer === null && !gaveUp)) return;
      if (timer) clearTimeout(timer);
      timer = null;
      if (gaveUp) {
        gaveUp = false;
        attempt = 1;
        setStalled(false);
      }
      setReconnecting(true);
      void connect();
    };

    void connect();

    return () => {
      cancelled = true;
      retryNowRef.current = () => {};
      if (timer) clearTimeout(timer);
      if (watchdog) clearTimeout(watchdog);
      socket?.close();
    };
    // `onMessage`는 ref로 들어가므로 의존성에 없다 — 넣으면 렌더마다 재연결한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, role, defaultError]);

  return { socketRef, connectionError, reconnecting, stalled, outage, revoked, retryNow: () => retryNowRef.current() };
}
