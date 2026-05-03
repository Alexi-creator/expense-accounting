/*
  Warnings:

  - Made the column `description` on table `expenses` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "expenses" ALTER COLUMN "description" SET NOT NULL;
