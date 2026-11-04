-- OpenUsecase: use cases that agents propose, people approve and tests prove.
--
--   accounts, sessions           people who sign in (as in OpenAnnounce)
--   teams                        the tenant
--     ├─ memberships             which accounts belong to a team, as admin or member
--     ├─ actors, api_tokens      who acted: a person or an agent; agents use tokens (as in OpenPurpose)
--     ├─ projects, repositories  git remotes map to a project
--     └─ use_cases               UC-142, with revisions (the Gherkin), scenarios and comments
--
-- Every team table has row-level security: a request only sees the team it was opened for
-- (openusecase.team_id), so a query that forgets its WHERE clause can't leak another team.

CREATE TABLE teams (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE CHECK (email = lower(email)),
  name            text NOT NULL DEFAULT '',
  password_hash   text NOT NULL,
  is_server_admin boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_account ON sessions(account_id);

CREATE TABLE memberships (
  team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('admin', 'member')),
  PRIMARY KEY (team_id, account_id)
);
CREATE INDEX memberships_account ON memberships(account_id);

CREATE TABLE actors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id        uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('human', 'agent', 'ci')),
  name           text NOT NULL,
  -- Set for a person, so an account has one actor per team.
  account_id     uuid REFERENCES accounts(id) ON DELETE SET NULL,
  -- An agent's review mode. Stored now so permissions can be protected; phase 7 makes it act.
  review         text NOT NULL DEFAULT 'human_approval'
                   CHECK (review IN ('human_approval', 'agent_review', 'auto_approve')),
  can_review     boolean NOT NULL DEFAULT false,
  permissions_by uuid REFERENCES actors(id) ON DELETE SET NULL,
  permissions_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, account_id)
);

CREATE TABLE api_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  actor_id   uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  -- The start of the token, so people can tell tokens apart. Not secret.
  prefix     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX api_tokens_actor ON api_tokens(actor_id);

CREATE TABLE projects (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id             uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  slug                text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name                text NOT NULL,
  -- One Gherkin language per project.
  language            text NOT NULL DEFAULT 'en',
  next_usecase_number integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, slug)
);

-- Per team from the start: OpenPurpose's remote_key was global at first and had to change.
CREATE TABLE repositories (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id        uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  remote_key     text NOT NULL,
  default_branch text NOT NULL DEFAULT 'main',
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, remote_key)
);

CREATE TABLE use_cases (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id              uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  project_id           uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number               integer NOT NULL,
  title                text NOT NULL,
  next_scenario_number integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);

-- A use case's status is the state of its latest revision, so it isn't stored twice.
CREATE TABLE revisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id          uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  use_case_id      uuid NOT NULL REFERENCES use_cases(id) ON DELETE CASCADE,
  number           integer NOT NULL,
  gherkin          text NOT NULL,
  original_request text,
  what_changed     text,
  state            text NOT NULL DEFAULT 'proposed'
                     CHECK (state IN ('proposed', 'changes_requested', 'approved')),
  proposed_by      uuid NOT NULL REFERENCES actors(id),
  decided_by       uuid REFERENCES actors(id),
  decided_at       timestamptz,
  approval_method  text CHECK (approval_method IN ('human', 'agent_review', 'auto_approve')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (use_case_id, number)
);
CREATE INDEX revisions_inbox ON revisions(team_id) WHERE state = 'proposed';

-- Every scenario number a use case has ever had, so numbers are never reused.
CREATE TABLE scenarios (
  team_id     uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  use_case_id uuid NOT NULL REFERENCES use_cases(id) ON DELETE CASCADE,
  number      integer NOT NULL,
  PRIMARY KEY (use_case_id, number)
);

CREATE TABLE comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  use_case_id     uuid NOT NULL REFERENCES use_cases(id) ON DELETE CASCADE,
  revision_id     uuid NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  scenario_number integer,
  body            text NOT NULL,
  author_id       uuid NOT NULL REFERENCES actors(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (use_case_id, scenario_number) REFERENCES scenarios(use_case_id, number)
);
CREATE INDEX comments_use_case ON comments(use_case_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memberships', 'actors', 'api_tokens', 'projects', 'repositories',
                           'use_cases', 'revisions', 'scenarios', 'comments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY team_isolation ON %I
      USING (team_id::text = current_setting(''openusecase.team_id'', true)
             OR current_setting(''openusecase.bypass'', true) = ''on'')', t);
  END LOOP;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openusecase_app') THEN
    CREATE ROLE openusecase_app NOLOGIN;
  END IF;
END $$;
