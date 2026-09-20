const express = require('express');
const router = express.Router();
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { GoogleGenAI } = require('@google/genai');

// 與 requireAuth 不同：有帶合法 token 就解析出 req.member，
// 沒帶 token（訪客）或 token 無效，都放行、req.member 設為 null，
// 而不是回 401。讓「非會員也能用 AI 分析」但登入者仍可留下紀錄。
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    req.member = null;
    return next();
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.member = payload;
  } catch {
    req.member = null; // token 過期或無效，當成訪客處理，不擋下請求
  }
  next();
}

// 用記憶體暫存照片，分析完就丟棄，不寫進硬碟（隱私考量）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('只允許上傳 jpg、png、webp 格式的圖片'));
    }
  }
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// POST /api/facial-analysis   上傳照片，AI分析特徵並推薦湯品（會員與訪客皆可使用；
// 若有登入，會額外把這次結果存進 facial_records 供日後查詢）
router.post('/', optionalAuth, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '沒有收到照片檔案' });
    }

    const memberId = req.member ? req.member.member_id : null;
    const base64Image = req.file.buffer.toString('base64');

    // 撈出目前資料庫實際有的湯品，讓 AI 從這份真實清單裡挑選推薦
    const [dishes] = await pool.query(`
      SELECT d.id, d.name, d.description, d.price, d.image_url,
             GROUP_CONCAT(t.name SEPARATOR '、') AS tags
      FROM dishes d
      JOIN categories c ON d.category_id = c.id
      LEFT JOIN dish_tags dt ON d.id = dt.dish_id
      LEFT JOIN tags t ON dt.tag_id = t.id
      WHERE d.is_available = 1 AND c.name = '補湯'
      GROUP BY d.id
    `);

    const dishListText = dishes
      .map(d => `id=${d.id}｜${d.name}｜功效:${d.description || '無'}｜標籤:${d.tags || '無'}`)
      .join('\n');

    const prompt = `你是一位中醫養生顧問。請根據使用者上傳的照片，觀察臉部氣色、眼周狀態（如黑眼圈、浮腫），以及舌頭（若照片中有拍到，觀察舌色、舌苔；若沒拍到舌頭則此欄位留空字串）。

根據觀察結果，判斷使用者目前偏向哪一種中醫體質（例如：氣虛、陰虛、陽虛、濕熱、氣血兩虛等），並從下方「目前供應的湯品清單」中，選出 2 到 3 道最適合的湯品，由最推薦到次推薦排序。

湯品清單：
${dishListText}

請務必只回傳以下格式的 JSON，不要有任何其他文字、不要用 markdown 的 \`\`\` 包住：
{
  "face_features": "臉部氣色觀察描述（文字）",
  "eye_features": "眼周狀態觀察描述（文字）",
  "tongue_features": "舌頭觀察描述，若照片中沒有拍到舌頭則為空字串",
  "constitution": "判斷出的體質類型（例如：氣虛）",
  "reasoning": "簡短說明為什麼判斷是這個體質",
  "recommended_dishes": [
    { "dish_id": 從上方清單中選出的湯品id（數字）, "reason": "為什麼推薦這道湯的簡短說明" }
  ]
}

recommended_dishes 陣列必須包含 2 到 3 項，依推薦程度由高到低排序，且 dish_id 只能是上方清單中出現過的id。

重要提醒：這只是趣味性的養生參考，不是醫療診斷，請在措辭上保持溫和、不誇大、不使用嚇人的疾病用詞。`;

    const result = await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: req.file.mimetype, data: base64Image } }
          ]
        }
      ],
      config: {
        responseMimeType: 'application/json'
      }
    });

    const rawText = result.text;
    let analysis;
    try {
      analysis = JSON.parse(rawText);
    } catch (parseErr) {
      console.error('AI 回傳格式解析失敗:', rawText);
      return res.status(502).json({ error: 'AI 回傳格式異常，請重新嘗試' });
    }

    // 把 AI 選出的 dish_id 對應回真正的湯品資料（含價格、照片），並過濾掉不存在於清單中的 id
    const rawRecs = Array.isArray(analysis.recommended_dishes) ? analysis.recommended_dishes : [];
    const recommendedList = rawRecs
      .map(rd => {
        const dish = dishes.find(d => d.id === rd.dish_id);
        return dish ? { ...dish, reason: rd.reason || '' } : null;
      })
      .filter(Boolean)
      .slice(0, 3);

    // 只有登入會員才把這次分析存進資料庫（訪客的結果不留存，只回傳給前端這一次用）
    // recommended_dish_id 欄位延續原本設計，存「最推薦的第一道」；完整名單另外存進 ai_result
    let recordId = null;
    if (memberId) {
      const [insertResult] = await pool.query(
        `INSERT INTO facial_records
         (member_id, face_features, eye_features, tongue_features, ai_result, recommended_dish_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          memberId,
          JSON.stringify({ description: analysis.face_features }),
          JSON.stringify({ description: analysis.eye_features }),
          JSON.stringify({ description: analysis.tongue_features }),
          JSON.stringify({
            constitution: analysis.constitution,
            reasoning: analysis.reasoning,
            recommended_dishes: recommendedList.map(d => ({ id: d.id, reason: d.reason }))
          }),
          recommendedList[0] ? recommendedList[0].id : null
        ]
      );
      recordId = insertResult.insertId;
    }

    res.status(201).json({
      message: '分析完成',
      record_id: recordId,
      face_features: analysis.face_features,
      eye_features: analysis.eye_features,
      tongue_features: analysis.tongue_features,
      constitution: analysis.constitution,
      reasoning: analysis.reasoning,
      recommended_dishes: recommendedList.map(d => ({
        id: d.id,
        name: d.name,
        price: d.price,
        image_url: d.image_url,
        reason: d.reason
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'AI 分析失敗，請稍後再試' });
  }
});

// GET /api/facial-analysis/mine   查詢自己過去的分析紀錄（需登入）
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const memberId = req.member.member_id;

    const [records] = await pool.query(
      `SELECT fr.id, fr.analyzed_at, fr.face_features, fr.eye_features,
              fr.tongue_features, fr.ai_result, fr.recommended_dish_id,
              d.name AS recommended_dish_name
       FROM facial_records fr
       LEFT JOIN dishes d ON fr.recommended_dish_id = d.id
       WHERE fr.member_id = ?
       ORDER BY fr.analyzed_at DESC`,
      [memberId]
    );

    // 解析每筆紀錄的 ai_result，取出完整推薦湯品清單（含每道的 reason）
    // 舊資料可能是 recommended_dish_ids（純 id 陣列），沒有 reason，一併相容處理
    const allDishIds = new Set();
    const parsed = records.map(r => {
      let aiResult = {};
      // ai_result 目前是文字欄位存 JSON 字串，但同樣做防呆：
      // 如果哪天欄位型別改成 JSON、驅動程式自動解析成物件，這裡也不會爆掉
      if (r.ai_result && typeof r.ai_result === 'object') {
        aiResult = r.ai_result;
      } else {
        try {
          aiResult = JSON.parse(r.ai_result) || {};
        } catch (parseErr) {
          // 除錯用：如果這裡有印出東西，代表 ai_result 存進資料庫的內容不是完整合法的 JSON
          // （很可能是欄位容量不夠被截斷），確認沒問題後可以把這行 log 拿掉
          console.error(`facial_records id=${r.id} 的 ai_result 解析失敗，原始內容:`, r.ai_result);
          aiResult = {};
        }
      }

      const recs = Array.isArray(aiResult.recommended_dishes)
        ? aiResult.recommended_dishes
        : Array.isArray(aiResult.recommended_dish_ids)
          ? aiResult.recommended_dish_ids.map(id => ({ id, reason: '' }))
          : [];

      recs.forEach(rd => allDishIds.add(rd.id));
      return { row: r, aiResult, recs };
    });

    // 一次查出所有紀錄會用到的湯品完整資料（圖片、價格、描述），避免逐筆查詢
    let dishMap = {};
    if (allDishIds.size > 0) {
      const [dishRows] = await pool.query(
        `SELECT id, name, price, image_url, description FROM dishes WHERE id IN (?)`,
        [Array.from(allDishIds)]
      );
      dishMap = Object.fromEntries(dishRows.map(d => [d.id, d]));
    }

    const enriched = parsed.map(({ row, aiResult, recs }) => ({
      id: row.id,
      analyzed_at: row.analyzed_at,
      face_features: row.face_features,
      eye_features: row.eye_features,
      tongue_features: row.tongue_features,
      ai_result: row.ai_result,
      constitution: aiResult.constitution || null,
      reasoning: aiResult.reasoning || '',
      recommended_dish_id: row.recommended_dish_id,
      recommended_dish_name: row.recommended_dish_name,
      // 完整推薦清單，供前端「查看更多」呈現當時的所有推薦湯品與理由
      recommended_dishes: recs
        .map(rd => (dishMap[rd.id] ? { ...dishMap[rd.id], reason: rd.reason || '' } : null))
        .filter(Boolean)
    }));

    res.json(enriched);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

module.exports = router;