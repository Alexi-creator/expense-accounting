/*
  Warnings:

  - Made the column `category_id` on table `expenses` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "expenses" ALTER COLUMN "category_id" SET NOT NULL;
