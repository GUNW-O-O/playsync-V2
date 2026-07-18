-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'DEALER', 'STORE_ADMIN', 'PLATFORM_ADMIN');

-- CreateEnum
CREATE TYPE "GameType" AS ENUM ('TOURNAMENT', 'SIT_AND_GO');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('CHARGE', 'BUY_IN', 'REBUY', 'PRIZE', 'REFUND');

-- CreateEnum
CREATE TYPE "TournamentStatus" AS ENUM ('PENDING', 'ONGOING', 'SYNCING', 'FINISHED');

-- CreateEnum
CREATE TYPE "PlayerStatus" AS ENUM ('WAITING', 'PLAYING', 'ELIMINATED', 'AWARDED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "type" "TransactionType" NOT NULL,
    "tournamentId" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlindStructure" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "structure" JSONB NOT NULL,
    "storeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlindStructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tournament" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "GameType" NOT NULL DEFAULT 'TOURNAMENT',
    "status" "TournamentStatus" NOT NULL DEFAULT 'PENDING',
    "blindId" TEXT NOT NULL,
    "entryFee" INTEGER NOT NULL DEFAULT 0,
    "startStack" INTEGER NOT NULL DEFAULT 0,
    "itmCount" INTEGER NOT NULL DEFAULT 3,
    "rebuyUntil" INTEGER NOT NULL DEFAULT 0,
    "isRegistrationOpen" BOOLEAN NOT NULL DEFAULT true,
    "totalBuyinAmount" INTEGER NOT NULL DEFAULT 0,
    "activePlayers" INTEGER NOT NULL DEFAULT 0,
    "totalPlayers" INTEGER NOT NULL DEFAULT 0,
    "avgStack" INTEGER NOT NULL DEFAULT 0,
    "dealerOtp" INTEGER,
    "storeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Tournament_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Table" (
    "id" TEXT NOT NULL,
    "tableOrder" SERIAL NOT NULL,
    "dealerId" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,

    CONSTRAINT "Table_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TablePlayer" (
    "id" TEXT NOT NULL,
    "nickname" TEXT,
    "tableId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seatPosition" INTEGER NOT NULL,
    "currentStack" INTEGER NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tournamentId" TEXT,

    CONSTRAINT "TablePlayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentParticipation" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "PlayerStatus" NOT NULL DEFAULT 'WAITING',
    "buyInCount" INTEGER NOT NULL DEFAULT 1,
    "finalPlace" INTEGER,
    "prizeAmount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TournamentParticipation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealerSession" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,

    CONSTRAINT "DealerSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_nickname_key" ON "User"("nickname");

-- CreateIndex
CREATE UNIQUE INDEX "Store_name_key" ON "Store"("name");

-- CreateIndex
CREATE UNIQUE INDEX "BlindStructure_name_key" ON "BlindStructure"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Table_tournamentId_id_key" ON "Table"("tournamentId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TablePlayer_tableId_seatPosition_key" ON "TablePlayer"("tableId", "seatPosition");

-- CreateIndex
CREATE UNIQUE INDEX "TablePlayer_tableId_userId_key" ON "TablePlayer"("tableId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentParticipation_tournamentId_userId_key" ON "TournamentParticipation"("tournamentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "DealerSession_tournamentId_key" ON "DealerSession"("tournamentId");

-- AddForeignKey
ALTER TABLE "PointTransaction" ADD CONSTRAINT "PointTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlindStructure" ADD CONSTRAINT "BlindStructure_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_blindId_fkey" FOREIGN KEY ("blindId") REFERENCES "BlindStructure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Table" ADD CONSTRAINT "Table_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "DealerSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Table" ADD CONSTRAINT "Table_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TablePlayer" ADD CONSTRAINT "TablePlayer_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TablePlayer" ADD CONSTRAINT "TablePlayer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TablePlayer" ADD CONSTRAINT "TablePlayer_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentParticipation" ADD CONSTRAINT "TournamentParticipation_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentParticipation" ADD CONSTRAINT "TournamentParticipation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerSession" ADD CONSTRAINT "DealerSession_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;
