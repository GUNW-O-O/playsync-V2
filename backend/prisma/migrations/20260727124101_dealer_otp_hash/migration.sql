-- 기존 개발 DB의 평문 OTP는 해시로 옮길 방법이 없다. 개발 데이터라 버려도 문제되지 않는다.
TRUNCATE TABLE "Tournament" CASCADE;

-- AlterTable
ALTER TABLE "Tournament" DROP COLUMN "dealerOtp",
ADD COLUMN "dealerOtpHash" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "DealerSession" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
