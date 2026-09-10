-- CreateTable
CREATE TABLE "currency_exchanges" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "from_currency" TEXT NOT NULL,
    "from_amount" DECIMAL(12,2) NOT NULL,
    "to_currency" TEXT NOT NULL,
    "to_amount" DECIMAL(12,2) NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "currency_exchanges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "currency_exchanges_user_id_date_idx" ON "currency_exchanges"("user_id", "date");

-- AddForeignKey
ALTER TABLE "currency_exchanges" ADD CONSTRAINT "currency_exchanges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
