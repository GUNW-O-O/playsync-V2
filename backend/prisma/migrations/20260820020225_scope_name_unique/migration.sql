-- 이름 유니크를 전역에서 스코프로 좁힌다.
--
-- `Store.name`은 소유자 안에서만, `BlindStructure.name`은 상점 안에서만
-- 유일하면 된다. 전역 유니크였을 때는 다른 테넌트가 먼저 쓴 이름을 다시
-- 못 써서 두 번째 상점의 `POST /store/sessions`가 P2002로 500이 났고,
-- 그 실패로 다른 테넌트가 어떤 이름을 쓰는지 떠볼 수 있었다.
--
-- 전역 → 스코프는 제약을 느슨하게 하는 방향이라 기존 행이 위반할 수 없다.

-- DropIndex
DROP INDEX "BlindStructure_name_key";

-- DropIndex
DROP INDEX "Store_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "BlindStructure_storeId_name_key" ON "BlindStructure"("storeId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Store_ownerId_name_key" ON "Store"("ownerId", "name");
