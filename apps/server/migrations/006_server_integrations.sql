-- Server-wide connections, set by a server admin. Not team-scoped, so no row-level security:
-- only the server-admin routes read or write it. The deploy token is encrypted and never returned.
CREATE TABLE server_integrations (
  kind                    text PRIMARY KEY CHECK (kind IN ('openversion')),
  url                     text NOT NULL,
  public_key              text NOT NULL,
  deploy_token_sealed     text,
  last_test_ok            boolean,
  last_test_message       text,
  last_tested_at          timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
