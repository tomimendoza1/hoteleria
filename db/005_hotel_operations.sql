ALTER TABLE reservations ADD COLUMN IF NOT EXISTS invoice boolean NOT NULL DEFAULT false;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'other' CHECK (payment_method IN ('cash','transfer','debit','credit','booking','other'));
CREATE TABLE IF NOT EXISTS reservation_consumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reservation_id uuid NOT NULL REFERENCES reservations(id),
  description text NOT NULL, amount numeric(12,2) NOT NULL CHECK (amount > 0), consumed_on date NOT NULL DEFAULT CURRENT_DATE,
  charged_on date, method text NOT NULL DEFAULT 'other' CHECK (method IN ('cash','transfer','debit','credit','booking','other')),
  affects_stock boolean NOT NULL DEFAULT false, product_id uuid REFERENCES products(id), quantity numeric(12,3), created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reservation_consumptions_reservation_idx ON reservation_consumptions(reservation_id);
CREATE INDEX IF NOT EXISTS guests_search_idx ON guests(document, phone);
CREATE INDEX IF NOT EXISTS reservations_status_dates_idx ON reservations(status, checkin, checkout);
