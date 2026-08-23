-- Preflight check for migration 0014_payment_concurrency.
--
-- 0014 introduces partial UNIQUE indexes (payments_order_unique /
-- payments_gift_unique) that enforce at most one payment row per order and
-- per gift. Run this BEFORE applying 0014. If any row is returned, the
-- database already violates the invariant that the migration enforces and the
-- migration MUST NOT be applied; resolve duplicates manually (do NOT rewrite
-- or delete rows automatically) before re-running.
--
--   psql "$DATABASE_URL" -f packages/db/scripts/preflight_payment_duplicates.sql
--
-- Expected (safe to migrate): zero rows returned.

SELECT 'duplicate_order_target' AS violation, order_id::text AS target, count(*) AS rows
  FROM payments
 WHERE order_id IS NOT NULL
 GROUP BY order_id
HAVING count(*) > 1
UNION ALL
SELECT 'duplicate_gift_target', gift_id::text, count(*)
  FROM payments
 WHERE gift_id IS NOT NULL
 GROUP BY gift_id
HAVING count(*) > 1;
