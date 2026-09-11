import "dotenv/config";
import express from "express";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";

const { Pool } = pg;
const app = express();
pg.types.setTypeParser(1082, (value) => value);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 8000,
  idleTimeoutMillis: 10000,
  statement_timeout: 15000,
});
pool.on("error", () => console.error("Database pool unavailable"));
const transactions = new AsyncLocalStorage();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jwtSecret = process.env.JWT_SECRET;
const secure = process.env.NODE_ENV === "production" || !!process.env.VERCEL;
const cookieOptions = {
  httpOnly: true,
  secure,
  sameSite: "lax",
  path: "/",
  maxAge: 8 * 60 * 60 * 1000,
};
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.get("origin");
    const expected =
      process.env.APP_ORIGIN || `${req.protocol}://${req.get("host")}`;
    if (
      !origin ||
      origin !== expected ||
      req.get("sec-fetch-site") === "cross-site"
    )
      return res.status(403).json({ error: "Origen no permitido" });
  }
  next();
});
app.use(express.static(path.join(root, "public")));

const roles = {
  admin: "*",
  reception: "reservations",
  cashier: "cash",
  inventory: "inventory",
  readonly: "read",
};
const auth = async (req, res, next) => {
  let session;
  try {
    const value = (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("hotel_session="));
    session = jwt.verify(
      value ? value.slice("hotel_session=".length) : "",
      jwtSecret,
      { algorithms: ["HS256"] },
    );
  } catch {
    return res.status(401).json({ error: "Iniciá sesión para continuar" });
  }
  try {
    const user = (
      await pool.query(
        "SELECT id,email,role FROM users WHERE id=$1 AND active=true",
        [session.sub],
      )
    ).rows[0];
    if (!user) return res.status(401).json({ error: "Sesión inválida" });
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
};
const allow =
  (...needed) =>
  (req, res, next) => {
    if (roles[req.user.role] === "*" || needed.includes(roles[req.user.role]))
      return next();
    res.status(403).json({ error: "No tenés permisos para esta operación" });
  };
const query = (text, params) =>
  (transactions.getStore() || pool).query(text, params);
// Express 4 does not forward rejected async handlers automatically.
for (const method of ["get", "post", "patch"]) {
  const register = app[method].bind(app);
  app[method] = (route, ...handlers) =>
    register(
      route,
      ...handlers.map(
        (handler) => (req, res, next) =>
          Promise.resolve()
            .then(() => handler(req, res, next))
            .catch(next),
      ),
    );
}
app.get("/api/health", async (_, res) => {
  if (!process.env.DATABASE_URL)
    return res
      .status(503)
      .json({ ok: false, error: "DATABASE_URL no está configurada" });
  try {
    await query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res
      .status(503)
      .json({ ok: false, error: "No se puede conectar a PostgreSQL" });
  }
});
async function audit(user, action, entity, entityId, details = {}) {
  await query(
    "INSERT INTO audit_log(user_id,action,entity,entity_id,details) VALUES($1,$2,$3,$4,$5)",
    [user?.id, action, entity, entityId, JSON.stringify(details)],
  );
}
const reservationSchema = z.object({
  guest: z.object({
    name: z.string().trim().min(2),
    document: z.string().optional().default(""),
    phone: z.string().optional().default(""),
    address: z.string().optional().default(""),
  }),
  roomId: z.string().uuid(),
  checkin: z.coerce.date(),
  checkout: z.coerce.date(),
  adults: z.coerce.number().int().positive(),
  children: z.coerce.number().int().nonnegative().default(0),
  status: z
    .enum([
      "pending",
      "confirmed",
      "cancelled",
      "no_show",
      "checked_in",
      "checked_out",
    ])
    .default("pending"),
  source: z.string().default("direct"),
  pricePerNight: z.coerce.number().nonnegative(),
  deposit: z.coerce.number().nonnegative().default(0),
  dueDate: z.string().optional().nullable(),
  notes: z.string().optional().default(""),
});
function dateOnly(d) {
  return d.toISOString().slice(0, 10);
}

app.post("/api/auth/login", async (req, res) => {
  if (!jwtSecret || jwtSecret.length < 32 || !process.env.DATABASE_URL)
    return res.status(503).json({
      error: "El servicio necesita configuración. Contactá al administrador.",
    });
  const body = z
    .object({
      email: z.string().trim().email(),
      password: z.string().min(1).max(256),
    })
    .parse(req.body);
  const user = (
    await query(
      "SELECT id,email,role,password_hash FROM users WHERE email=$1 AND active=true",
      [body.email.toLowerCase()],
    )
  ).rows[0];
  if (!user || !(await bcrypt.compare(body.password, user.password_hash)))
    return res.status(401).json({ error: "Credenciales inválidas" });
  res.cookie(
    "hotel_session",
    jwt.sign({}, jwtSecret, {
      subject: user.id,
      expiresIn: "8h",
      algorithm: "HS256",
    }),
    cookieOptions,
  );
  res.json({ user: { id: user.id, email: user.email, role: user.role } });
});
app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("hotel_session", {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
  });
  res.json({ ok: true });
});
app.get("/api/me", auth, (req, res) => res.json({ user: req.user }));

// Buffer JSON until commit succeeds: a failed audit or payment cannot leave a partial write.
const post = app.post.bind(app),
  patch = app.patch.bind(app);
function atomic(handler) {
  return async (req, res, next) => {
    const client = await pool.connect();
    const send = res.json.bind(res);
    let payload,
      sent = false;
    res.json = (value) => {
      payload = value;
      sent = true;
      return res;
    };
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(71830608)");
      await transactions.run(client, () => handler(req, res, next));
      if (!sent) throw new Error("Missing response");
      await client.query(res.statusCode >= 400 ? "ROLLBACK" : "COMMIT");
      res.json = send;
      send(payload);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      res.json = send;
      throw e;
    } finally {
      client.release();
    }
  };
}
app.post = (route, ...handlers) =>
  post(route, ...handlers.slice(0, -1), atomic(handlers.at(-1)));
app.patch = (route, ...handlers) =>
  patch(route, ...handlers.slice(0, -1), atomic(handlers.at(-1)));
app.get("/api/rooms", auth, async (_, res) =>
  res.json((await query("SELECT * FROM rooms ORDER BY number")).rows),
);
app.post("/api/rooms", auth, allow("reservations"), async (req, res) => {
  try {
    const b = z
      .object({
        number: z.string().min(1),
        floor: z.string().default(""),
        type: z.string().default("standard"),
        capacity: z.coerce.number().int().positive(),
        basePrice: z.coerce.number().nonnegative(),
        status: z
          .enum(["available", "maintenance", "out_of_service"])
          .default("available"),
        notes: z.string().default(""),
      })
      .parse(req.body);
    const r = await query(
      "INSERT INTO rooms(number,floor,type,capacity,base_price,status,notes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [b.number, b.floor, b.type, b.capacity, b.basePrice, b.status, b.notes],
    );
    await audit(req.user, "create", "room", r.rows[0].id, b);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    throw e;
  }
});

app.get("/api/reservations", auth, async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, g.name guest_name,g.document,g.phone,g.address, rm.number room_number FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN rooms rm ON rm.id=r.room_id WHERE ($1='' OR r.status=$1) ORDER BY r.checkin`,
    [req.query.status || ""],
  );
  res.json(rows);
});
app.post("/api/reservations", auth, allow("reservations"), async (req, res) => {
  const client = transactions.getStore();
  try {
    const b = reservationSchema.parse(req.body);
    const nights = Math.ceil((b.checkout - b.checkin) / 86400000);
    if (nights <= 0)
      return res
        .status(400)
        .json({ error: "La salida debe ser posterior a la entrada" });
    const g = await client.query(
      `INSERT INTO guests(name,document,phone,address) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
      [b.guest.name, b.guest.document, b.guest.phone, b.guest.address],
    );
    let guestId = g.rows[0]?.id;
    if (!guestId)
      guestId = (
        await client.query(
          "SELECT id FROM guests WHERE name=$1 AND document=$2 ORDER BY created_at DESC LIMIT 1",
          [b.guest.name, b.guest.document],
        )
      ).rows[0].id;
    const room = (
      await client.query("SELECT capacity,status FROM rooms WHERE id=$1", [
        b.roomId,
      ])
    ).rows[0];
    if (!room) throw new Error("Habitación inexistente");
    if (room.status !== "available")
      throw new Error("La habitación no está disponible");
    if (b.adults + b.children > room.capacity)
      throw new Error("La cantidad de huéspedes supera la capacidad");
    const r = await client.query(
      `INSERT INTO reservations(guest_id,room_id,checkin,checkout,adults,children,status,source,price_per_night,total_price,deposit,due_date,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9::numeric*$10::integer,$11,$12,$13,$14) RETURNING *`,
      [
        guestId,
        b.roomId,
        dateOnly(b.checkin),
        dateOnly(b.checkout),
        b.adults,
        b.children,
        b.status,
        b.source,
        b.pricePerNight,
        nights,
        b.deposit,
        b.dueDate || null,
        b.notes,
        req.user.id,
      ],
    );
    await audit(req.user, "create", "reservation", r.rows[0].id, b);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    throw e;
  } finally {
    /* outer transaction owns release */
  }
});
app.patch(
  "/api/reservations/:id/status",
  auth,
  allow("reservations"),
  async (req, res) => {
    try {
      const status = z
        .object({
          status: z.enum([
            "pending",
            "confirmed",
            "cancelled",
            "no_show",
            "checked_in",
            "checked_out",
          ]),
        })
        .parse(req.body).status;
      const r = await query(
        "UPDATE reservations SET status=$1,updated_at=now() WHERE id=$2 RETURNING *",
        [status, req.params.id],
      );
      if (!r.rows[0]) return res.status(404).json({ error: "No encontrado" });
      await audit(req.user, "status_change", "reservation", req.params.id, {
        status,
      });
      res.json(r.rows[0]);
    } catch (e) {
      throw e;
    }
  },
);
app.post(
  "/api/reservations/:id/payments",
  auth,
  allow("cash"),
  async (req, res) => {
    try {
      const b = z
        .object({
          amount: z.coerce.number().positive(),
          method: z.enum([
            "cash",
            "transfer",
            "debit",
            "credit",
            "booking",
            "other",
          ]),
          notes: z.string().default(""),
        })
        .parse(req.body);
      if (
        !(
          await query("SELECT 1 FROM reservations WHERE id=$1", [req.params.id])
        ).rowCount
      )
        return res.status(404).json({ error: "Reserva inexistente" });
      const day = (
        await query(
          "SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS day",
        )
      ).rows[0].day;
      if (
        (
          await query(
            "SELECT 1 FROM cash_closures WHERE closure_date=$1 AND closed_at IS NOT NULL",
            [day],
          )
        ).rowCount
      )
        return res.status(409).json({ error: "La caja está cerrada" });
      const r = await query(
        "INSERT INTO payments(reservation_id,amount,method,notes,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [req.params.id, b.amount, b.method, b.notes, req.user.id],
      );
      await query(
        "INSERT INTO cash_movements(kind,amount,method,description,created_by,movement_date) VALUES($1,$2,$3,$4,$5,$6)",
        [
          "income",
          b.amount,
          b.method,
          `Pago de reserva ${req.params.id}`,
          req.user.id,
          day,
        ],
      );
      await audit(req.user, "create", "payment", r.rows[0].id, b);
      res.status(201).json(r.rows[0]);
    } catch (e) {
      throw e;
    }
  },
);

app.get("/api/cash/:date", auth, async (req, res) => {
  const [m, c] = await Promise.all([
    query(
      "SELECT * FROM cash_movements WHERE movement_date=$1 ORDER BY created_at",
      [req.params.date],
    ),
    query("SELECT * FROM cash_closures WHERE closure_date=$1", [
      req.params.date,
    ]),
  ]);
  res.json({ movements: m.rows, closure: c.rows[0] || null });
});
app.post("/api/cash/movements", auth, allow("cash"), async (req, res) => {
  try {
    const b = z
      .object({
        kind: z.enum(["income", "expense", "withdrawal", "adjustment"]),
        amount: z.coerce.number().positive(),
        method: z.enum([
          "cash",
          "transfer",
          "debit",
          "credit",
          "booking",
          "other",
        ]),
        description: z.string().min(2),
        movementDate: z.string(),
      })
      .parse(req.body);
    const closed = (
      await query(
        "SELECT 1 FROM cash_closures WHERE closure_date=$1 AND closed_at IS NOT NULL",
        [b.movementDate],
      )
    ).rowCount;
    if (closed) return res.status(409).json({ error: "La caja está cerrada" });
    const r = await query(
      "INSERT INTO cash_movements(kind,amount,method,description,movement_date,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [b.kind, b.amount, b.method, b.description, b.movementDate, req.user.id],
    );
    await audit(req.user, "create", "cash_movement", r.rows[0].id, b);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    throw e;
  }
});
app.post("/api/cash/:date/close", auth, allow("cash"), async (req, res) => {
  try {
    const b = z
      .object({
        openingBalance: z.coerce.number().nonnegative(),
        countedBalance: z.coerce.number().nonnegative(),
      })
      .parse(req.body);
    if (
      (
        await query(
          "SELECT 1 FROM cash_closures WHERE closure_date=$1 AND closed_at IS NOT NULL",
          [req.params.date],
        )
      ).rowCount
    )
      return res.status(409).json({ error: "La caja ya está cerrada" });
    const net = (
      await query(
        "SELECT COALESCE(sum(CASE WHEN kind='income' THEN amount ELSE -amount END),0) AS net FROM cash_movements WHERE movement_date=$1 AND method='cash'",
        [req.params.date],
      )
    ).rows[0].net;
    const expected = b.openingBalance + Number(net);
    const r = await query(
      "INSERT INTO cash_closures(closure_date,opening_balance,counted_balance,closed_by,closed_at,expected_balance,difference) VALUES($1,$2,$3,$4,now(),$5,$3::numeric-$5::numeric) ON CONFLICT(closure_date) DO UPDATE SET opening_balance=$2,counted_balance=$3,closed_by=$4,closed_at=now(),expected_balance=$5,difference=$3::numeric-$5::numeric RETURNING *",
      [
        req.params.date,
        b.openingBalance,
        b.countedBalance,
        req.user.id,
        expected,
      ],
    );
    await audit(req.user, "close", "cash", req.params.date, b);
    res.json(r.rows[0]);
  } catch (e) {
    throw e;
  }
});

app.get("/api/products", auth, async (_, res) =>
  res.json(
    (
      await query(
        "SELECT *, current_stock <= minimum_stock low_stock FROM products WHERE active=true ORDER BY name",
      )
    ).rows,
  ),
);
app.post("/api/products", auth, allow("inventory"), async (req, res) => {
  try {
    const b = z
      .object({
        name: z.string().min(2),
        category: z.string().default("general"),
        unit: z.string().default("unidad"),
        minimumStock: z.coerce.number().nonnegative(),
        cost: z.coerce.number().nonnegative(),
        supplier: z.string().default(""),
      })
      .parse(req.body);
    const r = await query(
      "INSERT INTO products(name,category,unit,minimum_stock,cost,supplier) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [b.name, b.category, b.unit, b.minimumStock, b.cost, b.supplier],
    );
    await audit(req.user, "create", "product", r.rows[0].id, b);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    throw e;
  }
});
app.post(
  "/api/products/:id/movements",
  auth,
  allow("inventory"),
  async (req, res) => {
    const client = transactions.getStore();
    try {
      const b = z
        .object({
          kind: z.enum(["purchase", "consumption", "adjustment"]),
          quantity: z.coerce.number().refine((n) => n !== 0),
          unitCost: z.coerce.number().nonnegative(),
          reference: z.string().default(""),
        })
        .parse(req.body);
      const p = (
        await client.query(
          "SELECT current_stock FROM products WHERE id=$1 FOR UPDATE",
          [req.params.id],
        )
      ).rows[0];
      if (!p) throw new Error("Producto inexistente");
      const delta =
        b.kind === "consumption"
          ? -Math.abs(b.quantity)
          : b.kind === "purchase"
            ? Math.abs(b.quantity)
            : b.quantity;
      if (Number(p.current_stock) + delta < 0)
        throw new Error("El movimiento dejaría stock negativo");
      const m = await client.query(
        "INSERT INTO inventory_movements(product_id,kind,quantity,unit_cost,reference,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [req.params.id, b.kind, delta, b.unitCost, b.reference, req.user.id],
      );
      await client.query(
        "UPDATE products SET current_stock=current_stock+$1 WHERE id=$2",
        [delta, req.params.id],
      );
      await audit(req.user, "create", "inventory_movement", m.rows[0].id, b);
      res.status(201).json(m.rows[0]);
    } catch (e) {
      throw e;
    } finally {
      /* outer transaction owns release */
    }
  },
);

app.get("/api/export", auth, allow("read"), async (_, res) => {
  const data = {
    reservations: (await query("SELECT * FROM reservations")).rows,
    guests: (await query("SELECT * FROM guests")).rows,
    rooms: (await query("SELECT * FROM rooms")).rows,
    payments: (await query("SELECT * FROM payments")).rows,
    cash: (await query("SELECT * FROM cash_movements")).rows,
    closures: (await query("SELECT * FROM cash_closures")).rows,
    products: (await query("SELECT * FROM products")).rows,
    inventory: (await query("SELECT * FROM inventory_movements")).rows,
    audit: (await query("SELECT * FROM audit_log")).rows,
  };
  res.json(data);
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});
app.post(
  "/api/import/csv",
  auth,
  allow("admin"),
  upload.single("file"),
  async (req, res) => {
    const client = transactions.getStore();
    try {
      if (!req.file)
        return res.status(400).json({ error: "Falta el archivo CSV" });
      const lines = req.file.buffer
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .filter(Boolean);
      const cells = (l) =>
        l.split(";").map((x) => x.replace(/^"|"$/g, "").replace(/""/g, '"'));
      const headers = cells(lines[0]).map((x) => x.trim().toLowerCase());
      const at = (row, ...names) => {
        const i = names.map((n) => headers.indexOf(n)).find((i) => i >= 0);
        return i >= 0 ? row[i]?.trim() || "" : "";
      };
      let imported = 0,
        skipped = 0;
      for (const line of lines.slice(1)) {
        const row = cells(line);
        const name = at(row, "nombre");
        const roomNumber = at(row, "habitación", "habitacion");
        const checkin = at(row, "entrada");
        const checkout = at(row, "salida");
        if (!name || !roomNumber || !checkin || !checkout) {
          skipped++;
          continue;
        }
        const room = (
          await client.query("SELECT id,capacity FROM rooms WHERE number=$1", [
            roomNumber,
          ])
        ).rows[0];
        if (!room) {
          skipped++;
          continue;
        }
        const conflict = await client.query(
          "SELECT 1 FROM reservations WHERE room_id=$1 AND status NOT IN ('cancelled','no_show') AND daterange(checkin,checkout,'[)') && daterange($2::date,$3::date,'[)')",
          [room.id, checkin, checkout],
        );
        if (conflict.rowCount) {
          skipped++;
          continue;
        }
        const g = (
          await client.query(
            "INSERT INTO guests(name,document,phone,address) VALUES($1,$2,$3,$4) RETURNING id",
            [
              name,
              at(row, "documento"),
              at(row, "teléfono", "telefono"),
              at(row, "dirección", "direccion"),
            ],
          )
        ).rows[0];
        const total =
          Number(
            (at(row, "precio") || "0")
              .replace(/[^0-9,.-]/g, "")
              .replace(",", "."),
          ) || 0;
        await client.query(
          `INSERT INTO reservations(guest_id,room_id,checkin,checkout,adults,children,status,source,total_price,notes,created_by) VALUES($1,$2,$3,$4,$5,0,'pending',$6,$7,$8,$9)`,
          [
            g.id,
            room.id,
            checkin,
            checkout,
            Math.max(1, Number(at(row, "personas")) || 1),
            at(row, "origen") || "legacy",
            total,
            at(row, "notas"),
            req.user.id,
          ],
        );
        imported++;
      }
      await audit(req.user, "import", "reservation", null, {
        imported,
        skipped,
      });
      res.json({
        imported,
        skipped,
        message:
          "Importación completada. Las filas omitidas deben revisarse manualmente.",
      });
    } catch (e) {
      throw e;
    } finally {
      /* outer transaction owns release */
    }
  },
);

app.use("/api", (_, res) =>
  res.status(404).json({ error: "Ruta no encontrada" }),
);
app.use((err, req, res, next) => {
  console.error("Request failed:", err.code || err.name);
  if (res.headersSent) return next(err);
  if (err instanceof z.ZodError)
    return res.status(400).json({
      error: "Datos inválidos",
      fields: err.issues.map((x) => x.path.join(".")),
    });
  if (err.code === "23P01")
    return res
      .status(409)
      .json({ error: "La habitación ya está reservada en esas fechas" });
  if (["23503", "23505", "23514", "22P02", "22007", "22008"].includes(err.code))
    return res
      .status(400)
      .json({ error: "Datos inválidos o registro duplicado" });
  const known = [
    "Habitación inexistente",
    "La habitación no está disponible",
    "La cantidad de huéspedes supera la capacidad",
    "Producto inexistente",
    "El movimiento dejaría stock negativo",
  ];
  if (known.includes(err.message))
    return res.status(400).json({ error: err.message });
  res
    .status(503)
    .json({ error: "No se pudo completar la operación. Intentá nuevamente." });
});
export { pool };
export default app;
