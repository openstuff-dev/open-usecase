-- Areas: the vertical slices of a product, such as Billing or Settings. A new area joins the project
-- when the use case that proposed it gets approved.
CREATE TABLE areas (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
ALTER TABLE use_cases
  ADD COLUMN area_id uuid REFERENCES areas(id) ON DELETE SET NULL,
  ADD COLUMN proposed_area text;

-- A team's link to OpenPurpose, which holds the glossary. The token is encrypted. Without this row,
-- no terms are marked and everything else works the same.
CREATE TABLE openpurpose_links (
  team_id      uuid PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  url          text NOT NULL,
  token_sealed text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['areas', 'openpurpose_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY team_isolation ON %I
      USING (team_id::text = current_setting(''openusecase.team_id'', true)
             OR current_setting(''openusecase.bypass'', true) = ''on'')', t);
  END LOOP;
END $$;

-- Without OPENUSECASE_SECRET_KEY, the key that encrypts these tokens is made once and kept here.
CREATE TABLE server_settings (
  name  text PRIMARY KEY,
  value text NOT NULL
);
