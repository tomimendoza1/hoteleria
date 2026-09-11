CREATE TABLE IF NOT EXISTS hotel_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  hotel_name text NOT NULL DEFAULT 'Hotelería' CHECK (char_length(hotel_name) BETWEEN 2 AND 100),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO hotel_settings(id, hotel_name)
VALUES (1, 'Hotelería')
ON CONFLICT (id) DO NOTHING;
