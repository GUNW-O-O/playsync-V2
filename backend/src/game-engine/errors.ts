export class NotYourTurnError extends Error {
  constructor(playerId: string) {
    super(`Player ${playerId} tried to act out of turn.`);
    this.name = "NotYourTurnError";
  }
}

export class InvalidActionError extends Error {
  constructor(playerId: string, action: string) {
    super(`Player ${playerId} performed invalid action: ${action}`);
    this.name = "InvalidActionError";
  }
}

export class InsufficientStackError extends Error {
  constructor(playerId: string, amount: number) {
    super(`Player ${playerId} has insufficient stack for amount: ${amount}`);
    this.name = "InsufficientStackError";
  }
}