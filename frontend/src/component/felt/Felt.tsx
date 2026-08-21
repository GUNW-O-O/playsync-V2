'use client';

import { TableState } from '@playsync/contract';
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

/**
 * 좌석의 시각 상태.
 *
 * 와이어프레임(253–262행)은 찬 자리를 `background: --tb-panel`(#191d20),
 * 빈 자리를 `border-style: dashed`로만 갈랐다. 펠트가 #123b33이라 **어두운
 * 채움끼리는 서로 구별되지 않고**, 남는 신호가 1px 점선 하나였다. 팔 길이에서
 * 안 읽혔다 — 자리가 차고 사람이 빠지는 것이 이 화면이 보여줄 전부인데.
 *
 * 그래서 신호를 **테두리 밝기**로 옮긴다. #9aa4a8은 펠트 위에서 멀리서도
 * 선으로 읽히고, 빈 자리는 거의 안 보이는 윤곽만 남는다.
 *
 * 굵기는 상태와 무관하게 2px로 고정한다. 굵기가 바뀌면 상태가 바뀔 때마다
 * 판이 1px씩 움직이고, 그 흔들림이 영상에 그대로 남는다.
 */
const SEAT_HAIRLINE_DIM = 'border-[rgba(238,242,243,0.16)]';

const SEAT_STATE_CLASS: Record<SeatVisualState, string> = {
  empty: `border-dashed ${SEAT_HAIRLINE_DIM} bg-transparent text-tb-sub`,
  idle: 'border-tb-muted bg-tb-panel text-tb-ink',
  me: 'border-tb-act bg-[#16302a] text-tb-act',
  turn: 'border-warn bg-tb-panel text-tb-ink shadow-[0_0_0_3px_rgba(241,194,27,0.32)]',
  // 폴드는 게임에서 빠진 것이지 자리가 빈 것이 아니다. 테두리를 죽이고
  // 채움은 남겨 둔다 — 빈 자리와 달리 여전히 판이 거기 있다.
  folded: `${SEAT_HAIRLINE_DIM} bg-tb-panel text-tb-muted opacity-45`,
  allin: 'border-warn bg-tb-panel text-tb-ink',
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
        {/*
          사람 딜러가 서 있는 자리. 좌석 아홉이 **딜러를 12시로 놓고** 도는
          배치라(`seatPosition`) 이 표찰이 곧 화면의 방향이다. 자리만 비워
          두고 그리지 않아서, 화면만 보고는 어느 쪽이 딜러인지 알 수 없었다.

          딜러 화면에서는 좌석이 180° 돌아 자기 자리가 아래로 오므로 표찰도
          같이 내려간다 — 눈앞의 배치와 겹쳐야 하기 때문이다.
        */}
        <div
          data-testid="felt-dealer-mark"
          className={`absolute left-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap border border-tb-line bg-tb-panel px-2.5 py-0.5 text-[10px] tracking-[0.14em] text-tb-muted ${
            orientation === 'dealer' ? 'top-[97%]' : 'top-[3%]'
          }`}
        >
          딜러
        </div>

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
          {/*
            칩이 디지털이고 화면이 유일한 장부다. 매 핸드 스택에서 앤티가
            빠지는데 왜 빠졌는지 화면에 없으면 참가자가 확인할 방법이 없고,
            딜러도 이 대회에 앤티가 붙는지 화면으로는 모른다(T58).

            state.ante는 이미 금액이다(0이면 없음) — DealerService.startPreFlop이
            deriveAnteAmount로 채운 값을 그대로 받아 그린다. sb / 5를 여기서
            다시 계산하지 않는다.
          */}
          <div data-testid="ante" className="font-mono text-[11px] text-tb-muted">
            앤티 {state && state.ante > 0 ? state.ante.toLocaleString() : '없음'}
          </div>
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
              className={`absolute w-20 border-2 px-3 py-2 text-left ${SEAT_STATE_CLASS[visualState]}`}
              style={seatPosition(seatIndex, orientation)}
            >
              {/*
                빈 자리는 **글자를 지운다.** "빈 자리"와 "—"를 적어 두면 빈
                자리가 찬 자리와 같은 덩어리를 차지해서, 테두리를 아무리
                고쳐도 멀리서는 아홉 개의 같은 상자로 보인다. 없음은 비어
                보여야 한다.
              */}
              {player ? (
                <>
                  <span className="block font-mono text-xs text-tb-sub">{seatIndex + 1}</span>
                  <span className="block truncate text-sm font-semibold">{player.nickname}</span>
                  <span className="block font-mono text-sm">
                    {player.stack.toLocaleString()}
                    {player.isAllIn ? ' · 올인' : ''}
                  </span>
                </>
              ) : (
                <span className="block text-center font-mono text-sm">{seatIndex + 1}</span>
              )}
              {/*
                버튼은 **`state.buttonUser`에서 나온다.** 엔진이 옮기는 것이
                그 하나뿐이다. 예전에는 손으로 복사한 프론트 타입에
                `player.button`이 있었고, 그걸 믿으면 버튼이 어느 자리에도 안
                붙었다 — 촬영본에 한 번도 안 나왔던 이유다. 지금은 타입이
                `@playsync/contract`에서 오므로 그 필드가 존재하지 않는다(T71).
              */}
              {player && state?.buttonUser === seatIndex && (
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
 *
 * **자리를 소수 넷째 자리에서 끊는다.** 끊지 않으면 하이드레이션이 어긋난다 —
 * 서버가 `left: 28.404308111849023%`를 HTML에 쓰면 브라우저 CSSOM이 유효숫자
 * 여섯 자리(`28.4043%`)로 줄여 저장하는데, 클라이언트의 React는 자기가 다시
 * 계산한 긴 값과 그 줄어든 값을 비교하고 불일치로 판정한다. 좌석 아홉 × 펠트가
 * 있는 모든 화면에서 매번 났다.
 *
 * 넷째 자리면 1280px 기준 0.0013px이라 화면에는 아무 차이가 없다.
 */
const SEAT_POS_DECIMALS = 4;

function seatPosition(seatIndex: number, orientation: FeltOrientation): React.CSSProperties {
  const baseAngleDeg = 28 + 38 * seatIndex;
  const angleDeg = orientation === 'dealer' ? baseAngleDeg + 180 : baseAngleDeg;
  const angleRad = (angleDeg * Math.PI) / 180;
  const RX = 46;
  const RY = 45;
  return {
    left: `${(50 + RX * Math.sin(angleRad)).toFixed(SEAT_POS_DECIMALS)}%`,
    top: `${(50 - RY * Math.cos(angleRad)).toFixed(SEAT_POS_DECIMALS)}%`,
    transform: 'translate(-50%, -50%)',
  };
}
