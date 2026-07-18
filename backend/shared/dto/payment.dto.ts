import { IsInt, IsString, Max, Min } from "class-validator";

export class PayMentDto {

  @IsString()
  tournamentId: string;

  @IsString()
  tableId: string;

  @IsInt()
  @Min(0)
  @Max(8)
  seatIndex: number;

}

export class RebuyDto {

  @IsString()
  tableId: string;

}