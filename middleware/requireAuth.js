const jwt = require('jsonwebtoken');

// 驗證請求是否帶有合法的登入憑證
// 用法：在需要登入保護的路由加上這個中介層
// 例如：router.get('/my-orders', requireAuth, async (req, res) => {...})
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization; // 格式：Bearer xxxxxx

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '請先登入' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.member = decoded; // 把解碼出的會員資訊掛在 req 上，後面的路由可以直接用
    next();
  } catch (err) {
    return res.status(401).json({ error: '登入憑證已過期或無效，請重新登入' });
  }
}

module.exports = requireAuth;