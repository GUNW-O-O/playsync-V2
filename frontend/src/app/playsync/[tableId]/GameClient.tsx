'use client';

import { useEffect, useRef, useState } from 'react';
import PokerTable from './PokerTable';
import { TableState } from '@/app/types/game';
import ActionPanel from './ActionPanel';

export default function GameClient({ tableId, initialData, seatIndex, token, initIsDealer }: { tableId: string, initialData?: TableState, seatIndex: number, token: string, initIsDealer: boolean }) {
  const socketRef = useRef<WebSocket | null>(null);
  const [gameState, setGameState] = useState<TableState | null>(initialData || null);
  const [mySeatIndex, setMySeatIndex] = useState<number | null>(seatIndex ?? null);
  const [isDealer, setIsDealer] = useState<boolean>(initIsDealer || false); // 딜러 세션 여부
  const [rebuyData, setRebuyData] = useState<any>(null);

  useEffect(() => {
    const wsUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL?.replace('http', 'ws')}/playsync?tableId=${tableId}&token=${token}`;
    const ws = new WebSocket(wsUrl);
    if (seatIndex === -1) {
      setIsDealer(true);
    } else {
      setIsDealer(false);
      setMySeatIndex(seatIndex);
    }
    socketRef.current = ws;
    ws.onmessage = (event) => {
      const { event: serverEvent, data } = JSON.parse(event.data);
      if (serverEvent === 'renderGame') {
        setGameState(data);
      }
      else if (serverEvent === 'REBUY_PROMPT') {
        setRebuyData(data);
      }
    };

    return () => ws.close();
  }, [tableId]);


  const sendAction = (type: 'PLAYER_ACTION' | 'DEALER_ACTION', payload: any = {}) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      const message = {
        event: type, // 백엔드 @SubscribeMessage와 매칭
        data: {
          ...payload,      // action, amount, winnerUserIds 등이 담김
          token,           // 검증용 토큰
          tableId          // 대상 테이블 ID
        }
      };

      console.log(`[WS Send] ${type}:`, message.data); // 디버깅용
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