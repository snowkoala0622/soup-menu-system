// 透過 Brevo 的 HTTPS API 寄信。
// 不用 SMTP：Render 免費方案會擋掉 25 / 465 / 587 這些寄信 port，走 HTTPS(443) 則不受影響。
// 需要的環境變數（本機放 .env，Render 放 Environment）：
//   BREVO_API_KEY        Brevo 後台建立的 API 金鑰
//   BREVO_SENDER_EMAIL   在 Brevo 驗證過的寄件信箱
//   BREVO_SENDER_NAME    寄件人顯示名稱（選填，預設「補湯菜單」）

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

async function sendMail({ to, subject, html, text }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail) {
    throw new Error('尚未設定 BREVO_API_KEY 或 BREVO_SENDER_EMAIL 環境變數');
  }

  const res = await fetch(BREVO_ENDPOINT, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey
    },
    body: JSON.stringify({
      sender: { name: process.env.BREVO_SENDER_NAME || '補湯菜單', email: senderEmail },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text
    }),
    signal: AbortSignal.timeout(10000) // 最多等 10 秒，避免卡住整個請求
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Brevo 寄信失敗 (HTTP ${res.status}): ${detail}`);
  }
}

// purpose: 'verify' = 註冊驗證信箱，'reset' = 忘記密碼
async function sendCodeMail({ to, code, purpose, ttlMinutes }) {
  const isReset = purpose === 'reset';
  const title = isReset ? '重設密碼驗證碼' : '註冊信箱驗證碼';
  const intro = isReset
    ? '你正在重設「補湯菜單」的會員密碼，請輸入下面的驗證碼：'
    : '歡迎註冊「補湯菜單」會員，請輸入下面的驗證碼完成信箱驗證：';

  const html = `
    <div style="font-family:'Noto Sans TC',Arial,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#2B2620;">
      <h2 style="margin:0 0 12px;">${title}</h2>
      <p style="margin:0 0 18px;line-height:1.6;">${intro}</p>
      <div style="font-size:32px;font-weight:700;letter-spacing:10px;background:#F5F0E5;border-radius:8px;padding:16px;text-align:center;">${code}</div>
      <p style="margin:18px 0 0;font-size:13px;color:#6B6255;line-height:1.6;">
        驗證碼 ${ttlMinutes} 分鐘內有效。如果不是你本人操作，請直接忽略這封信，你的帳號不會有任何變動。
      </p>
    </div>`;
  const text = `${title}：${code}（${ttlMinutes} 分鐘內有效）。如果不是你本人操作，請忽略這封信。`;

  await sendMail({ to, subject: `【補湯菜單】${title}`, html, text });
}

module.exports = { sendMail, sendCodeMail };