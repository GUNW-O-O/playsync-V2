-- 상금 분배율을 **구간표**로 바꾼다. 참가 규모에 따라 상금권 인원이 늘어난다.
--
-- 예전에는 `prizePayouts`가 대회 생성 시점에 박힌 배열이었고 `itmCount`가 그
-- 길이를 복사해 들고 있었다. 그래서 20명이 오든 200명이 오든 상금권이 같았고
-- 프라이즈풀만 커졌다. 그리고 같은 사실이 두 컬럼에 있어서 한쪽만 고쳐지는
-- 날이 올 수 있었다.
--
-- 새 컬럼 하나가 그 둘을 대신한다. 분배율도 상금권 인원도 엔트리 수에서
-- 파생된다(`payoutsFor`) — 굳히는 코드가 없다. 리바인은 등록 마감과 함께
-- 끝나므로 마감 뒤에는 걷은 총액이 불변이고, 따라서 파생값도 저절로 고정된다.
ALTER TABLE "Tournament" ADD COLUMN "payoutTable" JSONB NOT NULL DEFAULT '[]';

-- 기존 대회는 **구간 하나짜리 표**로 옮긴다. 뜻이 정확히 같다 — 엔트리 수와
-- 무관하게 늘 같은 분배율이다. 표현력이 같으므로 데이터가 하나도 안 바뀐다.
UPDATE "Tournament"
SET "payoutTable" = jsonb_build_array(
  jsonb_build_object('minEntries', 0, 'payouts', "prizePayouts")
)
WHERE jsonb_array_length("prizePayouts") > 0;

ALTER TABLE "Tournament" DROP COLUMN "prizePayouts";
ALTER TABLE "Tournament" DROP COLUMN "itmCount";
