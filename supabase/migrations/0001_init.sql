-- Deep Field crowd schema (mirrors apps/api/deepfield_api/store.py SQLite schema).
create table if not exists users (
  id text primary key,
  display_name text default 'anonymous',
  points integer default 0,
  real_correct double precision default 0,
  real_seen double precision default 0,
  bogus_correct double precision default 0,
  bogus_seen double precision default 0,
  n_votes integer default 0,
  created_at timestamptz default now()
);
create table if not exists tasks (
  id text primary key,
  user_id text references users(id),
  candidate_id text not null,
  is_test boolean default false,
  truth text,
  answered boolean default false,
  created_at timestamptz default now()
);
create table if not exists votes (
  id text primary key,
  user_id text references users(id),
  task_id text references tasks(id),
  candidate_id text not null,
  answer text check (answer in ('real','artifact','nothing')),
  click_x double precision, click_y double precision,
  weight double precision default 0,
  created_at timestamptz default now()
);
create table if not exists consensus (
  candidate_id text primary key,
  p_real double precision,
  n_votes integer default 0,
  weighted_votes double precision default 0,
  updated_at timestamptz default now()
);
create table if not exists patch_credit (
  patch_id text primary key,
  weighted_votes double precision default 0,
  updated_at timestamptz default now()
);
-- Row level security: the API writes with the service key; anon clients may only read consensus/leaderboard.
alter table users enable row level security;
alter table tasks enable row level security;
alter table votes enable row level security;
alter table consensus enable row level security;
alter table patch_credit enable row level security;
create policy "public read consensus" on consensus for select using (true);
create policy "public read patch_credit" on patch_credit for select using (true);
create policy "public read leaderboard" on users for select using (true);
