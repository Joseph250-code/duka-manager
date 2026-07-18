from collections import defaultdict
import os
import time
import uuid

from flask import Flask, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from database import get_connection, init_db
from mpesa import get_access_token, trigger_stk_push


app = Flask(__name__)

SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError(
        "SECRET_KEY environment variable is required. "
        "Generate one with: python -c 'import secrets; print(secrets.token_hex(32))'"
    )

app.secret_key = SECRET_KEY
app.config["SESSION_COOKIE_NAME"] = "duka_session"
app.config["SESSION_COOKIE_SAMESITE"] = "None"
app.config["SESSION_COOKIE_SECURE"] = True
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_PARTITIONED"] = True
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024

ALLOWED_ORIGIN = "https://duka-manager-frontend.onrender.com"
RATE_LIMIT = 30
RATE_WINDOW = 10
request_log = defaultdict(list)

PUBLIC_ROUTES = {
    "/",
    "/health",
    "/signup",
    "/login",
    "/test-mpesa-token",
    "/mpesa-callback",
}


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN
    response.headers["Access-Control-Allow-Methods"] = (
        "GET, POST, PUT, DELETE, OPTIONS"
    )
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Credentials"] = "true"
    return response


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({"error": "Request body too large"}), 413


@app.before_request
def rate_limit_and_auth():
    ip = request.remote_addr or "unknown"
    now = time.time()

    request_log[ip] = [
        timestamp
        for timestamp in request_log[ip]
        if now - timestamp < RATE_WINDOW
    ]

    if len(request_log[ip]) >= RATE_LIMIT:
        return jsonify({
            "error": "Too many requests — slow down"
        }), 429

    request_log[ip].append(now)

    if request.method == "OPTIONS":
        return None

    if request.path in PUBLIC_ROUTES:
        return None

    if not session.get("user_id"):
        return jsonify({
            "error": "Not logged in"
        }), 401

    return None


def current_user_id():
    return session["user_id"]


def normalize_phone(phone_number):
    """
    Return a Kenyan mobile number in 2547XXXXXXXX format.
    """
    if not isinstance(phone_number, str):
        return None

    phone_number = phone_number.strip().replace(" ", "")

    if not phone_number:
        return None

    if phone_number.startswith("0") and len(phone_number) == 10:
        phone_number = "254" + phone_number[1:]

    elif phone_number.startswith("+254"):
        phone_number = phone_number[1:]

    if (
        phone_number.startswith("254")
        and len(phone_number) == 12
        and phone_number.isdigit()
    ):
        return phone_number

    return None


def release_reserved_stock(
    checkout_request_id,
    final_status="failed",
):
    """
    Release reserved stock exactly once and set
    the request's final status.
    """
    conn = get_connection()

    try:
        conn.execute("BEGIN IMMEDIATE")

        pending = conn.execute(
            """
            SELECT *
            FROM pending_stk_requests
            WHERE checkout_request_id = ?
            """,
            (checkout_request_id,),
        ).fetchone()

        if not pending:
            conn.commit()
            return

        if (
            pending["stock_reserved"] == 1
            and pending["product_id"]
            and pending["quantity"]
        ):
            conn.execute(
                """
                UPDATE products
                SET stock = stock + ?
                WHERE id = ?
                  AND user_id = ?
                """,
                (
                    pending["quantity"],
                    pending["product_id"],
                    pending["user_id"],
                ),
            )

        conn.execute(
            """
            UPDATE pending_stk_requests
            SET status = ?,
                stock_reserved = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                final_status,
                pending["id"],
            ),
        )

        conn.commit()

    except Exception:
        conn.rollback()
        raise

    finally:
        conn.close()


def release_expired_reservations():
    """
    Return stock held by requests that have waited
    longer than 15 minutes.
    """
    conn = get_connection()

    try:
        conn.execute("BEGIN IMMEDIATE")

        expired = conn.execute(
            """
            SELECT *
            FROM pending_stk_requests
            WHERE stock_reserved = 1
              AND status IN ('initiating', 'pending')
              AND expires_at IS NOT NULL
              AND expires_at <= CURRENT_TIMESTAMP
            """
        ).fetchall()

        for pending in expired:
            if (
                pending["product_id"]
                and pending["quantity"]
            ):
                conn.execute(
                    """
                    UPDATE products
                    SET stock = stock + ?
                    WHERE id = ?
                      AND user_id = ?
                    """,
                    (
                        pending["quantity"],
                        pending["product_id"],
                        pending["user_id"],
                    ),
                )

            conn.execute(
                """
                UPDATE pending_stk_requests
                SET status = 'expired',
                    stock_reserved = 0,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (pending["id"],),
            )

        conn.commit()

    except Exception:
        conn.rollback()
        raise

    finally:
        conn.close()


def serialize_payment(payment):
    """
    Convert a pending STK row into a payment
    status message for the frontend.
    """
    payment_data = dict(payment)

    status = payment_data.get("status") or "pending"
    phone = payment_data.get("phone_number") or "customer"
    amount = float(payment_data.get("amount") or 0)
    product_name = (
        payment_data.get("product_name")
        or "Payment"
    )
    quantity = payment_data.get("quantity") or 1
    receipt = payment_data.get("mpesa_receipt")

    if status in {"initiating", "pending"}:
        message = (
            f"Payment request sent to {phone} "
            f"for KES {amount:.2f}. "
            "Waiting for the customer to enter "
            "their M-Pesa PIN."
        )

    elif status == "success":
        message = (
            f"Payment successful. Receipt: {receipt}. "
            f"{product_name} × {quantity} sold "
            f"for KES {amount:.2f}. "
            "The sale has been recorded and stock updated."
        )

    elif status == "cancelled":
        message = (
            "The customer cancelled the M-Pesa payment. "
            "The reserved stock has been returned."
        )

    elif status == "timed_out":
        message = (
            "The M-Pesa request timed out before payment "
            "was completed. The reserved stock has been returned."
        )

    elif status == "expired":
        message = (
            "The payment request expired without confirmation. "
            "The reserved stock has been returned."
        )

    elif status == "paid_no_stock":
        message = (
            f"Payment was received with receipt {receipt}, "
            "but the stock could not be allocated automatically. "
            "Manual review is required."
        )

    else:
        message = (
            "The M-Pesa payment was not completed. "
            "The reserved stock has been returned."
        )

    payment_data["message"] = message

    payment_data["is_terminal"] = status in {
        "success",
        "failed",
        "cancelled",
        "timed_out",
        "expired",
        "paid_no_stock",
    }

    return payment_data


def payment_query():
    return """
        SELECT
            pending_stk_requests.checkout_request_id,
            pending_stk_requests.phone_number,
            pending_stk_requests.amount,
            pending_stk_requests.status,
            pending_stk_requests.mpesa_receipt,
            pending_stk_requests.product_id,
            pending_stk_requests.quantity,
            pending_stk_requests.created_at,
            pending_stk_requests.updated_at,
            products.name AS product_name
        FROM pending_stk_requests
        LEFT JOIN products
            ON pending_stk_requests.product_id = products.id
    """


@app.route("/", methods=["GET"])
@app.route("/health", methods=["GET"])
def health_check():
    return jsonify({
        "status": "ok",
        "service": "duka-manager-backend",
    }), 200


# ============================================================
# AUTHENTICATION
# ============================================================

@app.route("/signup", methods=["POST"])
def signup():
    data = request.get_json(silent=True)

    if not data:
        return jsonify({
            "error": "Invalid or missing JSON body"
        }), 400

    username = data.get("username")
    password = data.get("password")

    if (
        not isinstance(username, str)
        or not username.strip()
    ):
        return jsonify({
            "error": "username must be a non-empty string"
        }), 400

    username = username.strip()[:50]

    if (
        not isinstance(password, str)
        or len(password) < 6
    ):
        return jsonify({
            "error": "password must be at least 6 characters"
        }), 400

    conn = get_connection()

    existing = conn.execute(
        """
        SELECT id
        FROM users
        WHERE username = ?
        """,
        (username,),
    ).fetchone()

    if existing:
        conn.close()

        return jsonify({
            "error": "That username is already taken"
        }), 409

    password_hash = generate_password_hash(password)

    cursor = conn.execute(
        """
        INSERT INTO users (
            username,
            password_hash
        )
        VALUES (?, ?)
        """,
        (
            username,
            password_hash,
        ),
    )

    conn.commit()

    new_id = cursor.lastrowid

    conn.close()

    session["user_id"] = new_id
    session["username"] = username

    return jsonify({
        "message": "Account created",
        "username": username,
    }), 201


@app.route("/login", methods=["POST"])
def login():
    data = request.get_json(silent=True)

    if not data:
        return jsonify({
            "error": "Invalid or missing JSON body"
        }), 400

    username = data.get("username")
    password = data.get("password")

    if (
        not isinstance(username, str)
        or not isinstance(password, str)
    ):
        return jsonify({
            "error": "username and password are required"
        }), 400

    conn = get_connection()

    user = conn.execute(
        """
        SELECT *
        FROM users
        WHERE username = ?
        """,
        (username.strip(),),
    ).fetchone()

    conn.close()

    if (
        not user
        or not check_password_hash(
            user["password_hash"],
            password,
        )
    ):
        return jsonify({
            "error": "Invalid username or password"
        }), 401

    session["user_id"] = user["id"]
    session["username"] = user["username"]

    return jsonify({
        "message": "Logged in",
        "username": user["username"],
    })


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()

    return jsonify({
        "message": "Logged out"
    })


@app.route("/me", methods=["GET"])
def me():
    return jsonify({
        "username": session.get("username")
    })


# Create or update database tables at startup.
init_db()


# ============================================================
# PRODUCTS
# ============================================================

@app.route("/products", methods=["GET"])
def get_products():
    release_expired_reservations()

    conn = get_connection()

    products = conn.execute(
        """
        SELECT *
        FROM products
        WHERE user_id = ?
        ORDER BY name
        """,
        (current_user_id(),),
    ).fetchall()

    conn.close()

    return jsonify([
        dict(product)
        for product in products
    ])


@app.route("/products", methods=["POST"])
def add_product():
    data = request.get_json(silent=True)

    if not data:
        return jsonify({
            "error": "Invalid or missing JSON body"
        }), 400

    name = data.get("name")
    price = data.get("price")
    stock = data.get("stock", 0)

    if (
        not isinstance(name, str)
        or not name.strip()
    ):
        return jsonify({
            "error": "name must be a non-empty string"
        }), 400

    if (
        not isinstance(price, (int, float))
        or isinstance(price, bool)
        or price <= 0
    ):
        return jsonify({
            "error": "price must be a positive number"
        }), 400

    if (
        not isinstance(stock, int)
        or isinstance(stock, bool)
        or stock < 0
    ):
        return jsonify({
            "error": (
                "stock must be zero or "
                "a positive whole number"
            )
        }), 400

    name = name.strip()[:100]

    conn = get_connection()

    cursor = conn.execute(
        """
        INSERT INTO products (
            user_id,
            name,
            price,
            stock
        )
        VALUES (?, ?, ?, ?)
        """,
        (
            current_user_id(),
            name,
            price,
            stock,
        ),
    )

    conn.commit()

    product_id = cursor.lastrowid

    conn.close()

    return jsonify({
        "id": product_id,
        "name": name,
        "price": price,
        "stock": stock,
    }), 201


@app.route(
    "/products/<int:product_id>",
    methods=["PUT"],
)
def update_product(product_id):
    data = request.get_json(silent=True)

    if not data:
        return jsonify({
            "error": "Invalid or missing JSON body"
        }), 400

    conn = get_connection()

    product = conn.execute(
        """
        SELECT *
        FROM products
        WHERE id = ?
          AND user_id = ?
        """,
        (
            product_id,
            current_user_id(),
        ),
    ).fetchone()

    if not product:
        conn.close()

        return jsonify({
            "error": "Product not found"
        }), 404

    name = data.get(
        "name",
        product["name"],
    )

    price = data.get(
        "price",
        product["price"],
    )

    stock = data.get(
        "stock",
        product["stock"],
    )

    if (
        not isinstance(name, str)
        or not name.strip()
    ):
        conn.close()

        return jsonify({
            "error": "name must be a non-empty string"
        }), 400

    if (
        not isinstance(price, (int, float))
        or isinstance(price, bool)
        or price <= 0
    ):
        conn.close()

        return jsonify({
            "error": "price must be a positive number"
        }), 400

    if (
        not isinstance(stock, int)
        or isinstance(stock, bool)
        or stock < 0
    ):
        conn.close()

        return jsonify({
            "error": (
                "stock must be zero or "
                "a positive whole number"
            )
        }), 400

    name = name.strip()[:100]

    conn.execute(
        """
        UPDATE products
        SET name = ?,
            price = ?,
            stock = ?
        WHERE id = ?
          AND user_id = ?
        """,
        (
            name,
            price,
            stock,
            product_id,
            current_user_id(),
        ),
    )

    conn.commit()
    conn.close()

    return jsonify({
        "id": product_id,
        "name": name,
        "price": price,
        "stock": stock,
    })


@app.route(
    "/products/<int:product_id>",
    methods=["DELETE"],
)
def delete_product(product_id):
    conn = get_connection()

    conn.execute(
        """
        DELETE FROM products
        WHERE id = ?
          AND user_id = ?
        """,
        (
            product_id,
            current_user_id(),
        ),
    )

    conn.commit()
    conn.close()

    return jsonify({
        "message": "Product deleted"
    })


# ============================================================
# SALES
# ============================================================

@app.route("/sales", methods=["GET"])
def get_sales():
    conn = get_connection()

    sales = conn.execute(
        """
        SELECT
            sales.id,
            sales.product_id,
            products.name,
            sales.quantity,
            sales.total_amount,
            sales.sale_time,
            sales.matched
        FROM sales
        JOIN products
            ON sales.product_id = products.id
        WHERE sales.user_id = ?
        ORDER BY sales.sale_time DESC
        """,
        (current_user_id(),),
    ).fetchall()

    conn.close()

    return jsonify([
        dict(sale)
        for sale in sales
    ])


@app.route("/sales", methods=["POST"])
def record_sale():
    """
    Manual sale route retained for backwards compatibility.
    """
    release_expired_reservations()

    data = request.get_json(silent=True)

    if not data:
        return jsonify({
            "error": "Invalid or missing JSON body"
        }), 400

    product_id = data.get("product_id")
    quantity = data.get("quantity")

    if (
        not isinstance(product_id, int)
        or isinstance(product_id, bool)
        or product_id <= 0
    ):
        return jsonify({
            "error": "product_id must be a positive integer"
        }), 400

    if (
        not isinstance(quantity, int)
        or isinstance(quantity, bool)
        or quantity <= 0
    ):
        return jsonify({
            "error": "quantity must be a positive integer"
        }), 400

    if quantity > 100000:
        return jsonify({
            "error": "quantity is unrealistically large"
        }), 400

    conn = get_connection()

    try:
        conn.execute("BEGIN IMMEDIATE")

        product = conn.execute(
            """
            SELECT *
            FROM products
            WHERE id = ?
              AND user_id = ?
            """,
            (
                product_id,
                current_user_id(),
            ),
        ).fetchone()

        if not product:
            conn.rollback()

            return jsonify({
                "error": "Product not found"
            }), 404

        if product["stock"] < quantity:
            conn.rollback()

            return jsonify({
                "error": "Not enough stock available"
            }), 400

        total_amount = round(
            product["price"] * quantity,
            2,
        )

        conn.execute(
            """
            INSERT INTO sales (
                user_id,
                product_id,
                quantity,
                total_amount
            )
            VALUES (?, ?, ?, ?)
            """,
            (
                current_user_id(),
                product_id,
                quantity,
                total_amount,
            ),
        )

        conn.execute(
            """
            UPDATE products
            SET stock = stock - ?
            WHERE id = ?
              AND user_id = ?
            """,
            (
                quantity,
                product_id,
                current_user_id(),
            ),
        )

        conn.commit()

        return jsonify({
            "product_id": product_id,
            "product_name": product["name"],
            "quantity": quantity,
            "total_amount": total_amount,
            "remaining_stock": (
                product["stock"] - quantity
            ),
        }), 201

    finally:
        conn.close()


@app.route(
    "/sales/request-payment",
    methods=["POST"],
)
def request_sale_payment():
    """
    Reserve stock, send an STK Push, and wait for
    the callback before recording the sale.
    """
    data = request.get_json(silent=True)

    if not data:
        return jsonify({
            "error": "Invalid or missing JSON body"
        }), 400

    product_id = data.get("product_id")
    quantity = data.get("quantity")

    phone_number = normalize_phone(
        data.get("phone_number")
    )

    if (
        not isinstance(product_id, int)
        or isinstance(product_id, bool)
        or product_id <= 0
    ):
        return jsonify({
            "error": "product_id must be a positive integer"
        }), 400

    if (
        not isinstance(quantity, int)
        or isinstance(quantity, bool)
        or quantity <= 0
    ):
        return jsonify({
            "error": "quantity must be a positive integer"
        }), 400

    if quantity > 100000:
        return jsonify({
            "error": "quantity is unrealistically large"
        }), 400

    if not phone_number:
        return jsonify({
            "error": (
                "phone_number must be a valid Kenyan "
                "number (e.g. 0712345678)"
            )
        }), 400

    release_expired_reservations()

    user_id = current_user_id()

    local_request_id = (
        f"LOCAL-{uuid.uuid4().hex}"
    )

    conn = get_connection()

    try:
        conn.execute("BEGIN IMMEDIATE")

        product = conn.execute(
            """
            SELECT *
            FROM products
            WHERE id = ?
              AND user_id = ?
            """,
            (
                product_id,
                user_id,
            ),
        ).fetchone()

        if not product:
            conn.rollback()

            return jsonify({
                "error": "Product not found"
            }), 404

        total_amount = round(
            product["price"] * quantity,
            2,
        )

        stock_update = conn.execute(
            """
            UPDATE products
            SET stock = stock - ?
            WHERE id = ?
              AND user_id = ?
              AND stock >= ?
            """,
            (
                quantity,
                product_id,
                user_id,
                quantity,
            ),
        )

        if stock_update.rowcount != 1:
            conn.rollback()

            return jsonify({
                "error": "Not enough stock available"
            }), 400

        conn.execute(
            """
            INSERT INTO pending_stk_requests (
                user_id,
                checkout_request_id,
                phone_number,
                amount,
                product_id,
                quantity,
                status,
                stock_reserved,
                expires_at
            )
            VALUES (
                ?, ?, ?, ?, ?, ?,
                'initiating',
                1,
                datetime('now', '+15 minutes')
            )
            """,
            (
                user_id,
                local_request_id,
                phone_number,
                total_amount,
                product_id,
                quantity,
            ),
        )

        conn.commit()

    except Exception as error:
        conn.rollback()

        return jsonify({
            "error": (
                "Could not reserve stock: "
                f"{str(error)}"
            )
        }), 500

    finally:
        conn.close()

    try:
        result = trigger_stk_push(
            phone_number,
            total_amount,
        )

    except Exception as error:
        release_reserved_stock(
            local_request_id,
            "failed",
        )

        return jsonify({
            "error": (
                "Failed to reach M-Pesa: "
                f"{str(error)}"
            )
        }), 502

    checkout_request_id = result.get(
        "CheckoutRequestID"
    )

    response_code = result.get(
        "ResponseCode"
    )

    if (
        str(response_code) != "0"
        or not checkout_request_id
    ):
        release_reserved_stock(
            local_request_id,
            "failed",
        )

        return jsonify({
            "error": result.get(
                "errorMessage",
                "M-Pesa rejected the request",
            )
        }), 400

    conn = get_connection()

    try:
        conn.execute("BEGIN IMMEDIATE")

        updated = conn.execute(
            """
            UPDATE pending_stk_requests
            SET checkout_request_id = ?,
                status = 'pending',
                updated_at = CURRENT_TIMESTAMP
            WHERE checkout_request_id = ?
              AND status = 'initiating'
            """,
            (
                checkout_request_id,
                local_request_id,
            ),
        )

        if updated.rowcount != 1:
            raise RuntimeError(
                "The pending payment reservation "
                "could not be finalized"
            )

        conn.commit()

    except Exception as error:
        conn.rollback()
        conn.close()

        release_reserved_stock(
            local_request_id,
            "failed",
        )

        return jsonify({
            "error": (
                "Could not save the M-Pesa request: "
                f"{str(error)}"
            )
        }), 500

    else:
        conn.close()

    return jsonify({
        "message": (
            f"Payment prompt sent for {product['name']} "
            "— waiting for customer to pay"
        ),
        "checkout_request_id": checkout_request_id,
        "phone_number": phone_number,
        "product_id": product_id,
        "product_name": product["name"],
        "quantity": quantity,
        "amount": total_amount,
        "remaining_stock": (
            product["stock"] - quantity
        ),
        "status": "pending",
    }), 201


# ============================================================
# PAYMENT STATUS MESSAGES
# ============================================================

@app.route("/payments", methods=["GET"])
def get_payments():
    release_expired_reservations()

    conn = get_connection()

    payments = conn.execute(
        payment_query()
        + """
        WHERE pending_stk_requests.user_id = ?
        ORDER BY pending_stk_requests.created_at DESC
        LIMIT 50
        """,
        (current_user_id(),),
    ).fetchall()

    conn.close()

    return jsonify([
        serialize_payment(payment)
        for payment in payments
    ])


@app.route(
    "/payments/<checkout_request_id>",
    methods=["GET"],
)
def get_payment_status(checkout_request_id):
    release_expired_reservations()

    conn = get_connection()

    payment = conn.execute(
        payment_query()
        + """
        WHERE pending_stk_requests.checkout_request_id = ?
          AND pending_stk_requests.user_id = ?
        """,
        (
            checkout_request_id,
            current_user_id(),
        ),
    ).fetchone()

    conn.close()

    if not payment:
        return jsonify({
            "error": "Payment request not found"
        }), 404

    return jsonify(
        serialize_payment(payment)
    )


# ============================================================
# M-PESA LEDGER
# ============================================================

@app.route("/mpesa", methods=["GET"])
def get_mpesa_transactions():
    conn = get_connection()

    transactions = conn.execute(
        """
        SELECT *
        FROM mpesa_transactions
        WHERE user_id = ?
        ORDER BY transaction_time DESC
        """,
        (current_user_id(),),
    ).fetchall()

    conn.close()

    return jsonify([
        dict(transaction)
        for transaction in transactions
    ])


@app.route("/mpesa", methods=["POST"])
def add_mpesa_transaction():
    data = request.get_json(silent=True)

    if not data:
        return jsonify({
            "error": "Invalid or missing JSON body"
        }), 400

    mpesa_code = data.get("mpesa_code")
    sender_name = data.get("sender_name")
    amount = data.get("amount")

    if (
        not isinstance(mpesa_code, str)
        or not mpesa_code.strip()
    ):
        return jsonify({
            "error": "mpesa_code must be a non-empty string"
        }), 400

    if (
        sender_name is not None
        and not isinstance(sender_name, str)
    ):
        return jsonify({
            "error": "sender_name must be a string"
        }), 400

    if (
        not isinstance(amount, (int, float))
        or isinstance(amount, bool)
        or amount <= 0
    ):
        return jsonify({
            "error": "amount must be a positive number"
        }), 400

    mpesa_code = mpesa_code.strip()[:30]

    sender_name = (
        sender_name.strip()[:100]
        if sender_name
        else None
    )

    conn = get_connection()

    existing = conn.execute(
        """
        SELECT id
        FROM mpesa_transactions
        WHERE mpesa_code = ?
        """,
        (mpesa_code,),
    ).fetchone()

    if existing:
        conn.close()

        return jsonify({
            "error": (
                "This M-Pesa code has already "
                "been recorded"
            )
        }), 409

    cursor = conn.execute(
        """
        INSERT INTO mpesa_transactions (
            user_id,
            mpesa_code,
            sender_name,
            amount
        )
        VALUES (?, ?, ?, ?)
        """,
        (
            current_user_id(),
            mpesa_code,
            sender_name,
            amount,
        ),
    )

    conn.commit()

    transaction_id = cursor.lastrowid

    conn.close()

    return jsonify({
        "id": transaction_id,
        "mpesa_code": mpesa_code,
        "sender_name": sender_name,
        "amount": amount,
    }), 201


# ============================================================
# RECONCILIATION
# ============================================================

@app.route("/reconcile", methods=["POST"])
def reconcile():
    user_id = current_user_id()

    conn = get_connection()

    unmatched_sales = conn.execute(
        """
        SELECT *
        FROM sales
        WHERE matched = 0
          AND user_id = ?
        ORDER BY sale_time ASC
        """,
        (user_id,),
    ).fetchall()

    unmatched_mpesa = conn.execute(
        """
        SELECT *
        FROM mpesa_transactions
        WHERE matched = 0
          AND user_id = ?
        ORDER BY transaction_time ASC
        """,
        (user_id,),
    ).fetchall()

    unmatched_mpesa_list = [
        dict(transaction)
        for transaction in unmatched_mpesa
    ]

    matched_pairs = []

    for sale in unmatched_sales:
        sale_data = dict(sale)

        match = next(
            (
                transaction
                for transaction in unmatched_mpesa_list
                if (
                    transaction["amount"]
                    == sale_data["total_amount"]
                )
            ),
            None,
        )

        if match:
            conn.execute(
                """
                UPDATE sales
                SET matched = 1
                WHERE id = ?
                """,
                (sale_data["id"],),
            )

            conn.execute(
                """
                UPDATE mpesa_transactions
                SET matched = 1
                WHERE id = ?
                """,
                (match["id"],),
            )

            unmatched_mpesa_list.remove(match)

            matched_pairs.append({
                "sale_id": sale_data["id"],
                "mpesa_id": match["id"],
                "amount": sale_data["total_amount"],
            })

    conn.commit()

    still_unmatched_sales = conn.execute(
        """
        SELECT
            sales.id,
            products.name,
            sales.quantity,
            sales.total_amount,
            sales.sale_time
        FROM sales
        JOIN products
            ON sales.product_id = products.id
        WHERE sales.matched = 0
          AND sales.user_id = ?
        """,
        (user_id,),
    ).fetchall()

    still_unmatched_mpesa = conn.execute(
        """
        SELECT *
        FROM mpesa_transactions
        WHERE matched = 0
          AND user_id = ?
        """,
        (user_id,),
    ).fetchall()

    conn.close()

    return jsonify({
        "matched_count": len(matched_pairs),
        "matched_pairs": matched_pairs,
        "unmatched_sales": [
            dict(sale)
            for sale in still_unmatched_sales
        ],
        "unmatched_mpesa": [
            dict(transaction)
            for transaction in still_unmatched_mpesa
        ],
    })


# ============================================================
# GENERIC STK PUSH
# Retained temporarily until the old Request Payment tab
# is removed from the frontend.
# ============================================================

@app.route("/stkpush", methods=["POST"])
def stk_push():
    data = request.get_json(silent=True)

    if not data:
        return jsonify({
            "error": "Invalid or missing JSON body"
        }), 400

    phone_number = normalize_phone(
        data.get("phone_number")
    )

    amount = data.get("amount")

    if not phone_number:
        return jsonify({
            "error": (
                "phone_number must be a valid Kenyan "
                "number (e.g. 0712345678)"
            )
        }), 400

    if (
        not isinstance(amount, (int, float))
        or isinstance(amount, bool)
        or amount <= 0
    ):
        return jsonify({
            "error": "amount must be a positive number"
        }), 400

    try:
        result = trigger_stk_push(
            phone_number,
            amount,
        )

    except Exception as error:
        return jsonify({
            "error": (
                "Failed to reach M-Pesa: "
                f"{str(error)}"
            )
        }), 502

    checkout_request_id = result.get(
        "CheckoutRequestID"
    )

    response_code = result.get(
        "ResponseCode"
    )

    if (
        str(response_code) != "0"
        or not checkout_request_id
    ):
        return jsonify({
            "error": result.get(
                "errorMessage",
                "M-Pesa rejected the request",
            )
        }), 400

    conn = get_connection()

    conn.execute(
        """
        INSERT INTO pending_stk_requests (
            user_id,
            checkout_request_id,
            phone_number,
            amount,
            status
        )
        VALUES (?, ?, ?, ?, 'pending')
        """,
        (
            current_user_id(),
            checkout_request_id,
            phone_number,
            amount,
        ),
    )

    conn.commit()
    conn.close()

    return jsonify({
        "message": (
            "Payment prompt sent to customer's phone"
        ),
        "checkout_request_id": checkout_request_id,
        "phone_number": phone_number,
        "amount": amount,
        "status": "pending",
    }), 201


# ============================================================
# SAFARICOM CALLBACK
# ============================================================

@app.route("/mpesa-callback", methods=["POST"])
def mpesa_callback():
    data = request.get_json(silent=True)

    if not data:
        return jsonify({
            "ResultCode": 1,
            "ResultDesc": "No data received",
        }), 200

    stk_callback = (
        data
        .get("Body", {})
        .get("stkCallback", {})
    )

    checkout_request_id = stk_callback.get(
        "CheckoutRequestID"
    )

    result_code = stk_callback.get(
        "ResultCode"
    )

    if not checkout_request_id:
        return jsonify({
            "ResultCode": 1,
            "ResultDesc": "Missing CheckoutRequestID",
        }), 200

    conn = get_connection()

    try:
        conn.execute("BEGIN IMMEDIATE")

        pending = conn.execute(
            """
            SELECT *
            FROM pending_stk_requests
            WHERE checkout_request_id = ?
            """,
            (checkout_request_id,),
        ).fetchone()

        if not pending:
            conn.commit()

            return jsonify({
                "ResultCode": 0,
                "ResultDesc": "Accepted",
            }), 200

        terminal_statuses = {
            "success",
            "failed",
            "cancelled",
            "timed_out",
            "paid_no_stock",
        }

        if pending["status"] in terminal_statuses:
            conn.commit()

            return jsonify({
                "ResultCode": 0,
                "ResultDesc": "Already processed",
            }), 200

        if str(result_code) == "0":
            metadata_items = (
                stk_callback
                .get("CallbackMetadata", {})
                .get("Item", [])
            )

            metadata = {
                item.get("Name"): item.get("Value")
                for item in metadata_items
                if item.get("Name")
            }

            mpesa_receipt = metadata.get(
                "MpesaReceiptNumber",
                f"STK{checkout_request_id[-10:]}",
            )

            amount_paid = metadata.get(
                "Amount",
                pending["amount"],
            )

            if (
                pending["product_id"]
                and pending["quantity"]
            ):
                if pending["stock_reserved"] != 1:
                    late_stock_update = conn.execute(
                        """
                        UPDATE products
                        SET stock = stock - ?
                        WHERE id = ?
                          AND user_id = ?
                          AND stock >= ?
                        """,
                        (
                            pending["quantity"],
                            pending["product_id"],
                            pending["user_id"],
                            pending["quantity"],
                        ),
                    )

                    if late_stock_update.rowcount != 1:
                        conn.execute(
                            """
                            INSERT OR IGNORE INTO
                            mpesa_transactions (
                                user_id,
                                mpesa_code,
                                sender_name,
                                amount,
                                matched
                            )
                            VALUES (?, ?, ?, ?, 0)
                            """,
                            (
                                pending["user_id"],
                                mpesa_receipt,
                                pending["phone_number"],
                                amount_paid,
                            ),
                        )

                        conn.execute(
                            """
                            UPDATE pending_stk_requests
                            SET status = 'paid_no_stock',
                                mpesa_receipt = ?,
                                stock_reserved = 0,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?
                            """,
                            (
                                mpesa_receipt,
                                pending["id"],
                            ),
                        )

                        conn.commit()

                        return jsonify({
                            "ResultCode": 0,
                            "ResultDesc": (
                                "Paid but stock requires "
                                "manual review"
                            ),
                        }), 200

                conn.execute(
                    """
                    INSERT INTO sales (
                        user_id,
                        product_id,
                        quantity,
                        total_amount,
                        matched
                    )
                    VALUES (?, ?, ?, ?, 1)
                    """,
                    (
                        pending["user_id"],
                        pending["product_id"],
                        pending["quantity"],
                        amount_paid,
                    ),
                )

                conn.execute(
                    """
                    INSERT INTO mpesa_transactions (
                        user_id,
                        mpesa_code,
                        sender_name,
                        amount,
                        matched
                    )
                    VALUES (?, ?, ?, ?, 1)
                    """,
                    (
                        pending["user_id"],
                        mpesa_receipt,
                        pending["phone_number"],
                        amount_paid,
                    ),
                )

            else:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO
                    mpesa_transactions (
                        user_id,
                        mpesa_code,
                        sender_name,
                        amount
                    )
                    VALUES (?, ?, ?, ?)
                    """,
                    (
                        pending["user_id"],
                        mpesa_receipt,
                        pending["phone_number"],
                        amount_paid,
                    ),
                )

            conn.execute(
                """
                UPDATE pending_stk_requests
                SET status = 'success',
                    mpesa_receipt = ?,
                    stock_reserved = 0,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (
                    mpesa_receipt,
                    pending["id"],
                ),
            )

        else:
            if (
                pending["stock_reserved"] == 1
                and pending["product_id"]
                and pending["quantity"]
            ):
                conn.execute(
                    """
                    UPDATE products
                    SET stock = stock + ?
                    WHERE id = ?
                      AND user_id = ?
                    """,
                    (
                        pending["quantity"],
                        pending["product_id"],
                        pending["user_id"],
                    ),
                )

            result_code_text = str(result_code)

            if result_code_text == "1032":
                final_status = "cancelled"

            elif result_code_text == "1037":
                final_status = "timed_out"

            else:
                final_status = "failed"

            conn.execute(
                """
                UPDATE pending_stk_requests
                SET status = ?,
                    stock_reserved = 0,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (
                    final_status,
                    pending["id"],
                ),
            )

        conn.commit()

    except Exception:
        conn.rollback()

        return jsonify({
            "ResultCode": 1,
            "ResultDesc": "Callback processing failed",
        }), 200

    finally:
        conn.close()

    return jsonify({
        "ResultCode": 0,
        "ResultDesc": "Accepted",
    }), 200


# Temporary OAuth test route.
# Remove it after confirming Daraja is working.

@app.route(
    "/test-mpesa-token",
    methods=["GET"],
)
def test_mpesa_token():
    try:
        token = get_access_token()

        return jsonify({
            "access_token": token
        })

    except Exception as error:
        return jsonify({
            "error": str(error)
        }), 500


if __name__ == "__main__":
    app.run(
        debug=False,
        host="0.0.0.0",
        port=8080,
    )