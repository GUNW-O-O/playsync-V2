'use client';

import { useEffect, useRef, useState } from 'react';
import PokerTable from './PokerTable';
import { TableState } from '@/app/types/game';
import ActionPanel from './ActionPanel';

// 서버·소켓이 문구를 안 줄 때의 최후 안내. 딜러가 무엇을 해야 하는지는
// 알려준다 — 화면 재구성은 B7의 몫이라 배너 이상으로 꾸미지 않는다.
const DEFAULT_CONNECTION_ERROR = '연결이 끊어졌습니다. 화면을 새로고침하거나 운영자에게 알려주세요.';

export default function GameClient({ tableId, initialData, seatIndex, initIsDealer }: { tableId: string, initialData?: TableState, seatIndex: number, initIsDealer: boolean }) {
  const socketRef = useRef<WebSocket | null>(null);
  const [gameState, setGameState] = useState<TableState | null>(initialData || null);
  const [mySeatIndex, setMySeatIndex] = useState<number | null>(seatIndex ?? null);
  const [isDealer, setIsDealer] = useState<boolean>(initIsDealer || false); // 딜러 세션 여부
  const [rebuyData, setRebuyData] = useState<any>(null);
  // 티켓 발급 실패나 소켓 이상 종료를 화면에 보이게 한다. 딜러 클릭이 게임
  // 진행의 트리거인 시스템에서 "화면은 멀쩡해 보이는데 아무것도 안 움직이는"
  // 상태가 가장 나쁜 실패 모드다.
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(() => {
    if (seatIndex === -1) {
      setIsDealer(true);
    } else {
      setIsDealer(false);
      setMySeatIndex(seatIndex);
    }

    let socket: WebSocket | null = null;
    let cancelled = false;

    // 티켓은 1회용 30초라 연결 시도마다 새로 받는다. 액세스 토큰은 이 컴포넌트에
    // 들어오지 않는다 — 쿠키를 읽는 것은 route handler(서버)뿐이다.
    //
    // fetch 자체가 reject하는 경우(네트워크 단절, 브라우저 확장 차단 등)를
    // try/catch로 감싼다. 감싸지 않으면 이 async IIFE는 어디서도 await되지
    // 않으므로 처리되지 않은 프라미스 거부로 새어 나간다. res.json() 파싱
    // 실패도 같은 자리에서 잡힌다.
    (async () => {
      try {
        const res = await fetch('/api/ws-ticket', { method: 'POST' });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          const message = (body as { message?: unknown } | null)?.message;
          console.error('WS 티켓을 받지 못했습니다.');
          if (!cancelled) {
            setConnectionError(typeof message === 'string' && message ? message : DEFAULT_CONNECTION_ERROR);
          }
          return;
        }
        const { ticket } = await res.json();
        if (cancelled) return;

        const wsUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL?.replace('http', 'ws')}/playsync?tableId=${tableId}&ticket=${ticket}`;
        socket = new WebSocket(wsUrl);
        socketRef.current = socket;

        socket.onmessage = (event) => {
          const { event: serverEvent, data } = JSON.parse(event.data);
          if (serverEvent === 'renderGame') {
            setGameState(data);
          }
          else if (serverEvent === 'REBUY_PROMPT') {
            setRebuyData(data);
          }
        };

        socket.onclose = (event) => {
          // cleanup(언마운트)이 socket.close()를 부르면 이 핸들러도 불린다.
          // cancelled로 그 정상 종료를 구분한다. 코드 1000(정상 종료)도
          // 에러로 보지 않는다.
          if (cancelled || event.code === 1000) return;
          setConnectionError(event.reason && event.reason.trim() ? event.reason : DEFAULT_CONNECTION_ERROR);
        };

        socket.onerror = () => {
          if (cancelled) return;
          setConnectionError(DEFAULT_CONNECTION_ERROR);
        };
      } catch (err) {
        // 언마운트로 인한 중단(cancelled)은 정상 경로다. 에러처럼 남기지 않는다.
        if (!cancelled) {
          console.error('WS 티켓 요청 중 오류가 발생했습니다.', err);
          setConnectionError(DEFAULT_CONNECTION_ERROR);
        }
      }
    })();

    return () => {
      cancelled = true;
      socket?.close();
    };
  }, [tableId, seatIndex]);


  const sendAction = (type: 'PLAYER_ACTION' | 'DEALER_ACTION', payload: any = {}) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      // token과 tableId는 싣지 않는다. 서버는 둘 다 읽지 않는다 — 핸드셰이크에서
      // 이미 검증해 소켓에 박아 두었다. 매 액션마다 토큰을 흘려 보내면 로그
      // 유출 표면만 넓어지고, 인바운드 스키마가 모르는 키로 거부한다.
      const message = {
        event: type, // 백엔드 @SubscribeMessage와 매칭
        data: payload, // action, amount, winnerUserIds 등
      };

      socketRef.current.send(JSON.stringify(message));
    } else {
      console.error("웹소켓 연결이 열려있지 않습니다.");
    }
  };

  const handleRebuyAction = (accept: boolean) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        event: 'REBUY_RESPONSE',
        data: { accept }
      }));
    }
    setRebuyData(null);
  };

  return (
    <div className="relative flex h-screen w-screen bg-slate-950 text-white overflow-hidden p-2 gap-2">
      {connectionError && (
        <div className="absolute top-0 inset-x-0 z-50 bg-red-600 text-white text-center py-2 px-4 text-sm font-medium">
          {connectionError}
        </div>
      )}
      {/* 3/2 영역: 포커 테이블 (고정 레이아웃) */}
      <div className="flex-[2] relative bg-slate-900 rounded-3xl border border-slate-800 shadow-inner overflow-hidden">
        <PokerTable
          state={gameState}
          mySeatIndex={mySeatIndex}
        />
      </div>

      {/* 1/3 영역: 컨트롤 패널 (유저/딜러 분기) */}
      <div className="flex-[1] flex flex-col bg-slate-900 rounded-3xl border border-slate-800 p-4 overflow-y-auto">
        <ActionPanel
          state={gameState}
          mySeatIndex={mySeatIndex}
          isDealer={isDealer}
          onAction={sendAction}
          onRebuyResponse={handleRebuyAction}
          rebuyData={rebuyData}
        />
      </div>
    </div>
  );
}