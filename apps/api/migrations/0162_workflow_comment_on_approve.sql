-- A workflow step can require a comment when approving, the same way it can already require one when rejecting.
-- The setting lives on the template step and is copied onto each running step, so changing a template later does not
-- change a request that is already waiting.
ALTER TABLE workflow_template_steps
  ADD COLUMN IF NOT EXISTS require_comment_on_approve boolean NOT NULL DEFAULT false;
ALTER TABLE workflow_step_instances
  ADD COLUMN IF NOT EXISTS require_comment_on_approve boolean NOT NULL DEFAULT false;
