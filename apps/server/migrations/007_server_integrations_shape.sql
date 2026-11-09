-- The same server_integrations shape as every OpenStuff app, so the shared @openstuff-dev/server
-- routes run here unchanged, and an OpenAnnounce connection can be saved too. The deploy token keeps
-- its value; only the column's name changes.
ALTER TABLE server_integrations RENAME COLUMN deploy_token_sealed TO deploy_token_encrypted;
ALTER TABLE server_integrations ADD COLUMN signing_secret_encrypted text;
ALTER TABLE server_integrations DROP CONSTRAINT IF EXISTS server_integrations_kind_check;
ALTER TABLE server_integrations ADD CONSTRAINT server_integrations_kind_check
  CHECK (kind IN ('openversion', 'openannounce'));
