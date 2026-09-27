/*
  q4 · full-text catalogue search, best matches first.
  Index target: GIN index on search_vector.
  A B-tree cannot help here: @@ asks whether a word is inside the vector,
  and GIN indexes each word separately, mapping it to the rows that contain it.
  plainto_tsquery joins the two words with AND, so both must be present.
  With GIN that means intersecting two row lists: кросівки (2.5% of products,
  seed C2) and шкіряні (1 in 7). Adjective and noun come from coprime moduli
  (7 and 40), so the pair lands in 1 row in 280, 357 rows or 0.36%.
  The simple config does no stemming, so кросівок matches nothing.
  ts_rank is the same for every match in this seed data, so id breaks the tie
  and keeps the top 20 stable between runs.
*/
SELECT id, name, ts_rank(search_vector, plainto_tsquery('simple', 'шкіряні кросівки')) AS rank
FROM products
WHERE search_vector @@ plainto_tsquery('simple', 'шкіряні кросівки')
ORDER BY rank DESC, id
LIMIT 20
