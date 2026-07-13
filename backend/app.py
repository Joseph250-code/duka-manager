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


if __name__ == "__main__":
    app.run(debug=False, host="0.0.0.0", port=8080)