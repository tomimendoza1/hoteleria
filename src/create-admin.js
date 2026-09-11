import "dotenv/config";
import bcrypt from "bcryptjs";
import pg from "pg";
const { Pool } = pg;
const email = process.env.ADMIN_EMAIL,
  password = process.env.ADMIN_PASSWORD;
if (!email || !password || password.length < 16) {
  console.error(
    "Configure ADMIN_EMAIL y ADMIN_PASSWORD (mínimo 16 caracteres) en el entorno privado",
  );
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000,
});
const hash = await bcrypt.hash(password, 12);
const result = await pool.query(
  "INSERT INTO users(email,password_hash,role) VALUES($1,$2,$3) ON CONFLICT(email) DO NOTHING",
  [email.toLowerCase(), hash, "admin"],
);
await pool.end();
console.log(
  result.rowCount
    ? "Administrador creado"
    : "Cuenta existente conservada sin cambios",
);
