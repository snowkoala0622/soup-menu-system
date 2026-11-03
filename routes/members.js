const express = require('express');
const router = express.Router();
const pool = require('../db');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const requireAuth = require('../middleware/requireAuth');
const { sendCodeMail } = require('../utils/mailer');

const SALT_ROUNDS = 10;

// ---- 信箱驗證／忘記密碼的設定 ----
const CODE_TTL_MINUTES = 10;         // 驗證碼有效時間
const RESEND_COOLDOWN_SECONDS = 60;  // 同一個帳號兩次寄驗證碼的最短間隔
const MAX_CODE_ATTEMPTS = 5;         // 同一組驗證碼最多可以輸入錯誤的次數
const ONLY_GMAIL = true;            // 改成 true 就只允許 @gmail.com 信箱註冊

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return email.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function makeCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function signToken(member) {
  return jwt.sign(
    { member_id: member.id, phone: member.phone },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// 產生一組新驗證碼、存進資料庫（只存雜湊，不存明碼）並寄出。
// 回傳 { sent: false } 代表還在冷卻時間內、這次沒有寄；寄信失敗會丟出錯誤（同時把剛存的碼刪掉，讓使用者可以馬上重試）。
async function issueCode(memberId, email, purpose) {
  const [recent] = await pool.query(
    `SELECT id FROM email_codes
     WHERE member_id = ? AND purpose = ? AND created_at > (NOW() - INTERVAL ? SECOND)
     LIMIT 1`,
    [memberId, purpose, RESEND_COOLDOWN_SECONDS]
  );
  if (recent.length > 0) return { sent: false };

  await pool.query('DELETE FROM email_codes WHERE member_id = ? AND purpose = ?', [memberId, purpose]);

  const code = makeCode();
  const codeHash = await bcrypt.hash(code, SALT_ROUNDS);
  await pool.query(
    `INSERT INTO email_codes (member_id, purpose, code_hash, expires_at)
     VALUES (?, ?, ?, NOW() + INTERVAL ? MINUTE)`,
    [memberId, purpose, codeHash, CODE_TTL_MINUTES]
  );

  try {
    await sendCodeMail({ to: email, code, purpose, ttlMinutes: CODE_TTL_MINUTES });
  } catch (err) {
    await pool.query('DELETE FROM email_codes WHERE member_id = ? AND purpose = ?', [memberId, purpose]);
    throw err;
  }
  return { sent: true };
}

// 檢查使用者輸入的驗證碼。回傳 'ok' | 'invalid'（錯誤或已過期）| 'locked'（錯太多次）
async function checkCode(memberId, purpose, code) {
  const [rows] = await pool.query(
    `SELECT id, code_hash FROM email_codes
     WHERE member_id = ? AND purpose = ? AND expires_at > NOW()
     ORDER BY id DESC LIMIT 1`,
    [memberId, purpose]
  );
  if (rows.length === 0) return 'invalid';

  // 先把嘗試次數 +1 再比對：同時送來很多個請求時，也不會超過次數上限
  const [bump] = await pool.query(
    'UPDATE email_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < ?',
    [rows[0].id, MAX_CODE_ATTEMPTS]
  );
  if (bump.affectedRows === 0) return 'locked';

  const match = await bcrypt.compare(String(code), rows[0].code_hash);
  return match ? 'ok' : 'invalid';
}

function sendCodeError(res, result) {
  if (result === 'locked') {
    return res.status(429).json({ error: '輸入錯誤次數過多，請重新取得驗證碼' });
  }
  return res.status(400).json({ error: '驗證碼錯誤或已過期' });
}

// POST /api/members/register   註冊新會員（需要信箱，註冊後要先驗證信箱才能登入）
router.post('/register', async (req, res) => {
  try {
    const { phone, password, name } = req.body;
    const email = normalizeEmail(req.body.email);

    if (!phone || !password) {
      return res.status(400).json({ error: '手機號碼與密碼為必填' });
    }
    if (!email) {
      return res.status(400).json({ error: '請填寫信箱' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: '信箱格式不正確' });
    }
    if (ONLY_GMAIL && !email.endsWith('@gmail.com')) {
      return res.status(400).json({ error: '目前只開放使用 Gmail 信箱註冊' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '密碼至少需要 6 個字元' });
    }

    // 同信箱的待驗證帳號如果剛寄過驗證碼，先擋下，避免這支 API 被拿來連續寄信騷擾別人
    const [justSent] = await pool.query(
      `SELECT m.id FROM members m
       JOIN email_codes c ON c.member_id = m.id AND c.purpose = 'verify'
       WHERE m.email = ? AND m.email_verified = 0
         AND c.created_at > (NOW() - INTERVAL ? SECOND)
       LIMIT 1`,
      [email, RESEND_COOLDOWN_SECONDS]
    );
    if (justSent.length > 0) {
      return res.status(429).json({ error: '驗證碼剛寄出，請稍候約 1 分鐘再試' });
    }

    // 清掉「註冊到一半、一直沒驗證」的舊紀錄（同手機或同信箱），讓人可以重新註冊。
    // 條件要求 email 不是 NULL，所以沒有信箱的舊會員不會被刪到。
    await pool.query(
      `DELETE FROM members
       WHERE email IS NOT NULL AND email_verified = 0 AND (phone = ? OR email = ?)`,
      [phone, email]
    );

    const [phoneTaken] = await pool.query('SELECT id FROM members WHERE phone = ?', [phone]);
    if (phoneTaken.length > 0) {
      return res.status(409).json({ error: '此手機號碼已經註冊過了' });
    }
    const [emailTaken] = await pool.query('SELECT id FROM members WHERE email = ?', [email]);
    if (emailTaken.length > 0) {
      return res.status(409).json({ error: '此信箱已經註冊過了' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const [result] = await pool.query(
      'INSERT INTO members (phone, password_hash, name, email, email_verified) VALUES (?, ?, ?, ?, 0)',
      [phone, passwordHash, name || null, email]
    );

    // 帳號建立後寄驗證碼；寄信失敗不會讓註冊失敗，使用者可以在驗證畫面按「重新寄送」
    let emailSent = true;
    try {
      await issueCode(result.insertId, email, 'verify');
    } catch (mailErr) {
      emailSent = false;
      console.error('寄送註冊驗證碼失敗:', mailErr.message);
    }

    res.status(201).json({
      message: emailSent ? '註冊成功，驗證碼已寄到你的信箱' : '註冊成功，但驗證碼寄送失敗，請按「重新寄送」',
      id: result.insertId,
      email,
      email_sent: emailSent
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: '此手機號碼或信箱已經註冊過了' });
    }
    console.error(err);
    res.status(500).json({ error: '註冊失敗' });
  }
});

// POST /api/members/verify-email   輸入註冊時寄到信箱的驗證碼，通過後帳號啟用並直接登入
router.post('/verify-email', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.code || '').trim();

    if (!email || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: '請輸入 6 位數驗證碼' });
    }

    const [rows] = await pool.query(
      'SELECT id, phone, name FROM members WHERE email = ? AND email_verified = 0',
      [email]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: '驗證碼錯誤或已過期' });
    }
    const member = rows[0];

    const result = await checkCode(member.id, 'verify', code);
    if (result !== 'ok') return sendCodeError(res, result);

    await pool.query('UPDATE members SET email_verified = 1 WHERE id = ?', [member.id]);
    await pool.query('DELETE FROM email_codes WHERE member_id = ?', [member.id]);

    res.json({
      message: '信箱驗證成功',
      token: signToken(member),
      member: { id: member.id, phone: member.phone, name: member.name, email }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '驗證失敗' });
  }
});

// POST /api/members/resend-verification   重新寄送註冊驗證碼
// 不論信箱存不存在、是否在冷卻時間內，都回一樣的訊息，避免被拿來探測誰註冊過
router.post('/resend-verification', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: '信箱格式不正確' });
    }

    const [rows] = await pool.query(
      'SELECT id FROM members WHERE email = ? AND email_verified = 0',
      [email]
    );
    if (rows.length > 0) {
      try {
        await issueCode(rows[0].id, email, 'verify');
      } catch (mailErr) {
        console.error('重新寄送註冊驗證碼失敗:', mailErr.message);
      }
    }

    res.json({ message: '如果這個信箱有待驗證的帳號，驗證碼已重新寄出' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '寄送失敗' });
  }
});

// POST /api/members/forgot-password   忘記密碼：寄驗證碼到註冊時的信箱
// 一樣不透露信箱是否註冊過
router.post('/forgot-password', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: '信箱格式不正確' });
    }

    const [rows] = await pool.query(
      'SELECT id FROM members WHERE email = ? AND email_verified = 1',
      [email]
    );
    if (rows.length > 0) {
      try {
        await issueCode(rows[0].id, email, 'reset');
      } catch (mailErr) {
        console.error('寄送重設密碼驗證碼失敗:', mailErr.message);
      }
    }

    res.json({ message: `如果這個信箱已註冊，驗證碼已寄出（${CODE_TTL_MINUTES} 分鐘內有效）` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '寄送失敗' });
  }
});

// POST /api/members/reset-password   輸入驗證碼與新密碼，完成重設
router.post('/reset-password', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.code || '').trim();
    const { new_password } = req.body;

    if (!email || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: '請輸入 6 位數驗證碼' });
    }
    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ error: '新密碼至少需要 6 個字元' });
    }

    const [rows] = await pool.query(
      'SELECT id FROM members WHERE email = ? AND email_verified = 1',
      [email]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: '驗證碼錯誤或已過期' });
    }
    const memberId = rows[0].id;

    const result = await checkCode(memberId, 'reset', code);
    if (result !== 'ok') return sendCodeError(res, result);

    const newHash = await bcrypt.hash(new_password, SALT_ROUNDS);
    await pool.query('UPDATE members SET password_hash = ? WHERE id = ?', [newHash, memberId]);
    await pool.query('DELETE FROM email_codes WHERE member_id = ?', [memberId]);

    res.json({ message: '密碼已重設，請用新密碼登入' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '重設失敗' });
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
      'SELECT id, phone, password_hash, name, email, email_verified FROM members WHERE phone = ?',
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

    // 有填信箱但還沒驗證的帳號不能登入（密碼正確才會看到這個提示）。
    // 沒有信箱的舊會員（email 是 NULL）照舊可以登入。
    if (member.email && !member.email_verified) {
      return res.status(403).json({
        error: '這個帳號的信箱還沒驗證，請先完成信箱驗證',
        needs_verification: true,
        email: member.email
      });
    }

    res.json({
      message: '登入成功',
      token: signToken(member),
      member: { id: member.id, phone: member.phone, name: member.name, email: member.email || null }
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
      'SELECT id, phone, name, email, email_verified, created_at FROM members WHERE id = ?',
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