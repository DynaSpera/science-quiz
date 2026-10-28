-- Supabase SQL Editor에서 실행. 새 프로젝트 전용으로 사용하세요.
-- 실제 학생 데이터는 학교의 개인정보 처리 기준을 확인한 후 수집하세요.
create extension if not exists pgcrypto;

create table if not exists public.teacher_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.questions (
  id text primary key,
  unit text not null,
  difficulty text not null check (difficulty in ('쉬움','보통','어려움')),
  prompt text not null,
  choices jsonb not null check (jsonb_typeof(choices)='array' and jsonb_array_length(choices) between 4 and 5),
  correct_index smallint not null check (correct_index between 0 and 4),
  explanation text not null default '',
  points integer not null check (points between 1 and 100),
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint correct_choice_in_range check (correct_index < jsonb_array_length(choices))
);

create table if not exists public.attempts (
  id uuid primary key default gen_random_uuid(),
  student_name text not null,
  student_code text not null default '',
  quiz_items jsonb not null,
  result_items jsonb,
  score numeric(10,2),
  max_score numeric(10,2),
  status text not null default 'started' check (status in ('started','submitted')),
  started_at timestamptz not null default now(),
  submitted_at timestamptz
);
create index if not exists idx_attempts_submitted_at on public.attempts(submitted_at desc);
create index if not exists idx_attempts_status on public.attempts(status);

-- 비공개 문제·학생 점수·교사 권한 테이블을 브라우저에서 직접 조회하지 못하도록 차단.
alter table public.teacher_accounts enable row level security;
alter table public.questions enable row level security;
alter table public.attempts enable row level security;
revoke all on table public.teacher_accounts from anon, authenticated;
revoke all on table public.questions from anon, authenticated;
revoke all on table public.attempts from anon, authenticated;

-- 모든 테이블 액세스는 Edge Function이 서버 내부의 service_role로만 처리합니다.
-- teacher_accounts는 Supabase SQL Editor에서 교사 계정을 명시적으로 승인할 때만 변경합니다.
-- Supabase Dashboard > Authentication > Users에서 교사 사용자 생성 후 아래 SQL을 실행하세요.
-- 아래 이메일을 실제 교사 로그인 이메일로 변경하세요.
-- insert into public.teacher_accounts(user_id)
-- select id from auth.users where email = 'teacher@example.com'
-- on conflict (user_id) do nothing;
