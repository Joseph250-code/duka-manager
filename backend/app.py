from flask import Flask, jsonify, request
from database import get_connection, init_db

app = Flask(__name__)

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
    data = request.get_json()
    name = data.get("name")
    price = data.get("price")
    stock = data.get("stock", 0)

    if not name or price is None:
        return jsonify({"error": "name and price are required"}), 400

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
    data = request.get_json()
    conn = get_connection()

    product = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    if not product:
        conn.close()
        return jsonify({"error": "Product not found"}), 404

    name = data.get("name", product["name"])
    price = data.get("price", product["price"])
    stock = data.get("stock", product["stock"])

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
    data = request.get_json()
    product_id = data.get("product_id")
    quantity = data.get("quantity")

    if not product_id or not quantity:
        return jsonify({"error": "product_id and quantity are required"}), 400

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


if __name__ == "__main__":
    app.run(debug=False, host="0.0.0.0", port=8080)