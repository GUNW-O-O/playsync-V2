'use client';

import { useState } from 'react';
import type { SyncStatus } from '@playsync/contract';
import type { TableInfo, TableSeatInfo } from './ConsoleClient';

/**
 * 재기동 복구 중인 대회(T117). 서버는 딜러와 좌석 기기가 다 돌아와야 대회를 연다 —
 * 끝내 안 돌아오는 자리가 있으면 상점이 이 목록을 보고 연다.
 *
 * 테이블 번호와 닉네임은 콘솔이 이미 받은 좌석 목록으로 잇는다(`SyncStatus`는
 * 자리만 싣는다). Carbon 토큰만 쓴다(`ConsoleClient`와 같은 면).
 */
export default function SyncPanel({
  sync,
  tables,
  seatOccupants,
  pending,
  onForce,
}: {
  sync: SyncStatus;
  tables: TableInfo[];
  seatOccupants: TableSeatInfo[];
  pending: boolean;
  onForce: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const order = new Map(tables.map((t) => [t.id, t.tableOrder]));
  // 테이블 순서(모르는 테이블은 맨 뒤) → 딜러 → 좌석 번호.
  const byTableThenDealerThenSeat = (a: SyncStatus['missing'][number], b: SyncStatus['missing'][number]) =>
    (order.get(a.tableId) ?? Infinity) - (order.get(b.tableId) ?? Infinity) ||
    (a.seatIndex ?? -1) - (b.seatIndex ?? -1);
  const nickname = (tableId: string, seatIndex: number) =>
    seatOccupants.find((t) => t.tableId === tableId)?.players.find((p) => p.seatIndex === seatIndex)?.nickname ?? '';

  return (
    <div data-testid="sync-panel" className="border border-[var(--hairline)] bg-[var(--surface)] p-4 text-sm">
      <p className="font-semibold">
        서버 복구 중. 태블릿 {sync.present}/{sync.required}대 연결됨
      </p>
      <p className="mt-1 text-[var(--ink-subtle)]">
        딜러와 좌석 태블릿이 모두 다시 연결되면 대회가 자동으로 재개됩니다. 끝내 연결되지 않는 자리가 있으면 지금
        진행할 수 있습니다. 그 자리의 참가자는 차례가 오면 시간 초과로 폴드됩니다.
      </p>
      {sync.missing.length > 0 && (
        <ul className="mt-2 list-disc pl-5">
          {[...sync.missing].sort(byTableThenDealerThenSeat).map((m) => (
            <li key={`${m.tableId}:${m.seatIndex ?? 'dealer'}`}>
              {m.seatIndex === null
                ? `테이블 ${order.get(m.tableId) ?? '?'} · 딜러`
                : `테이블 ${order.get(m.tableId) ?? '?'} · ${m.seatIndex + 1}번 ${nickname(m.tableId, m.seatIndex)}`.trimEnd()}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex gap-2">
        {confirming ? (
          <>
            <button type="button" disabled={pending} onClick={() => { setConfirming(false); onForce(); }}
              className="bg-[var(--blue)] px-4 py-2 text-white disabled:opacity-40">
              진행한다
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="border border-[var(--hairline)] px-4 py-2">
              취소
            </button>
          </>
        ) : (
          <button type="button" disabled={pending} onClick={() => setConfirming(true)}
            className="bg-[var(--blue)] px-4 py-2 text-white disabled:opacity-40">
            지금 진행
          </button>
        )}
      </div>
    </div>
  );
}
