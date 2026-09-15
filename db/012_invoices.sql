CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('lodging','deposit')),
  invoice_number text NOT NULL CHECK (btrim(invoice_number) <> ''),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  issued_on date NOT NULL DEFAULT CURRENT_DATE,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reservation_id, kind)
);

CREATE UNIQUE INDEX IF NOT EXISTS invoices_number_normalized_idx
  ON invoices (lower(btrim(invoice_number)));

CREATE INDEX IF NOT EXISTS invoices_reservation_idx ON invoices(reservation_id);
CREATE INDEX IF NOT EXISTS invoices_issued_on_idx ON invoices(issued_on);
