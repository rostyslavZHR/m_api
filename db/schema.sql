CREATE TABLE
    users (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now ()
    );

CREATE TABLE
    products (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
        in_stock BOOLEAN DEFAULT false NOT NULL,
        deleted_at timestamptz,
        search_vector tsvector GENERATED ALWAYS AS (
            to_tsvector ('simple', name || ' ' || description)
        ) STORED
    );

CREATE TABLE
    orders (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users (id),
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'paid', 'shipped', 'cancelled')),
        total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
        created_at timestamptz NOT NULL DEFAULT now ()
    );

CREATE TABLE
    order_items (
        order_id BIGINT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
        product_id BIGINT NOT NULL REFERENCES products (id),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        unit_price_cents BIGINT NOT NULL CHECK (unit_price_cents >= 0),
        product_name TEXT NOT NULL,
        PRIMARY KEY (order_id, product_id)
    );
