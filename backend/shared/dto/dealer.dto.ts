import { IsInt, IsString } from "class-validator";

export class DealerDto {

  @IsString()
  tournamentId: string;

  @IsString()
  tableId: string;

  @IsInt()
  otp: number;

}