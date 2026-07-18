import { BlindLevelDto } from "shared/dto/blind-structure.dto";

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