SELECT id, title, ts_rank(search_vector, plainto_tsquery('simple', 'шкіряні кросівки')) AS rank
FROM products
WHERE search_vector @@ plainto_tsquery('simple', 'шкіряні кросівки')
ORDER BY rank DESC, id
LIMIT 20
