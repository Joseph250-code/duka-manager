from flask import Flask, jsonify, request
from database import get_connection, init_db

app = Flask(__name__)

@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response

# Make sure database exists on startup
init_db()

@app.route("/products", methods=["GET"])
def get_products():
    conn = get_connection()
    products = conn.execute("SELECT * FROM products").fetchall()
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
        "INSERT INTO products (name, price, stock) VALUES (?, ?, ?)",
        (name, price, stock)
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

    product = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
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
        "UPDATE products SET name = ?, price = ?, stock = ? WHERE id = ?",
        (name, price, stock, product_id)
    )
    conn.commit()
    conn.close()

    return jsonify({"id": product_id, "name": name, "price": price, "stock": stock})

@app.route("/products/<int:product_id>", methods=["DELETE"])
def delete_product(product_id):
    conn = get_connection()
    conn.execute("DELETE FROM products WHERE id = ?", (product_id,))
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
        ORDER BY sales.sale_time DESC
    """).fetchall()
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
    product = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()

    if not product:
        conn.close()
        return jsonify({"error": "Product not found"}), 404

    if product["stock"] < quantity:
        conn.close()
        return jsonify({"error": "Not enough stock available"}), 400

    total_amount = product["price"] * quantity

    conn.execute(
        "INSERT INTO sales (product_id, quantity, total_amount) VALUES (?, ?, ?)",
        (product_id, quantity, total_amount)
    )

    new_stock = product["stock"] - quantity
    conn.execute("UPDATE products SET stock = ? WHERE id = ?", (new_stock, product_id))

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
        "SELECT * FROM mpesa_transactions ORDER BY transaction_time DESC"
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
        "INSERT INTO mpesa_transactions (mpesa_code, sender_name, amount) VALUES (?, ?, ?)",
        (mpesa_code, sender_name, amount)
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
    conn = get_connection()

    unmatched_sales = conn.execute(
        "SELECT * FROM sales WHERE matched = 0 ORDER BY sale_time ASC"
    ).fetchall()
    unmatched_mpesa = conn.execute(
        "SELECT * FROM mpesa_transactions WHERE matched = 0 ORDER BY transaction_time ASC"
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

    still_unmatched_sales = conn.execute(
        "SELECT sales.id, products.name, sales.quantity, sales.total_amount, sales.sale_time FROM sales JOIN products ON sales.product_id = products.id WHERE sales.matched = 0"
    ).fetchall()
    still_unmatched_mpesa = conn.execute(
        "SELECT * FROM mpesa_transactions WHERE matched = 0"
    ).fetchall()

    conn.close()

    return jsonify({
        "matched_count": len(matched_pairs),
        "matched_pairs": matched_pairs,
        "unmatched_sales": [dict(s) for s in still_unmatched_sales],
        "unmatched_mpesa": [dict(t) for t in still_unmatched_mpesa]
    })


if __name__ == "__main__":
    app.run(debug=False, host="0.0.0.0", port=8080)