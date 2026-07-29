import { IsInt, IsString, Matches, Max, Min } from 'class-validator';
import { PLAYER_OTP_LENGTH } from 'src/payment/player-otp';

export class EnterTournamentDto {
  // 길이만 재면 "abcdefgh"가 통과해 DB 조회까지 내려간다. 형식으로 막는다.
  @Matches(new RegExp(`^\\d{${PLAYER_OTP_LENGTH}}$`), {
    message: '참가 OTP 형식이 올바르지 않습니다.',
  })
  otp: string;

  @IsString()
  tableId: string;

  @IsInt()
  @Min(0)
  @Max(8)
  seatIndex: number;
}
