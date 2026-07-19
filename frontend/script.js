const API_URL = "https://duka-manager.onrender.com";

let authMode = "login";
let productsCache = [];
let salesCache = [];
let mpesaCache = [];
let paymentsCache = [];
let clockTimer = null;
let paymentPollTimer = null;
let activeStockProductId = null;
let stockLookupToken = 0;

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

const productForm = document.getElementById("productForm");
const productBarcodeInput = document.getElementById("productBarcode");
const productNameInput = document.getElementById("productName");
const productPriceInput = document.getElementById("productPrice");
const productStockInput = document.getElementById("productStock");
const productSubmitBtn = document.getElementById("productSubmitBtn");
const productBarcodeStatus = document.getElementById(
    "productBarcodeStatus"
);

const saleBarcodeForm = document.getElementById("saleBarcodeForm");
const saleBarcodeInput = document.getElementById("saleBarcode");
const saleBarcodeBtn = document.getElementById("saleBarcodeBtn");
const saleBarcodeStatus = document.getElementById("saleBarcodeStatus");
const saleForm = document.getElementById("saleForm");
const saleProductSelect = document.getElementById("saleProduct");
const saleQuantityInput = document.getElementById("saleQuantity");
const salePhoneInput = document.getElementById("salePhone");
const saleSubmitBtn = document.getElementById("saleSubmitBtn");
const saleStatus = document.getElementById("saleStatus");


function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}


function normalizeBarcode(value) {
    return String(value ?? "")
        .trim()
        .replaceAll(" ", "")
        .slice(0, 100);
}


function setStatus(element, message, type = "") {
    if (!element) {
        return;
    }

    element.textContent = message;
    element.dataset.status = type;
}


function setAuthMode(mode) {
    authMode = mode;

    const passwordInput = document.getElementById("authPassword");

    if (mode === "login") {
        authModeLabel.textContent = "Log in to your ledger";
        authSubmitBtn.textContent = "Log In";
        authToggleText.textContent = "Don't have an account?";
        authToggleLink.textContent = "Sign up";
        passwordInput.autocomplete = "current-password";
    } else {
        authModeLabel.textContent = "Create your ledger account";
        authSubmitBtn.textContent = "Sign Up";
        authToggleText.textContent = "Already have an account?";
        authToggleLink.textContent = "Log in";
        passwordInput.autocomplete = "new-password";
    }

    authError.textContent = "";
}


authToggleLink.addEventListener("click", (event) => {
    event.preventDefault();

    setAuthMode(
        authMode === "login"
            ? "signup"
            : "login"
    );
});


authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    authError.textContent = "";

    const username = document
        .getElementById("authUsername")
        .value
        .trim();

    const password =
        document.getElementById("authPassword").value;

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
                    "Content-Type": "application/json"
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

        showApp(
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
});


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
            showApp(
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


function showApp(username) {
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

    refreshDashboard()
        .then(() => {
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
        })
        .catch(() => {
            showToast(
                "Some dashboard information could not load.",
                "error"
            );
        });
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

            resetStockForm();
            resetSaleBarcode();
            setAuthMode("login");
        }
    );


function toDate(timestamp) {
    if (!timestamp) {
        return null;
    }

    const normalized =
        timestamp.includes("T")
            ? timestamp
            : `${timestamp.replace(
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


function toLocalTime(timestamp) {
    const date =
        toDate(timestamp);

    if (!date) {
        return timestamp || "—";
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


function isToday(timestamp) {
    const date =
        toDate(timestamp);

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


async function requestJson(
    path,
    options = {}
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
        }

        return {
            ok: response.ok,
            status: response.status,
            data
        };
    } catch (error) {
        return {
            ok: false,
            status: 0,

            data: {
                error: "Can't reach the backend."
            }
        };
    }
}


async function apiCall(
    path,
    options = {},
    silent = false
) {
    const result =
        await requestJson(
            path,
            options
        );

    if (!result.ok) {
        if (!silent) {
            showToast(
                result.data.error ||
                    "Something went wrong",
                "error"
            );
        }

        return null;
    }

    return result.data;
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

    if (tabName === "products") {
        setTimeout(
            () =>
                productBarcodeInput.focus(),
            50
        );
    }

    if (tabName === "sales") {
        setTimeout(
            () =>
                saleBarcodeInput.focus(),
            50
        );
    }

    if (tabName === "mpesa") {
        loadPayments();
        loadMpesa();
    }
}


tabButtons.forEach(
    (button) => {
        button.addEventListener(
            "click",
            () => {
                activateTab(
                    button.dataset.tab
                );
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
        () => {
            row.classList.remove(
                "row-new"
            );
        },
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
// BARCODE LOOKUP
// ==========================================================

async function lookupProductByBarcode(
    barcode
) {
    const cleanBarcode =
        normalizeBarcode(
            barcode
        );

    if (!cleanBarcode) {
        return {
            found: false,
            status: 400,
            product: null,
            error: "Enter or scan a barcode."
        };
    }

    const cached =
        productsCache.find(
            (product) =>
                normalizeBarcode(
                    product.barcode
                ) === cleanBarcode
        );

    if (cached) {
        return {
            found: true,
            status: 200,
            product: cached,
            error: null
        };
    }

    const result =
        await requestJson(
            `/products/barcode/${encodeURIComponent(
                cleanBarcode
            )}`
        );

    if (result.ok) {
        return {
            found: true,
            status: result.status,
            product: result.data,
            error: null
        };
    }

    return {
        found: false,
        status: result.status,
        product: null,

        error:
            result.data.error ||
            "Product not found"
    };
}


function setStockExistingMode(
    product
) {
    activeStockProductId =
        product.id;

    productBarcodeInput.value =
        product.barcode || "";

    productNameInput.value =
        product.name;

    productPriceInput.value =
        Number(
            product.price
        ).toFixed(2);

    productStockInput.value =
        "";

    productNameInput.readOnly =
        true;

    productPriceInput.readOnly =
        true;

    productSubmitBtn.textContent =
        "Add to existing stock";

    setStatus(
        productBarcodeStatus,

        `${product.name} found. ` +
            `Current stock: ${product.stock}. ` +
            "Enter the quantity being added.",

        "found"
    );

    productStockInput.focus();
}


function setStockNewMode(
    barcode = ""
) {
    activeStockProductId =
        null;

    productNameInput.readOnly =
        false;

    productPriceInput.readOnly =
        false;

    productSubmitBtn.textContent =
        "Add entry";

    if (barcode) {
        setStatus(
            productBarcodeStatus,

            "New barcode. Enter the product " +
                "name, price and quantity.",

            "new"
        );

        productNameInput.focus();
    } else {
        setStatus(
            productBarcodeStatus,
            ""
        );
    }
}


function resetStockForm(
    keepBarcode = false
) {
    const barcode =
        keepBarcode
            ? productBarcodeInput.value
            : "";

    productForm.reset();

    productBarcodeInput.value =
        barcode;

    activeStockProductId =
        null;

    productNameInput.readOnly =
        false;

    productPriceInput.readOnly =
        false;

    productSubmitBtn.disabled =
        false;

    productSubmitBtn.textContent =
        "Add entry";

    setStatus(
        productBarcodeStatus,
        ""
    );
}


async function handleStockBarcodeLookup() {
    const barcode =
        normalizeBarcode(
            productBarcodeInput.value
        );

    productBarcodeInput.value =
        barcode;

    if (!barcode) {
        resetStockForm();
        productBarcodeInput.focus();

        return;
    }

    const token =
        ++stockLookupToken;

    productSubmitBtn.disabled =
        true;

    setStatus(
        productBarcodeStatus,
        "Checking barcode...",
        "loading"
    );

    const result =
        await lookupProductByBarcode(
            barcode
        );

    if (
        token !==
        stockLookupToken
    ) {
        return;
    }

    productSubmitBtn.disabled =
        false;

    if (result.found) {
        setStockExistingMode(
            result.product
        );

        return;
    }

    if (
        result.status === 404
    ) {
        productNameInput.value =
            "";

        productPriceInput.value =
            "";

        productStockInput.value =
            "";

        setStockNewMode(
            barcode
        );

        return;
    }

    setStockNewMode(
        barcode
    );

    setStatus(
        productBarcodeStatus,

        result.error ||
            "Barcode lookup failed.",

        "error"
    );
}


productBarcodeInput.addEventListener(
    "keydown",
    (event) => {
        if (
            event.key === "Enter"
        ) {
            event.preventDefault();

            handleStockBarcodeLookup();
        }
    }
);


productBarcodeInput.addEventListener(
    "input",
    () => {
        const currentProduct =
            productsCache.find(
                (product) =>
                    product.id ===
                    activeStockProductId
            );

        if (
            activeStockProductId &&

            normalizeBarcode(
                productBarcodeInput.value
            ) !==

                normalizeBarcode(
                    currentProduct?.barcode
                )
        ) {
            activeStockProductId =
                null;

            productNameInput.value =
                "";

            productPriceInput.value =
                "";

            productStockInput.value =
                "";

            setStockNewMode();
        }
    }
);


productBarcodeInput.addEventListener(
    "blur",
    () => {
        const barcode =
            normalizeBarcode(
                productBarcodeInput.value
            );

        if (
            barcode &&
            !activeStockProductId
        ) {
            handleStockBarcodeLookup();
        }
    }
);


saleBarcodeForm.addEventListener(
    "submit",
    async (event) => {
        event.preventDefault();

        const barcode =
            normalizeBarcode(
                saleBarcodeInput.value
            );

        saleBarcodeInput.value =
            barcode;

        if (!barcode) {
            setStatus(
                saleBarcodeStatus,
                "Scan or enter a barcode.",
                "error"
            );

            saleBarcodeInput.focus();

            return;
        }

        saleBarcodeBtn.disabled =
            true;

        saleBarcodeBtn.textContent =
            "Finding...";

        setStatus(
            saleBarcodeStatus,
            "Checking barcode...",
            "loading"
        );

        const result =
            await lookupProductByBarcode(
                barcode
            );

        saleBarcodeBtn.disabled =
            false;

        saleBarcodeBtn.textContent =
            "Find item";

        if (!result.found) {
            setStatus(
                saleBarcodeStatus,

                result.status === 404
                    ? (
                        "Product not found. Add it " +
                        "in the Stock tab first."
                    )
                    : (
                        result.error ||
                        "Barcode lookup failed."
                    ),

                "error"
            );

            saleBarcodeInput.select();

            return;
        }

        const product =
            result.product;

        const optionExists =
            Array
                .from(
                    saleProductSelect.options
                )
                .some(
                    (option) =>
                        Number(
                            option.value
                        ) ===
                        Number(
                            product.id
                        )
                );

        if (!optionExists) {
            await loadProducts();
        }

        saleProductSelect.value =
            String(
                product.id
            );

        saleQuantityInput.value =
            "1";

        updateSaleTotal();

        setStatus(
            saleBarcodeStatus,

            `${product.name} selected. ` +
                `Available stock: ${product.stock}.`,

            "found"
        );

        salePhoneInput.focus();
    }
);


function resetSaleBarcode() {
    saleBarcodeInput.value =
        "";

    setStatus(
        saleBarcodeStatus,
        ""
    );
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

    body.innerHTML =
        "";

    if (!products.length) {
        body.innerHTML =
            '<tr><td colspan="5">' +
            "No stock entries yet." +
            "</td></tr>";
    }

    let totalStock =
        0;

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

            row.dataset.id =
                product.id;

            row.innerHTML = `
                <td>
                    ${escapeHtml(
                        product.name
                    )}
                </td>

                <td class="mono">
                    ${escapeHtml(
                        product.barcode ||
                            "—"
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

            body.appendChild(
                row
            );
        }
    );

    document.getElementById(
        "totalStock"
    ).textContent =
        totalStock;

    const previousValue =
        saleProductSelect.value;

    saleProductSelect.innerHTML =
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
                String(
                    product.id
                ) ===
                previousValue
        )
    ) {
        saleProductSelect.value =
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
                        const product =
                            productsCache.find(
                                (item) =>
                                    String(
                                        item.id
                                    ) ===
                                    button.dataset.id
                            );

                        const confirmed =
                            window.confirm(
                                `Remove ${
                                    product?.name ||
                                    "this product"
                                } from stock?`
                            );

                        if (!confirmed) {
                            return;
                        }

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

                            if (
                                activeStockProductId ===
                                Number(
                                    button.dataset.id
                                )
                            ) {
                                resetStockForm();
                            }

                            await loadProducts();
                        }
                    }
                );
            }
        );

    return products;
}


productForm.addEventListener(
    "submit",
    async (event) => {
        event.preventDefault();

        const barcode =
            normalizeBarcode(
                productBarcodeInput.value
            );

        const name =
            productNameInput
                .value
                .trim();

        const price =
            Number.parseFloat(
                productPriceInput.value
            );

        const quantity =
            Number.parseInt(
                productStockInput.value,
                10
            );

        if (
            !Number.isInteger(
                quantity
            ) ||
            quantity < 0
        ) {
            showToast(
                "Enter a valid stock quantity",
                "error"
            );

            productStockInput.focus();

            return;
        }

        productSubmitBtn.disabled =
            true;

        if (
            activeStockProductId
        ) {
            if (
                quantity <= 0
            ) {
                showToast(
                    "Enter a quantity greater " +
                        "than zero to add stock",
                    "error"
                );

                productSubmitBtn.disabled =
                    false;

                productStockInput.focus();

                return;
            }

            productSubmitBtn.textContent =
                "Adding stock...";

            const result =
                await apiCall(
                    `/products/${activeStockProductId}/add-stock`,
                    {
                        method:
                            "POST",

                        headers: {
                            "Content-Type":
                                "application/json"
                        },

                        body:
                            JSON.stringify({
                                quantity
                            })
                    }
                );

            productSubmitBtn.disabled =
                false;

            if (!result) {
                productSubmitBtn.textContent =
                    "Add to existing stock";

                return;
            }

            showToast(
                `${result.name} stock ` +
                    `increased by ${quantity}`
            );

            resetStockForm();

            await loadProducts();

            flashRow(
                document.querySelector(
                    `#productsBody tr[data-id="${result.id}"]`
                )
            );

            productBarcodeInput.focus();

            return;
        }

        if (!name) {
            showToast(
                "Enter the product name",
                "error"
            );

            productSubmitBtn.disabled =
                false;

            productNameInput.focus();

            return;
        }

        if (
            !Number.isFinite(
                price
            ) ||
            price <= 0
        ) {
            showToast(
                "Enter a valid product price",
                "error"
            );

            productSubmitBtn.disabled =
                false;

            productPriceInput.focus();

            return;
        }

        productSubmitBtn.textContent =
            "Adding entry...";

        const result =
            await requestJson(
                "/products",
                {
                    method:
                        "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body:
                        JSON.stringify({
                            barcode:
                                barcode ||
                                null,

                            name,
                            price,
                            stock:
                                quantity
                        })
                }
            );

        productSubmitBtn.disabled =
            false;

        productSubmitBtn.textContent =
            "Add entry";

        if (!result.ok) {
            if (
                result.status === 409 &&
                result.data.existing_product
            ) {
                productsCache = [
                    ...productsCache.filter(
                        (product) =>
                            product.id !==
                            result.data
                                .existing_product
                                .id
                    ),

                    result.data
                        .existing_product
                ];

                setStockExistingMode(
                    result.data
                        .existing_product
                );

                showToast(
                    "That barcode already exists. " +
                        "Enter quantity to add stock.",
                    "error"
                );

                return;
            }

            showToast(
                result.data.error ||
                    "Could not add product",
                "error"
            );

            return;
        }

        showToast(
            `${name} added to stock`
        );

        resetStockForm();

        await loadProducts();

        flashRow(
            document.querySelector(
                `#productsBody tr[data-id="${result.data.id}"]`
            )
        );

        productBarcodeInput.focus();
    }
);


// ==========================================================
// SALES
// ==========================================================

async function loadSales() {
    const sales =
        await apiCall(
            "/sales"
        );

    if (!sales) {
        return null;
    }

    salesCache =
        sales;

    const body =
        document.getElementById(
            "salesBody"
        );

    body.innerHTML =
        "";

    if (!sales.length) {
        body.innerHTML =
            '<tr><td colspan="5">' +
            "No confirmed sales yet." +
            "</td></tr>";
    }

    let totalToday =
        0;

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

            body.appendChild(
                row
            );
        }
    );

    document.getElementById(
        "totalSales"
    ).textContent =
        formatKes(
            totalToday
        );

    return sales;
}


function selectedSaleProduct() {
    const productId =
        Number.parseInt(
            saleProductSelect.value,
            10
        );

    return (
        productsCache.find(
            (product) =>
                Number(
                    product.id
                ) ===
                productId
        ) ||
        null
    );
}


function updateSaleTotal() {
    const product =
        selectedSaleProduct();

    const quantity =
        Number.parseInt(
            saleQuantityInput.value,
            10
        ) || 0;

    const total =
        product &&
        quantity > 0
            ? (
                Number(
                    product.price
                ) *
                quantity
            )
            : 0;

    document.getElementById(
        "saleTotal"
    ).textContent =
        formatKes(
            total
        );
}


saleProductSelect.addEventListener(
    "change",
    () => {
        updateSaleTotal();

        const product =
            selectedSaleProduct();

        if (
            product?.barcode
        ) {
            saleBarcodeInput.value =
                product.barcode;

            setStatus(
                saleBarcodeStatus,

                `${product.name} selected. ` +
                    `Available stock: ${product.stock}.`,

                "found"
            );
        } else {
            resetSaleBarcode();
        }
    }
);


saleQuantityInput.addEventListener(
    "input",
    updateSaleTotal
);


saleForm.addEventListener(
    "submit",
    async (event) => {
        event.preventDefault();

        const product =
            selectedSaleProduct();

        const quantity =
            Number.parseInt(
                saleQuantityInput.value,
                10
            );

        const phoneNumber =
            salePhoneInput
                .value
                .trim();

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

            saleQuantityInput.focus();

            return;
        }

        if (
            quantity >
            Number(
                product.stock
            )
        ) {
            showToast(
                "Not enough stock available",
                "error"
            );

            saleQuantityInput.focus();

            return;
        }

        saleSubmitBtn.disabled =
            true;

        saleSubmitBtn.textContent =
            "Sending prompt...";

        setStatus(
            saleStatus,

            "Reserving stock and " +
                "contacting M-Pesa...",

            "loading"
        );

        const result =
            await apiCall(
                "/sales/request-payment",
                {
                    method:
                        "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body:
                        JSON.stringify({
                            product_id:
                                Number(
                                    product.id
                                ),

                            quantity,

                            phone_number:
                                phoneNumber
                        })
                }
            );

        saleSubmitBtn.disabled =
            false;

        saleSubmitBtn.textContent =
            "Send M-Pesa prompt";

        if (!result) {
            setStatus(
                saleStatus,
                "Payment request was not sent.",
                "error"
            );

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

        setStatus(
            saleStatus,

            `Prompt sent for ${formatKes(
                result.amount
            )}. ` +
                "Check the M-Pesa tab " +
                "for live updates.",

            "found"
        );

        showToast(
            "M-Pesa prompt sent"
        );

        await Promise.all([
            loadProducts(),
            loadPayments()
        ]);

        activateTab(
            "mpesa"
        );

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
        ].includes(
            status
        )
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
        payments[0] ||
        null
    );

    const body =
        document.getElementById(
            "paymentsBody"
        );

    body.innerHTML =
        "";

    if (!payments.length) {
        body.innerHTML =
            '<tr><td colspan="6">' +
            "No payment requests yet." +
            "</td></tr>";

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
                            ? ` × ${payment.quantity}`
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

            body.appendChild(
                row
            );
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

        paymentPollTimer =
            null;
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
    stopPaymentPolling(
        true
    );

    renderLatestPayment(
        payment
    );

    await refreshDashboard();

    if (
        payment.status ===
        "success"
    ) {
        setStatus(
            saleStatus,

            `Payment confirmed. ` +
                `Receipt: ${payment.mpesa_receipt}.`,

            "found"
        );

        saleForm.reset();

        saleQuantityInput.value =
            "1";

        resetSaleBarcode();
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
        setStatus(
            saleStatus,

            "Payment received, but stock " +
                "needs manual review.",

            "error"
        );

        showToast(
            "Payment needs manual review",
            "error"
        );
    } else {
        setStatus(
            saleStatus,
            payment.message,
            "error"
        );

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

    let pollRunning =
        false;

    const pollOnce =
        async () => {
            if (pollRunning) {
                return;
            }

            pollRunning =
                true;

            try {
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
            } finally {
                pollRunning =
                    false;
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

    body.innerHTML =
        "";

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

            body.appendChild(
                row
            );
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
                method:
                    "POST"
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