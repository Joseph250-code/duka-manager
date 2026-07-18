from flask import Flask, jsonify, request, session
from werkzeug.security import generate_password_hash, check_password_hash
from database import get_connection, init_db
from mpesa import get_access_token, trigger_stk_push
import time
import secrets
from collections import defaultdict

app = Flask(__name__)

app.secret_key = secrets.token_hex(32)
app.config["SESSION_COOKIE_SAMESITE"] = "None"
app.config["SESSION_COOKIE_SECURE"] = True
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024

ALLOWED_ORIGIN = "https://duka-manager-frontend.onrender.com"

@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Credentials"] = "true"
    return response

@app.errorhandler(413)
def request_too_large(e):
    return jsonify({"error": "Request body too large"}), 413

RATE_LIMIT = 30
RATE_WINDOW = 10
request_log = defaultdict(list)

PUBLIC_ROUTES = {"/signup", "/login", "/test-mpesa-token"}

@app.before_request
def rate_limit_and_auth():
    ip = request.remote_addr
    now = time.time()
    request_log[ip] = [t for t in request_log[ip] if now - t < RATE_WINDOW]

    if len(request_log[ip]) >= RATE_LIMIT:
        return jsonify({"error": "Too many requests — slow down"}), 429

    request_log[ip].append(now)

    if request.method == "OPTIONS":
        return

    if request.path in PUBLIC_ROUTES:
        return

    if not session.get("user_id"):
        return jsonify({"error": "Not logged in"}), 401


def current_user_id():
    return session["user_id"]


# ---- AUTH ----
@app.route("/signup", methods=["POST"])
def signup():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid or missing JSON body"}), 400

    username = data.get("username")
    password = data.get("password")

    if not isinstance(username, str) or not username.strip():
        return jsonify({"error": "username must be a non-empty string"}), 400
    username = username.strip()[:50]

    if not isinstance(password, str) or len(password) < 6:
        return jsonify({"error": "password must be at least 6 characters"}), 400

    conn = get_connection()
    existing = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()

    if existing:
        conn.close()
        return jsonify({"error": "That username is already taken"}), 409

    password_hash = generate_password_hash(password)

    cursor = conn.execute(
        "INSERT INTO users (username, password_hash) VALUES (?, ?)",
        (username, password_hash)
    )
    conn.commit()
    new_id = cursor.lastrowid
    conn.close()

    session["user_id"] = new_id
    session["username"] = username

    return jsonify({"message": "Account created", "username": username}), 201


@app.route("/login", methods=["POST"])
def login():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid or missing JSON body"}), 400

    username = data.get("username")
    password = data.get("password")

    if not isinstance(username, str) or not isinstance(password, str):
        return jsonify({"error": "username and password are required"}), 400

    conn = get_connection()
    user = conn.execute("SELECT * FROM users WHERE username = ?", (username.strip(),)).fetchone()
    conn.close()

    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Invalid username or password"}), 401

    session["user_id"] = user["id"]
    session["username"] = user["username"]

    return jsonify({"message": "Logged in", "username": user["username"]})


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"message": "Logged out"})


@app.route("/me", methods=["GET"])
def me():
    return jsonify({"username": session.get("username")})


# Make sure database exists on startup
init_db()

@app.route("/products", methods=["GET"])
def get_products():
    conn = get_connection()
    products = conn.execute(
        "SELECT * FROM products WHERE user_id = ?", (current_user_id(),)
    ).fetchall()
    conn.close()
    return jsonify([dict(p) for p in products])

@app.route("/products", methods=["POST"])
def add_product():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid or missing JSON body"}), 400

    name = data.get("name")
    price = data.get("price")
    stock = data.get("stock", 0)

    if not isinstance(name, str) or not name.strip():
        return jsonify({"error": "name must be a non-empty string"}), 400
    name = name.strip()[:100]

    if not isinstance(price, (int, float)) or isinstance(price, bool) or price <= 0:
        return jsonify({"error": "price must be a positive number"}), 400

    if not isinstance(stock, int) or isinstance(stock, bool) or stock < 0:
        return jsonify({"error": "stock must be zero or a positive whole number"}), 400

    conn = get_connection()
    cursor = conn.execute(
        "INSERT INTO products (user_id, name, price, stock) VALUES (?, ?, ?, ?)",
        (current_user_id(), name, price, stock)
    )
    conn.commit()
    new_id = cursor.lastrowid
    conn.close()

    return jsonify({"id": new_id, "name": name, "price": price, "stock": stock}), 201

@app.route("/products/<int:product_id>", methods=["PUT"])
def update_product(product_id):
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid or missing JSON body"}), 400

    conn = get_connection()

    product = conn.execute(
        "SELECT * FROM products WHERE id = ? AND user_id = ?", (product_id, current_user_id())
    ).fetchone()
    if not product:
        conn.close()
        return jsonify({"error": "Product not found"}), 404

    name = data.get("name", product["name"])
    price = data.get("price", product["price"])
    stock = data.get("stock", product["stock"])

    if not isinstance(name, str) or not name.strip():
        conn.close()
        return jsonify({"error": "name must be a non-empty string"}), 400
    name = name.strip()[:100]

    if not isinstance(price, (int, float)) or isinstance(price, bool) or price <= 0:
        conn.close()
        return jsonify({"error": "price must be a positive number"}), 400

    if not isinstance(stock, int) or isinstance(stock, bool) or stock < 0:
        conn.close()
        return jsonify({"error": "stock must be zero or a positive whole number"}), 400

    conn.execute(
        "UPDATE products SET name = ?, price = ?, stock = ? WHERE id = ? AND user_id = ?",
        (name, price, stock, product_id, current_user_id())
    )
    conn.commit()
    conn.close()

    return jsonify({"id": product_id, "name": name, "price": price, "stock": stock})

@app.route("/products/<int:product_id>", methods=["DELETE"])
def delete_product(product_id):
    conn = get_connection()
    conn.execute(
        "DELETE FROM products WHERE id = ? AND user_id = ?", (product_id, current_user_id())
    )
    conn.commit()
    conn.close()
    return jsonify({"message": "Product deleted"})


@app.route("/sales", methods=["GET"])
def get_sales():
    conn = get_connection()
    sales = conn.execute("""
        SELECT sales.id, sales.product_id, products.name, sales.quantity,
               sales.total_amount, sales.sale_time, sales.matched
        FROM sales
        JOIN products ON sales.product_id = products.id
        WHERE sales.user_id = ?
        ORDER BY sales.sale_time DESC
    """, (current_user_id(),)).fetchall()
    conn.close()
    return jsonify([dict(s) for s in sales])

@app.route("/sales", methods=["POST"])
def record_sale():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid or missing JSON body"}), 400

    product_id = data.get("product_id")
    quantity = data.get("quantity")

    if not isinstance(product_id, int) or isinstance(product_id, bool) or product_id <= 0:
        return jsonify({"error": "product_id must be a positive integer"}), 400

    if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity <= 0:
        return jsonify({"error": "quantity must be a positive integer"}), 400

    if quantity > 100000:
        return jsonify({"error": "quantity is unrealistically large"}), 400

    conn = get_connection()
    product = conn.execute(
        "SELECT * FROM products WHERE id = ? AND user_id = ?", (product_id, current_user_id())
    ).fetchone()

    if not product:
        conn.close()
        return jsonify({"error": "Product not found"}), 404

    if product["stock"] < quantity:
        conn.close()
        return jsonify({"error": "Not enough stock available"}), 400

    total_amount = product["price"] * quantity

    conn.execute(
        "INSERT INTO sales (user_id, product_id, quantity, total_amount) VALUES (?, ?, ?, ?)",
        (current_user_id(), product_id, quantity, total_amount)
    )

    new_stock = product["stock"] - quantity
    conn.execute(
        "UPDATE products SET stock = ? WHERE id = ? AND user_id = ?",
        (new_stock, product_id, current_user_id())
    )

    conn.commit()
    conn.close()

    return jsonify({
        "product_id": product_id,
        "product_name": product["name"],
        "quantity": quantity,
        "total_amount": total_amount,
        "remaining_stock": new_stock
    }), 201


@app.route("/mpesa", methods=["GET"])
def get_mpesa_transactions():
    conn = get_connection()
    transactions = conn.execute(
        "SELECT * FROM mpesa_transactions WHERE user_id = ? ORDER BY transaction_time DESC",
        (current_user_id(),)
    ).fetchall()
    conn.close()
    return jsonify([dict(t) for t in transactions])

@app.route("/mpesa", methods=["POST"])
def add_mpesa_transaction():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid or missing JSON body"}), 400

    mpesa_code = data.get("mpesa_code")
    sender_name = data.get("sender_name")
    amount = data.get("amount")

    if not isinstance(mpesa_code, str) or not mpesa_code.strip():
        return jsonify({"error": "mpesa_code must be a non-empty string"}), 400
    mpesa_code = mpesa_code.strip()[:30]

    if sender_name is not None:
        if not isinstance(sender_name, str):
            return jsonify({"error": "sender_name must be a string"}), 400
        sender_name = sender_name.strip()[:100]

    if not isinstance(amount, (int, float)) or isinstance(amount, bool) or amount <= 0:
        return jsonify({"error": "amount must be a positive number"}), 400

    conn = get_connection()

    existing = conn.execute(
        "SELECT * FROM mpesa_transactions WHERE mpesa_code = ?", (mpesa_code,)
    ).fetchone()

    if existing:
        conn.close()
        return jsonify({"error": "This M-Pesa code has already been recorded"}), 409

    cursor = conn.execute(
        "INSERT INTO mpesa_transactions (user_id, mpesa_code, sender_name, amount) VALUES (?, ?, ?, ?)",
        (current_user_id(), mpesa_code, sender_name, amount)
    )
    conn.commit()
    new_id = cursor.lastrowid
    conn.close()

    return jsonify({
        "id": new_id,
        "mpesa_code": mpesa_code,
        "sender_name": sender_name,
        "amount": amount
    }), 201


@app.route("/reconcile", methods=["POST"])
def reconcile():
    uid = current_user_id()
    conn = get_connection()

    unmatched_sales = conn.execute(
        "SELECT * FROM sales WHERE matched = 0 AND user_id = ? ORDER BY sale_time ASC", (uid,)
    ).fetchall()
    unmatched_mpesa = conn.execute(
        "SELECT * FROM mpesa_transactions WHERE matched = 0 AND user_id = ? ORDER BY transaction_time ASC", (uid,)
    ).fetchall()

    unmatched_mpesa_list = [dict(t) for t in unmatched_mpesa]
    matched_pairs = []

    for sale in unmatched_sales:
        sale_dict = dict(sale)
        match = None

        for txn in unmatched_mpesa_list:
            if txn["amount"] == sale_dict["total_amount"]:
                match = txn
                break

        if match:
            conn.execute("UPDATE sales SET matched = 1 WHERE id = ?", (sale_dict["id"],))
            conn.execute("UPDATE mpesa_transactions SET matched = 1 WHERE id = ?", (match["id"],))
            unmatched_mpesa_list.remove(match)
            matched_pairs.append({
                "sale_id": sale_dict["id"],
                "mpesa_id": match["id"],
                "amount": sale_dict["total_amount"]
            })

    conn.commit()

    still_unmatched_sales = conn.execute("""
        SELECT sales.id, products.name, sales.quantity, sales.total_amount, sales.sale_time
        FROM sales JOIN products ON sales.product_id = products.id
        WHERE sales.matched = 0 AND sales.user_id = ?
    """, (uid,)).fetchall()
    still_unmatched_mpesa = conn.execute(
        "SELECT * FROM mpesa_transactions WHERE matched = 0 AND user_id = ?", (uid,)
    ).fetchall()

    conn.close()

    return jsonify({
        "matched_count": len(matched_pairs),
        "matched_pairs": matched_pairs,
        "unmatched_sales": [dict(s) for s in still_unmatched_sales],
        "unmatched_mpesa": [dict(t) for t in still_unmatched_mpesa]
    })


@app.route("/stkpush", methods=["POST"])
def stk_push():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid or missing JSON body"}), 400

    phone_number = data.get("phone_number")
    amount = data.get("amount")

    if not isinstance(phone_number, str) or not phone_number.strip():
        return jsonify({"error": "phone_number must be a non-empty string"}), 400
    phone_number = phone_number.strip()

    # Normalize common formats to 2547XXXXXXXX
    if phone_number.startswith("0") and len(phone_number) == 10:
        phone_number = "254" + phone_number[1:]
    elif phone_number.startswith("+254"):
        phone_number = phone_number[1:]

    if not (phone_number.startswith("254") and len(phone_number) == 12 and phone_number.isdigit()):
        return jsonify({"error": "phone_number must be a valid Kenyan number (e.g. 0712345678)"}), 400

    if not isinstance(amount, (int, float)) or isinstance(amount, bool) or amount <= 0:
        return jsonify({"error": "amount must be a positive number"}), 400

    try:
        result = trigger_stk_push(phone_number, amount)
    except Exception as e:
        return jsonify({"error": f"Failed to reach M-Pesa: {str(e)}"}), 502

    checkout_request_id = result.get("CheckoutRequestID")
    response_code = result.get("ResponseCode")

    if response_code != "0" or not checkout_request_id:
        return jsonify({"error": result.get("errorMessage", "M-Pesa rejected the request")}), 400

    conn = get_connection()
    conn.execute(
        "INSERT INTO pending_stk_requests (user_id, checkout_request_id, phone_number, amount) VALUES (?, ?, ?, ?)",
        (current_user_id(), checkout_request_id, phone_number, amount)
    )
    conn.commit()
    conn.close()

    return jsonify({
        "message": "Payment prompt sent to customer's phone",
        "checkout_request_id": checkout_request_id
    }), 201


# ---- TEMPORARY: M-Pesa OAuth test route (remove after confirming it works) ----
@app.route("/test-mpesa-token", methods=["GET"])
def test_mpesa_token():
    try:
        token = get_access_token()
        return jsonify({"access_token": token})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(debug=False, host="0.0.0.0", port=8080)