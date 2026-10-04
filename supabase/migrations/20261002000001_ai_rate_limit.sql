-- Phase 17 — AI Rate Limiting
-- Adds per-user AI request throttling that happens before expensive provider calls.
-- Works with the existing credit reservation system; does not replace it.

-- 1. Create the rate limit tracking table
CREATE TABLE IF NOT EXISTS ai_rate_limits (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  minute_bucket TIMESTAMPTZ NOT NULL,
  hour_bucket TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, minute_bucket, hour_bucket)
);

-- 2. Create indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_ai_rate_limits_user_minute
  ON ai_rate_limits (user_id, minute_bucket);

CREATE INDEX IF NOT EXISTS idx_ai_rate_limits_user_hour
  ON ai_rate_limits (user_id, hour_bucket);

-- 3. Create/refresh policy: authenticated users can only manage their own rate limits
DO $$
BEGIN
  -- Drop existing policies if they exist (idempotent)
  PERFORM 1 FROM pg_policy WHERE polname = 'ai_rate_limits_user_policy';
  IF FOUND THEN
    EXECUTE 'DROP POLICY ai_rate_limits_user_policy ON public.ai_rate_limits';
  END IF;

  -- Create new policy: authenticated users can only INSERT/SELECT their own rate limits
  EXECUTE '
    CREATE POLICY ai_rate_limits_user_policy ON public.ai_rate_limits
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  ';
END $$;

-- 4. Add comment explaining the rate limit purpose
COMMENT ON TABLE ai_rate_limits IS '
  Tracks per-user AI request counts for rate limiting.
  Used by the AI chat pipeline to throttle requests before provider calls.
  Does not replace the credit reservation system (reserve_chat_credit/finalize_chat_credit).
  Limits are configurable via environment or runtime parameters.
';

-- 5. Grant necessary permissions
GRANT SELECT, INSERT, DELETE ON public.ai_rate_limits TO authenticated;
GRANT SELECT ON public.ai_rate_limits TO anon;