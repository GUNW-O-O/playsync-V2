-- AlterTable
ALTER TABLE "Table" ADD COLUMN     "buttonUser" INTEGER;

-- AlterTable
ALTER TABLE "Tournament" ADD COLUMN     "pausedMs" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ServerHeartbeat" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "beatAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerHeartbeat_pkey" PRIMARY KEY ("id")
);

