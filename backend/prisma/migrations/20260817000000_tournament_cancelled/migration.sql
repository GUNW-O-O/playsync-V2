-- 취소 상태를 추가한다. 시작 전에 닫고 참가비를 전액 환불한 대회다.
--
-- FINISHED와 섞지 않는 이유는 스키마 주석에 있다 — FINISHED는 정산 게이트를
-- 통과했다는 뜻이고, 취소는 그 게이트를 지나지 않는다.
--
-- ALTER TYPE ... ADD VALUE는 PostgreSQL 12부터 트랜잭션 안에서 돌 수 있다.
-- 다만 추가한 값을 같은 트랜잭션에서 쓸 수는 없는데, 이 마이그레이션은
-- 값을 쓰지 않으므로 걸리지 않는다.
ALTER TYPE "TournamentStatus" ADD VALUE 'CANCELLED';
