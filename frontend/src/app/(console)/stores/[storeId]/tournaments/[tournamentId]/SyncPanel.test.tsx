import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SyncPanel from './SyncPanel';

const tables = [{ id: 't1', tableOrder: 1 }, { id: 't2', tableOrder: 2 }];
const seatOccupants = [
  { tableId: 't1', tableOrder: 1, players: [{ seatIndex: 3, userId: 'u1', nickname: '민수' }] },
];

describe('SyncPanel', () => {
  it('기기 수와 안 돌아온 자리를 테이블 번호 · 좌석 번호 · 닉네임으로 보여준다', () => {
    render(
      <SyncPanel
        sync={{ syncing: true, present: 10, required: 12, missing: [{ tableId: 't1', seatIndex: 3 }, { tableId: 't2', seatIndex: null }] }}
        tables={tables}
        seatOccupants={seatOccupants}
        pending={false}
        onForce={() => {}}
      />,
    );
    expect(screen.getByTestId('sync-panel')).toHaveTextContent('태블릿 10/12대 연결됨');
    expect(screen.getByText('테이블 1 · 4번 민수')).toBeInTheDocument();
    expect(screen.getByText('테이블 2 · 딜러')).toBeInTheDocument();
  });

  /** 되돌릴 수 없는 조작이라 한 번 더 묻는다 — 첫 클릭은 확인만 연다. */
  it('지금 진행은 확인을 거쳐야 부른다', () => {
    const onForce = vi.fn();
    render(
      <SyncPanel sync={{ syncing: true, present: 1, required: 2, missing: [] }} tables={tables} seatOccupants={[]} pending={false} onForce={onForce} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '지금 진행' }));
    expect(onForce).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '진행한다' }));
    expect(onForce).toHaveBeenCalledTimes(1);
  });

  it('처리 중에는 누를 수 없다', () => {
    render(
      <SyncPanel sync={{ syncing: true, present: 1, required: 2, missing: [] }} tables={tables} seatOccupants={[]} pending onForce={() => {}} />,
    );
    expect(screen.getByRole('button', { name: '지금 진행' })).toBeDisabled();
  });
});

describe('SyncPanel 정렬', () => {
  it('안 돌아온 자리를 테이블 순서, 딜러 먼저, 좌석 번호 순으로 보여준다', () => {
    render(
      <SyncPanel
        sync={{
          syncing: true, present: 0, required: 4,
          missing: [
            { tableId: 't2', seatIndex: 5 },
            { tableId: 't1', seatIndex: 3 },
            { tableId: 't1', seatIndex: null },
            { tableId: 't2', seatIndex: null },
          ],
        }}
        tables={tables}
        seatOccupants={[]}
        pending={false}
        onForce={() => {}}
      />,
    );
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '테이블 1 · 딜러',
      '테이블 1 · 4번',
      '테이블 2 · 딜러',
      '테이블 2 · 6번',
    ]);
  });
});
