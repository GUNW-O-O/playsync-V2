export enum GamePhase {
  WAITING,
  PRE_FLOP,
  FLOP,
  TURN,
  RIVER,
  SHOWDOWN,
  HAND_END
}

// ActionType은 여기 있었지만 @playsync/contract로 옮겼다.
//
// 프론트가 직접 정의하면 백엔드와 따로 움직인다. 실제로 그동안 양쪽이 각자
// 숫자 enum을 들고 있었고, 어느 쪽 순서가 바뀌어도 컴파일은 통과하지만
// 와이어에서는 다른 액션이 되는 상태였다.
//
// 클라이언트가 보낼 수 있는 것은 PlayerActionType이 전부다. TIME_OUT과
// DEALER_*는 서버 내부에서만 만들어지므로 contract에 존재하지 않는다.

export interface TablePlayer {
  id: string;
  tableId: string;
  nickname: string;
  seatIndex: number;
  stack: number;
  bet: number;
  hasFolded: boolean;
  isAllIn: boolean;
  button: boolean;
  totalContributed: number;
}

export interface TableState {
  phase: GamePhase;
  players: (TablePlayer | null)[];
  buttonUser: number;
  currentTurnSeatIndex: number;
  pot: number;
  sidePots: SidePot[];
  currentBet: number;
  smallBlind: number;
  ante: boolean;
  actionDeadline?: number;
  tournamentId: string;
}

export interface SidePot {
  amount: number;
  relevantPlayerIds: string[];
}