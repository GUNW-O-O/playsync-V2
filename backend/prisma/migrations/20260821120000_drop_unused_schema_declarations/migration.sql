-- T71 9-3. 스키마가 선언했는데 코드가 한 줄도 쓰지 않던 것들을 걷어낸다.
--
-- 넷 다 데이터가 없다. `SYNCING`과 `SIT_AND_GO`는 어디서도 대입하지 않았고,
-- `tableOrder`의 시퀀스는 모든 INSERT가 값을 명시해서 한 번도 돌지 않았다.

-- GameType.SIT_AND_GO 제거.
-- `Tournament.type`을 읽고 분기하는 코드가 없어서, 그 값으로 만든 대회가
-- TOURNAMENT와 완전히 같이 동작했다.
BEGIN;
CREATE TYPE "GameType_new" AS ENUM ('TOURNAMENT');
ALTER TABLE "Tournament" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "Tournament" ALTER COLUMN "type" TYPE "GameType_new" USING ("type"::text::"GameType_new");
ALTER TYPE "GameType" RENAME TO "GameType_old";
ALTER TYPE "GameType_new" RENAME TO "GameType";
DROP TYPE "GameType_old";
ALTER TABLE "Tournament" ALTER COLUMN "type" SET DEFAULT 'TOURNAMENT';
COMMIT;

-- TournamentStatus.SYNCING 제거.
-- 테이블 이동/밸런싱 대기 상태였는데, 자동 밸런싱은 이 도메인에 의도적으로
-- 없다(`docs/domain.md`). 대입한 적이 없으므로 옮길 행도 없다.
BEGIN;
CREATE TYPE "TournamentStatus_new" AS ENUM ('PENDING', 'ONGOING', 'FINISHED', 'CANCELLED');
ALTER TABLE "Tournament" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Tournament" ALTER COLUMN "status" TYPE "TournamentStatus_new" USING ("status"::text::"TournamentStatus_new");
ALTER TYPE "TournamentStatus" RENAME TO "TournamentStatus_old";
ALTER TYPE "TournamentStatus_new" RENAME TO "TournamentStatus";
DROP TYPE "TournamentStatus_old";
ALTER TABLE "Tournament" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- itmCount의 기본값을 prizePayouts와 맞춘다.
-- 3(상금권 세 자리)과 "[]"(분배율 없음)이 서로 모순이었다. 실제로는 모든
-- 쓰기가 `payouts.length`를 명시하므로 기본값이 쓰인 적은 없다.
ALTER TABLE "Tournament" ALTER COLUMN "itmCount" SET DEFAULT 0;

-- tableOrder의 전역 시퀀스 제거.
-- 번호는 대회 안에서만 뜻이 있다(`@@unique([tournamentId, tableOrder])`).
-- 명시 INSERT는 시퀀스를 밀지 않으므로, 기본값에 기대는 경로가 하나라도
-- 생기면 그 순간 P2002가 난다.
ALTER TABLE "Table" ALTER COLUMN "tableOrder" DROP DEFAULT;
DROP SEQUENCE "Table_tableOrder_seq";
