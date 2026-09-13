SELECT id, buyer_id, total, created_at
FROM orders
WHERE status = 'pending'
  AND created_at < now() - interval '15 minutes'
ORDER BY created_at
LIMIT 100
