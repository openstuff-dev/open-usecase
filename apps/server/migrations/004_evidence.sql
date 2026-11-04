-- Test evidence. A report replaces all results for its (repository, suite), and the file itself is
-- never stored. History gets a row only when a scenario's health changes, so storage grows with
-- scenarios and real changes, not with CI runs.
CREATE TABLE scenario_results (
  team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  use_case_id     uuid NOT NULL REFERENCES use_cases(id) ON DELETE CASCADE,
  scenario_number integer NOT NULL,
  repository_id   uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  suite           text NOT NULL,
  result          text NOT NULL CHECK (result IN ('passed', 'failed')),
  tests           text[] NOT NULL,
  commit_sha      text NOT NULL,
  reported_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (use_case_id, scenario_number, repository_id, suite),
  FOREIGN KEY (use_case_id, scenario_number) REFERENCES scenarios(use_case_id, number) ON DELETE CASCADE
);
CREATE INDEX scenario_results_repo ON scenario_results(repository_id, suite);

CREATE TABLE scenario_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  use_case_id     uuid NOT NULL REFERENCES use_cases(id) ON DELETE CASCADE,
  scenario_number integer NOT NULL,
  health          text NOT NULL CHECK (health IN ('passing', 'failing', 'no_evidence')),
  commit_sha      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scenario_events_use_case ON scenario_events(use_case_id, created_at);

-- Only a person can add one. It belongs to a scenario number, so a changed meaning (a new number)
-- doesn't inherit it.
CREATE TABLE manual_verifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  use_case_id     uuid NOT NULL REFERENCES use_cases(id) ON DELETE CASCADE,
  scenario_number integer NOT NULL,
  verified_by     uuid NOT NULL REFERENCES actors(id),
  verified_at     timestamptz NOT NULL DEFAULT now(),
  note            text NOT NULL,
  FOREIGN KEY (use_case_id, scenario_number) REFERENCES scenarios(use_case_id, number) ON DELETE CASCADE
);
CREATE INDEX manual_verifications_scenario ON manual_verifications(use_case_id, scenario_number);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['scenario_results', 'scenario_events', 'manual_verifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY team_isolation ON %I
      USING (team_id::text = current_setting(''openusecase.team_id'', true)
             OR current_setting(''openusecase.bypass'', true) = ''on'')', t);
  END LOOP;
END $$;

-- The one definition of health. A failure anywhere wins, then a passing test or a person's check.
CREATE FUNCTION scenario_health(use_case uuid, scenario integer) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM scenario_results r
                  WHERE r.use_case_id = use_case AND r.scenario_number = scenario AND r.result = 'failed')
      THEN 'failing'
    WHEN EXISTS (SELECT 1 FROM scenario_results r
                  WHERE r.use_case_id = use_case AND r.scenario_number = scenario)
      OR EXISTS (SELECT 1 FROM manual_verifications m
                  WHERE m.use_case_id = use_case AND m.scenario_number = scenario)
      THEN 'passing'
    ELSE 'no_evidence'
  END
$$;

-- A use case: failing if any scenario fails, passing only if every scenario passes.
CREATE FUNCTION use_case_health(use_case uuid, scenarios integer[]) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN bool_or(h = 'failing') THEN 'failing'
    WHEN bool_and(h = 'passing') THEN 'passing'
    ELSE 'no_evidence'
  END
  FROM (SELECT scenario_health(use_case, n) AS h FROM unnest(scenarios) AS n) s
$$;
