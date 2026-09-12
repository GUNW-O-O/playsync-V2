-- T96: 서버 복구 중 상태를 되살리고, 정지 시작 시각을 둔다.
-- T71(20260821120000)이 지운 값이다. 이제 대입하는 자리가 있다.
ALTER TYPE "TournamentStatus" ADD VALUE 'SYNCING' AFTER 'ONGOING';
ALTER TABLE "Tournament" ADD COLUMN "pausedAt" TIMESTAMP(3);
