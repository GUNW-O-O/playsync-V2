export interface DashboardData {
  dashboard: {
    isRegistrationOpen: boolean;
    totalPlayer: number;
    activePlayer: number;
    totalBuyinAmount: number;
    rebuyUntil: number;
    avgStack: number;
  };
  blindField: {
    isBreak: boolean;
    startedAt: number;
    currentBlindLv: number;
    nextLevelAt: number;
    serverTime: number;
    blindStructure: any[];
  };
}
