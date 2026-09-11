ALTER TABLE cash_closures ADD COLUMN IF NOT EXISTS expected_balance numeric(12,2);
ALTER TABLE cash_closures ADD COLUMN IF NOT EXISTS difference numeric(12,2);
UPDATE rooms SET notes='Revisar capacidad y tarifa inicial antes de operar' WHERE base_price=0 AND notes='';
