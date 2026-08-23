import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';
import DisplayClient from './DisplayClient';

// DisplayClient.tsx의 POLL_MS와 같은 값. export되어 있지 않아 직접 든다 —
// 값이 갈라지면 이 테스트가 페이크 타이머를 잘못된 간격으로 밀게 되어
// 스스로 실패한다.
const POLL_MS = 1000;

// packages/contract/src/dashboard.spec.ts의 VALID와 같은 모양. 백엔드 출처는
// backend/shared/types/tournamentMeta.ts(Dashboard·BlindField)와
// backend/shared/dto/blind-structure.dto.ts(BlindLevelDto)다.
const VALID = {
  dashboard: {
    isRegistrationOpen: true, totalPlayer: 20, activePlayer: 7,
    totalBuyinAmount: 350000, rakePercent: 0, rebuyUntil: 0, avgStack: 50000,
    tournamentName: '데모 토너먼트', entryFee: 50000, startStack: 30000,
    entryCount: 7, itmCount: 3, prizePool: 350000,
    prizes: [{ place: 1, percent: 50, amount: 175000 }],
  },
  blindField: {
    isBreak: false, startedAt: 0, currentBlindLv: 0,
    nextLevelAt: 1000, serverTime: 0,
    blindStructure: [{ lv: 1, sb: 100, ante: 0, duration: 10 }],
  },
};

describe('DisplayClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * 리뷰 지적(Important): 초기 상태(`info === null`)가 이미 "대기 중"이라,
   * 첫 렌더만 보는 테스트는 빈 본문 분기(`text.length === 0` →
   * `setInfo(null)`)를 한 줄도 실행하지 않아도 통과했다. 그래서 **전이**를
   * 본다 — 유효한 응답으로 평상시 화면이 뜬 뒤, 다음 폴링이 진짜 빈 200을
   * 받았을 때 "대기 중"으로 돌아오는지. 이래야 `setInfo(null)`이 실제로
   * 실행됐다는 것이 증명된다.
   *
   * Nest가 null을 반환하면 본문이 비어서 나간다(playsync.controller.ts:22 →
   * redis.service.ts:287). HttpResponse.json(null)은 본문이 "null"이라
   * 실제와 다르므로, 두 번째 응답부터는 진짜 빈 본문을 먹인다.
   */
  it('평상시 화면이 뜬 뒤 다음 폴링이 빈 본문이면 대기 중으로 돌아온다', async () => {
    let pollCount = 0;
    server.use(
      http.get('*/playsync/dashboard/:id', () => {
        pollCount += 1;
        return pollCount === 1
          ? HttpResponse.json(VALID)
          : new HttpResponse(null, { status: 200 });
      }),
    );

    vi.useFakeTimers();
    render(<DisplayClient tournamentId="t1" />);

    // 마운트 시 즉시 실행되는 첫 폴링이 평상시 화면을 그릴 때까지 마이크로
    // 태스크를 흘려보낸다. msw의 fetch 응답은 페이크 타이머가 흉내내지
    // 않는 프라미스 체인으로 오므로 실시간 타이머 없이도 풀린다.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('350,000')).toBeInTheDocument();

    // 다음 폴링 주기(POLL_MS)를 페이크 타이머로 민다 — 이번엔 빈 본문이다.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });

    expect(screen.getByText('대기 중')).toBeInTheDocument();
    expect(pollCount).toBeGreaterThanOrEqual(2);
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
    // 자리로 집는다. 픽스처의 `activePlayer`와 `entryCount`가 둘 다 7이라
    // 글자로 찾으면 어느 칸을 본 것인지 알 수 없다.
    expect(screen.getByTestId('active-player')).toHaveTextContent('7');
  });

  /**
   * T58에서는 「앤티 있음」 배지였다. 그것만으로는 딜러도 참가자도 **얼마를
   * 내는지** 화면으로 못 본다 — 칩이 디지털이고 화면이 유일한 장부인데,
   * 매 핸드 나가는 돈이 화면 어디에도 없었다.
   *
   * 금액은 계약이 든다(`BlindLevelSchema.ante`). 여기서 `sb / 5`를 다시
   * 적으면 백엔드가 식을 바꿀 때 조용히 어긋난다.
   */
  it('앤티가 붙으면 금액을 보여준다', async () => {
    server.use(http.get('*/playsync/dashboard/:id', () => HttpResponse.json({
      ...VALID,
      blindField: {
        ...VALID.blindField,
        blindStructure: [{ lv: 1, sb: 600, ante: 120, duration: 10 }],
      },
    })));
    render(<DisplayClient tournamentId="t1" />);
    expect(await screen.findByText('앤티 120')).toBeInTheDocument();
  });

  /**
   * **없으면 줄이 없다.** 「앤티 없음」을 적지 않는다 — 10m 밖에서 읽는
   * 화면에 없는 것을 알리는 줄이 자리를 먹는다.
   *
   * 0을 그대로 렌더하면 `{0 && ...}`가 화면에 `0`을 남긴다. React가 falsy
   * 중 `0`만 그리기 때문이고, `boolean`이던 시절에는 없던 함정이다.
   */
  it('앤티가 없으면 그 줄이 통째로 없다 — 0도 안 뜬다', async () => {
    server.use(http.get('*/playsync/dashboard/:id', () => HttpResponse.json(VALID)));
    render(<DisplayClient tournamentId="t1" />);
    await screen.findByText('350,000');
    expect(screen.queryByTestId('ante-current')).not.toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  /**
   * **분모가 엔트리다.** 프라이즈풀도 상금권 인원도 바이인 횟수에서
   * 파생되므로(T81), 그 자리에 사람 수가 있으면 "왜 저만큼인가"가 안 읽힌다.
   * 사람 수는 부제로 내린다 — 리바인이 없으면 둘이 같고, 있으면 갈린다.
   */
  it('엔트리를 크게, 사람 수를 부제로 그린다', async () => {
    server.use(http.get('*/playsync/dashboard/:id', () => HttpResponse.json({
      ...VALID,
      dashboard: { ...VALID.dashboard, entryCount: 21, totalPlayer: 16 },
    })));
    render(<DisplayClient tournamentId="t1" />);
    expect(await screen.findByText('엔트리')).toBeInTheDocument();
    expect(screen.getByTestId('entry-count')).toHaveTextContent('21');
    expect(screen.getByText('참가 16명')).toBeInTheDocument();
    // 「총 참가」는 사라졌다. 같은 자리에 두 이름이 있으면 어느 쪽이 분모인지 흐려진다.
    expect(screen.queryByText('총 참가')).not.toBeInTheDocument();
  });

  /**
   * **등록이 열려 있는 동안 상금은 미정이다.** 리바인이 들어올 때마다
   * 프라이즈풀이 커지고 구간이 바뀌면 상금권 인원도 는다 — 그 숫자를 확정된
   * 것처럼 그리면 참가자가 그 금액을 받을 것으로 읽는다.
   */
  it('등록이 열려 있으면 상금이 미정이라고 말한다', async () => {
    server.use(http.get('*/playsync/dashboard/:id', () => HttpResponse.json(VALID)));
    render(<DisplayClient tournamentId="t1" />);
    expect(await screen.findByText('마감 전 · 예상')).toBeInTheDocument();
  });

  it('마감되면 미정 표시가 걷힌다', async () => {
    server.use(http.get('*/playsync/dashboard/:id', () => HttpResponse.json({
      ...VALID,
      dashboard: { ...VALID.dashboard, isRegistrationOpen: false },
    })));
    render(<DisplayClient tournamentId="t1" />);
    await screen.findByText('350,000');
    expect(screen.queryByText('마감 전 · 예상')).not.toBeInTheDocument();
  });

  /**
   * **상금권이 늘면 한 줄에 안 들어간다.** 엔트리가 많은 대회는 아홉까지
   * 가는데, 줄바꿈하면 전광판의 다른 정보가 밀리고 자르면 뒤 등수가 영영
   * 안 보인다. 한 방향으로 흘려 전부 지나가게 한다.
   *
   * **넷까지는 안 흐른다.** 이유 없는 움직임은 읽는 사람이 눈으로 따라가게
   * 만든다.
   */
  it('상금권이 넷을 넘으면 목록이 흐른다', async () => {
    const prizes = Array.from({ length: 9 }, (_, i) => ({
      place: i + 1, percent: 10, amount: 1000 * (9 - i),
    }));
    server.use(http.get('*/playsync/dashboard/:id', () => HttpResponse.json({
      ...VALID,
      dashboard: { ...VALID.dashboard, isRegistrationOpen: false, itmCount: 9, prizes },
    })));
    render(<DisplayClient tournamentId="t1" />);
    expect(await screen.findByTestId('prize-flow')).toBeInTheDocument();
  });

  it('상금권이 넷 이하면 흐르지 않는다', async () => {
    const prizes = Array.from({ length: 4 }, (_, i) => ({
      place: i + 1, percent: 25, amount: 1000,
    }));
    server.use(http.get('*/playsync/dashboard/:id', () => HttpResponse.json({
      ...VALID,
      dashboard: { ...VALID.dashboard, isRegistrationOpen: false, itmCount: 4, prizes },
    })));
    render(<DisplayClient tournamentId="t1" />);
    await screen.findByText('1ST');
    expect(screen.queryByTestId('prize-flow')).not.toBeInTheDocument();
  });

  /**
   * T67 잔여. `poll`에 `try`/`catch`가 없어서 네트워크가 튈 때마다 처리되지
   * 않은 프라미스 거부가 샜다. 전광판은 하루 종일 켜 두는 화면이고 폴링이
   * 1초 주기라, 행사장 Wi-Fi가 흔들리는 동안 그만큼 쌓인다.
   *
   * 화면에 안내를 띄우지는 않는다 — 다음 주기가 낫게 하는 종류다. 그래서
   * 볼 수 있는 것이 "거부가 새어 나가지 않는가" 하나뿐이고, 그것을 본다.
   */
  it('폴링이 네트워크 실패로 거부돼도 처리되지 않은 거부가 새어 나가지 않는다', async () => {
    const leaked: unknown[] = [];
    const onUnhandled = (reason: unknown) => leaked.push(reason);
    process.on('unhandledRejection', onUnhandled);

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    vi.useFakeTimers();

    render(<DisplayClient tournamentId="t1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    });

    // 거부가 "처리되지 않았다"는 판정은 마이크로태스크 큐가 빈 뒤에
    // 내려간다. 진짜 타이머로 한 틱을 돌려 그 판정을 받는다.
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await new Promise((resolve) => setTimeout(resolve, 10));

    process.off('unhandledRejection', onUnhandled);
    expect(leaked).toEqual([]);
  });
});
