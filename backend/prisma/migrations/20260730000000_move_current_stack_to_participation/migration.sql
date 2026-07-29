-- currentStack을 좌석 배치표에서 장부로 옮긴다.
-- TablePlayer는 좌석을 뜨면 사라지는 행이라 칩이 거기 있으면 함께 사라진다.
ALTER TABLE "TournamentParticipation" ADD COLUMN "currentStack" INTEGER NOT NULL DEFAULT 0;

-- 이미 앉아 있는 사람의 스택을 옮긴다. 앉은 적 없는 참가자는 0으로 남는데,
-- 이사 후에는 결제가 startStack을 넣으므로 대회 중간 배포에서만 생긴다.
UPDATE "TournamentParticipation" p
   SET "currentStack" = t."currentStack"
  FROM "TablePlayer" t
 WHERE t."tournamentId" = p."tournamentId" AND t."userId" = p."userId";

ALTER TABLE "TablePlayer" DROP COLUMN "currentStack";
