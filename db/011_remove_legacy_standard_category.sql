DELETE FROM room_categories c
WHERE c.name = 'standard'
  AND NOT EXISTS (
    SELECT 1 FROM rooms r WHERE r.category_id = c.id
  );
