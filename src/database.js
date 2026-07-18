import {
  neon,
} from "@neondatabase/serverless";

const databaseUrl =
  process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "Missing DATABASE_URL in backend .env."
  );
}

export const sql =
  neon(databaseUrl);

export async function initializeDatabase() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

      clerk_uuid TEXT NOT NULL UNIQUE,

      name TEXT,
      first_name TEXT,
      last_name TEXT,
      email TEXT,
      username TEXT,
      image_url TEXT,
      phone_number TEXT,

      onboarding_completed
        BOOLEAN NOT NULL
        DEFAULT FALSE,

      is_premium
        BOOLEAN NOT NULL
        DEFAULT FALSE,

      subscription_status
        TEXT NOT NULL
        DEFAULT 'free',

      entitlement_ids
        TEXT[] NOT NULL
        DEFAULT '{}',

      active_subscriptions
        TEXT[] NOT NULL
        DEFAULT '{}',

      product_identifier TEXT,

      subscription_expires_at
        TIMESTAMPTZ,

      reading_voice
        TEXT NOT NULL
        DEFAULT 'nova',

      reading_style
        TEXT NOT NULL
        DEFAULT 'natural',

      reading_speed
        TEXT NOT NULL
        DEFAULT '1.0',

      created_at
        TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      updated_at
        TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    )
  `;

  /*
   * Rename old users.clerk_id to clerk_uuid.
   */
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE
          table_name = 'users'
          AND column_name = 'clerk_id'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE
          table_name = 'users'
          AND column_name = 'clerk_uuid'
      )
      THEN
        ALTER TABLE users
        RENAME COLUMN clerk_id
        TO clerk_uuid;
      END IF;
    END
    $$
  `;

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS
      onboarding_completed
      BOOLEAN NOT NULL
      DEFAULT FALSE
  `;

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS
      is_premium
      BOOLEAN NOT NULL
      DEFAULT FALSE
  `;

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS
      subscription_status
      TEXT NOT NULL
      DEFAULT 'free'
  `;

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS
      entitlement_ids
      TEXT[] NOT NULL
      DEFAULT '{}'
  `;

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS
      active_subscriptions
      TEXT[] NOT NULL
      DEFAULT '{}'
  `;

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS
      product_identifier
      TEXT
  `;

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS
      subscription_expires_at
      TIMESTAMPTZ
  `;

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS
      reading_voice
      TEXT NOT NULL
      DEFAULT 'nova'
  `;

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS
      reading_style
      TEXT NOT NULL
      DEFAULT 'natural'
  `;

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS
      reading_speed
      TEXT NOT NULL
      DEFAULT '1.0'
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      users_clerk_uuid_unique_index
    ON users (
      clerk_uuid
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS
      users_email_index
    ON users (
      email
    )
  `;

  /*
   * Create documents table for new databases.
   *
   * clerk_uuid starts nullable so old databases
   * can be migrated safely below.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,

      clerk_uuid TEXT,

      name TEXT NOT NULL,

      filename TEXT NOT NULL UNIQUE,

      mime_type TEXT NOT NULL,

      size_bytes INTEGER NOT NULL
        DEFAULT 0,

      file_url TEXT NOT NULL,

      extracted_text TEXT NOT NULL
        DEFAULT '',

      preview TEXT NOT NULL
        DEFAULT '',

      pages INTEGER NOT NULL
        DEFAULT 0,

      word_count INTEGER NOT NULL
        DEFAULT 0,

      estimated_minutes INTEGER NOT NULL
        DEFAULT 0,

      has_text BOOLEAN NOT NULL
        DEFAULT FALSE,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    )
  `;

  /*
   * Add clerk_uuid to an existing documents table.
   */
  await sql`
    ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS
      clerk_uuid TEXT
  `;

  /*
   * Copy old documents.user_id values into clerk_uuid.
   */
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE
          table_name = 'documents'
          AND column_name = 'user_id'
      )
      THEN
        UPDATE documents
        SET clerk_uuid = user_id
        WHERE
          clerk_uuid IS NULL
          AND user_id IS NOT NULL;
      END IF;
    END
    $$
  `;

  /*
   * Remove the old column after migration.
   */
  await sql`
    ALTER TABLE documents
    DROP COLUMN IF EXISTS user_id
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS
      documents_created_at_index
    ON documents (
      created_at DESC
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS
      documents_clerk_uuid_index
    ON documents (
      clerk_uuid
    )
  `;

  /*
   * Delete documents whose Clerk user no longer exists.
   */
  await sql`
    DELETE FROM documents
    WHERE
      clerk_uuid IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM users
        WHERE users.clerk_uuid =
          documents.clerk_uuid
      )
  `;

  /*
   * Delete old documents that were never linked
   * to any Clerk user.
   */
  await sql`
    DELETE FROM documents
    WHERE clerk_uuid IS NULL
  `;

  /*
   * Now every document must belong to a user.
   */
  await sql`
    ALTER TABLE documents
    ALTER COLUMN clerk_uuid
    SET NOT NULL
  `;

  /*
   * Add the foreign key only once.
   */
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE
          conname =
            'documents_clerk_uuid_foreign_key'
      )
      THEN
        ALTER TABLE documents
        ADD CONSTRAINT
          documents_clerk_uuid_foreign_key
        FOREIGN KEY (
          clerk_uuid
        )
        REFERENCES users (
          clerk_uuid
        )
        ON DELETE CASCADE;
      END IF;
    END
    $$
  `;

  console.log(
    "Neon users and documents tables are ready."
  );
}