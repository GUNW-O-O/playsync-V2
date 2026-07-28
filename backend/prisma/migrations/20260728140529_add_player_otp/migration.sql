-- 1) 먼저 nullable로 붙인다
ALTER TABLE "TournamentParticipation" ADD COLUMN "playerOtp" TEXT;

-- 2) 기존 행을 대회 안에서 유일한 값으로 채운다.
--    난수가 아니라 순번이다 — 이미 있는 행은 개발·테스트 데이터뿐이고,
--    난수로 채우면 충돌 재시도를 SQL로 구현해야 한다.
UPDATE "TournamentParticipation" p
SET "playerOtp" = lpad(s.rn::text, 8, '0')
FROM (
  SELECT id, row_number() OVER (PARTITION BY "tournamentId" ORDER BY "createdAt") AS rn
  FROM "TournamentParticipation"
) s
WHERE p.id = s.id;

-- 3) 이제 NOT NULL로 조인다
ALTER TABLE "TournamentParticipation" ALTER COLUMN "playerOtp" SET NOT NULL;

-- 4) 대회 안 유일성. 입장이 (대회, OTP)로 사람을 찾으므로 겹치면 조회가
--    성립하지 않는다. 재시도 코드가 아니라 제약이 최종 방어다.
CREATE UNIQUE INDEX "TournamentParticipation_tournamentId_playerOtp_key"
  ON "TournamentParticipation"("tournamentId", "playerOtp");
