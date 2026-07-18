const API_URL = "https://duka-manager.onrender.com";

// ---- AUTH STATE ----
let authMode = "login"; // or "signup"
let productsCache = [];
let clockTimer = null;

const authWrap = document.getElementById("authWrap");
const ledgerApp = document.getElementById("ledgerApp");
const authForm = document.getElementById("authForm");
const authModeLabel = document.getElementById("authModeLabel");
const authSubmitBtn = document.getElementById("authSubmitBtn");
const authToggleText = document.getElementById("authToggleText");
const authToggleLink = document.getElementById("authToggleLink");
const authError = document.getElementById("authError");

function setAuthMode(mode) {
    authMode = mode;

    if (mode === "login") {
        authModeLabel.textContent = "Log in to your ledger";
        authSubmitBtn.textContent = "Log In";
        authToggleText.textContent = "Don't have an account?";
        authToggleLink.textContent = "Sign up";
    } else {
        authModeLabel.textContent = "Create your ledger account";
        authSubmitBtn.textContent = "Sign Up";
        authToggleText.textContent = "Already have an account?";
        authToggleLink.textContent = "Log in";
    }

    authError.textContent = "";
}

authToggleLink.addEventListener("click", (e) => {
    e.preventDefault();
    setAuthMode(authMode === "login" ? "signup" : "login");
});

authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    authError.textContent = "";

    const username = document.getElementById("authUsername").value;
    const password = document.getElementById("authPassword").value;
    const endpoint = authMode === "login" ? "/login" : "/signup";

    try {
        const res = await fetch(`${API_URL}${endpoint}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            credentials: "include",
            body: JSON.stringify({
                username,
                password
            })
        });

        const data = await res.json();

        if (!res.ok) {
            authError.textContent = data.error || "Something went wrong";
            return;
        }

        showApp(data.username);
    } catch (err) {
        authError.textContent = "Can't reach the backend — is it running?";
    }
});

async function checkExistingSession() {
    try {
        const res = await fetch(`${API_URL}/me`, {
            credentials: "include"
        });

        const data = await res.json();

        if (data.username) {
            showApp(data.username);
        } else {
            authWrap.style.display = "flex";
        }
    } catch (err) {
        authWrap.style.display = "flex";
    }
}

function showApp(username) {
    authWrap.style.display = "none";
    ledgerApp.style.display = "block";
    document.getElementById("loggedInAs").textContent = username;

    tickClock();

    if (clockTimer) {
        clearInterval(clockTimer);
    }

    clockTimer = setInterval(tickClock, 1000);

    renderLedgerNumber();
    loadProducts();
    loadSales();
    loadMpesa().then(updateUnmatchedTotal);
}

document.getElementById("logoutBtn").addEventListener("click", async () => {
    await fetch(`${API_URL}/logout`, {
        method: "POST",
        credentials: "include"
    });

    ledgerApp.style.display = "none";
    authWrap.style.display = "flex";

    setAuthMode("login");
    document.getElementById("authForm").reset();

    if (clockTimer) {
        clearInterval(clockTimer);
        clockTimer = null;
    }
});

// ---- LIVE CLOCK & TIMESTAMP HELPER ----
function toLocalTime(sqliteTimestamp) {
    const isoLike = sqliteTimestamp.replace(" ", "T") + "Z";
    const d = new Date(isoLike);

    if (isNaN(d)) {
        return sqliteTimestamp;
    }

    return d.toLocaleString("en-KE", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
}

function tickClock() {
    const now = new Date();

    const dateStr = now.toLocaleDateString("en-KE", {
        year: "numeric",
        month: "long",
        day: "numeric"
    });

    const timeStr = now.toLocaleTimeString("en-KE", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });

    document.getElementById("todayDate").textContent =
        `${dateStr} · ${timeStr}`;
}

function formatKes(amount) {
    return `KES ${Number(amount || 0).toFixed(2)}`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- LEDGER NUMBER ----
function getLedgerNumber() {
    return parseInt(
        localStorage.getItem("dukaLedgerNumber") || "0",
        10
    );
}

function bumpLedgerNumber() {
    const next = getLedgerNumber() + 1;

    localStorage.setItem("dukaLedgerNumber", next);
    renderLedgerNumber();
}

function renderLedgerNumber() {
    document.getElementById("ledgerNumber").textContent =
        String(getLedgerNumber()).padStart(3, "0");
}

// ---- TOAST ----
function showToast(message, type = "ok") {
    const toast = document.createElement("div");

    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    document.body.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add("show");
    });

    setTimeout(() => {
        toast.classList.remove("show");

        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 2200);
}

async function apiCall(path, options = {}) {
    try {
        const res = await fetch(`${API_URL}${path}`, {
            ...options,
            credentials: "include"
        });

        if (res.status === 401) {
            ledgerApp.style.display = "none";
            authWrap.style.display = "flex";

            setAuthMode("login");

            showToast(
                "Session expired — please log in again",
                "error"
            );

            return null;
        }

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));

            showToast(
                err.error || "Something went wrong",
                "error"
            );

            return null;
        }

        return await res.json();
    } catch (err) {
        showToast(
            "Can't reach the backend — is it running?",
            "error"
        );

        return null;
    }
}

// ---- TAB SWITCHING ----
const tabBtns = document.querySelectorAll(".tab-btn");
const tabContents = document.querySelectorAll(".tab-content");

function activateTab(tabName) {
    tabBtns.forEach((button) => {
        button.classList.remove("active");
    });

    tabContents.forEach((content) => {
        content.classList.remove("active");
    });

    const selectedButton = document.querySelector(
        `[data-tab="${tabName}"]`
    );

    if (selectedButton) {
        selectedButton.classList.add("active");
    }

    const panel = document.getElementById(`${tabName}-tab`);

    if (!panel) {
        return;
    }

    panel.classList.remove("active");
    void panel.offsetWidth;
    panel.classList.add("active");
}

tabBtns.forEach((button) => {
    button.addEventListener("click", () => {
        activateTab(button.dataset.tab);
    });
});

function flashRow(row) {
    row.classList.add("row-new");

    setTimeout(() => {
        row.classList.remove("row-new");
    }, 900);
}

// ---- PRODUCTS ----
async function loadProducts() {
    const products = await apiCall("/products");

    if (!products) {
        return;
    }

    productsCache = products;

    const body = document.getElementById("productsBody");

    body.innerHTML = "";

    let totalStockCount = 0;

    products.forEach((product) => {
        totalStockCount += product.stock;

        const row = document.createElement("tr");

        row.innerHTML = `
            <td>${product.name}</td>
            <td class="mono">${product.price.toFixed(2)}</td>
            <td class="mono">${product.stock}</td>
            <td>
                <button
                    class="del-btn"
                    data-id="${product.id}"
                >
                    Remove
                </button>
            </td>
        `;

        body.appendChild(row);
    });

    document.getElementById("totalStock").textContent =
        totalStockCount;

    const saleSelect = document.getElementById("saleProduct");
    const prevValue = saleSelect.value;

    saleSelect.innerHTML = products.length
        ? products
            .map(
                (product) =>
                    `<option value="${product.id}">
                        ${product.name} (${product.stock} left)
                    </option>`
            )
            .join("")
        : '<option value="">No products available</option>';

    if (
        prevValue &&
        products.some(
            (product) => String(product.id) === prevValue
        )
    ) {
        saleSelect.value = prevValue;
    }

    updateSaleTotal();

    body.querySelectorAll(".del-btn").forEach((button) => {
        button.addEventListener("click", async () => {
            const result = await apiCall(
                `/products/${button.dataset.id}`,
                {
                    method: "DELETE"
                }
            );

            if (result) {
                showToast("Removed from stock");
                loadProducts();
            }
        });
    });
}

document
    .getElementById("productForm")
    .addEventListener("submit", async (e) => {
        e.preventDefault();

        const name =
            document.getElementById("productName").value;

        const price = parseFloat(
            document.getElementById("productPrice").value
        );

        const stock = parseInt(
            document.getElementById("productStock").value,
            10
        );

        const result = await apiCall("/products", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                name,
                price,
                stock
            })
        });

        if (result) {
            e.target.reset();

            showToast(`${name} added to stock`);

            await loadProducts();

            const newRow = [
                ...document.querySelectorAll("#productsBody tr")
            ].find(
                (row) =>
                    row.firstElementChild?.textContent === name
            );

            if (newRow) {
                flashRow(newRow);
            }
        }
    });

// ---- SALES ----
async function loadSales() {
    const sales = await apiCall("/sales");

    if (!sales) {
        return null;
    }

    const body = document.getElementById("salesBody");

    body.innerHTML = "";

    let totalToday = 0;

    const today = new Date().toISOString().slice(0, 10);

    sales.forEach((sale) => {
        if (sale.sale_time.startsWith(today)) {
            totalToday += sale.total_amount;
        }

        const row = document.createElement("tr");

        row.dataset.id = sale.id;

        row.innerHTML = `
            <td>${sale.name}</td>
            <td class="mono">${sale.quantity}</td>
            <td class="mono">${sale.total_amount.toFixed(2)}</td>
            <td class="mono">
                ${toLocalTime(sale.sale_time)}
            </td>
            <td>
                ${
                    sale.matched
                        ? '<span class="stamp stamp-matched">Matched</span>'
                        : '<span class="stamp stamp-unmatched">Unmatched</span>'
                }
            </td>
        `;

        body.appendChild(row);
    });

    document.getElementById("totalSales").textContent =
        formatKes(totalToday);

    return sales;
}

function selectedSaleProduct() {
    const productId = parseInt(
        document.getElementById("saleProduct").value,
        10
    );

    return (
        productsCache.find(
            (product) => product.id === productId
        ) || null
    );
}

function updateSaleTotal() {
    const product = selectedSaleProduct();

    const quantity =
        parseInt(
            document.getElementById("saleQuantity").value,
            10
        ) || 0;

    const total =
        product && quantity > 0
            ? product.price * quantity
            : 0;

    document.getElementById("saleTotal").textContent =
        formatKes(total);
}

document
    .getElementById("saleProduct")
    .addEventListener("change", updateSaleTotal);

document
    .getElementById("saleQuantity")
    .addEventListener("input", updateSaleTotal);

document
    .getElementById("saleForm")
    .addEventListener("submit", async (e) => {
        e.preventDefault();

        const product = selectedSaleProduct();

        const product_id = product ? product.id : 0;

        const quantity = parseInt(
            document.getElementById("saleQuantity").value,
            10
        );

        const phone_number =
            document
                .getElementById("salePhone")
                .value
                .trim();

        const statusEl =
            document.getElementById("saleStatus");

        const submitBtn =
            document.getElementById("saleSubmitBtn");

        if (!product) {
            showToast("Select a valid product", "error");
            return;
        }

        if (!Number.isInteger(quantity) || quantity <= 0) {
            showToast("Enter a valid quantity", "error");
            return;
        }

        if (quantity > product.stock) {
            showToast(
                "Not enough stock available",
                "error"
            );

            return;
        }

        const salesBefore = await apiCall("/sales");

        if (!salesBefore) {
            return;
        }

        const highestExistingSaleId =
            salesBefore.reduce(
                (max, sale) => Math.max(max, sale.id),
                0
            );

        submitBtn.disabled = true;
        submitBtn.textContent = "Sending prompt...";

        statusEl.textContent =
            "Reserving stock and contacting M-Pesa...";

        const result = await apiCall(
            "/sales/request-payment",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    product_id,
                    quantity,
                    phone_number
                })
            }
        );

        if (!result) {
            submitBtn.disabled = false;
            submitBtn.textContent =
                "Send M-Pesa prompt";

            statusEl.textContent =
                "Payment request was not sent.";

            await loadProducts();

            return;
        }

        statusEl.textContent =
            `Prompt sent for ${formatKes(result.amount)}. ` +
            "Waiting for the customer to enter their M-Pesa PIN...";

        showToast("M-Pesa prompt sent");

        await loadProducts();

        let confirmedSale = null;

        for (let attempt = 0; attempt < 20; attempt++) {
            await sleep(3000);

            const latestSales =
                await apiCall("/sales");

            if (!latestSales) {
                break;
            }

            confirmedSale = latestSales.find(
                (sale) =>
                    sale.id > highestExistingSaleId &&
                    sale.product_id === product_id &&
                    sale.quantity === quantity &&
                    Math.abs(
                        sale.total_amount - result.amount
                    ) < 0.01 &&
                    sale.matched
            );

            if (confirmedSale) {
                break;
            }
        }

        if (confirmedSale) {
            statusEl.textContent =
                "Payment confirmed. Sale recorded for " +
                `${formatKes(confirmedSale.total_amount)}.`;

            showToast(
                "Payment confirmed and sale recorded"
            );

            e.target.reset();

            await loadProducts();
            await loadSales();
            await loadMpesa();
            await updateUnmatchedTotal();

            updateSaleTotal();

            const firstRow =
                document.querySelector("#salesBody tr");

            if (firstRow) {
                flashRow(firstRow);
            }
        } else {
            statusEl.textContent =
                "Payment has not been confirmed yet. " +
                "Check the customer's phone and the M-Pesa ledger. " +
                "Reserved stock is released automatically if " +
                "payment fails or expires.";

            await loadProducts();
            await loadSales();
            await loadMpesa();
            await updateUnmatchedTotal();
        }

        submitBtn.disabled = false;
        submitBtn.textContent =
            "Send M-Pesa prompt";
    });

// ---- MPESA ----
async function loadMpesa() {
    const transactions = await apiCall("/mpesa");

    if (!transactions) {
        return null;
    }

    const body = document.getElementById("mpesaBody");

    body.innerHTML = "";

    transactions.forEach((transaction) => {
        const row = document.createElement("tr");

        row.innerHTML = `
            <td class="mono">
                ${transaction.mpesa_code}
            </td>
            <td>
                ${transaction.sender_name || "—"}
            </td>
            <td class="mono">
                ${transaction.amount.toFixed(2)}
            </td>
            <td class="mono">
                ${toLocalTime(transaction.transaction_time)}
            </td>
            <td>
                ${
                    transaction.matched
                        ? '<span class="stamp stamp-matched">Matched</span>'
                        : '<span class="stamp stamp-unmatched">Unmatched</span>'
                }
            </td>
        `;

        body.appendChild(row);
    });

    return transactions;
}

document
    .getElementById("mpesaForm")
    .addEventListener("submit", async (e) => {
        e.preventDefault();

        const mpesa_code =
            document.getElementById("mpesaCode").value;

        const sender_name =
            document.getElementById("mpesaSender").value;

        const amount = parseFloat(
            document.getElementById("mpesaAmount").value
        );

        const result = await apiCall("/mpesa", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                mpesa_code,
                sender_name,
                amount
            })
        });

        if (result) {
            e.target.reset();

            showToast(
                `Payment logged — ${formatKes(amount)}`
            );

            await loadMpesa();
            await updateUnmatchedTotal();

            const firstRow =
                document.querySelector("#mpesaBody tr");

            if (firstRow) {
                flashRow(firstRow);
            }
        }
    });

// ---- GENERIC STK PUSH ----
document
    .getElementById("stkForm")
    .addEventListener("submit", async (e) => {
        e.preventDefault();

        const phone_number =
            document.getElementById("stkPhone").value;

        const amount = parseFloat(
            document.getElementById("stkAmount").value
        );

        const statusEl =
            document.getElementById("stkStatus");

        const submitBtn =
            document.getElementById("stkSubmitBtn");

        submitBtn.disabled = true;
        submitBtn.textContent = "Sending...";
        statusEl.textContent = "";

        const result = await apiCall("/stkpush", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                phone_number,
                amount
            })
        });

        submitBtn.disabled = false;
        submitBtn.textContent =
            "Send payment request";

        if (result) {
            e.target.reset();

            statusEl.textContent =
                "Prompt sent — waiting for the customer " +
                "to enter their PIN...";

            showToast("Payment request sent");

            let attempts = 0;

            const poll = setInterval(async () => {
                attempts++;

                await loadMpesa();
                await updateUnmatchedTotal();

                if (attempts >= 6) {
                    clearInterval(poll);
                }
            }, 5000);
        } else {
            statusEl.textContent =
                "Something went wrong sending the request.";
        }
    });

// ---- UNMATCHED TOTAL ----
async function updateUnmatchedTotal() {
    const sales = await apiCall("/sales");
    const mpesa = await apiCall("/mpesa");

    if (!sales || !mpesa) {
        return;
    }

    const unmatchedSales =
        sales.filter((sale) => !sale.matched).length;

    const unmatchedMpesa =
        mpesa.filter(
            (transaction) => !transaction.matched
        ).length;

    document.getElementById(
        "totalUnmatched"
    ).textContent =
        unmatchedSales + unmatchedMpesa;
}

// ---- RECONCILE ----
async function runReconcile() {
    const resultsEl =
        document.getElementById("reconcileResults");

    resultsEl.innerHTML =
        '<p class="muted">Stamping the books…</p>';

    const data = await apiCall("/reconcile", {
        method: "POST"
    });

    if (!data) {
        resultsEl.innerHTML =
            '<p class="muted">' +
            "Reconciliation failed — check the backend." +
            "</p>";

        return;
    }

    let html =
        `<div class="recon-summary">` +
        `${data.matched_count} ` +
        `entr${data.matched_count === 1 ? "y" : "ies"} ` +
        `matched this run` +
        `</div>`;

    if (data.matched_pairs.length > 0) {
        html += `
            <div class="recon-section">
                <h3>Newly matched</h3>
                <table>
                    <thead>
                        <tr>
                            <th>Sale ID</th>
                            <th>M-Pesa ID</th>
                            <th>Amount</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        data.matched_pairs.forEach((pair, index) => {
            html += `
                <tr style="animation-delay:${index * 90}ms">
                    <td class="mono">
                        #${pair.sale_id}
                    </td>
                    <td class="mono">
                        #${pair.mpesa_id}
                    </td>
                    <td class="mono">
                        <span class="stamp stamp-matched">
                            ${formatKes(pair.amount)}
                        </span>
                    </td>
                </tr>
            `;
        });

        html += `
                    </tbody>
                </table>
            </div>
        `;
    }

    if (data.unmatched_sales.length > 0) {
        html += `
            <div class="recon-section">
                <h3>Sales with no matching payment</h3>
                <table>
                    <thead>
                        <tr>
                            <th>Item</th>
                            <th>Qty</th>
                            <th>Amount</th>
                            <th>Time</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        data.unmatched_sales.forEach((sale) => {
            html += `
                <tr>
                    <td>${sale.name}</td>
                    <td class="mono">
                        ${sale.quantity}
                    </td>
                    <td class="mono">
                        ${formatKes(sale.total_amount)}
                    </td>
                    <td class="mono">
                        ${toLocalTime(sale.sale_time)}
                    </td>
                </tr>
            `;
        });

        html += `
                    </tbody>
                </table>
            </div>
        `;
    }

    if (data.unmatched_mpesa.length > 0) {
        html += `
            <div class="recon-section">
                <h3>Payments with no matching sale</h3>
                <table>
                    <thead>
                        <tr>
                            <th>Code</th>
                            <th>Sender</th>
                            <th>Amount</th>
                            <th>Time</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        data.unmatched_mpesa.forEach(
            (transaction) => {
                html += `
                    <tr>
                        <td class="mono">
                            ${transaction.mpesa_code}
                        </td>
                        <td>
                            ${transaction.sender_name || "—"}
                        </td>
                        <td class="mono">
                            ${formatKes(transaction.amount)}
                        </td>
                        <td class="mono">
                            ${toLocalTime(
                                transaction.transaction_time
                            )}
                        </td>
                    </tr>
                `;
            }
        );

        html += `
                    </tbody>
                </table>
            </div>
        `;
    }

    resultsEl.innerHTML = html;

    showToast(
        `${data.matched_count} entries reconciled`
    );

    bumpLedgerNumber();

    loadSales();
    loadMpesa();
    updateUnmatchedTotal();
}

document
    .getElementById("reconcileBtn")
    .addEventListener("click", runReconcile);

document
    .getElementById("reconcileBtnTop")
    .addEventListener("click", () => {
        activateTab("reconcile");
        runReconcile();
    });

// ---- INITIAL LOAD ----
checkExistingSession();