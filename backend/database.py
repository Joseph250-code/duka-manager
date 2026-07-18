import sqlite3

DB_NAME = "duka.db"

def get_connection():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn

def _column_exists(cursor, table, column):
    cursor.execute(f"PRAGMA table_info({table})")
    return any(row[1] == column for row in cursor.fetchall())

def init_db():
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            price REAL NOT NULL,
            stock INTEGER NOT NULL DEFAULT 0
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS sales (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            total_amount REAL NOT NULL,
            sale_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            matched INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (product_id) REFERENCES products (id)
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS mpesa_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mpesa_code TEXT UNIQUE NOT NULL,
            sender_name TEXT,
            amount REAL NOT NULL,
            transaction_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            matched INTEGER NOT NULL DEFAULT 0
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS pending_stk_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            checkout_request_id TEXT UNIQUE NOT NULL,
            phone_number TEXT NOT NULL,
            amount REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            mpesa_receipt TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )
    """)

    # ---- Migration: add user_id to existing tables if missing ----
    for table in ("products", "sales", "mpesa_transactions"):
        if not _column_exists(cursor, table, "user_id"):
            cursor.execute(f"ALTER TABLE {table} ADD COLUMN user_id INTEGER")
            print(f"Added user_id column to {table}")

    conn.commit()
    conn.close()
    print("Database initialized successfully.")

def migrate_existing_data_to_user(username):
    """One-time helper: assigns any ownerless rows to the given username."""
    conn = get_connection()
    user = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
    if not user:
        conn.close()
        print(f"No user named '{username}' found — nothing migrated.")
        return

    user_id = user["id"]
    conn.execute("UPDATE products SET user_id = ? WHERE user_id IS NULL", (user_id,))
    conn.execute("UPDATE sales SET user_id = ? WHERE user_id IS NULL", (user_id,))
    conn.execute("UPDATE mpesa_transactions SET user_id = ? WHERE user_id IS NULL", (user_id,))
    conn.commit()
    conn.close()
    print(f"Existing data assigned to '{username}'.")

if __name__ == "__main__":
    init_db()
    migrate_existing_data_to_user("joe")