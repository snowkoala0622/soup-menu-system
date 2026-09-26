const express = require('express');
const router = express.Router();
const pool = require('../db');
const multer = require('multer');
const path = require('path');

// 設定圖片存放位置與檔名規則
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../uploads'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `dish_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 限制 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('只允許上傳 jpg、jpeg、png、webp 格式的圖片'));
    }
  }
});

// GET /api/dishes           取得供應中的湯品（顧客頁用）
// GET /api/dishes?all=1     取得全部湯品，含下架的（後台管理用）
router.get('/', async (req, res) => {
  try {
    const showAll = req.query.all === '1';
    const [rows] = await pool.query(`
      SELECT 
        d.id, d.name, d.price, d.image_url, d.description,
        d.contraindication, d.is_available,
        c.name AS category,
        GROUP_CONCAT(t.name SEPARATOR '、') AS tags
      FROM dishes d
      LEFT JOIN categories c ON d.category_id = c.id
      LEFT JOIN dish_tags dt ON d.id = dt.dish_id
      LEFT JOIN tags t ON dt.tag_id = t.id
      ${showAll ? '' : 'WHERE d.is_available = 1'}
      GROUP BY d.id
      ORDER BY c.sort_order, d.sort_order
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '資料讀取失敗' });
  }
});

// 把「用、或,分隔的標籤文字」同步成該道菜色的 dish_tags 關聯：
// 先清掉舊的關聯，缺少的標籤自動建立，再依序重新建立關聯。
// 新增與編輯共用這段邏輯，避免兩邊各寫一次、之後改壞其中一邊。
async function syncDishTags(dishId, tagsText) {
  const tagNames = (tagsText || '')
    .split(/[、,]/)
    .map(t => t.trim())
    .filter(Boolean);

  await pool.query('DELETE FROM dish_tags WHERE dish_id = ?', [dishId]);

  for (const tagName of tagNames) {
    await pool.query(
      'INSERT IGNORE INTO tags (name) VALUES (?)',
      [tagName]
    );
    await pool.query(
      `INSERT INTO dish_tags (dish_id, tag_id)
       SELECT ?, id FROM tags WHERE name = ?`,
      [dishId, tagName]
    );
  }
}

// POST /api/dishes   新增一道湯品，可同時帶入標籤（用、分隔的文字）
router.post('/', async (req, res) => {
  try {
    const {
      category_id,
      name,
      price,
      description,
      contraindication,
      tags
    } = req.body;

    if (!name || price === undefined || price === '') {
      return res.status(400).json({ error: '名稱與價格為必填' });
    }

    const [result] = await pool.query(
      `INSERT INTO dishes (category_id, name, price, description, contraindication, is_available, sort_order)
       VALUES (?, ?, ?, ?, ?, 1, 
         (SELECT t FROM (SELECT COALESCE(MAX(sort_order), 0) + 1 AS t FROM dishes) AS x)
       )`,
      [category_id || null, name, price, description || '', contraindication || '']
    );

    const dishId = result.insertId;

    await syncDishTags(dishId, tags);

    res.status(201).json({ message: '新增成功', id: dishId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '新增失敗' });
  }
});

// PUT /api/dishes/:id   編輯湯品資料（名稱、價格、說明、禁忌、標籤、上下架狀態）
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, price, description, contraindication, is_available, tags } = req.body;

    const [result] = await pool.query(
      `UPDATE dishes 
       SET name = ?, price = ?, description = ?, contraindication = ?, is_available = ?
       WHERE id = ?`,
      [name, price, description, contraindication, is_available ? 1 : 0, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: '找不到此湯品' });
    }

    // tags 欄位有帶值（哪怕是空字串，代表使用者清空了標籤）才更新，
    // undefined 代表這次請求沒打算動標籤，維持原樣
    if (tags !== undefined) {
      await syncDishTags(id, tags);
    }

    res.json({ message: '更新成功' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '更新失敗' });
  }
});

// POST /api/dishes/:id/image   上傳/更新某道湯品的圖片
router.post('/:id/image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '沒有收到圖片檔案' });
    }

    const { id } = req.params;
    const imageUrl = `/uploads/${req.file.filename}`;

    const [result] = await pool.query(
      'UPDATE dishes SET image_url = ? WHERE id = ?',
      [imageUrl, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: '找不到此湯品' });
    }

    res.json({ message: '圖片上傳成功', image_url: imageUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '圖片上傳失敗' });
  }
});

// DELETE /api/dishes/:id   永久刪除一道湯品
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query('DELETE FROM dishes WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: '找不到此湯品' });
    }

    res.json({ message: '刪除成功' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '刪除失敗' });
  }
});

module.exports = router;