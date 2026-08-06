'use client';

import { useState } from 'react';

export type WinnerCandidate = {
  id: string;
  nickname: string;
  hasFolded: boolean;
  seatIndex?: number;
};

/**
 * 승자 결정 오버레이(와이어프레임 1046–1102행). 시스템이 정답을 계산하지
 * 않는 유일한 입력이다 — 딜러가 실물 카드를 보고 이긴 순서대로 자리를
 * 누른다.
 *
 * 승자는 동점 그룹의 배열(`string[][]`)로 모은다. 순서가 곧 순위이고,
 * 한 그룹 안의 여럿은 공동 순위다. 평면 배열이 아닌 이유는 보드 하이 —
 * 커뮤니티 카드가 그대로 모두의 최고 핸드가 되면 살아남은 전원이 팟을
 * 나눠 갖는데, 순위 배열로는 그걸 표현할 방법이 없다(`dealer-action.ts`
 * 주석). 서버에 별도 엔드포인트를 만들지 않는다 — 돈이 나가는 경로는
 * 하나여야 한다.
 */
export default function WinnerOverlay({
  players,
  onSubmit,
  onCancel,
}: {
  players: WinnerCandidate[];
  onSubmit: (winnerGroups: string[][]) => void;
  onCancel: () => void;
}) {
  // 마지막 원소가 지금 채우는 그룹이다. 자리를 누르면 여기에 쌓인다.
  const [groups, setGroups] = useState<string[][]>([[]]);

  const pickedIds = new Set(groups.flat());
  const currentGroup = groups[groups.length - 1];
  const canSubmit = groups.some((g) => g.length > 0);

  function pick(id: string) {
    setGroups((prev) => {
      const next = prev.map((g) => [...g]);
      next[next.length - 1] = [...next[next.length - 1], id];
      return next;
    });
  }

  function nextRank() {
    setGroups((prev) => (prev[prev.length - 1].length === 0 ? prev : [...prev, []]));
  }

  function undo() {
    setGroups((prev) => {
      const next = prev.map((g) => [...g]);
      const last = next[next.length - 1];
      if (last.length > 0) {
        last.pop();
        return next;
      }
      if (next.length > 1) {
        next.pop();
      }
      return next;
    });
  }

  // 보드 하이는 별도 엔드포인트가 아니라, 폴드하지 않은 전원을 한 그룹으로
  // 채워 같은 RESOLVE_WINNERS 명령으로 보낸다.
  function boardHigh() {
    onSubmit([players.filter((p) => !p.hasFolded).map((p) => p.id)]);
  }

  function submit() {
    const finalGroups = groups.filter((g) => g.length > 0);
    if (finalGroups.length === 0) return;
    onSubmit(finalGroups);
  }

  function nameOf(id: string) {
    const player = players.find((p) => p.id === id);
    if (!player) return id;
    return player.seatIndex !== undefined ? `${player.seatIndex + 1}번 · ${player.nickname}` : player.nickname;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-tb-bg/90 p-6">
      <div className="w-full max-w-[560px] border border-tb-line bg-tb-panel p-6">
        <p className="text-xs tracking-[0.14em] text-tb-act">승자 결정</p>
        <div className="mb-1.5 mt-2 text-xl font-light leading-snug text-tb-ink">
          이긴 순서대로 자리를 누르세요
        </div>
        <p className="text-sm text-tb-muted">
          같이 이겼으면 한 줄에 같이 넣습니다. 넣지 않은 사람은 순위가 없습니다.
        </p>

        <div className="mt-5 flex flex-col gap-2">
          {groups.map((group, i) => (
            <div
              key={i}
              className="flex flex-wrap items-center gap-2 border border-dashed border-tb-line px-3 py-2"
            >
              <span className="text-xs text-tb-act">{i + 1}위</span>
              {group.length === 0 ? (
                <span className="text-xs italic text-tb-sub">자리를 누르세요</span>
              ) : (
                group.map((id) => (
                  <span key={id} className="text-sm text-tb-ink">
                    {nameOf(id)}
                  </span>
                ))
              )}
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {players.map((p) => (
            <button
              key={p.id}
              type="button"
              data-testid={`winner-pick-${p.id}`}
              disabled={p.hasFolded || pickedIds.has(p.id)}
              onClick={() => pick(p.id)}
              className="rounded border border-tb-line bg-tb-bg px-3 py-2 text-sm text-tb-ink disabled:opacity-30"
            >
              {nameOf(p.id)}
            </button>
          ))}
        </div>

        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={nextRank}
            disabled={currentGroup.length === 0}
            className="rounded border border-tb-line px-3 py-1.5 text-xs text-tb-muted disabled:opacity-30"
          >
            다음 순위
          </button>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-tb-line pt-4">
          <div>
            <button
              type="button"
              onClick={boardHigh}
              className="rounded border border-tb-line px-3 py-2 text-sm text-tb-muted"
            >
              보드 하이
            </button>
            <p className="mt-1.5 max-w-[30ch] text-xs text-tb-sub">남은 전원이 똑같이 나눠 갖습니다</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={undo}
              className="rounded border border-tb-line px-3 py-2 text-sm text-tb-muted"
            >
              되돌리기
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-tb-line px-3 py-2 text-sm text-tb-muted"
            >
              취소
            </button>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={submit}
              className="rounded border border-tb-act bg-tb-act px-4 py-2 text-sm font-semibold text-[#06201a] disabled:opacity-40"
            >
              배분
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
