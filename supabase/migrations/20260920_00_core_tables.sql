-- Phase 2: Database - Core Tables Migration
-- ============================================

-- 1. profiles table
-- Stores user profile information associated with authenticated users
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade not null primary key,
  username text unique,
  display_name text not null,
  avatar_url text,
  level integer default 1,
  xp integer default 0,
  streak integer default 0,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS on profiles
alter table public.profiles enable row level security;

-- Create policy: users can read their own profile, admins can read all
create policy "Users can read own profile" on public.profiles
  for select using (auth.uid() = id);

create policy "Admins can read all profiles" on public.profiles
  for select using (true);

-- 2. wallet table
-- Authoritative server-side wallet source
create table if not exists public.wallet (
  user_id uuid references auth.users on delete cascade not null primary key,
  ai_credits integer default 0 not null,
  earned_coins integer default 0 not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS on wallet
alter table public.wallet enable row level security;

-- Policy: users can read own wallet, admins can read all
create policy "Users can read own wallet" on public.wallet
  for select using (auth.uid() = user_id);

create policy "Admins can read all wallets" on public.wallet
  for select using (true);

-- 3. wallet_transactions table
-- Tracks all economic transactions for auditable history
create table if not exists public.wallet_transactions (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  type text not null check (type in ('AI_USAGE', 'GAME_REWARD', 'DAILY_LOGIN', 'OTHER_VALIDATED_REWARD')),
  amount integer not null,
  source text,
  reference_id text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS on wallet_transactions
alter table public.wallet_transactions enable row level security;

-- Policy: users can read own transactions, admins can read all
create policy "Users can read own transactions" on public.wallet_transactions
  for select using (auth.uid() = user_id);

create policy "Admins can read all transactions" on public.wallet_transactions
  for select using (true);

-- 4. games table
-- Game registry - catalog of available games
create table if not exists public.games (
  id text primary key,
  name text not null,
  slug text unique not null,
  category text not null check (category in ('Cognitive', 'Puzzle', 'Reflex', 'Strategy')),
  description text,
  difficulty text not null check (difficulty in ('Easy', 'Medium', 'Hard')),
  estimated_duration integer default 5 not null,
  active boolean default true not null,
  supports_ai boolean default false not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Insert initial game registry
INSERT INTO public.games (id, name, slug, category, description, difficulty, estimated_duration, active, supports_ai) VALUES
  ('sudoku', 'Sudoku', 'sudoku', 'Cognitive', 'Classic number placement puzzle', 'Medium', 5, true, true),
  ('tictactoe', 'Tic-Tac-Toe', 'tictactoe', 'Strategy', 'Play against the AI', 'Easy', 3, true, true),
  ('ball-run', 'Ball Run', 'ball-run', 'Reflex', 'Avoid obstacles and survive', 'Medium', 3, true, false),
  ('water-sort', 'Water Sort', 'water-sort', 'Puzzle', 'Sort colored water into tubes', 'Medium', 5, true, false)
ON CONFLICT (slug) DO NOTHING;

-- Enable RLS on games
alter table public.games enable row level security;

-- Policy: public read access for game catalog
create policy "Public can view games" on public.games
  for select using (true);

-- 5. game_sessions table
-- Represents one actual gameplay attempt
create table if not exists public.game_sessions (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  game_id text references public.games(id) not null,
  started_at timestamp with time zone default timezone('utc'::text, now()) not null,
  completed_at timestamp with time zone,
  status text default 'STARTED' check (status in ('STARTED', 'COMPLETED', 'ABANDONED')),
  session_data jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS on game_sessions
alter table public.game_sessions enable row level security;

-- Policy: users can manage own sessions, admins can read all
create policy "Users can manage own sessions" on public.game_sessions
  for all using (auth.uid() = user_id);

create policy "Admins can read all sessions" on public.game_sessions
  for select using (true);

-- 6. game_results table
-- Stores validated results from game completions
create table if not exists public.game_results (
  id uuid default gen_random_uuid() primary key,
  session_id uuid references public.game_sessions(id) on delete cascade not null,
  user_id uuid references auth.users on delete cascade not null,
  game_id text references public.games(id) not null,
  score integer,
  duration integer,
  moves integer,
  accuracy integer,
  outcome text not null check (outcome in ('win', 'loss', 'draw', 'complete')),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS on game_results
alter table public.game_results enable row level security;

-- Policy: users can read own results, admins can read all
create policy "Users can read own results" on public.game_results
  for select using (auth.uid() = user_id);

create policy "Admins can read all results" on public.game_results
  for select using (true);

-- 7. game_progress table
-- Tracks user-specific game progress
create table if not exists public.game_progress (
  user_id uuid references auth.users on delete cascade not null,
  game_id text references public.games(id) not null,
  games_played integer default 0 not null,
  games_won integer default 0 not null,
  best_score integer,
  best_time integer,
  total_xp integer default 0 not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  primary key (user_id, game_id)
);

-- Enable RLS on game_progress
alter table public.game_progress enable row level security;

-- Policy: users can manage own progress, admins can read all
create policy "Users can manage own progress" on public.game_progress
  for all using (auth.uid() = user_id);

create policy "Admins can read all progress" on public.game_progress
  for select using (true);

-- 8. achievements table
-- Central definition of achievements
create table if not exists public.achievements (
  id text primary key,
  name text not null,
  description text not null,
  category text not null default 'general',
  target_type text not null check (target_type in ('games_played', 'games_won', 'streak', 'xp', 'first_game')),
  target_value integer not null,
  icon text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS on achievements
alter table public.achievements enable row level security;

-- Policy: public read access for achievement definitions
create policy "Public can view achievements" on public.achievements
  for select using (true);

-- 9. user_achievements table
-- Links users to earned achievements
create table if not exists public.user_achievements (
  user_id uuid references auth.users on delete cascade not null,
  achievement_id text references public.achievements(id) not null,
  earned_at timestamp with time zone default timezone('utc'::text, now()) not null,
  primary key (user_id, achievement_id)
);

-- Enable RLS on user_achievements
alter table public.user_achievements enable row level security;

-- Policy: users can manage own achievements, admins can read all
create policy "Users can manage own achievements" on public.user_achievements
  for all using (auth.uid() = user_id);

create policy "Admins can read all achievements" on public.user_achievements
  for select using (true);

-- 10. leaderboard table
-- Simple leaderboard - can be expanded later
create table if not exists public.leaderboard (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  score integer not null,
  game_id text references public.games(id),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS on leaderboard
alter table public.leaderboard enable row level security;

-- Policy: users can read leaderboard, admins can manage
create policy "Public can view leaderboard" on public.leaderboard
  for select using (true);

create policy "Admins can manage leaderboard" on public.leaderboard
  for all using (true);

-- 11. audit_log table
-- For important economic/security events
create table if not exists public.audit_log (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete set null,
  action text not null,
  reference_id text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS on audit_log
alter table public.audit_log enable row level security;

-- Policy: users can read own audit log, admins can read all
create policy "Users can read own audit log" on public.audit_log
  for select using (auth.uid() = user_id);

create policy "Admins can read all audit log" on public.audit_log
  for select using (true);

-- ============================================
-- Indexes for performance
-- ============================================

-- Profiles indexes
create index if not exists idx_profiles_username on public.profiles(username);
create index if not exists idx_profiles_updated_at on public.profiles(updated_at);

-- Wallet indexes
create index if not exists idx_wallet_user_id on public.wallet(user_id);
create index if not exists idx_wallet_updated_at on public.wallet(updated_at);

-- Wallet transactions indexes
create index if not exists idx_wallet_transactions_user_id on public.wallet_transactions(user_id);
create index if not exists idx_wallet_transactions_type on public.wallet_transactions(type);
create index if not exists idx_wallet_transactions_created_at on public.wallet_transactions(created_at);

-- Games indexes
create index if not exists idx_games_category on public.games(category);
create index if not exists idx_games_active on public.games(active);
create index if not exists idx_games_slug on public.games(slug);

-- Game sessions indexes
create index if not exists idx_game_sessions_user_id on public.game_sessions(user_id);
create index if not exists idx_game_sessions_game_id on public.game_sessions(game_id);
create index if not exists idx_game_sessions_status on public.game_sessions(status);

-- Game results indexes
create index if not exists idx_game_results_session_id on public.game_results(session_id);
create index if not exists idx_game_results_user_id on public.game_results(user_id);
create index if not exists idx_game_results_created_at on public.game_results(created_at);

-- Game progress indexes
create index if not exists idx_game_progress_user_id on public.game_progress(user_id);
create index if not exists idx_game_progress_game_id on public.game_progress(game_id);

-- User achievements indexes
create index if not exists idx_user_achievements_achievement_id on public.user_achievements(achievement_id);

-- Leaderboard indexes
create index if not exists idx_leaderboard_user_id on public.leaderboard(user_id);
create index if not exists idx_leaderboard_score on public.leaderboard(score);

-- Audit log indexes
create index if not exists idx_audit_log_user_id on public.audit_log(user_id);
create index if not exists idx_audit_log_created_at on public.audit_log(created_at);