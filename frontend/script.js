const API_URL = "https://duka-manager.onrender.com";

let authMode = "login";
let productsCache = [];
let salesCache = [];
let mpesaCache = [];
let paymentsCache = [];
let clockTimer = null;
let paymentPollTimer = null;

let activeCheckoutRequestId =
    localStorage.getItem("dukaActiveCheckoutId") || null;

const authWrap = document.getElementById("authWrap");
const ledgerApp = document.getElementById("ledgerApp");
const authForm = document.getElementById("authForm");
const authModeLabel = document.getElementById("authModeLabel");
const authSubmitBtn = document.getElementById("authSubmitBtn");
const authToggleText = document.getElementById("authToggleText");
const authToggleLink = document.getElementById("authToggleLink");
const authError = document.getElementById("authError");


function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}


function setAuthMode(mode) {
    authMode = mode;

    const passwordInput =
        document.getElementById("authPassword");

    if (mode === "login") {
        authModeLabel.textContent =
            "Log in to your ledger";

        authSubmitBtn.textContent =
            "Log In";

        authToggleText.textContent =
            "Don't have an account?";

        authToggleLink.textContent =
            "Sign up";

        passwordInput.autocomplete =
            "current-password";
    } else {
        authModeLabel.textContent =
            "Create your ledger account";

        authSubmitBtn.textContent =
            "Sign Up";

        authToggleText.textContent =
            "Already have an account?";

        authToggleLink.textContent =
            "Log in";

        passwordInput.autocomplete =
            "new-password";
    }

    authError.textContent = "";
}


authToggleLink.addEventListener(
    "click",
    (event) => {
        event.preventDefault();

        setAuthMode(
            authMode === "login"
                ? "signup"
                : "login"
        );
    }
);


authForm.addEventListener(
    "submit",
    async (event) => {
        event.preventDefault();

        authError.textContent = "";

        const username = document
            .getElementById("authUsername")
            .value
            .trim();

        const password =
            document.getElementById(
                "authPassword"
            ).value;

        const endpoint =
            authMode === "login"
                ? "/login"
                : "/signup";

        authSubmitBtn.disabled = true;

        authSubmitBtn.textContent =
            authMode === "login"
                ? "Logging in..."
                : "Creating account...";

        try {
            const response = await fetch(
                `${API_URL}${endpoint}`,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    credentials: "include",

                    body: JSON.stringify({
                        username,
                        password
                    })
                }
            );

            const data =
                await response
                    .json()
                    .catch(() => ({}));

            if (!response.ok) {
                authError.textContent =
                    data.error ||
                    "Something went wrong";

                return;
            }

            authForm.reset();

            await showApp(
                data.username
            );
        } catch (error) {
            authError.textContent =
                "Can't reach the backend. Please try again.";
        } finally {
            authSubmitBtn.disabled = false;

            authSubmitBtn.textContent =
                authMode === "login"
                    ? "Log In"
                    : "Sign Up";
        }
    }
);


async function checkExistingSession() {
    try {
        const response = await fetch(
            `${API_URL}/me`,
            {
                credentials: "include"
            }
        );

        if (!response.ok) {
            authWrap.style.display =
                "flex";

            return;
        }

        const data =
            await response.json();

        if (data.username) {
            await showApp(
                data.username
            );
        } else {
            authWrap.style.display =
                "flex";
        }
    } catch (error) {
        authWrap.style.display =
            "flex";
    }
}


async function showApp(username) {
    authWrap.style.display =
        "none";

    ledgerApp.style.display =
        "block";

    document.getElementById(
        "loggedInAs"
    ).textContent = username;

    tickClock();

    clearInterval(
        clockTimer
    );

    clockTimer =
        setInterval(
            tickClock,
            1000
        );

    renderLedgerNumber();

    await refreshDashboard();

    if (activeCheckoutRequestId) {
        startPaymentPolling(
            activeCheckoutRequestId
        );

        return;
    }

    const pendingPayment =
        paymentsCache.find(
            (payment) =>
                [
                    "initiating",
                    "pending"
                ].includes(
                    payment.status
                )
        );

    if (pendingPayment) {
        activeCheckoutRequestId =
            pendingPayment
                .checkout_request_id;

        localStorage.setItem(
            "dukaActiveCheckoutId",
            activeCheckoutRequestId
        );

        startPaymentPolling(
            activeCheckoutRequestId
        );
    }
}


document
    .getElementById("logoutBtn")
    .addEventListener(
        "click",
        async () => {
            await fetch(
                `${API_URL}/logout`,
                {
                    method: "POST",
                    credentials: "include"
                }
            ).catch(() => null);

            stopPaymentPolling();

            clearInterval(
                clockTimer
            );

            clockTimer = null;

            ledgerApp.style.display =
                "none";

            authWrap.style.display =
                "flex";

            authForm.reset();

            setAuthMode("login");
        }
    );


function toDate(sqliteTimestamp) {
    if (!sqliteTimestamp) {
        return null;
    }

    const normalized =
        sqliteTimestamp.includes("T")
            ? sqliteTimestamp
            : `${sqliteTimestamp.replace(
                " ",
                "T"
            )}Z`;

    const date =
        new Date(normalized);

    return Number.isNaN(
        date.getTime()
    )
        ? null
        : date;
}


function toLocalTime(sqliteTimestamp) {
    const date =
        toDate(sqliteTimestamp);

    if (!date) {
        return (
            sqliteTimestamp ||
            "—"
        );
    }

    return date.toLocaleString(
        "en-KE",
        {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit"
        }
    );
}


function isToday(sqliteTimestamp) {
    const date =
        toDate(sqliteTimestamp);

    if (!date) {
        return false;
    }

    const today =
        new Date();

    return (
        date.getFullYear() ===
            today.getFullYear() &&

        date.getMonth() ===
            today.getMonth() &&

        date.getDate() ===
            today.getDate()
    );
}


function tickClock() {
    const now =
        new Date();

    const date =
        now.toLocaleDateString(
            "en-KE",
            {
                year: "numeric",
                month: "long",
                day: "numeric"
            }
        );

    const time =
        now.toLocaleTimeString(
            "en-KE",
            {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit"
            }
        );

    document.getElementById(
        "todayDate"
    ).textContent =
        `${date} · ${time}`;
}


function formatKes(amount) {
    return (
        `KES ${Number(
            amount || 0
        ).toLocaleString(
            "en-KE",
            {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            }
        )}`
    );
}


function formatPhone(phone) {
    const value =
        String(phone || "");

    if (
        /^254\d{9}$/.test(
            value
        )
    ) {
        return (
            `0${value.slice(3)}`
        );
    }

    return value || "—";
}


function getLedgerNumber() {
    return Number.parseInt(
        localStorage.getItem(
            "dukaLedgerNumber"
        ) || "0",
        10
    );
}


function renderLedgerNumber() {
    document.getElementById(
        "ledgerNumber"
    ).textContent =
        String(
            getLedgerNumber()
        ).padStart(
            3,
            "0"
        );
}


function bumpLedgerNumber() {
    localStorage.setItem(
        "dukaLedgerNumber",
        String(
            getLedgerNumber() + 1
        )
    );

    renderLedgerNumber();
}


function showToast(
    message,
    type = "ok"
) {
    const toast =
        document.createElement(
            "div"
        );

    toast.className =
        `toast toast-${type}`;

    toast.textContent =
        message;

    document.body.appendChild(
        toast
    );

    requestAnimationFrame(
        () =>
            toast.classList.add(
                "show"
            )
    );

    setTimeout(
        () => {
            toast.classList.remove(
                "show"
            );

            setTimeout(
                () => toast.remove(),
                300
            );
        },
        2600
    );
}


async function apiCall(
    path,
    options = {},
    silent = false
) {
    try {
        const response =
            await fetch(
                `${API_URL}${path}`,
                {
                    ...options,
                    credentials: "include"
                }
            );

        const data =
            await response
                .json()
                .catch(() => ({}));

        if (
            response.status === 401
        ) {
            stopPaymentPolling();

            ledgerApp.style.display =
                "none";

            authWrap.style.display =
                "flex";

            setAuthMode("login");

            if (!silent) {
                showToast(
                    "Session expired. Please log in again.",
                    "error"
                );
            }

            return null;
        }

        if (!response.ok) {
            if (!silent) {
                showToast(
                    data.error ||
                        "Something went wrong",
                    "error"
                );
            }

            return null;
        }

        return data;
    } catch (error) {
        if (!silent) {
            showToast(
                "Can't reach the backend.",
                "error"
            );
        }

        return null;
    }
}


const tabButtons =
    document.querySelectorAll(
        ".tab-btn"
    );

const tabContents =
    document.querySelectorAll(
        ".tab-content"
    );


function activateTab(tabName) {
    tabButtons.forEach(
        (button) => {
            button.classList.toggle(
                "active",
                button.dataset.tab ===
                    tabName
            );
        }
    );

    tabContents.forEach(
        (section) => {
            section.classList.toggle(
                "active",
                section.id ===
                    `${tabName}-tab`
            );
        }
    );
}


tabButtons.forEach(
    (button) => {
        button.addEventListener(
            "click",
            () => {
                activateTab(
                    button.dataset.tab
                );

                if (
                    button.dataset.tab ===
                    "mpesa"
                ) {
                    loadPayments();
                    loadMpesa();
                }
            }
        );
    }
);


function flashRow(row) {
    if (!row) {
        return;
    }

    row.classList.add(
        "row-new"
    );

    setTimeout(
        () =>
            row.classList.remove(
                "row-new"
            ),
        900
    );
}


async function refreshDashboard() {
    await Promise.all([
        loadProducts(),
        loadSales(),
        loadMpesa(),
        loadPayments()
    ]);

    updateUnmatchedTotal();
}


// ==========================================================
// PRODUCTS
// ==========================================================

async function loadProducts() {
    const products =
        await apiCall(
            "/products"
        );

    if (!products) {
        return null;
    }

    productsCache =
        products;

    const body =
        document.getElementById(
            "productsBody"
        );

    body.innerHTML = "";

    if (!products.length) {
        body.innerHTML =
            '<tr><td colspan="4">No stock entries yet.</td></tr>';
    }

    let totalStock = 0;

    products.forEach(
        (product) => {
            totalStock +=
                Number(
                    product.stock || 0
                );

            const row =
                document.createElement(
                    "tr"
                );

            row.innerHTML = `
                <td>
                    ${escapeHtml(
                        product.name
                    )}
                </td>

                <td class="mono">
                    ${formatKes(
                        product.price
                    )}
                </td>

                <td class="mono">
                    ${product.stock}
                </td>

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
        }
    );

    document.getElementById(
        "totalStock"
    ).textContent =
        totalStock;

    const saleSelect =
        document.getElementById(
            "saleProduct"
        );

    const previousValue =
        saleSelect.value;

    saleSelect.innerHTML =
        products.length
            ? products
                .map(
                    (product) => `
                        <option
                            value="${product.id}"
                        >
                            ${escapeHtml(
                                product.name
                            )}
                            (${product.stock} left)
                        </option>
                    `
                )
                .join("")
            : (
                '<option value="">' +
                "No products available" +
                "</option>"
            );

    if (
        previousValue &&
        products.some(
            (product) =>
                String(product.id) ===
                previousValue
        )
    ) {
        saleSelect.value =
            previousValue;
    }

    updateSaleTotal();

    body
        .querySelectorAll(
            ".del-btn"
        )
        .forEach(
            (button) => {
                button.addEventListener(
                    "click",
                    async () => {
                        const result =
                            await apiCall(
                                `/products/${button.dataset.id}`,
                                {
                                    method:
                                        "DELETE"
                                }
                            );

                        if (result) {
                            showToast(
                                "Stock entry removed"
                            );

                            await loadProducts();
                        }
                    }
                );
            }
        );

    return products;
}


document
    .getElementById(
        "productForm"
    )
    .addEventListener(
        "submit",
        async (event) => {
            event.preventDefault();

            const name =
                document
                    .getElementById(
                        "productName"
                    )
                    .value
                    .trim();

            const price =
                Number.parseFloat(
                    document
                        .getElementById(
                            "productPrice"
                        )
                        .value
                );

            const stock =
                Number.parseInt(
                    document
                        .getElementById(
                            "productStock"
                        )
                        .value,
                    10
                );

            const result =
                await apiCall(
                    "/products",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json"
                        },

                        body:
                            JSON.stringify({
                                name,
                                price,
                                stock
                            })
                    }
                );

            if (!result) {
                return;
            }

            event.target.reset();

            showToast(
                `${name} added to stock`
            );

            await loadProducts();

            flashRow(
                document.querySelector(
                    "#productsBody tr"
                )
            );
        }
    );


// ==========================================================
// SALES
// ==========================================================

async function loadSales() {
    const sales =
        await apiCall("/sales");

    if (!sales) {
        return null;
    }

    salesCache = sales;

    const body =
        document.getElementById(
            "salesBody"
        );

    body.innerHTML = "";

    if (!sales.length) {
        body.innerHTML =
            '<tr><td colspan="5">No confirmed sales yet.</td></tr>';
    }

    let totalToday = 0;

    sales.forEach(
        (sale) => {
            if (
                isToday(
                    sale.sale_time
                )
            ) {
                totalToday +=
                    Number(
                        sale.total_amount ||
                            0
                    );
            }

            const row =
                document.createElement(
                    "tr"
                );

            row.dataset.id =
                sale.id;

            row.innerHTML = `
                <td>
                    ${escapeHtml(
                        sale.name
                    )}
                </td>

                <td class="mono">
                    ${sale.quantity}
                </td>

                <td class="mono">
                    ${formatKes(
                        sale.total_amount
                    )}
                </td>

                <td class="mono">
                    ${toLocalTime(
                        sale.sale_time
                    )}
                </td>

                <td>
                    ${
                        sale.matched
                            ? (
                                '<span class="stamp stamp-matched">' +
                                "Paid" +
                                "</span>"
                            )
                            : (
                                '<span class="stamp stamp-unmatched">' +
                                "Unmatched" +
                                "</span>"
                            )
                    }
                </td>
            `;

            body.appendChild(row);
        }
    );

    document.getElementById(
        "totalSales"
    ).textContent =
        formatKes(totalToday);

    return sales;
}


function selectedSaleProduct() {
    const productId =
        Number.parseInt(
            document
                .getElementById(
                    "saleProduct"
                )
                .value,
            10
        );

    return (
        productsCache.find(
            (product) =>
                product.id ===
                productId
        ) || null
    );
}


function updateSaleTotal() {
    const product =
        selectedSaleProduct();

    const quantity =
        Number.parseInt(
            document
                .getElementById(
                    "saleQuantity"
                )
                .value,
            10
        ) || 0;

    const total =
        product &&
        quantity > 0
            ? product.price *
                quantity
            : 0;

    document.getElementById(
        "saleTotal"
    ).textContent =
        formatKes(total);
}


document
    .getElementById(
        "saleProduct"
    )
    .addEventListener(
        "change",
        updateSaleTotal
    );


document
    .getElementById(
        "saleQuantity"
    )
    .addEventListener(
        "input",
        updateSaleTotal
    );


document
    .getElementById(
        "saleForm"
    )
    .addEventListener(
        "submit",
        async (event) => {
            event.preventDefault();

            const product =
                selectedSaleProduct();

            const quantity =
                Number.parseInt(
                    document
                        .getElementById(
                            "saleQuantity"
                        )
                        .value,
                    10
                );

            const phoneNumber =
                document
                    .getElementById(
                        "salePhone"
                    )
                    .value
                    .trim();

            const statusElement =
                document.getElementById(
                    "saleStatus"
                );

            const submitButton =
                document.getElementById(
                    "saleSubmitBtn"
                );

            if (!product) {
                showToast(
                    "Select a valid product",
                    "error"
                );

                return;
            }

            if (
                !Number.isInteger(
                    quantity
                ) ||
                quantity <= 0
            ) {
                showToast(
                    "Enter a valid quantity",
                    "error"
                );

                return;
            }

            if (
                quantity >
                product.stock
            ) {
                showToast(
                    "Not enough stock available",
                    "error"
                );

                return;
            }

            submitButton.disabled =
                true;

            submitButton.textContent =
                "Sending prompt...";

            statusElement.textContent =
                "Reserving stock and contacting M-Pesa...";

            const result =
                await apiCall(
                    "/sales/request-payment",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json"
                        },

                        body:
                            JSON.stringify({
                                product_id:
                                    product.id,

                                quantity,

                                phone_number:
                                    phoneNumber
                            })
                    }
                );

            submitButton.disabled =
                false;

            submitButton.textContent =
                "Send M-Pesa prompt";

            if (!result) {
                statusElement.textContent =
                    "Payment request was not sent.";

                await loadProducts();

                return;
            }

            activeCheckoutRequestId =
                result
                    .checkout_request_id;

            localStorage.setItem(
                "dukaActiveCheckoutId",
                activeCheckoutRequestId
            );

            statusElement.textContent =
                `Prompt sent for ${formatKes(
                    result.amount
                )}. ` +
                "Check the M-Pesa tab for live updates.";

            showToast(
                "M-Pesa prompt sent"
            );

            await loadProducts();

            await loadPayments();

            activateTab("mpesa");

            startPaymentPolling(
                activeCheckoutRequestId
            );
        }
    );


// ==========================================================
// PAYMENT MESSAGES
// ==========================================================

function paymentStatusLabel(status) {
    const labels = {
        initiating: "Sending",
        pending: "Pending",
        success: "Successful",
        cancelled: "Cancelled",
        timed_out: "Timed out",
        expired: "Expired",
        paid_no_stock: "Review",
        failed: "Failed"
    };

    return (
        labels[status] ||
        "Unknown"
    );
}


function paymentStampClass(status) {
    if (
        status === "success"
    ) {
        return "stamp-matched";
    }

    if (
        [
            "initiating",
            "pending"
        ].includes(status)
    ) {
        return "";
    }

    return "stamp-unmatched";
}


function renderLatestPayment(payment) {
    const status =
        document.getElementById(
            "latestPaymentStatus"
        );

    const message =
        document.getElementById(
            "latestPaymentMessage"
        );

    const details =
        document.getElementById(
            "latestPaymentDetails"
        );

    status.className =
        "stamp";

    if (!payment) {
        status.textContent =
            "No payment";

        message.innerHTML =
            '<p class="muted">' +
            "Make a sale to send an M-Pesa prompt." +
            "</p>";

        details.style.display =
            "none";

        return;
    }

    const extraClass =
        paymentStampClass(
            payment.status
        );

    if (extraClass) {
        status.classList.add(
            extraClass
        );
    }

    status.textContent =
        paymentStatusLabel(
            payment.status
        );

    message.innerHTML =
        `<p>${escapeHtml(
            payment.message
        )}</p>`;

    details.style.display =
        "grid";

    document.getElementById(
        "paymentPhone"
    ).textContent =
        formatPhone(
            payment.phone_number
        );

    document.getElementById(
        "paymentItem"
    ).textContent =
        payment.product_name
            ? (
                `${payment.product_name} × ` +
                `${payment.quantity || 1}`
            )
            : "General payment";

    document.getElementById(
        "paymentAmount"
    ).textContent =
        formatKes(
            payment.amount
        );

    document.getElementById(
        "paymentReceipt"
    ).textContent =
        payment.mpesa_receipt ||
        "—";
}


async function loadPayments() {
    const payments =
        await apiCall(
            "/payments"
        );

    if (!payments) {
        return null;
    }

    paymentsCache =
        payments;

    renderLatestPayment(
        payments[0] || null
    );

    const body =
        document.getElementById(
            "paymentsBody"
        );

    body.innerHTML = "";

    if (!payments.length) {
        body.innerHTML =
            '<tr><td colspan="6">No payment requests yet.</td></tr>';

        return payments;
    }

    payments.forEach(
        (payment) => {
            const row =
                document.createElement(
                    "tr"
                );

            const stampClass =
                paymentStampClass(
                    payment.status
                );

            row.innerHTML = `
                <td class="mono">
                    ${toLocalTime(
                        payment.created_at
                    )}
                </td>

                <td>
                    ${escapeHtml(
                        formatPhone(
                            payment.phone_number
                        )
                    )}
                </td>

                <td>
                    ${escapeHtml(
                        payment.product_name ||
                            "General payment"
                    )}

                    ${
                        payment.quantity
                            ? (
                                ` × ${payment.quantity}`
                            )
                            : ""
                    }
                </td>

                <td class="mono">
                    ${formatKes(
                        payment.amount
                    )}
                </td>

                <td class="mono">
                    ${escapeHtml(
                        payment.mpesa_receipt ||
                            "—"
                    )}
                </td>

                <td>
                    <span
                        class="stamp ${stampClass}"
                    >
                        ${paymentStatusLabel(
                            payment.status
                        )}
                    </span>
                </td>
            `;

            body.appendChild(row);
        }
    );

    return payments;
}


async function fetchPaymentStatus(
    checkoutRequestId
) {
    return apiCall(
        `/payments/${encodeURIComponent(
            checkoutRequestId
        )}`,
        {},
        true
    );
}


function stopPaymentPolling(
    clearSavedId = false
) {
    if (paymentPollTimer) {
        clearInterval(
            paymentPollTimer
        );

        paymentPollTimer = null;
    }

    if (clearSavedId) {
        activeCheckoutRequestId =
            null;

        localStorage.removeItem(
            "dukaActiveCheckoutId"
        );
    }
}


async function handleTerminalPayment(
    payment
) {
    stopPaymentPolling(true);

    renderLatestPayment(
        payment
    );

    await refreshDashboard();

    const statusElement =
        document.getElementById(
            "saleStatus"
        );

    if (
        payment.status ===
        "success"
    ) {
        statusElement.textContent =
            `Payment confirmed. Receipt: ` +
            `${payment.mpesa_receipt}.`;

        document
            .getElementById(
                "saleForm"
            )
            .reset();

        updateSaleTotal();

        bumpLedgerNumber();

        showToast(
            "Payment confirmed and sale recorded"
        );

        flashRow(
            document.querySelector(
                "#salesBody tr"
            )
        );

        flashRow(
            document.querySelector(
                "#mpesaBody tr"
            )
        );
    } else if (
        payment.status ===
        "paid_no_stock"
    ) {
        statusElement.textContent =
            "Payment received, but stock needs manual review.";

        showToast(
            "Payment needs manual review",
            "error"
        );
    } else {
        statusElement.textContent =
            payment.message;

        showToast(
            paymentStatusLabel(
                payment.status
            ),
            "error"
        );
    }
}


function startPaymentPolling(
    checkoutRequestId
) {
    stopPaymentPolling();

    activeCheckoutRequestId =
        checkoutRequestId;

    localStorage.setItem(
        "dukaActiveCheckoutId",
        checkoutRequestId
    );

    const pollOnce =
        async () => {
            const payment =
                await fetchPaymentStatus(
                    checkoutRequestId
                );

            if (!payment) {
                return;
            }

            renderLatestPayment(
                payment
            );

            await loadPayments();

            if (
                payment.is_terminal
            ) {
                await handleTerminalPayment(
                    payment
                );
            }
        };

    pollOnce();

    paymentPollTimer =
        setInterval(
            pollOnce,
            3000
        );
}


// ==========================================================
// CONFIRMED M-PESA TRANSACTIONS
// ==========================================================

async function loadMpesa() {
    const transactions =
        await apiCall(
            "/mpesa"
        );

    if (!transactions) {
        return null;
    }

    mpesaCache =
        transactions;

    const body =
        document.getElementById(
            "mpesaBody"
        );

    body.innerHTML = "";

    if (!transactions.length) {
        body.innerHTML =
            '<tr><td colspan="5">' +
            "No confirmed M-Pesa transactions yet." +
            "</td></tr>";

        return transactions;
    }

    transactions.forEach(
        (transaction) => {
            const row =
                document.createElement(
                    "tr"
                );

            row.innerHTML = `
                <td class="mono">
                    ${escapeHtml(
                        transaction.mpesa_code
                    )}
                </td>

                <td>
                    ${escapeHtml(
                        formatPhone(
                            transaction.sender_name
                        )
                    )}
                </td>

                <td class="mono">
                    ${formatKes(
                        transaction.amount
                    )}
                </td>

                <td class="mono">
                    ${toLocalTime(
                        transaction.transaction_time
                    )}
                </td>

                <td>
                    ${
                        transaction.matched
                            ? (
                                '<span class="stamp stamp-matched">' +
                                "Matched" +
                                "</span>"
                            )
                            : (
                                '<span class="stamp stamp-unmatched">' +
                                "Unmatched" +
                                "</span>"
                            )
                    }
                </td>
            `;

            body.appendChild(row);
        }
    );

    return transactions;
}


function updateUnmatchedTotal() {
    const unmatchedSales =
        salesCache.filter(
            (sale) =>
                !sale.matched
        ).length;

    const unmatchedMpesa =
        mpesaCache.filter(
            (transaction) =>
                !transaction.matched
        ).length;

    document.getElementById(
        "totalUnmatched"
    ).textContent =
        unmatchedSales +
        unmatchedMpesa;
}


// ==========================================================
// RECONCILIATION
// ==========================================================

async function runReconcile() {
    const results =
        document.getElementById(
            "reconcileResults"
        );

    results.innerHTML =
        '<p class="muted">' +
        "Stamping the books…" +
        "</p>";

    const data =
        await apiCall(
            "/reconcile",
            {
                method: "POST"
            }
        );

    if (!data) {
        results.innerHTML =
            '<p class="muted">' +
            "Reconciliation failed." +
            "</p>";

        return;
    }

    let html = `
        <div class="recon-summary">
            ${data.matched_count}
            entr${
                data.matched_count === 1
                    ? "y"
                    : "ies"
            }
            matched this run
        </div>
    `;

    if (
        data.matched_pairs.length
    ) {
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
                        ${
                            data.matched_pairs
                                .map(
                                    (pair) => `
                                        <tr>
                                            <td class="mono">
                                                #${pair.sale_id}
                                            </td>

                                            <td class="mono">
                                                #${pair.mpesa_id}
                                            </td>

                                            <td class="mono">
                                                ${formatKes(
                                                    pair.amount
                                                )}
                                            </td>
                                        </tr>
                                    `
                                )
                                .join("")
                        }
                    </tbody>
                </table>
            </div>
        `;
    }

    if (
        data.unmatched_sales.length
    ) {
        html += `
            <div class="recon-section">
                <h3>
                    Sales with no matching payment
                </h3>

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
                        ${
                            data.unmatched_sales
                                .map(
                                    (sale) => `
                                        <tr>
                                            <td>
                                                ${escapeHtml(
                                                    sale.name
                                                )}
                                            </td>

                                            <td class="mono">
                                                ${sale.quantity}
                                            </td>

                                            <td class="mono">
                                                ${formatKes(
                                                    sale.total_amount
                                                )}
                                            </td>

                                            <td class="mono">
                                                ${toLocalTime(
                                                    sale.sale_time
                                                )}
                                            </td>
                                        </tr>
                                    `
                                )
                                .join("")
                        }
                    </tbody>
                </table>
            </div>
        `;
    }

    if (
        data.unmatched_mpesa.length
    ) {
        html += `
            <div class="recon-section">
                <h3>
                    Payments with no matching sale
                </h3>

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
                        ${
                            data.unmatched_mpesa
                                .map(
                                    (transaction) => `
                                        <tr>
                                            <td class="mono">
                                                ${escapeHtml(
                                                    transaction.mpesa_code
                                                )}
                                            </td>

                                            <td>
                                                ${escapeHtml(
                                                    transaction.sender_name ||
                                                        "—"
                                                )}
                                            </td>

                                            <td class="mono">
                                                ${formatKes(
                                                    transaction.amount
                                                )}
                                            </td>

                                            <td class="mono">
                                                ${toLocalTime(
                                                    transaction.transaction_time
                                                )}
                                            </td>
                                        </tr>
                                    `
                                )
                                .join("")
                        }
                    </tbody>
                </table>
            </div>
        `;
    }

    if (
        !data.matched_pairs.length &&
        !data.unmatched_sales.length &&
        !data.unmatched_mpesa.length
    ) {
        html +=
            '<p class="muted">' +
            "Everything is balanced." +
            "</p>";
    }

    results.innerHTML =
        html;

    await refreshDashboard();

    showToast(
        "Reconciliation complete"
    );
}


document
    .getElementById(
        "reconcileBtn"
    )
    .addEventListener(
        "click",
        runReconcile
    );


document
    .getElementById(
        "reconcileBtnTop"
    )
    .addEventListener(
        "click",
        () => {
            activateTab(
                "reconcile"
            );

            runReconcile();
        }
    );


setAuthMode("login");
checkExistingSession();