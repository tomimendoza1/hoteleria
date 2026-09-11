ALTER TABLE payments ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'lodging';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS consumption_id uuid;
ALTER TABLE reservation_consumptions ADD COLUMN IF NOT EXISTS payment_id uuid;
DO $$ BEGIN
  ALTER TABLE payments ADD CONSTRAINT payments_category_check CHECK (category IN ('lodging','consumption','other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE payments ADD CONSTRAINT payments_consumption_fk FOREIGN KEY (consumption_id) REFERENCES reservation_consumptions(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE reservation_consumptions ADD CONSTRAINT consumptions_payment_fk FOREIGN KEY (payment_id) REFERENCES payments(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS payments_one_per_consumption_idx ON payments(consumption_id) WHERE consumption_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_reservation_category_idx ON payments(reservation_id,category);
