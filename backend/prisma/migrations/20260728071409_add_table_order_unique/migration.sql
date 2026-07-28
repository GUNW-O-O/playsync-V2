-- 번호는 물리 테이블을 가리킨다. 겹치면 딜러와 전광판이 서로 다른 테이블을
-- 같은 번호로 부른다. tableOrder를 트랜잭션 밖에서 세면 동시 호출이 같은
-- 값을 읽을 수 있으므로, 재시도 코드가 아니라 제약으로 막는다.
-- CreateIndex
CREATE UNIQUE INDEX "Table_tournamentId_tableOrder_key" ON "Table"("tournamentId", "tableOrder");
