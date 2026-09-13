SELECT id, status, total, currency, created_at
FROM orders
WHERE buyer_id = 137
  AND created_at >= now() - interval '180 days'
ORDER BY created_at DESC, id DESC
LIMIT 20
