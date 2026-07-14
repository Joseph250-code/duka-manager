const API_URL = "http://127.0.0.1:8080";


function tickClock() {
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-KE", { year: "numeric", month: "long", day: "numeric" });
    const timeStr = now.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    document.getElementById("todayDate").textContent = `${dateStr} · ${timeStr}`;
}
tickClock();
setInterval(tickClock, 1000);


function getLedgerNumber() {
    return parseInt(localStorage.getItem("dukaLedgerNumber") || "0", 10);
}

function bumpLedgerNumber() {
    const next = getLedgerNumber() + 1;
    localStorage.setItem("dukaLedgerNumber", next);
    renderLedgerNumber();
}

function renderLedgerNumber() {
    document.getElementById("ledgerNumber").textContent = String(getLedgerNumber()).padStart(3, "0");
}

renderLedgerNumber();


function showToast(message, type = "ok") {
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));
    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 300);
    }, 2200);
}

async function apiCall(path, options = {}) {
    try {
        const res = await fetch(`${API_URL}${path}`, options);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showToast(err.error || "Something went wrong", "error");
            return null;
        }
        return await res.json();
    } catch (err) {
        showToast("Can't reach the backend — is it running?", "error");
        return null;
    }
}


const tabBtns = document.querySelectorAll(".tab-btn");
const tabContents = document.querySelectorAll(".tab-content");

function activateTab(tabName) {
    tabBtns.forEach(b => b.classList.remove("active"));
    tabContents.forEach(c => c.classList.remove("active"));
    document.querySelector(`[data-tab="${tabName}"]`).classList.add("active");
    const panel = document.getElementById(tabName + "-tab");
    panel.classList.remove("active");
    void panel.offsetWidth;
    panel.classList.add("active");
}

tabBtns.forEach(btn => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});

function flashRow(row) {
    row.classList.add("row-new");
    setTimeout(() => row.classList.remove("row-new"), 900);
}


async function loadProducts() {
    const products = await apiCall("/products");
    if (!products) return;

    const body = document.getElementById("productsBody");
    body.innerHTML = "";
    let totalStockCount = 0;

    products.forEach(p => {
        totalStockCount += p.stock;
        const row = document.createElement("tr");
        row.innerHTML = `
            <td>${p.name}</td>
            <td class="mono">${p.price.toFixed(2)}</td>
            <td class="mono">${p.stock}</td>
            <td><button class="del-btn" data-id="${p.id}">Remove</button></td>
        `;
        body.appendChild(row);
    });

    document.getElementById("totalStock").textContent = totalStockCount;

    const saleSelect = document.getElementById("saleProduct");
    const prevValue = saleSelect.value;
    saleSelect.innerHTML = products.map(p =>
        `<option value="${p.id}">${p.name} (${p.stock} left)</option>`
    ).join("");
    if (prevValue) saleSelect.value = prevValue;

    body.querySelectorAll(".del-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
            await apiCall(`/products/${btn.dataset.id}`, { method: "DELETE" });
            showToast("Removed from stock");
            loadProducts();
        });
    });
}

document.getElementById("productForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("productName").value;
    const price = parseFloat(document.getElementById("productPrice").value);
    const stock = parseInt(document.getElementById("productStock").value);

    const result = await apiCall("/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, price, stock })
    });

    if (result) {
        e.target.reset();
        showToast(`${name} added to stock`);
        await loadProducts();
        const newRow = [...document.querySelectorAll("#productsBody tr")]
            .find(r => r.firstChild.textContent === name);
        if (newRow) flashRow(newRow);
    }
});


async function loadSales() {
    const sales = await apiCall("/sales");
    if (!sales) return;

    const body = document.getElementById("salesBody");
    body.innerHTML = "";
    let totalToday = 0;
    const today = new Date().toISOString().slice(0, 10);

    sales.forEach(s => {
        if (s.sale_time.startsWith(today)) totalToday += s.total_amount;
        const row = document.createElement("tr");
        row.dataset.id = s.id;
        row.innerHTML = `
            <td>${s.name}</td>
            <td class="mono">${s.quantity}</td>
            <td class="mono">${s.total_amount.toFixed(2)}</td>
            <td class="mono">${s.sale_time}</td>
            <td>${s.matched
                ? '<span class="stamp stamp-matched">Matched</span>'
                : '<span class="stamp stamp-unmatched">Unmatched</span>'}</td>
        `;
        body.appendChild(row);
    });

    document.getElementById("totalSales").textContent = `KES ${totalToday.toFixed(2)}`;
}

document.getElementById("saleForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const product_id = parseInt(document.getElementById("saleProduct").value);
    const quantity = parseInt(document.getElementById("saleQuantity").value);

    const result = await apiCall("/sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id, quantity })
    });

    if (result) {
        e.target.reset();
        showToast(`Sale recorded — KES ${result.total_amount.toFixed(2)}`);
        await loadProducts();
        await loadSales();
        const firstRow = document.querySelector("#salesBody tr");
        if (firstRow) flashRow(firstRow);
    }
});


async function loadMpesa() {
    const txns = await apiCall("/mpesa");
    if (!txns) return;

    const body = document.getElementById("mpesaBody");
    body.innerHTML = "";

    txns.forEach(t => {
        const row = document.createElement("tr");
        row.innerHTML = `
            <td class="mono">${t.mpesa_code}</td>
            <td>${t.sender_name || "—"}</td>
            <td class="mono">${t.amount.toFixed(2)}</td>
            <td class="mono">${t.transaction_time}</td>
            <td>${t.matched
                ? '<span class="stamp stamp-matched">Matched</span>'
                : '<span class="stamp stamp-unmatched">Unmatched</span>'}</td>
        `;
        body.appendChild(row);
    });
}

document.getElementById("mpesaForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const mpesa_code = document.getElementById("mpesaCode").value;
    const sender_name = document.getElementById("mpesaSender").value;
    const amount = parseFloat(document.getElementById("mpesaAmount").value);

    const result = await apiCall("/mpesa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mpesa_code, sender_name, amount })
    });

    if (result) {
        e.target.reset();
        showToast(`Payment logged — KES ${amount.toFixed(2)}`);
        await loadMpesa();
        await updateUnmatchedTotal();
        const firstRow = document.querySelector("#mpesaBody tr");
        if (firstRow) flashRow(firstRow);
    }
});


async function updateUnmatchedTotal() {
    const sales = await apiCall("/sales");
    const mpesa = await apiCall("/mpesa");
    if (!sales || !mpesa) return;

    const unmatchedSales = sales.filter(s => !s.matched).length;
    const unmatchedMpesa = mpesa.filter(t => !t.matched).length;

    document.getElementById("totalUnmatched").textContent = unmatchedSales + unmatchedMpesa;
}


async function runReconcile() {
    const resultsEl = document.getElementById("reconcileResults");
    resultsEl.innerHTML = '<p class="muted">Stamping the books…</p>';

    const data = await apiCall("/reconcile", { method: "POST" });
    if (!data) {
        resultsEl.innerHTML = '<p class="muted">Reconciliation failed — check the backend.</p>';
        return;
    }

    let html = `<div class="recon-summary">${data.matched_count} entr${data.matched_count === 1 ? "y" : "ies"} matched this run</div>`;

    if (data.matched_pairs.length > 0) {
        html += `<div class="recon-section"><h3>Newly matched</h3><table><thead><tr><th>Sale ID</th><th>M-Pesa ID</th><th>Amount</th></tr></thead><tbody>`;
        data.matched_pairs.forEach((p, i) => {
            html += `<tr style="animation-delay:${i * 90}ms"><td class="mono">#${p.sale_id}</td><td class="mono">#${p.mpesa_id}</td><td class="mono"><span class="stamp stamp-matched">KES ${p.amount.toFixed(2)}</span></td></tr>`;
        });
        html += `</tbody></table></div>`;
    }

    if (data.unmatched_sales.length > 0) {
        html += `<div class="recon-section"><h3>Sales with no matching payment</h3><table><thead><tr><th>Item</th><th>Qty</th><th>Amount</th><th>Time</th></tr></thead><tbody>`;
        data.unmatched_sales.forEach(s => {
            html += `<tr><td>${s.name}</td><td class="mono">${s.quantity}</td><td class="mono">KES ${s.total_amount.toFixed(2)}</td><td class="mono">${s.sale_time}</td></tr>`;
        });
        html += `</tbody></table></div>`;
    }

    if (data.unmatched_mpesa.length > 0) {
        html += `<div class="recon-section"><h3>Payments with no matching sale</h3><table><thead><tr><th>Code</th><th>Sender</th><th>Amount</th><th>Time</th></tr></thead><tbody>`;
        data.unmatched_mpesa.forEach(t => {
            html += `<tr><td class="mono">${t.mpesa_code}</td><td>${t.sender_name || "—"}</td><td class="mono">KES ${t.amount.toFixed(2)}</td><td class="mono">${t.transaction_time}</td></tr>`;
        });
        html += `</tbody></table></div>`;
    }

    resultsEl.innerHTML = html;
    showToast(`${data.matched_count} entries reconciled`);
    bumpLedgerNumber();

    loadSales();
    loadMpesa();
    updateUnmatchedTotal();
}

document.getElementById("reconcileBtn").addEventListener("click", runReconcile);
document.getElementById("reconcileBtnTop").addEventListener("click", () => {
    activateTab("reconcile");
    runReconcile();
});


loadProducts();
loadSales();
loadMpesa().then(updateUnmatchedTotal);