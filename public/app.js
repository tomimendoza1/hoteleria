const $ = (id) => document.getElementById(id),
  esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
let user = null,
  rooms = [],
  reservations = [],
  products = [];
async function api(url, opt = {}) {
  const r = await fetch("/api" + url, {
    ...opt,
    headers: { "Content-Type": "application/json", ...(opt.headers || {}) },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(d.error || "Error de servidor");
  return d;
}
function flash(s, bad = false) {
  $("flash").textContent = s;
  $("flash").className = bad ? "error" : "";
  setTimeout(() => {
    $("flash").textContent = "";
  }, 5000);
}
function show(view) {
  document.querySelectorAll(".view").forEach((x) => (x.hidden = x.id !== view));
  document
    .querySelectorAll("nav button")
    .forEach((x) => x.classList.toggle("active", x.dataset.view === view));
  if (view === "dashboard") dashboard();
  if (view === "reservations") loadReservations();
  if (view === "rooms") renderRooms();
  if (view === "stock") loadProducts();
  if (view === "cash") loadCash();
}
async function login(e) {
  e.preventDefault();
  const button = $("loginForm").querySelector("button");
  button.disabled = true;
  $("loginError").textContent = "Ingresando…";
  try {
    const d = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: $("email").value.trim(),
        password: $("password").value,
      }),
    });
    user = d.user;
    $("password").value = "";
    await boot();
  } catch (e) {
    $("loginError").textContent = e.message;
  } finally {
    button.disabled = false;
  }
}
async function boot() {
  try {
    user = (await api("/me")).user;
    [rooms, reservations, products] = await Promise.all([
      api("/rooms"),
      api("/reservations"),
      api("/products"),
    ]);
    $("login").hidden = true;
    $("panel").hidden = false;
    $("userInfo").textContent = `${user.email} · ${user.role}`;
    $("loginError").textContent = "";
    show("dashboard");
  } catch (e) {
    user = null;
    $("panel").hidden = true;
    $("login").hidden = false;
    $("loginError").textContent = e.message;
  }
}
function dashboard() {
  $("dashReservations").textContent = reservations.length;
  $("dashRooms").textContent = rooms.length;
  $("dashLow").textContent = products.filter((x) => x.low_stock).length;
}
async function loadReservations() {
  reservations = await api("/reservations");
  $("reservationList").innerHTML =
    reservations
      .map(
        (r) =>
          `<div class="row"><div><b>${esc(r.guest_name)}</b><br><small>Hab. ${esc(r.room_number)} · ${r.checkin} → ${r.checkout} · $${Number(r.total_price).toLocaleString("es-AR")}</small></div><span class="badge">${esc(r.status)}</span><select data-status="${r.id}"><option value="">Cambiar estado</option><option value="confirmed">Confirmada</option><option value="checked_in">Check-in</option><option value="checked_out">Check-out</option><option value="cancelled">Cancelada</option></select></div>`,
      )
      .join("") || "<p>No hay reservas.</p>";
  document.querySelectorAll("[data-status]").forEach(
    (x) =>
      (x.onchange = async () => {
        if (!x.value) return;
        try {
          await api(`/reservations/${x.dataset.status}/status`, {
            method: "PATCH",
            body: JSON.stringify({ status: x.value }),
          });
          loadReservations();
        } catch (e) {
          flash(e.message, true);
        }
      }),
  );
}
function renderRooms() {
  $("roomList").innerHTML = rooms
    .map(
      (r) =>
        `<div class="row"><b>Hab. ${esc(r.number)}</b><span>${esc(r.type)} · capacidad ${r.capacity} · $${Number(r.base_price).toLocaleString("es-AR")}</span><span class="badge">${esc(r.status)}</span></div>`,
    )
    .join("");
}
async function loadProducts() {
  products = await api("/products");
  $("productList").innerHTML =
    products
      .map(
        (p) =>
          `<div class="row"><div><b>${esc(p.name)}</b><br><small>${esc(p.category)} · ${p.current_stock} ${esc(p.unit)} · mínimo ${p.minimum_stock}</small></div><span class="${p.low_stock ? "low" : ""}">${p.low_stock ? "Stock bajo" : "OK"}</span></div>`,
      )
      .join("") || "<p>No hay productos.</p>";
  dashboard();
}
async function loadCash() {
  const date = $("cashDate").value;
  const d = await api(`/cash/${date}`);
  let total = d.movements.reduce(
    (s, m) => s + (m.kind === "income" ? 1 : -1) * Number(m.amount),
    0,
  );
  $("cashSummary").innerHTML =
    `<div class="card"><b>Movimientos: ${d.movements.length}</b><br>Variación del día: $${total.toLocaleString("es-AR")}<br>Estado: ${d.closure?.closed_at ? "Cerrada" : "Abierta"}</div>`;
  $("closeCash").disabled = !!d.closure?.closed_at;
}
function open(id) {
  $(id).showModal();
}
function close(id) {
  $(id).close();
}
$("loginForm").onsubmit = login;
$("logout").onclick = async () => {
  try {
    await api("/auth/logout", { method: "POST", body: "{}" });
    location.reload();
  } catch (e) {
    flash(e.message, true);
  }
};
document
  .querySelectorAll("nav button")
  .forEach((b) => (b.onclick = () => show(b.dataset.view)));
$("cashDate").value = new Date().toISOString().slice(0, 10);
$("newReservation").onclick = () => {
  $("roomId").innerHTML = rooms
    .filter((r) => r.status === "available")
    .map(
      (r) =>
        `<option value="${r.id}">${esc(r.number)} · ${esc(r.type)}</option>`,
    )
    .join("");
  open("reservationDialog");
};
$("cancelReservation").onclick = () => close("reservationDialog");
$("reservationForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/reservations", {
      method: "POST",
      body: JSON.stringify({
        guest: {
          name: $("guestName").value,
          document: $("guestDocument").value,
          phone: $("guestPhone").value,
        },
        roomId: $("roomId").value,
        checkin: $("checkin").value,
        checkout: $("checkout").value,
        adults: $("adults").value,
        children: $("children").value,
        status: $("status").value,
        pricePerNight: $("pricePerNight").value,
        deposit: $("deposit").value,
        notes: $("notes").value,
      }),
    });
    close("reservationDialog");
    await loadReservations();
    dashboard();
    flash("Reserva guardada");
  } catch (x) {
    $("reservationError").textContent = x.message;
  }
};
$("newRoom").onclick = () => open("roomDialog");
$("cancelRoom").onclick = () => close("roomDialog");
$("roomForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/rooms", {
      method: "POST",
      body: JSON.stringify({
        number: $("roomNumber").value,
        floor: $("roomFloor").value,
        type: $("roomType").value,
        capacity: $("roomCapacity").value,
        basePrice: $("roomPrice").value,
      }),
    });
    close("roomDialog");
    rooms = await api("/rooms");
    renderRooms();
    dashboard();
  } catch (x) {
    flash(x.message, true);
  }
};
$("cashForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/cash/movements", {
      method: "POST",
      body: JSON.stringify({
        kind: $("cashKind").value,
        amount: $("cashAmount").value,
        method: $("cashMethod").value,
        description: $("cashDescription").value,
        movementDate: $("cashDate").value,
      }),
    });
    e.target.reset();
    loadCash();
  } catch (x) {
    flash(x.message, true);
  }
};
$("cashDate").onchange = loadCash;
$("closeCash").onclick = async () => {
  const counted = prompt("Saldo contado:");
  if (counted !== null)
    try {
      await api(`/cash/${$("cashDate").value}/close`, {
        method: "POST",
        body: JSON.stringify({
          openingBalance: $("cashOpening").value || 0,
          countedBalance: counted,
        }),
      });
      loadCash();
    } catch (x) {
      flash(x.message, true);
    }
};
$("newProduct").onclick = () => open("productDialog");
$("cancelProduct").onclick = () => close("productDialog");
$("productForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/products", {
      method: "POST",
      body: JSON.stringify({
        name: $("productName").value,
        category: $("productCategory").value,
        unit: $("productUnit").value,
        minimumStock: $("productMinimum").value,
        cost: $("productCost").value,
        supplier: $("productSupplier").value,
      }),
    });
    close("productDialog");
    loadProducts();
  } catch (x) {
    flash(x.message, true);
  }
};
$("downloadExport").onclick = async () => {
  const d = await api("/export");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }),
  );
  a.download = `hotel-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
};
$("previewCsv").onclick = async () => {
  const f = $("csvFile").files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append("file", f);
  const r = await fetch("/api/import/csv", { method: "POST", body: fd });
  const d = await r.json();
  $("importResult").textContent =
    d.error || `${d.imported} filas importadas; ${d.skipped} omitidas.`;
};
boot();
window.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  flash(e.reason?.message || "No se pudo completar la operación", true);
});
