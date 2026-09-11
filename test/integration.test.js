import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

test(
  "Autenticación, persistencia y transacciones sobre Neon de pruebas",
  { skip: !process.env.RUN_DB_TESTS },
  async () => {
    assert.ok(
      process.env.DATABASE_URL.includes("ep-steep-star-"),
      "Solo rama de pruebas",
    );
    const { default: app, pool } = await import("../src/server.js");
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = "http://127.0.0.1:" + server.address().port;
    let cookie = "";
    async function call(path, method = "GET", body, override = {}) {
      const r = await fetch(base + "/api" + path, {
        method,
        headers: {
          Origin: base,
          "Content-Type": "application/json",
          Cookie: cookie,
          ...override,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        status: r.status,
        data: await r.json(),
        cookie: r.headers.get("set-cookie"),
      };
    }
    try {
      assert.equal((await call("/rooms")).status, 401);
      assert.equal(
        (
          await call("/auth/login", "POST", {
            email: process.env.ADMIN_EMAIL,
            password: "incorrecta",
          })
        ).status,
        401,
      );
      const login = await call("/auth/login", "POST", {
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD,
      });
      assert.equal(login.status, 200);
      assert.match(login.cookie, /HttpOnly/);
      assert.match(login.cookie, /SameSite=Lax/);
      assert.equal(login.data.token, undefined);
      cookie = login.cookie.split(";")[0];
      assert.equal((await call("/rooms")).status, 200);
      assert.equal((await call("/products")).status, 200);
      assert.equal((await call("/missing")).status, 404);
      assert.equal(
        (
          await call(
            "/rooms",
            "POST",
            {},
            { Origin: "https://example.invalid" },
          )
        ).status,
        403,
      );
      const room = await call("/rooms", "POST", {
        number: "test-" + randomUUID(),
        capacity: 2,
        basePrice: 100,
      });
      assert.equal(room.status, 201);
      const input = {
        guest: { name: "Huésped de prueba" },
        roomId: room.data.id,
        checkin: "2032-01-01",
        checkout: "2032-01-03",
        adults: 1,
        pricePerNight: 100,
      };
      const race = await Promise.all([
        call("/reservations", "POST", input),
        call("/reservations", "POST", input),
      ]);
      assert.deepEqual(
        race.map((x) => x.status).sort(),
        [201, 409],
        JSON.stringify(race),
      );
      const reservation = race.find((x) => x.status === 201).data;
      assert.equal(Number(reservation.total_price), 200);
      assert.ok(
        (await call("/reservations")).data.some((r) => r.id === reservation.id),
      );
      const before = Number(
        (await pool.query("SELECT count(*) FROM payments")).rows[0].count,
      );
      assert.equal(
        (
          await call("/reservations/" + randomUUID() + "/payments", "POST", {
            amount: 10,
            method: "cash",
          })
        ).status,
        400,
      );
      assert.equal(
        Number(
          (await pool.query("SELECT count(*) FROM payments")).rows[0].count,
        ),
        before,
      );
      const day = (
        await pool.query(
          "SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS day",
        )
      ).rows[0].day;
      // A dedicated test cash date avoids modifying production or re-opening historical cash.
      const date = "2032-02-01";
      const existing = (await call("/cash/" + date)).data.closure;
      if (!existing) {
        assert.equal(
          (
            await call("/cash/movements", "POST", {
              kind: "income",
              amount: 100,
              method: "cash",
              description: "Prueba",
              movementDate: date,
            })
          ).status,
          201,
        );
        const close = await call("/cash/" + date + "/close", "POST", {
          openingBalance: 50,
          countedBalance: 140,
        });
        assert.equal(close.status, 200);
        assert.equal(Number(close.data.expected_balance), 150);
        assert.equal(Number(close.data.difference), -10);
      }
      assert.equal(
        (
          await call("/cash/movements", "POST", {
            kind: "income",
            amount: 5,
            method: "cash",
            description: "Bloqueado",
            movementDate: date,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await call("/cash/" + date + "/close", "POST", {
            openingBalance: 0,
            countedBalance: 0,
          })
        ).status,
        409,
      );
      const product = await call("/products", "POST", {
        name: "Prueba " + randomUUID(),
        minimumStock: 1,
        cost: 10,
      });
      assert.equal(product.status, 201);
      assert.equal(
        (
          await call("/products/" + product.data.id + "/movements", "POST", {
            kind: "purchase",
            quantity: 2,
            unitCost: 10,
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await call("/products/" + product.data.id + "/movements", "POST", {
            kind: "consumption",
            quantity: 3,
            unitCost: 10,
          })
        ).status,
        400,
      );
      assert.equal(
        Number(
          (
            await pool.query("SELECT current_stock FROM products WHERE id=$1", [
              product.data.id,
            ])
          ).rows[0].current_stock,
        ),
        2,
      );
      assert.equal((await call("/auth/logout", "POST", {})).status, 200);
      cookie = "";
      assert.equal((await call("/me")).status, 401);
    } finally {
      server.close();
      await pool.end();
    }
  },
);
