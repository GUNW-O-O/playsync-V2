-- 좌석은 대회 안에서 하나다. 기존 두 제약(tableId+seatPosition, tableId+userId)은
-- 테이블이 다르면 못 막는다 — 같은 참가 OTP를 두 테이블에서 동시에 입력하는
-- 경합이 그 틈을 뚫는다(T28 리뷰 finding 1). tournamentId가 nullable이라
-- Postgres는 그 값이 NULL인 행끼리는 이 제약으로 묶지 않는다: 현재 모든 쓰기
-- 경로가 tournamentId를 채우므로 살아 있는 참가에는 문제가 없고, NULL은
-- 대회 삭제 시 ON DELETE SET NULL이 남기는 죽은 행뿐이다.
-- CreateIndex
CREATE UNIQUE INDEX "TablePlayer_tournamentId_userId_key" ON "TablePlayer"("tournamentId", "userId");
