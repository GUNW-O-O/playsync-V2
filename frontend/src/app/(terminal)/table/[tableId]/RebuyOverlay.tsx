'use client';

import ActionTimer from '@/component/ActionTimer';

export type RebuyPrompt = {
  deadline: number;
  // 서버(`rebuy.request.sent`)는 넷 다 채워 보낸다. 옵셔널로 두는 이유는
  // 방어일 뿐이다 — 여기서 죽으면 정작 필요한 "거절" 버튼까지 같이
  // 사라진다. 못 받은 필드는 문구를 생략할지언정 오버레이 자체는 뜬다.
  userPoints?: { points: number };
  entryFee?: number;
  tournamentName?: string;
};

/**
 * 칩이 0이 됐고 아직 리바인 구간일 때 화면을 덮는다(와이어프레임 846–881행).
 * 15초 안에 답해야 하고, 답하지 않으면 서버가 거절로 취급한다 — 여기서는
 * 그 타임아웃을 직접 재지 않는다. `ActionTimer`는 표시용이고, 진짜 마감은
 * 서버가 `deadline`이 지나면 `rebuy_res_${userId}`를 강제로 흘려보내는
 * 쪽에서 잰다.
 */
export default function RebuyOverlay({
  rebuyData,
  error,
  onRespond,
}: {
  rebuyData: RebuyPrompt;
  /**
   * 응답이 서버까지 가지 못했을 때의 문구(`SeatGameClient`의 `rebuyError`).
   * 팝업 **안에** 그린다 — 위에 모달을 얹으면 다시 눌러야 할 버튼을
   * 가리고, 이 실패의 유일한 해결이 "다시 누른다"이다.
   */
  error?: string | null;
  onRespond: (accept: boolean) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-tb-bg/90 p-6">
      <div className="w-full max-w-[430px] border border-tb-line bg-tb-panel p-6">
        <p className="text-xs tracking-[0.14em] text-tb-act">칩이 떨어졌습니다</p>
        <div className="mb-2.5 mt-2 text-xl font-light leading-snug text-tb-ink">
          {rebuyData.entryFee !== undefined
            ? `${rebuyData.entryFee.toLocaleString()} 포인트로 다시 칩을 받습니다`
            : '포인트로 다시 칩을 받습니다'}
        </div>
        {rebuyData.tournamentName && <div className="text-sm text-tb-muted">{rebuyData.tournamentName}</div>}

        <div className="mt-4 flex items-center justify-between text-xs">
          <span className="text-tb-sub">답하지 않으면 탈락합니다.</span>
          {rebuyData.userPoints && (
            <span className="text-tb-sub">보유 {rebuyData.userPoints.points.toLocaleString()}</span>
          )}
        </div>

        {error && (
          <p role="alert" data-testid="rebuy-error" className="mt-3 border border-err px-3 py-2 text-sm text-err">
            {error}
          </p>
        )}

        <div className="mt-3">
          <ActionTimer key={rebuyData.deadline} deadline={rebuyData.deadline} />
        </div>

        <div className="mt-5 flex gap-2.5">
          <button
            type="button"
            onClick={() => onRespond(false)}
            className="h-14 flex-1 border border-tb-line text-sm text-tb-muted"
          >
            거절
          </button>
          <button
            type="button"
            onClick={() => onRespond(true)}
            className="h-14 flex-1 border border-tb-act bg-tb-act text-sm font-semibold text-[#06201a]"
          >
            리바인
          </button>
        </div>
      </div>
    </div>
  );
}
