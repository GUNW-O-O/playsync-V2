import { BlindField, Dashboard } from 'shared/types/tournamentMeta';
import { getCurrentBlindLevel, parseBlindStructure } from 'shared/util/util';
import { startablePayouts } from 'src/playsync/prize';

/**
 * 대회 메타(전광판 + 블라인드 시계)를 DB 행에서 짠다.
 *
 * 두 호출자가 있다. 대회 시작(`initializeGame`)은 기준점이 "지금"이고, 장애
 * 복구(`RecoveryService`)는 `Tournament.startedAt + pausedMs`다. 구성 자체는
 * 같아야 한다 — 갈라지면 복구된 대회의 전광판이 정상 대회와 다른 값을 보인다.
 *
 * `blindBaseAt`은 **Redis BlindField의 기준점**이고 DB `Tournament.startedAt`이
 * 아니다. 둘은 다른 뜻이다(T31 스펙 결정 1).
 */
/**
 * 이 함수가 읽는 것만 받는다. Prisma 모델 전체를 받지 않는 이유는 두 호출자의
 * `include`가 다를 수 있는데 이 함수는 둘 다에서 같은 필드만 쓰기 때문이다.
 */
export interface TournamentMetaSource {
  name: string;
  entryFee: number;
  startStack: number;
  isRegistrationOpen: boolean;
  totalPlayers: number;
  activePlayers: number;
  totalBuyinAmount: number;
  rebuyUntil: number;
  avgStack: number;
  itmCount: number;
  // Prisma의 Json 컬럼이라 타입이 JsonValue다. PrizePayout[]로 좁혀 선언하면
  // 실제 조회 결과(`{ ... } & { prizePayouts: JsonValue }`)가 구조적으로
  // 맞지 않아 두 호출자 모두에서 타입 에러가 난다 — 검증은 어차피
  // `startablePayouts`가 런타임에 한다.
  prizePayouts: unknown;
  blindStructure: { structure: unknown };
}

export function buildTournamentMeta(
  game: TournamentMetaSource,
  blindBaseAt: number,
): { dashboard: Dashboard; blindField: BlindField } {
  const blindStructure = parseBlindStructure(game.blindStructure.structure);
  const blindInfo = getCurrentBlindLevel(blindStructure, blindBaseAt);

  const dashboard: Dashboard = {
    isRegistrationOpen: game.isRegistrationOpen,
    totalPlayer: game.totalPlayers,
    activePlayer: game.activePlayers,
    // DB가 누적한 값을 그대로 쓴다. `entryFee * totalPlayers`로 다시 계산하면
    // 같은 금액을 두 방식으로 구하는 셈이라, 참가 경로가 하나라도 달라지면
    // 전광판과 지급이 어긋난다.
    totalBuyinAmount: game.totalBuyinAmount,
    rebuyUntil: game.rebuyUntil,
    avgStack: game.avgStack,
    entryFee: game.entryFee,
    tournamentName: game.name,
    startStack: game.startStack,
    itmCount: game.itmCount,
    prizePool: game.totalBuyinAmount,
    // 금액은 여기서 굳히지 않는다. Redis에서 읽을 때 그때의 풀로 파생된다 —
    // 리바인으로 풀이 커지면 전광판이 따라 올라야 하기 때문이다.
    prizes: startablePayouts(game.prizePayouts).map(p => ({ ...p, amount: 0 })),
  };
  const blindField: BlindField = {
    isBreak: blindInfo.isBreak,
    startedAt: blindBaseAt,
    currentBlindLv: blindInfo.currentIndex,
    nextLevelAt: blindInfo.nextLevelAt,
    serverTime: Date.now(),
    blindStructure,
  };

  return { dashboard, blindField };
}
