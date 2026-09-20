const express = require('express');
const router = express.Router();
const pool = require('../db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const requireAuth = require('../middleware/requireAuth');

const SALT_ROUNDS = 10;

// POST /api/members/register   註冊新會員
router.post('/register', async (req, res) => {
  try {
    const { phone, password, name } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ error: '手機號碼與密碼為必填' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '密碼至少需要 6 個字元' });
    }

    const [existing] = await pool.query(
      'SELECT id FROM members WHERE phone = ?',
      [phone]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: '此手機號碼已經註冊過了' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const [result] = await pool.query(
      'INSERT INTO members (phone, password_hash, name) VALUES (?, ?, ?)',
      [phone, passwordHash, name || null]
    );

    res.status(201).json({ message: '註冊成功', id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '註冊失敗' });
  }
});

// POST /api/members/login   登入，成功後回傳 JWT 憑證
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ error: '手機號碼與密碼為必填' });
    }

    const [rows] = await pool.query(
      'SELECT id, phone, password_hash, name FROM members WHERE phone = ?',
      [phone]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: '手機號碼或密碼錯誤' });
    }

    const member = rows[0];
    const isMatch = await bcrypt.compare(password, member.password_hash);

    if (!isMatch) {
      return res.status(401).json({ error: '手機號碼或密碼錯誤' });
    }

    const token = jwt.sign(
      { member_id: member.id, phone: member.phone },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: '登入成功',
      token,
      member: { id: member.id, phone: member.phone, name: member.name }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '登入失敗' });
  }
});

// GET /api/members/me   取得目前登入會員自己的資料（需登入）
router.get('/me', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, phone, name, created_at FROM members WHERE id = ?',
      [req.member.member_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: '找不到會員資料' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// PUT /api/members/me   修改自己的姓名／電話號碼（需登入）
router.put('/me', requireAuth, async (req, res) => {
  try {
    const memberId = req.member.member_id;
    const { name, phone } = req.body;

    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: '電話號碼為必填' });
    }

    // 檢查這個電話號碼是不是「別人」已經在用了（自己原本的號碼不算重複）
    const [existing] = await pool.query(
      'SELECT id FROM members WHERE phone = ? AND id != ?',
      [phone.trim(), memberId]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: '此手機號碼已被其他帳號使用' });
    }

    await pool.query(
      'UPDATE members SET name = ?, phone = ? WHERE id = ?',
      [name?.trim() || null, phone.trim(), memberId]
    );

    // 電話號碼是登入憑證裡的一部分，改了之後要重新核發一組新的 token，
    // 不然舊 token 裡存的還是舊電話號碼，前端顯示會對不上
    const newToken = jwt.sign(
      { member_id: memberId, phone: phone.trim() },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: '個人資料已更新',
      token: newToken,
      member: { id: memberId, phone: phone.trim(), name: name?.trim() || null }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '更新失敗' });
  }
});

// PUT /api/members/me/password   修改密碼（需登入，需先驗證目前密碼正確）
router.put('/me/password', requireAuth, async (req, res) => {
  try {
    const memberId = req.member.member_id;
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: '請輸入目前密碼與新密碼' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ error: '新密碼至少需要 6 個字元' });
    }

    const [rows] = await pool.query(
      'SELECT password_hash FROM members WHERE id = ?',
      [memberId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: '找不到會員資料' });
    }

    const isMatch = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: '目前密碼不正確' });
    }

    const newHash = await bcrypt.hash(new_password, SALT_ROUNDS);
    await pool.query(
      'UPDATE members SET password_hash = ? WHERE id = ?',
      [newHash, memberId]
    );

    res.json({ message: '密碼已更新' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '更新失敗' });
  }
});

module.exports = router;