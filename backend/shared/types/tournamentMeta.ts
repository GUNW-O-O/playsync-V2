import { BlindLevelDto } from "shared/dto/blind-structure.dto";

/** 전광판에 뜨는 등수별 상금. 비율은 대회 생성 시 정해지고 금액은 파생된다. */
export interface PrizeRow {
  place: number,
  percent: number,
  amount: number,
}

export interface Dashboard {
  isRegistrationOpen: boolean,
  totalPlayer: number,
  activePlayer: number,
  totalBuyinAmount: number,
  rebuyUntil: number,
  avgStack: number,
  tournamentName: string,
  entryFee: number,
  startStack: number,
  itmCount: number,

  // 프라이즈풀은 걷은 참가비 총액(totalBuyinAmount)과 같다. 리바인이 들어올
  // 때마다 커지므로 전광판 숫자도 그 자리에서 따라 오른다.
  //
  // 지급의 진실은 DB다. 이 둘은 전광판용 파생값이라, 어긋나면 화면 숫자가
  // 틀리는 것이지 지급이 틀리는 것은 아니다.
  prizePool: number,
  prizes: PrizeRow[],
}

export interface BlindField {
  isBreak: boolean,
  startedAt: number,
  currentBlindLv: number,
  nextLevelAt: number,
  serverTime: number,
  blindStructure: BlindLevelDto[],
}

export interface FullTournamentInfo {
  dashboard: Dashboard,
  blindField: BlindField,
}