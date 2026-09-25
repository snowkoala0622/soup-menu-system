require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');

// Aiven（以及多數雲端代管 MySQL）強制要求 SSL 連線；
// 本機 MySQL 沒有這個限制，所以用一個環境變數決定要不要開啟 SSL，
// 本機跑的話不用設 DB_SSL_CA，雲端上再設定即可。
const sslOption = process.env.DB_SSL_CA
  ? { ca: fs.readFileSync(process.env.DB_SSL_CA) }
  : undefined;

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  ssl: sslOption,
  waitForConnections: true,
  connectionLimit: 10,
});

module.exports = pool;