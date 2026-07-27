-- 기존 대회의 평문 OTP는 해시로 옮길 방법이 없다. 삭제하는 대신 아무도 맞힐 수
-- 없는 더미 해시('000000-legacy-unusable'의 bcrypt)로 채운다 — Task 4의
-- 재발급 경로가 정식 값으로 대체하도록 설계돼 있다. TournamentParticipation
-- (참가비/상금 원장)까지 지우면 PointTransaction·User.points와 어긋나므로,
-- 여기서는 어떤 행도 지우지 않는다.
-- AlterTable
ALTER TABLE "Tournament" DROP COLUMN "dealerOtp",
ADD COLUMN "dealerOtpHash" TEXT NOT NULL DEFAULT '$2b$10$dxw3JKPpaajoMt219TyVHehMdKybGjDPfK1gpaELi0UJF0sVcMXlK';

ALTER TABLE "Tournament" ALTER COLUMN "dealerOtpHash" DROP DEFAULT;

-- AlterTable
ALTER TABLE "DealerSession" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
