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
  depositInvoice: z.coerce.boolean().default(false),
  dueDate: z.string().optional().nullable(),
  notes: z.string().optional().default(""),
  invoice: z.coerce.boolean().default(false),
  paymentMethod: z.enum(["cash", "transfer", "debit", "credit", "booking", "other"]).default("other"),
  paid: z.coerce.boolean().default(false),
});
function dateOnly(d) {
  return d.toISOString().slice(0, 10);
}
const paymentMethodSchema = z.enum(["cash", "transfer", "debit", "credit", "booking", "other"]);
const cashDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const date=new Date(`${value}T00:00:00Z`); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10)===value; }, "Fecha inválida");
async function reservationBalance(id, db = query) {
  const r = await db(`SELECT r.id,r.total_price lodging_total,
    COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.reservation_id=r.id AND p.category='lodging'),0) lodging_paid_rows,
    CASE WHEN NOT EXISTS (SELECT 1 FROM payments p WHERE p.reservation_id=r.id AND p.category='lodging') THEN r.deposit ELSE 0 END legacy_deposit,
    COALESCE((SELECT sum(c.amount) FROM reservation_consumptions c WHERE c.reservation_id=r.id),0) consumption_total,
    COALESCE((SELECT sum(CASE WHEN p.id IS NOT NULL THEN p.amount WHEN c.charged_on IS NOT NULL THEN c.amount ELSE 0 END) FROM reservation_consumptions c LEFT JOIN payments p ON p.consumption_id=c.id WHERE c.reservation_id=r.id),0) consumption_paid
    FROM reservations r WHERE r.id=$1`, [id]);
  if (!r.rows[0]) return null;
  const x=r.rows[0]; const lodgingPaid=Number(x.lodging_paid_rows)+Number(x.legacy_deposit); const consumptionTotal=Number(x.consumption_total); const consumptionPaid=Number(x.consumption_paid);
  return {reservationId:x.id,lodgingTotal:Number(x.lodging_total),lodgingPaid,lodgingPending:Math.max(0,Number(x.lodging_total)-lodgingPaid),consumptionTotal,consumptionPaid,consumptionPending:Math.max(0,consumptionTotal-consumptionPaid),total:Math.max(0,Number(x.lodging_total)+consumptionTotal-lodgingPaid-consumptionPaid)};
}
async function ensureCashOpen(db, day) {
  const run=typeof db==='function'?db:(text,params)=>db.query(text,params);
  const row=(await run("SELECT closed_at FROM cash_closures WHERE closure_date=$1",[day])).rows[0];
  if (!row) { const error=new Error("Primero abrí la caja de ese día"); error.status=409; throw error; }
  if (row.closed_at) { const error=new Error("La caja está cerrada"); error.status=409; throw error; }
}
async function insertPayment(db, {reservationId, amount, method, category, consumptionId=null, userId, notes='', movementDate=null}) {
  const run=typeof db==='function'?db:(text,params)=>db.query(text,params);
  const day=movementDate || (await run("SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS day")).rows[0].day;
  await ensureCashOpen(db,day);
  const p=await run("INSERT INTO payments(reservation_id,amount,method,category,consumption_id,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",[reservationId,amount,method,category,consumptionId,notes,userId]);
  await run("INSERT INTO cash_movements(kind,amount,method,description,created_by,movement_date) VALUES('income',$1,$2,$3,$4,$5)",[amount,method,category==='consumption'?`Consumo de reserva ${reservationId}`:`Pago de reserva ${reservationId}`,userId,day]);
  return p.rows[0];
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
app.get("/api/settings", auth, async (_, res) => {
  const row = (await query("SELECT hotel_name FROM hotel_settings WHERE id=1")).rows[0];
  res.json({ hotelName: row?.hotel_name || "Hotelería" });
});
app.patch("/api/settings", auth, allow("admin"), async (req, res) => {
  const body = z.object({ hotelName: z.string().trim().min(2).max(100) }).parse(req.body);
  const row = (await query("UPDATE hotel_settings SET hotel_name=$1,updated_by=$2,updated_at=now() WHERE id=1 RETURNING hotel_name", [body.hotelName, req.user.id])).rows[0];
  if (!row) return res.status(503).json({ error: "La configuración todavía no está disponible" });
  await audit(req.user, "update", "hotel_settings", "1", body);
  res.json({ hotelName: row.hotel_name });
});

// Buffer JSON until commit succeeds: a failed audit or payment cannot leave a partial write.
const post = app.post.bind(app),
  patch = app.patch.bind(app),
  del = app.delete.bind(app);
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
app.delete = (route, ...handlers) =>
  del(route, ...handlers.slice(0, -1), atomic(handlers.at(-1)));
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
app.patch("/api/rooms/:id", auth, allow("reservations"), async (req, res) => {
  const b = z.object({number:z.string().min(1),floor:z.string().default(""),type:z.string().default("standard"),capacity:z.coerce.number().int().positive(),basePrice:z.coerce.number().nonnegative(),status:z.enum(["available","maintenance","out_of_service"]),notes:z.string().default("")}).parse(req.body);
  const r=await query("UPDATE rooms SET number=$1,floor=$2,type=$3,capacity=$4,base_price=$5,status=$6,notes=$7 WHERE id=$8 RETURNING *",[b.number,b.floor,b.type,b.capacity,b.basePrice,b.status,b.notes,req.params.id]);
  if(!r.rows[0]) return res.status(404).json({error:"Habitación inexistente"});
  await audit(req.user,"update","room",req.params.id,b); res.json(r.rows[0]);
});
app.delete("/api/rooms/:id", auth, allow("reservations"), async (req,res) => {
  const r=await query("UPDATE rooms SET status='out_of_service',notes=CASE WHEN notes='' THEN 'Desactivada' ELSE notes END WHERE id=$1 RETURNING id",[req.params.id]);
  if(!r.rows[0]) return res.status(404).json({error:"Habitación inexistente"});
  await audit(req.user,"deactivate","room",req.params.id,{}); res.json({ok:true});
});

app.get("/api/reservations", auth, async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, g.name guest_name,g.document,g.phone,g.address, rm.number room_number,
      COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.reservation_id=r.id AND p.category='lodging'),0)+CASE WHEN NOT EXISTS (SELECT 1 FROM payments p WHERE p.reservation_id=r.id AND p.category='lodging') THEN r.deposit ELSE 0 END AS lodging_paid,
      COALESCE((SELECT sum(c.amount) FROM reservation_consumptions c WHERE c.reservation_id=r.id),0) AS consumption_total,
      COALESCE((SELECT sum(CASE WHEN p.id IS NOT NULL THEN p.amount WHEN c.charged_on IS NOT NULL THEN c.amount ELSE 0 END) FROM reservation_consumptions c LEFT JOIN payments p ON p.consumption_id=c.id WHERE c.reservation_id=r.id),0) AS consumption_paid
      FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN rooms rm ON rm.id=r.room_id WHERE ($1='' OR r.status=$1) ORDER BY r.checkin`,
    [req.query.status || ""],
  );
  res.json(rows.map(r => ({...r, lodging_pending:Math.max(0,Number(r.total_price)-Number(r.lodging_paid)), consumption_pending:Math.max(0,Number(r.consumption_total)-Number(r.consumption_paid)), total_pending:Math.max(0,Number(r.total_price)+Number(r.consumption_total)-Number(r.lodging_paid)-Number(r.consumption_paid))})));
});
app.get("/api/dashboard", auth, async (_, res) => {
  const d = await query(`SELECT
    count(*) FILTER (WHERE date_trunc('month',checkin)=date_trunc('month',CURRENT_DATE) AND status NOT IN ('cancelled','no_show')) monthly_reservations,
    coalesce(sum(adults+children) FILTER (WHERE date_trunc('month',checkin)=date_trunc('month',CURRENT_DATE) AND status NOT IN ('cancelled','no_show')),0) monthly_guests,
    count(*) FILTER (WHERE status='checked_in') staying_reservations,
    coalesce(sum(adults+children) FILTER (WHERE status='checked_in'),0) staying_guests,
    count(*) FILTER (WHERE checkin=CURRENT_DATE AND status NOT IN ('cancelled','no_show')) arrivals,
    count(*) FILTER (WHERE checkout=CURRENT_DATE AND status NOT IN ('cancelled','no_show')) departures
    FROM reservations`).then(x => x.rows[0]);
  const [today, alerts] = await Promise.all([
    query(`SELECT r.id,g.name guest_name,rm.number room_number,r.checkin,r.checkout,r.status,r.adults,r.children FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN rooms rm ON rm.id=r.room_id WHERE r.status='checked_in' OR r.checkin=CURRENT_DATE OR r.checkout=CURRENT_DATE ORDER BY r.checkin`),
    query(`SELECT r.id,g.name guest_name,rm.number room_number,r.checkin,r.total_price,
      COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.reservation_id=r.id AND p.category='lodging'),0)+CASE WHEN NOT EXISTS (SELECT 1 FROM payments p WHERE p.reservation_id=r.id AND p.category='lodging') THEN r.deposit ELSE 0 END AS lodging_paid,
      COALESCE((SELECT sum(c.amount) FROM reservation_consumptions c WHERE c.reservation_id=r.id),0) AS consumption_total,
      COALESCE((SELECT sum(CASE WHEN p.id IS NOT NULL THEN p.amount WHEN c.charged_on IS NOT NULL THEN c.amount ELSE 0 END) FROM reservation_consumptions c LEFT JOIN payments p ON p.consumption_id=c.id WHERE c.reservation_id=r.id),0) AS consumption_paid
      FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN rooms rm ON rm.id=r.room_id WHERE r.status NOT IN ('cancelled','no_show','checked_out') ORDER BY r.checkin LIMIT 50`)
  ]);
  res.json({ metrics:d, today:today.rows, pendingPayments:alerts.rows.map(x => ({...x,lodging_pending:Math.max(0,Number(x.total_price||0)-Number(x.lodging_paid)),consumption_pending:Math.max(0,Number(x.consumption_total)-Number(x.consumption_paid)),balance:Math.max(0,Number(x.total_price||0)+Number(x.consumption_total)-Number(x.lodging_paid)-Number(x.consumption_paid))})).filter(x => x.balance > 0) });
});
app.get("/api/reservations/:id/balance", auth, async (req,res) => {
  const balance=await reservationBalance(req.params.id);
  if(!balance) return res.status(404).json({error:"Reserva inexistente"});
  res.json(balance);
});
app.get("/api/reservations/:id/payments", auth, async (req,res) => {
  if(!(await query("SELECT 1 FROM reservations WHERE id=$1",[req.params.id])).rowCount) return res.status(404).json({error:"Reserva inexistente"});
  res.json((await query("SELECT * FROM payments WHERE reservation_id=$1 ORDER BY paid_at",[req.params.id])).rows);
});
app.get("/api/calendar", auth, async (req, res) => {
  const from = req.query.from || dateOnly(new Date());
  const days = Math.min(31, Math.max(7, Number(req.query.days) || 7));
  const { rows } = await query(`SELECT r.*,g.name guest_name,rm.number room_number,rm.status room_status,
    COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.reservation_id=r.id AND p.category='lodging'),0)+CASE WHEN NOT EXISTS (SELECT 1 FROM payments p WHERE p.reservation_id=r.id AND p.category='lodging') THEN r.deposit ELSE 0 END AS lodging_paid
    FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN rooms rm ON rm.id=r.room_id WHERE r.checkin < ($1::date + $2::int) AND r.checkout > $1::date AND r.status NOT IN ('cancelled','no_show') ORDER BY rm.number,r.checkin`, [from,days]);
  res.json({from,days,reservations:rows});
});
app.get("/api/guests", auth, async (_, res) => {
  const { rows } = await query(`SELECT g.*,count(r.id)::int reservations_count,max(r.checkout) last_stay FROM guests g LEFT JOIN reservations r ON r.guest_id=g.id GROUP BY g.id ORDER BY g.name`);
  res.json(rows);
});
app.get("/api/statistics", auth, async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const { rows } = await query(`SELECT EXTRACT(MONTH FROM checkin)::int month, count(*)::int reservations, COALESCE(sum(adults+children),0)::int guests, COALESCE(sum(checkout-checkin),0)::int nights, COALESCE(sum(total_price),0) revenue FROM reservations WHERE EXTRACT(YEAR FROM checkin)=$1 AND status NOT IN ('cancelled','no_show') GROUP BY 1 ORDER BY 1`, [year]);
  res.json({year,months:rows});
});
app.post("/api/reservations", auth, allow("reservations"), async (req, res) => {
  const client = transactions.getStore();
  try {
    const b = reservationSchema.parse(req.body);
    if (b.source === "booking" && b.deposit > 0)
      return res.status(400).json({error:"Las reservas de Booking no llevan seña ni anticipo"});
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
      `INSERT INTO reservations(guest_id,room_id,checkin,checkout,adults,children,status,source,price_per_night,total_price,deposit,deposit_invoice,due_date,notes,invoice,payment_method,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9::numeric*$10::integer,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
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
        b.depositInvoice,
        b.dueDate || null,
        b.notes,
        b.invoice,
        b.paymentMethod,
        req.user.id,
      ],
    );
    await audit(req.user, "create", "reservation", r.rows[0].id, b);
    // La casilla de alojamiento abonado completo siempre tiene prioridad sobre la seña.
    // La seña queda guardada como antecedente, pero no debe impedir registrar el saldo restante.
    const initialPayment = b.paid ? Number(r.rows[0].total_price) : Number(b.deposit || 0);
    if (initialPayment > Number(r.rows[0].total_price)) return res.status(400).json({error:"El pago no puede superar el total del alojamiento"});
    if (initialPayment > 0) {
      const payment = await insertPayment(client, {reservationId:r.rows[0].id, amount:initialPayment, method:b.paymentMethod, category:"lodging", userId:req.user.id, notes:"Pago inicial de alojamiento"});
      await audit(req.user, "create", "payment", payment.id, {reservationId:r.rows[0].id, amount:initialPayment, category:"lodging"});
    }
    res.status(201).json(r.rows[0]);
  } catch (e) {
    throw e;
  } finally {
    /* outer transaction owns release */
  }
});
app.patch("/api/reservations/:id", auth, allow("reservations"), async (req, res) => {
  const b = reservationSchema.parse(req.body);
  if (b.source === "booking" && b.deposit > 0)
    return res.status(400).json({error:"Las reservas de Booking no llevan seña ni anticipo"});
  const nights = Math.ceil((b.checkout-b.checkin)/86400000);
  if (nights <= 0) return res.status(400).json({error:"La salida debe ser posterior a la entrada"});
  const old = (await query("SELECT * FROM reservations WHERE id=$1",[req.params.id])).rows[0];
  if (!old) return res.status(404).json({error:"No encontrado"});
  const g = await query("UPDATE guests SET name=$1,document=$2,phone=$3,address=$4 WHERE id=$5 RETURNING id",[b.guest.name,b.guest.document,b.guest.phone,b.guest.address,old.guest_id]);
  const room = (await query("SELECT capacity,status FROM rooms WHERE id=$1",[b.roomId])).rows[0];
  if (!room) return res.status(400).json({error:"Habitación inexistente"});
  if (room.status !== 'available') return res.status(400).json({error:"La habitación no está disponible"});
  if (b.adults+b.children > room.capacity) return res.status(400).json({error:"La cantidad de huéspedes supera la capacidad"});
  const newTotal=Number(b.pricePerNight)*nights;
  const current=await reservationBalance(req.params.id);
  const paymentRows=await query("SELECT count(*)::int count FROM payments WHERE reservation_id=$1 AND category='lodging'",[req.params.id]);
  const currentPaid=current.lodgingPaid;
  // Al marcar abonado completo se registra el total, incluso si la reserva ya tenía una seña.
  // Si no está abonado completo, se conserva el pago acumulado o se registra la nueva seña.
  const targetPaid=b.paid ? newTotal : (b.deposit>0 ? Number(b.deposit) : currentPaid);
  if(targetPaid>newTotal) return res.status(400).json({error:"El pago no puede superar el total del alojamiento"});
  if(targetPaid<currentPaid) return res.status(409).json({error:"No se puede reducir un importe ya pagado; registrá una corrección contable"});
  const r = await query(`UPDATE reservations SET room_id=$1,checkin=$2,checkout=$3,adults=$4,children=$5,status=$6,source=$7,price_per_night=$8,total_price=($8::numeric*$9::integer),deposit=$10,deposit_invoice=$11,due_date=$12,notes=$13,invoice=$14,payment_method=$15,updated_at=now() WHERE id=$16 RETURNING *`,[b.roomId,dateOnly(b.checkin),dateOnly(b.checkout),b.adults,b.children,b.status,b.source,b.pricePerNight,nights,b.deposit,b.depositInvoice,b.dueDate||null,b.notes,b.invoice,b.paymentMethod,req.params.id]);
  if(targetPaid>currentPaid){
    const amount=Number(paymentRows.rows[0].count)===0 && currentPaid>0?targetPaid:targetPaid-currentPaid;
    const payment=await insertPayment(transactions.getStore(),{reservationId:req.params.id,amount,method:b.paymentMethod,category:"lodging",userId:req.user.id,notes:"Pago adicional de alojamiento"});
    await audit(req.user,"create","payment",payment.id,{reservationId:req.params.id,amount,category:"lodging"});
  }
  await audit(req.user,"update","reservation",req.params.id,b); res.json(r.rows[0]);
});
app.post("/api/reservations/:id/consumptions", auth, allow("reservations"), async (req,res) => {
  const client=transactions.getStore();
  const b=z.object({description:z.string().min(2),amount:z.coerce.number().positive(),consumedOn:z.string(),chargedOn:z.string().nullable().optional(),method:paymentMethodSchema.default("other")}).parse(req.body);
  if (!(await client.query("SELECT 1 FROM reservations WHERE id=$1",[req.params.id])).rowCount) return res.status(404).json({error:"Reserva inexistente"});
  const r=await client.query("INSERT INTO reservation_consumptions(reservation_id,description,amount,consumed_on,charged_on,method,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",[req.params.id,b.description,b.amount,b.consumedOn,b.chargedOn||null,b.method,req.user.id]);
  if(b.chargedOn){
    const payment=await insertPayment(client,{reservationId:req.params.id,amount:b.amount,method:b.method,category:"consumption",consumptionId:r.rows[0].id,userId:req.user.id,notes:`Pago de consumo: ${b.description}`,movementDate:b.chargedOn});
    await client.query("UPDATE reservation_consumptions SET payment_id=$1 WHERE id=$2",[payment.id,r.rows[0].id]);
  }
  await audit(req.user,"create","consumption",r.rows[0].id,b); res.status(201).json(r.rows[0]);
});
app.get("/api/reservations/:id/consumptions", auth, async (req,res) => {
  res.json((await query("SELECT c.*,p.id paid_payment_id,p.paid_at,p.method paid_method FROM reservation_consumptions c LEFT JOIN payments p ON p.consumption_id=c.id WHERE c.reservation_id=$1 ORDER BY c.consumed_on,c.created_at",[req.params.id])).rows);
});
app.patch("/api/consumptions/:id/pay", auth, allow("cash"), async (req,res) => {
  const client=transactions.getStore();
  const b=z.object({paidOn:z.string(),method:paymentMethodSchema}).parse(req.body);
  const c=(await client.query("SELECT * FROM reservation_consumptions WHERE id=$1 FOR UPDATE",[req.params.id])).rows[0];
  if(!c) return res.status(404).json({error:"Consumo inexistente"});
  if(c.payment_id || (await client.query("SELECT 1 FROM payments WHERE consumption_id=$1",[c.id])).rowCount) return res.status(409).json({error:"El consumo ya está pagado"});
  const payment=await insertPayment(client,{reservationId:c.reservation_id,amount:Number(c.amount),method:b.method,category:"consumption",consumptionId:c.id,userId:req.user.id,notes:`Pago de consumo: ${c.description}`,movementDate:b.paidOn});
  await client.query("UPDATE reservation_consumptions SET payment_id=$1,charged_on=$2 WHERE id=$3",[payment.id,b.paidOn,c.id]);
  await audit(req.user,"pay","consumption",c.id,{amount:c.amount,paidOn:b.paidOn,method:b.method}); res.json({consumptionId:c.id,payment});
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
      const balance=await reservationBalance(req.params.id);
      if (b.amount > balance.lodgingPending) return res.status(400).json({error:"El pago supera el saldo pendiente del alojamiento"});
      const day = (
        await query(
          "SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS day",
        )
      ).rows[0].day;
      await ensureCashOpen(transactions.getStore(), day);
      const r = await query(
        "INSERT INTO payments(reservation_id,amount,method,category,notes,created_by) VALUES($1,$2,$3,'lodging',$4,$5) RETURNING *",
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

app.post("/api/cash/:date/open", auth, allow("cash"), async (req, res) => {
  const date=cashDateSchema.parse(req.params.date);
  const b=z.object({openingBalance:z.coerce.number().nonnegative()}).parse(req.body);
  const existing=(await query("SELECT * FROM cash_closures WHERE closure_date=$1 FOR UPDATE",[date])).rows[0];
  if(existing?.closed_at) return res.status(409).json({error:"La caja ya está cerrada"});
  if(existing) return res.json(existing);
  const r=await query("INSERT INTO cash_closures(closure_date,opening_balance) VALUES($1,$2) RETURNING *",[date,b.openingBalance]);
  await audit(req.user,"open","cash",date,{openingBalance:b.openingBalance});
  res.status(201).json(r.rows[0]);
});
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
    await ensureCashOpen(transactions.getStore(), b.movementDate);
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
    const date=cashDateSchema.parse(req.params.date);
    const b = z
      .object({
        countedBalance: z.coerce.number().nonnegative(),
      })
      .parse(req.body);
    const closure=(await query("SELECT * FROM cash_closures WHERE closure_date=$1 FOR UPDATE",[date])).rows[0];
    if(!closure) return res.status(409).json({error:"Primero abrí la caja de ese día"});
    if(closure.closed_at) return res.status(409).json({error:"La caja ya está cerrada"});
    const net = (
      await query(
        "SELECT COALESCE(sum(CASE WHEN kind='income' THEN amount ELSE -amount END),0) AS net FROM cash_movements WHERE movement_date=$1 AND method='cash'",
        [date],
      )
    ).rows[0].net;
    const expected = Number(closure.opening_balance) + Number(net);
    const r = await query(
      "UPDATE cash_closures SET counted_balance=$1,closed_by=$2,closed_at=now(),expected_balance=$3,difference=$1::numeric-$3::numeric WHERE closure_date=$4 RETURNING *",
      [
        b.countedBalance,
        req.user.id,
        expected,
        date,
      ],
    );
    await audit(req.user, "close", "cash", date, b);
    res.json(r.rows[0]);
  } catch (e) {
    throw e;
  }
});

app.post("/api/cash/:date/reopen", auth, allow("admin"), async (req, res) => {
  const date = cashDateSchema.parse(req.params.date);
  const closure = (await query("SELECT * FROM cash_closures WHERE closure_date=$1 FOR UPDATE", [date])).rows[0];
  if (!closure) return res.status(404).json({error:"No existe un cierre para ese día"});
  if (!closure.closed_at) return res.status(409).json({error:"La caja ya está abierta"});
  const r = await query(
    "UPDATE cash_closures SET counted_balance=NULL,closed_by=NULL,closed_at=NULL,expected_balance=NULL,difference=NULL WHERE closure_date=$1 RETURNING *",
    [date],
  );
  await audit(req.user, "reopen", "cash", date, {
    previousClosedAt: closure.closed_at,
    previousCountedBalance: closure.counted_balance,
    previousExpectedBalance: closure.expected_balance,
    previousDifference: closure.difference,
  });
  res.json(r.rows[0]);
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
app.patch("/api/products/:id", auth, allow("inventory"), async (req,res) => {
  const b=z.object({name:z.string().min(2),category:z.string().default("general"),unit:z.string().default("unidad"),minimumStock:z.coerce.number().nonnegative(),cost:z.coerce.number().nonnegative(),supplier:z.string().default("")}).parse(req.body);
  const r=await query("UPDATE products SET name=$1,category=$2,unit=$3,minimum_stock=$4,cost=$5,supplier=$6 WHERE id=$7 AND active=true RETURNING *",[b.name,b.category,b.unit,b.minimumStock,b.cost,b.supplier,req.params.id]);
  if(!r.rows[0]) return res.status(404).json({error:"Producto inexistente"});
  await audit(req.user,"update","product",req.params.id,b); res.json(r.rows[0]);
});
app.delete("/api/products/:id", auth, allow("inventory"), async (req,res) => {
  const r=await query("UPDATE products SET active=false WHERE id=$1 AND active=true RETURNING id",[req.params.id]);
  if(!r.rows[0]) return res.status(404).json({error:"Producto inexistente"});
  await audit(req.user,"deactivate","product",req.params.id,{}); res.json({ok:true});
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
  if (err.status) return res.status(err.status).json({error:err.message});
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
    "El pago no puede superar el total del alojamiento",
    "El pago supera el saldo pendiente del alojamiento",
    "No se puede reducir un importe ya pagado; registrá una corrección contable",
    "Consumo inexistente",
  ];
  if (known.includes(err.message))
    return res.status(400).json({ error: err.message });
  res
    .status(503)
    .json({ error: "No se pudo completar la operación. Intentá nuevamente." });
});
export { pool };
export default app;
