import { IsString } from "class-validator";

export class PayMentDto {

  @IsString()
  tournamentId: string;

}

export class RebuyDto {

  @IsString()
  tableId: string;

}