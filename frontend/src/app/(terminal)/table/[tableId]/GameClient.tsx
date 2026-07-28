'use client';

import { useEffect, useRef, useState } from 'react';
import PokerTable from './PokerTable';
import { TableState } from '@/app/types/game';
import ActionPanel from './ActionPanel';

export default function GameClient({ tableId, initialData, seatIndex, initIsDealer }: { tableId: string, initialData?: TableState, seatIndex: number, initIsDealer: boolean }) {
  const socketRef = useRef<WebSocket | null>(null);
  const [gameState, setGameState] = useState<TableState | null>(initialData || null);
  const [mySeatIndex, setMySeatIndex] = useState<number | null>(seatIndex ?? null);
  const [isDealer, setIsDealer] = useState<boolean>(initIsDealer || false); // 딜러 세션 여부
  const [rebuyData, setRebuyData] = useState<any>(null);

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
    (async () => {
      const res = await fetch('/api/ws-ticket', { method: 'POST' });
      if (!res.ok) {
        console.error('WS 티켓을 받지 못했습니다.');
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
    <div className="flex h-screen w-screen bg-slate-950 text-white overflow-hidden p-2 gap-2">
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