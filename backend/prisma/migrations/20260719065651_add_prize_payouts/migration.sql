/*
  Warnings:

  - Made the column `dealerOtp` on table `Tournament` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Tournament" ADD COLUMN     "prizePayouts" JSONB NOT NULL DEFAULT '[]',
ALTER COLUMN "dealerOtp" SET NOT NULL;
