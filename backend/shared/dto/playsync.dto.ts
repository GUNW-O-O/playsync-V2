import { ActionType } from "src/game-engine/types";

export class PlayerActionDto {
  action: ActionType;
  amount?: number;
}