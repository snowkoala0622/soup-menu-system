const express = require('express');
const router = express.Router();
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const optionalAuth = require('../middleware/optionalAuth');

// POST /api/orders   送出訂單（會員與訪客皆可使用）
// body: { items: [{ dish_id, quantity }, ...], guest_name, facial_record_id }
// facial_record_id：若這筆訂單是從AI分析結果頁直接加入購物車送出的，記錄是哪一次分析（選填）
router.post('/', optionalAuth, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { items, guest_name, facial_record_id } = req.body;
    const memberId = req.member ? req.member.member_id : null;

    if (!Array.isArray(items) || items.length === 0) {
      connection.release();
      return res.status(400).json({ error: '訂單內容不能是空的' });
    }

    await connection.beginTransaction();

    let totalAmount = 0;
    const resolvedItems = [];

    for (const item of items) {
      const [rows] = await connection.query(
        'SELECT id, name, price FROM dishes WHERE id = ?',
        [item.dish_id]
      );
      if (rows.length === 0) {
        throw new Error(`找不到 id=${item.dish_id} 的湯品`);
      }
      const dish = rows[0];
      const quantity = Math.max(1, parseInt(item.quantity) || 1);
      totalAmount += Number(dish.price) * quantity;
      resolvedItems.push({
        dish_id: dish.id,
        dish_name: dish.name,
        price: dish.price,
        quantity
      });
    }

    // facial_record_id 只有在「有登入」且「確實帶了有效數字」時才會存，
    // 訪客的分析紀錄本來就不會存進 facial_records，沒有 id 可以關聯
    const validFacialRecordId =
      memberId && facial_record_id && !isNaN(parseInt(facial_record_id))
        ? parseInt(facial_record_id)
        : null;

    const [orderResult] = await connection.query(
      `INSERT INTO orders (member_id, guest_name, facial_record_id, status, total_amount)
       VALUES (?, ?, ?, ?, ?)`,
      [memberId, memberId ? null : (guest_name?.trim() || null), validFacialRecordId, '待處理', totalAmount]
    );
    const orderId = orderResult.insertId;

    for (const item of resolvedItems) {
      await connection.query(
        `INSERT INTO order_items (order_id, dish_id, dish_name, price, quantity)
         VALUES (?, ?, ?, ?, ?)`,
        [orderId, item.dish_id, item.dish_name, item.price, item.quantity]
      );
    }

    await connection.commit();
    res.status(201).json({ message: '訂單送出成功', order_id: orderId, total_amount: totalAmount });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ error: err.message || '訂單送出失敗' });
  } finally {
    connection.release();
  }
});

// GET /api/orders/mine   查詢自己的歷史訂單（需登入；訪客沒有帳號，沒有歷史可查）
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const memberId = req.member.member_id;

    const [orders] = await pool.query(
      `SELECT id, status, total_amount, created_at, facial_record_id
       FROM orders
       WHERE member_id = ?
       ORDER BY created_at DESC`,
      [memberId]
    );

    for (const order of orders) {
      const [items] = await pool.query(
        `SELECT dish_name, price, quantity
         FROM order_items
         WHERE order_id = ?`,
        [order.id]
      );
      order.items = items;
    }

    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// GET /api/orders   廚房後台用：查全部訂單（含會員與訪客訂單）
// 可加 ?status=待處理 篩選特定狀態，?date=2026-08-02 篩選特定日期
router.get('/', async (req, res) => {
  try {
    const { status, date } = req.query;

    const conditions = [];
    const params = [];
    if (status) {
      conditions.push('o.status = ?');
      params.push(status);
    }
    if (date) {
      conditions.push('DATE(o.created_at) = ?');
      params.push(date);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [orders] = await pool.query(
      `SELECT o.id, o.status, o.total_amount, o.created_at, o.facial_record_id,
              m.phone AS member_phone,
              COALESCE(m.name, o.guest_name, '訪客') AS customer_name,
              (o.member_id IS NULL) AS is_guest
       FROM orders o
       LEFT JOIN members m ON o.member_id = m.id
       ${whereClause}
       ORDER BY o.created_at ASC`,
      params
    );

    for (const order of orders) {
      const [items] = await pool.query(
        `SELECT dish_name, price, quantity
         FROM order_items
         WHERE order_id = ?`,
        [order.id]
      );
      order.items = items;
    }

    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// PUT /api/orders/:id/status   廚房後台用：更新訂單狀態
router.put('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['待處理', '製作中', '已完成', '已取消'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: '無效的訂單狀態' });
    }

    const [result] = await pool.query(
      'UPDATE orders SET status = ? WHERE id = ?',
      [status, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: '找不到此訂單' });
    }

    res.json({ message: '狀態更新成功' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '狀態更新失敗' });
  }
});

module.exports = router;