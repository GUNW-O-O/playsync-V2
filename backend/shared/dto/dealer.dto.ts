import { IsString, Matches } from "class-validator";

export class DealerDto {

  @IsString()
  tournamentId: string;

  @IsString()
  tableId: string;

  // 앞자리 0이 유효한 값이므로 숫자로 받으면 안 된다.
  @Matches(/^[0-9]{6}$/, { message: 'OTP는 6자리 숫자입니다.' })
  otp: string;

}
