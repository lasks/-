-- ============================================================
-- 常用SQL查询合集 —— 现场实施高频场景
-- 适用: MySQL 5.7+ / 8.0+
-- 使用: 把里面的表名、字段名替换成实际的就行
-- ============================================================

-- ── 1. 多表关联：客户订单明细 ──────────────────
-- 场景：查出每个客户的消费总额和订单数，按消费额排名

SELECT
    c.customer_id,
    c.customer_name,
    COUNT(o.order_id)          AS order_count,
    COALESCE(SUM(o.amount), 0) AS total_amount,
    MAX(o.order_date)          AS last_order_date
FROM customers c
LEFT JOIN orders o ON c.customer_id = o.customer_id
WHERE o.status != 'cancelled'   -- 排除已取消的订单
   OR o.status IS NULL          -- 保留没有订单的客户
GROUP BY c.customer_id, c.customer_name
HAVING total_amount > 0         -- 只看有消费的
ORDER BY total_amount DESC
LIMIT 100;


-- ── 2. 窗口函数：各部门工资排名 ──────────────────
-- 场景：查每个部门工资前3的员工

SELECT *
FROM (
    SELECT
        employee_id,
        name,
        department,
        salary,
        DENSE_RANK() OVER (PARTITION BY department ORDER BY salary DESC) AS rank_in_dept
    FROM employees
    WHERE status = 'active'
) t
WHERE rank_in_dept <= 3
ORDER BY department, rank_in_dept;


-- ── 3. 数据条数校验（对账用） ──────────────────
-- 场景：迁移后比对源库和目标库的条数

SELECT
    'customers'   AS table_name,
    (SELECT COUNT(*) FROM source_db.customers)   AS source_count,
    (SELECT COUNT(*) FROM target_db.customers)   AS target_count
UNION ALL
SELECT
    'orders',
    (SELECT COUNT(*) FROM source_db.orders),
    (SELECT COUNT(*) FROM target_db.orders)
UNION ALL
SELECT
    'payments',
    (SELECT COUNT(*) FROM source_db.payments),
    (SELECT COUNT(*) FROM target_db.payments)
;


-- ── 4. 找出目标端缺失的主键 ──────────────────
-- 场景：哪些订单在源库有但目标库没有？

SELECT s.order_id
FROM source_db.orders s
LEFT JOIN target_db.orders t ON s.order_id = t.order_id
WHERE t.order_id IS NULL
LIMIT 1000;


-- ── 5. 空值率检查 ──────────────────
-- 场景：跑一遍核心表的空值率

SELECT
    'customers'        AS table_name,
    'email'            AS column_name,
    COUNT(*)           AS total,
    SUM(CASE WHEN email IS NULL OR email = '' THEN 1 ELSE 0 END) AS null_count,
    ROUND(SUM(CASE WHEN email IS NULL OR email = '' THEN 1 ELSE 0 END) / COUNT(*) * 100, 2) AS null_rate_pct
FROM customers
UNION ALL
SELECT 'customers', 'phone', COUNT(*),
    SUM(CASE WHEN phone IS NULL OR phone = '' THEN 1 ELSE 0 END),
    ROUND(SUM(CASE WHEN phone IS NULL OR phone = '' THEN 1 ELSE 0 END) / COUNT(*) * 100, 2)
FROM customers
UNION ALL
SELECT 'orders', 'delivery_address', COUNT(*),
    SUM(CASE WHEN delivery_address IS NULL OR delivery_address = '' THEN 1 ELSE 0 END),
    ROUND(SUM(CASE WHEN delivery_address IS NULL OR delivery_address = '' THEN 1 ELSE 0 END) / COUNT(*) * 100, 2)
FROM orders;


-- ── 6. 重复数据检查 ──────────────────
-- 场景：检查是否有重复的订单号

SELECT order_id, COUNT(*) AS cnt
FROM orders
GROUP BY order_id
HAVING COUNT(*) > 1
ORDER BY cnt DESC
LIMIT 50;


-- ── 7. 增量数据提取（按时间） ──────────────────
-- 场景：每天凌晨抽前一天的增量数据

SELECT *
FROM orders
WHERE order_date >= CURDATE() - INTERVAL 1 DAY
  AND order_date < CURDATE()
ORDER BY order_date;


-- ── 8. 行转列：按月统计各渠道销售额 ──────────────────
-- 场景：把行的月份转成列，给报表用

SELECT
    channel,
    SUM(CASE WHEN DATE_FORMAT(order_date, '%Y-%m') = '2026-01' THEN amount ELSE 0 END) AS january,
    SUM(CASE WHEN DATE_FORMAT(order_date, '%Y-%m') = '2026-02' THEN amount ELSE 0 END) AS february,
    SUM(CASE WHEN DATE_FORMAT(order_date, '%Y-%m') = '2026-03' THEN amount ELSE 0 END) AS march,
    SUM(CASE WHEN DATE_FORMAT(order_date, '%Y-%m') = '2026-04' THEN amount ELSE 0 END) AS april,
    SUM(CASE WHEN DATE_FORMAT(order_date, '%Y-%m') = '2026-05' THEN amount ELSE 0 END) AS may,
    SUM(CASE WHEN DATE_FORMAT(order_date, '%Y-%m') = '2026-06' THEN amount ELSE 0 END) AS june
FROM orders
WHERE order_date >= '2026-01-01'
  AND order_date < '2026-07-01'
GROUP BY channel
ORDER BY channel;


-- ── 9. 子查询：消费超过平均值2倍的客户 ──────────────────
-- 场景：找出异常高消费客户（可能是刷单或VIP）

SELECT
    c.customer_id,
    c.customer_name,
    SUM(o.amount) AS total_spent
FROM customers c
JOIN orders o ON c.customer_id = o.customer_id
WHERE o.status = 'completed'
GROUP BY c.customer_id, c.customer_name
HAVING total_spent > (
    SELECT AVG(total) * 2
    FROM (
        SELECT SUM(amount) AS total
        FROM orders
        WHERE status = 'completed'
        GROUP BY customer_id
    ) t
)
ORDER BY total_spent DESC;


-- ── 10. 查询最近一条记录（每个客户的最新订单） ──────────────────
-- 场景：查每个客户最后一次下单的信息

SELECT o.*
FROM orders o
JOIN (
    SELECT customer_id, MAX(order_date) AS latest_date
    FROM orders
    GROUP BY customer_id
) latest ON o.customer_id = latest.customer_id AND o.order_date = latest.latest_date
ORDER BY o.customer_id;


-- ── 11. 数据分布统计 ──────────────────
-- 场景：看订单金额的分布情况

SELECT
    CASE
        WHEN amount < 100      THEN '0-100'
        WHEN amount < 500      THEN '100-500'
        WHEN amount < 1000     THEN '500-1000'
        WHEN amount < 5000     THEN '1000-5000'
        WHEN amount < 10000    THEN '5000-10000'
        ELSE '10000以上'
    END AS amount_range,
    COUNT(*) AS order_count,
    ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 2) AS pct
FROM orders
WHERE status = 'completed'
GROUP BY amount_range
ORDER BY MIN(amount);


-- ── 12. 锁表/长事务排查 ──────────────────
-- 场景：现场有人说"数据库卡了"，查是谁在跑长事务

-- MySQL 8.0
SELECT
    t.trx_id,
    t.trx_state,
    t.trx_started,
    TIMESTAMPDIFF(SECOND, t.trx_started, NOW()) AS running_seconds,
    t.trx_mysql_thread_id,
    p.user,
    p.host,
    p.db,
    p.time AS query_time_seconds,
    p.info AS current_query
FROM information_schema.innodb_trx t
LEFT JOIN information_schema.processlist p ON t.trx_mysql_thread_id = p.id
WHERE TIMESTAMPDIFF(SECOND, t.trx_started, NOW()) > 10
ORDER BY t.trx_started;


-- ── 13. 表大小统计 ──────────────────
-- 场景：看看哪个表占空间最大

SELECT
    table_name,
    ROUND((data_length + index_length) / 1024 / 1024, 2) AS size_mb,
    ROUND(data_length / 1024 / 1024, 2)                AS data_mb,
    ROUND(index_length / 1024 / 1024, 2)               AS index_mb,
    table_rows
FROM information_schema.tables
WHERE table_schema = 'your_database'
  AND table_type = 'BASE TABLE'
ORDER BY (data_length + index_length) DESC;


-- ── 14. 批量更新（安全的写法） ──────────────────
-- 场景：把某个客户的所有旧订单状态改成已归档
-- 注意：大批量更新先 SELECT 确认条数，再分批跑

-- 先确认要更新多少条
SELECT COUNT(*) FROM orders WHERE customer_id = 12345 AND status = 'old';

-- 分批更新，一次1000条，避免锁表
UPDATE orders
SET status = 'archived'
WHERE customer_id = 12345
  AND status = 'old'
LIMIT 1000;
-- 重复执行直到 affected rows = 0


-- ── 15. 创建备份表（操作前必备） ──────────────────
-- 场景：改数据之前，先备份

CREATE TABLE orders_backup_20260611 AS
SELECT * FROM orders
WHERE order_date >= '2026-01-01';

-- 确认条数一致
SELECT COUNT(*) FROM orders WHERE order_date >= '2026-01-01';
SELECT COUNT(*) FROM orders_backup_20260611;
