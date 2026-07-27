-- 기존 대회의 평문 OTP는 해시로 옮길 방법이 없다. 삭제하는 대신 **대응하는
-- 평문이 존재하지 않는** 값으로 채운다 — Task 4의 재발급 경로가 정식 값으로
-- 대체하도록 설계돼 있다. TournamentParticipation(참가비/상금 원장)까지 지우면
-- PointTransaction·User.points와 어긋나므로, 여기서는 어떤 행도 지우지 않는다.
--
-- 채우는 값은 bcrypt salt 자리가 base64가 아니라 hex 32자라 **형식 자체가
-- 유효하지 않다.** `bcrypt.compare`는 이런 값에 대해 예외 없이 false로
-- resolve하므로(확인함), 어떤 입력도 통과하지 못한다.
--
-- 리터럴 해시를 박지 않는 이유: 그 해시의 원문을 주석에 적으면 리포에 비밀번호를
-- 인쇄하는 것이 된다. 지금 그 원문이 닿지 못하는 근거는 DTO의 `^[0-9]{6}$`와
-- 전역 ValidationPipe뿐이라, OTP 형식이 완화되거나 파이프를 지나지 않는 호출자가
-- 하나 생기는 순간 모든 레거시 행이 공개된 값으로 열린다. gen_random_uuid()는
-- 원문이 애초에 존재하지 않고, 덤으로 행마다 값이 다르다.
-- AlterTable
ALTER TABLE "Tournament" DROP COLUMN "dealerOtp",
ADD COLUMN "dealerOtpHash" TEXT NOT NULL DEFAULT ('$2b$10$' || replace(gen_random_uuid()::text, '-', ''));

ALTER TABLE "Tournament" ALTER COLUMN "dealerOtpHash" DROP DEFAULT;

-- AlterTable
ALTER TABLE "DealerSession" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
