-- CreateTable
CREATE TABLE "fx_rates" (
    "date" DATE NOT NULL,
    "currency" TEXT NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("date","currency")
);

-- CreateIndex
CREATE INDEX "fx_rates_currency_date_idx" ON "fx_rates"("currency", "date");
