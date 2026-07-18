'use client'

import { joinTournament } from '../action';
import { useEffect, useRef, useState } from "react";

export default function TournamentClient({ initialData, id, token }: any) {
  const [data, setData] = useState(initialData);
  const [selectedSeat, setSelectedSeat] = useState<{ tableId: string, index: number } | null>(null);
  const socketRef = useRef<WebSocket | null>(null);


  useEffect(() => {
    // 웹소켓 연결 tournamentId, token 전달
    const wsUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL?.replace('http', 'ws')}/playsync?tournamentId=${id}&token=${token}`;
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onmessage = (event) => {
      const { event: serverEvent, data: updatedSeatStatus } = JSON.parse(event.data);

      if (serverEvent === 'renderSeatList') {
        setData((prev: any) => ({
          ...prev,
          seatStatus: updatedSeatStatus
        }));
        
        // 점유되었다면 선택 해제
        setSelectedSeat((prevSelected) => {
          if (!prevSelected) return null;
          const table = updatedSeatStatus.find((t: any) => t.tableId === prevSelected.tableId);
          if (table && table.seatStatus[prevSelected.index]) return null;
          return prevSelected;
        });
      }
    };

    return () => ws.close();
  }, [id]);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">{data.tournament.name}</h1>
        <p className="text-gray-500">{data.tournament.entryFee.toLocaleString()}원 | ITM: {data.tournament.itmCount}명</p>
      </div>

      <h2 className="text-xl font-bold mb-4">좌석 선택</h2>
      <div className="space-y-8">
        {data.seatStatus.map((tableObj: any) => {
          // 각 테이블 객체에서 필요한 정보를 꺼냅니다.
          const { tableId, seatStatus: seats } = tableObj;

          return (
            <div key={tableId} className="bg-gray-100 p-6 rounded-3xl border-4 border-gray-300 relative overflow-hidden">
              <div className="text-center font-bold text-gray-400 mb-4 italic">
                {data.tournament.tables.find((t: any) => t.id === tableId)?.tableOrder}번 테이블
              </div>

              <div className="grid grid-cols-9 gap-3 relative">
                {seats.map((isOccupied: boolean, idx: number) => (
                  <button
                    key={idx}
                    disabled={isOccupied}
                    onClick={() => setSelectedSeat({ tableId, index: idx })}
                    className={`
                h-10 w-10 rounded-full border-2 flex items-center justify-center font-bold transition
                ${isOccupied ? 'bg-red-200 border-red-400 text-red-700 cursor-not-allowed' :
                        selectedSeat?.index === idx && selectedSeat?.tableId === tableId
                          ? 'bg-yellow-400 border-yellow-600 scale-110 shadow-lg'
                          : 'bg-white border-gray-300 hover:border-indigo-500'}
              `}
                  >
                    {idx + 1}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {selectedSeat && (
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-white border-t shadow-2xl flex justify-between items-center">
          <div>
            <span className="text-sm text-gray-500">{data.tournament.name}</span>
            <p className="font-bold">{
              data.tournament.tables.find((t: any) => t.id === selectedSeat.tableId)?.tableOrder
            }번 테이블 - {selectedSeat.index + 1}번석</p>
          </div>
          <button
            onClick={() => joinTournament(id, selectedSeat.tableId, selectedSeat.index)}
            className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-indigo-700"
          >
            참가 결제하기
          </button>
        </div>
      )}
    </div>
  );
}