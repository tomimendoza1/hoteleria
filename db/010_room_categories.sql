CREATE TABLE IF NOT EXISTS room_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS category_id uuid;
INSERT INTO room_categories(name) VALUES
  ('Habitación Doble Estándar - 2 camas'),
  ('Habitación Doble Estándar'),
  ('Habitación Triple Económica'),
  ('Habitación Familiar con baño compartido'),
  ('2 Habitaciones Dobles comunicadas')
ON CONFLICT(name) DO NOTHING;
INSERT INTO room_categories(name)
SELECT DISTINCT type FROM rooms WHERE type IS NOT NULL AND trim(type) <> ''
ON CONFLICT(name) DO NOTHING;
UPDATE rooms SET type='Habitación Doble Estándar' WHERE type='standard';
UPDATE rooms r SET category_id=c.id FROM room_categories c WHERE r.category_id IS NULL AND c.name=r.type;
DO $$ BEGIN
  ALTER TABLE rooms ADD CONSTRAINT rooms_category_fk FOREIGN KEY (category_id) REFERENCES room_categories(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS rooms_category_idx ON rooms(category_id);
