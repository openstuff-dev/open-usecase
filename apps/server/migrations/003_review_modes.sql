-- How a revision gets approved is decided when it arrives, and doesn't change if the agent's mode
-- changes later.
ALTER TABLE revisions ADD COLUMN review_mode text NOT NULL DEFAULT 'human_approval'
  CHECK (review_mode IN ('human_approval', 'agent_review', 'auto_approve'));
