import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';
import DisplayClient from './DisplayClient';

// packages/contract/src/dashboard.spec.ts의 VALID와 같은 모양. 백엔드 출처는
// backend/shared/types/tournamentMeta.ts(Dashboard·BlindField)와
// backend/shared/dto/blind-structure.dto.ts(BlindLevelDto)다.
const VALID = {
  dashboard: {
    isRegistrationOpen: true, totalPlayer: 20, activePlayer: 7,
    totalBuyinAmount: 350000, rebuyUntil: 0, avgStack: 50000,
    tournamentName: '데모 토너먼트', entryFee: 50000, startStack: 30000,
    itmCount: 3, prizePool: 350000,
    prizes: [{ place: 1, percent: 50, amount: 175000 }],
  },
  blindField: {
    isBreak: false, startedAt: 0, currentBlindLv: 0,
    nextLevelAt: 1000, serverTime: 0,
    blindStructure: [{ lv: 1, sb: 100, ante: false, duration: 10 }],
  },
};

describe('DisplayClient', () => {
  it('본문이 빈 200이면 대기 중을 그린다', async () => {
    // Nest가 null을 반환하면 본문이 비어서 나간다(playsync.controller.ts:22 →
    // redis.service.ts:287). HttpResponse.json(null)은 본문이 "null"이라 실제와
    // 다르므로 진짜 빈 본문을 먹인다.
    server.use(http.get('*/playsync/dashboard/:id', () => new HttpResponse(null, { status: 200 })));
    render(<DisplayClient tournamentId="t1" />);
    expect(await screen.findByText('대기 중')).toBeInTheDocument();
  });

  it('isBreak면 화면을 통째로 휴식으로 바꾼다', async () => {
    server.use(http.get('*/playsync/dashboard/:id', () =>
      HttpResponse.json({ ...VALID, blindField: { ...VALID.blindField, isBreak: true } })));
    render(<DisplayClient tournamentId="t1" />);
    expect(await screen.findByText('휴식')).toBeInTheDocument();
    // 배지 하나로는 담배 피우러 나간 사람이 못 본다. 남은 시간만 남기고 지운다.
    expect(screen.queryByText('데모 토너먼트')).not.toBeInTheDocument();
  });

  it('평상시에는 프라이즈풀과 남은 인원이 보인다', async () => {
    server.use(http.get('*/playsync/dashboard/:id', () => HttpResponse.json(VALID)));
    render(<DisplayClient tournamentId="t1" />);
    expect(await screen.findByText('350,000')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });
});
