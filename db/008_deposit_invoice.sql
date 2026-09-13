ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS deposit_invoice boolean NOT NULL DEFAULT false;
