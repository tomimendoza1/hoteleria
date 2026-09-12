CREATE TABLE IF NOT EXISTS room_rate_calendar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id),
  rate_date date NOT NULL,
  prices jsonb NOT NULL DEFAULT '{}'::jsonb,
  min_stay integer NOT NULL DEFAULT 1 CHECK (min_stay > 0),
  closed boolean NOT NULL DEFAULT false,
  special_label text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, rate_date)
);
CREATE INDEX IF NOT EXISTS room_rate_calendar_date_idx ON room_rate_calendar(rate_date, room_id);
