const jwt = require('jsonwebtoken');

// 與 requireAuth 不同：有帶合法 token 就解析出 req.member，
// 沒帶 token（訪客）或 token 無效，都放行、req.member 設為 null，
// 而不是回 401。讓「非會員也能用」但登入者仍可留下紀錄。
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.member = null;
    return next();
  }

  const token = authHeader.split(' ')[1];

  try {
    req.member = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    req.member = null; // 憑證過期或無效，當作訪客處理，不擋請求
  }

  next();
}

module.exports = optionalAuth;