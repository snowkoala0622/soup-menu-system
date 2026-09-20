const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET /api/categories   取得所有分類
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name FROM categories ORDER BY sort_order'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '資料讀取失敗' });
  }
});

module.exports = router;