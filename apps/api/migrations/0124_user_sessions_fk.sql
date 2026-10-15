-- Gap Register SEC-09 (Step 2): user_sessions.user_account_id had no foreign
-- key (0042 declared it `uuid NOT NULL` only). A session could reference a
-- user that does not exist, and deleting a user left live-looking session rows.
--
-- Sessions are ephemeral (tokens expire in <=12h) so orphaned rows are simply
-- deleted before the constraint is added -- nothing a user could still use,
-- because auth resolves the user via user_accounts first.
-- ON DELETE CASCADE: removing a user account removes its sessions.
--
-- ROLLBACK: ALTER TABLE user_sessions DROP CONSTRAINT IF EXISTS user_sessions_user_account_id_fkey;
--           (deleted orphan rows are not recoverable and had no valid owner)

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

DELETE FROM user_sessions s
 WHERE NOT EXISTS (SELECT 1 FROM user_accounts u WHERE u.id = s.user_account_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_sessions_user_account_id_fkey' AND conrelid = 'user_sessions'::regclass
  ) THEN
    ALTER TABLE user_sessions
      ADD CONSTRAINT user_sessions_user_account_id_fkey
      FOREIGN KEY (user_account_id) REFERENCES user_accounts(id) ON DELETE CASCADE;
  END IF;
END $$;
