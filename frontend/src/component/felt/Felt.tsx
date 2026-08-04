'use client';

import { TableState } from '@/app/types/game';
import { seatOrder, type FeltOrientation } from './seatOrder';

/** 페이즈가 곧 깔린 카드 장수다. 무늬는 서버에 없고 앞으로도 없다. */
const BOARD_COUNT: Record<number, number> = { 0: 0, 1: 0, 2: 3, 3: 4, 4: 5, 5: 5, 6: 5 };

/** 좌석 카드의 시각 상태. 와이어프레임 `.seat[data-state]`와 짝을 맞춘다. */
type SeatVisualState = 'empty' | 'me' | 'turn' | 'folded' | 'allin' | 'idle';

function seatState(
  player: TableState['players'][number],
  seatIndex: number,
  state: TableState,
  mySeatIndex: number | null,
): SeatVisualState {
  if (!player) return 'empty';
  if (seatIndex === mySeatIndex) return 'me';
  if (seatIndex === state.currentTurnSeatIndex) return 'turn';
  if (player.hasFolded) return 'folded';
  if (player.isAllIn) return 'allin';
  return 'idle';
}

const SEAT_STATE_CLASS: Record<SeatVisualState, string> = {
  empty: 'border-dashed border-tb-line bg-transparent text-tb-sub',
  me: 'border-tb-act bg-[#16302a] text-tb-act',
  turn: 'border-warn shadow-[0_0_0_2px_rgba(241,194,27,0.28)] text-tb-ink',
  folded: 'border-tb-line bg-tb-panel text-tb-ink opacity-[0.34]',
  allin: 'border-warn bg-tb-panel text-tb-ink',
  idle: 'border-tb-line bg-tb-panel text-tb-ink',
};

export default function Felt({
  state,
  orientation,
  mySeatIndex,
  onSeatClick,
}: {
  state: TableState | null;
  orientation: FeltOrientation;
  mySeatIndex: number | null;
  onSeatClick?: (seatIndex: number) => void;
}) {
  const dealt = BOARD_COUNT[state?.phase ?? 0] ?? 0;

  return (
    <div className="relative h-full w-full bg-felt-rail p-[2%]">
      <div className="relative h-full w-full rounded-full border-4 border-felt-edge bg-felt">
        {/* 팟 — 사이드팟이 있으면 그 아래에 함께 보여준다 */}
        <div
          data-testid="pot"
          className="absolute left-1/2 top-[24%] -translate-x-1/2 -translate-y-1/2 text-center"
        >
          <div className="text-[9.5px] tracking-[0.14em] text-tb-act">팟</div>
          <div className="font-mono text-2xl font-light text-tb-ink">
            {(state?.pot ?? 0).toLocaleString()}
          </div>
          {state?.sidePots.map((sidePot, i) => (
            <div key={i} data-testid={`side-pot-${i}`} className="font-mono text-xs text-tb-muted">
              사이드팟 {i + 1} · {sidePot.amount.toLocaleString()}
            </div>
          ))}
        </div>

        {/* 보드 — 장수만 보여준다 */}
        <div className="absolute left-1/2 top-[56%] flex -translate-x-1/2 -translate-y-1/2 gap-2">
          {Array.from({ length: 5 }, (_, i) => (
            <div
              key={i}
              data-testid={`board-card-${i}`}
              data-dealt={i < dealt}
              className={
                i < dealt
                  ? 'h-14 w-10 rounded bg-card-face'
                  : 'h-14 w-10 rounded border border-dashed border-tb-sub'
              }
            />
          ))}
        </div>

        {/* 좌석 아홉 */}
        {seatOrder(orientation).map((seatIndex) => {
          const player = state?.players[seatIndex] ?? null;
          const visualState = state
            ? seatState(player, seatIndex, state, mySeatIndex)
            : player
              ? 'idle'
              : 'empty';
          return (
            <button
              key={seatIndex}
              type="button"
              data-testid={`seat-${seatIndex}`}
              data-state={visualState}
              data-me={seatIndex === mySeatIndex}
              disabled={!onSeatClick}
              onClick={() => onSeatClick?.(seatIndex)}
              className={`absolute w-20 rounded border px-3 py-2 text-left ${SEAT_STATE_CLASS[visualState]}`}
              style={seatPosition(seatIndex, orientation)}
            >
              <span className="block font-mono text-xs text-tb-sub">{seatIndex + 1}</span>
              <span className="block truncate text-sm">{player?.nickname ?? '빈 자리'}</span>
              <span className="block font-mono text-sm">
                {player ? `${player.stack.toLocaleString()}${player.isAllIn ? ' · 올인' : ''}` : '—'}
              </span>
              {player?.button && (
                <span
                  data-testid={`seat-${seatIndex}-button`}
                  className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-[#f4f4f4] font-mono text-[9px] font-bold text-[#161616]"
                >
                  D
                </span>
              )}
              {player && player.bet > 0 && (
                <span
                  data-testid={`seat-${seatIndex}-bet`}
                  className="absolute bottom-[-17px] left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[10px] text-warn"
                >
                  {player.bet.toLocaleString()}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 좌석 아홉은 딜러(위쪽 12시)를 기준으로 28°에서 시작해 38° 간격으로
 * 시계방향으로 놓인다 — 딜러 표찰이 들어갈 자리를 12시 근처에 남겨 둔다
 * (와이어프레임 761–763행). 각도는 좌석 번호(seatIndex)에 고정된 물리적
 * 값이고, `dealer` 화면은 **좌석 순서가 아니라 각도 자체를 180° 돌려**
 * 그린다 — 같은 테이블을 반대편에서 보는 것이므로, 참가자 화면의 (x, y)가
 * 딜러 화면에서는 정확히 (100-x, 100-y)가 된다(와이어프레임 973–974행 주석).
 *
 * 반지름(46 / 45)과 시작각(28°)·간격(38°)은 와이어프레임의 실측 좌표
 * (예: 1번 자리 left:71.6% top:10.3%)를 역산해 맞춘 값이다.
 */
function seatPosition(seatIndex: number, orientation: FeltOrientation): React.CSSProperties {
  const baseAngleDeg = 28 + 38 * seatIndex;
  const angleDeg = orientation === 'dealer' ? baseAngleDeg + 180 : baseAngleDeg;
  const angleRad = (angleDeg * Math.PI) / 180;
  const RX = 46;
  const RY = 45;
  return {
    left: `${50 + RX * Math.sin(angleRad)}%`,
    top: `${50 - RY * Math.cos(angleRad)}%`,
    transform: 'translate(-50%, -50%)',
  };
}
