-- The full lifecycle: rejected and retired use cases, and revisions that go live.
--
-- Status is still worked out, not stored: retired_at set means retired, a live revision means done,
-- and otherwise it's the latest revision's state.
SELECT set_config('openusecase.bypass', 'on', true);

ALTER TABLE revisions DROP CONSTRAINT revisions_state_check;
ALTER TABLE revisions ADD CONSTRAINT revisions_state_check CHECK (
  state IN ('proposed', 'changes_requested', 'approved', 'rejected', 'live', 'superseded')
);
ALTER TABLE revisions
  ADD COLUMN pr_url text,
  ADD COLUMN merge_sha text,
  ADD COLUMN claimed_done_at timestamptz,
  -- The scenario numbers in this revision's text, so health can be worked out in SQL.
  ADD COLUMN scenario_numbers integer[] NOT NULL DEFAULT '{}';
UPDATE revisions r SET scenario_numbers = coalesce((
  SELECT array_agg(m[1]::int) FROM regexp_matches(r.gherkin, '@S(\d+)\M', 'g') AS m
), '{}');
CREATE UNIQUE INDEX revisions_one_live ON revisions(use_case_id) WHERE state = 'live';

ALTER TABLE use_cases
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN retired_by uuid REFERENCES actors(id),
  ADD COLUMN retire_reason text,
  -- An agent's request, waiting in the inbox for a person.
  ADD COLUMN retirement_requested_at timestamptz,
  ADD COLUMN retirement_requested_by uuid REFERENCES actors(id),
  ADD COLUMN retirement_request_reason text;
