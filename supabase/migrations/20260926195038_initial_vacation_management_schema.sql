create extension if not exists pgcrypto;

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  registration text unique,
  full_name text not null,
  sector text not null,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_registration_format check (
    registration is null or registration ~ '^[A-Za-z0-9._-]{2,40}$'
  )
);

create table public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'employee',
  created_at timestamptz not null default now(),
  constraint user_roles_valid_role check (role in ('admin', 'employee'))
);

create table public.holidays (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  name text not null,
  is_national boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.vacation_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  duration_days integer not null,
  period_number integer not null default 1,
  status text not null default 'pending',
  wants_thirteenth_advance boolean not null default false,
  wants_abono boolean not null default false,
  abono_days integer,
  rejection_reason text,
  admin_notes text,
  is_launched boolean not null default false,
  launched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vacation_requests_valid_dates check (end_date >= start_date),
  constraint vacation_requests_valid_duration check (
    duration_days = (end_date - start_date + 1)
    and duration_days between 5 and 30
  ),
  constraint vacation_requests_valid_period check (period_number between 1 and 2),
  constraint vacation_requests_valid_status check (
    status in ('pending', 'approved', 'rejected', 'cancelled')
  ),
  constraint vacation_requests_valid_abono check (
    (not wants_abono and abono_days is null)
    or (wants_abono and abono_days between 1 and 10)
  ),
  constraint vacation_requests_launch_consistency check (
    (is_launched and launched_at is not null)
    or (not is_launched and launched_at is null)
  )
);

create table public.vacation_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  year integer not null,
  start_date date not null,
  end_date date not null,
  is_critical_period boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vacation_history_valid_year check (year between 2000 and 2100),
  constraint vacation_history_valid_dates check (end_date >= start_date)
);

create index vacation_requests_user_id_idx on public.vacation_requests(user_id);
create index vacation_requests_dates_idx on public.vacation_requests(start_date, end_date);
create index vacation_requests_status_idx on public.vacation_requests(status);
create index vacation_history_user_year_idx on public.vacation_history(user_id, year desc);
create index profiles_sector_idx on public.profiles(sector);

create or replace function private.is_admin(check_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles
    where user_id = check_user_id and role = 'admin'
  );
$$;

revoke all on function private.is_admin(uuid) from public, anon;
grant execute on function private.is_admin(uuid) to authenticated, service_role;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function private.set_updated_at();

create trigger vacation_requests_set_updated_at
before update on public.vacation_requests
for each row execute function private.set_updated_at();

create trigger vacation_history_set_updated_at
before update on public.vacation_history
for each row execute function private.set_updated_at();

create or replace function private.enforce_vacation_request_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_count integer;
  requester_sector text;
  allowed_simultaneous integer;
  conflicting_count integer;
  longest_overlap integer;
begin
  if new.status not in ('pending', 'approved') then
    return new;
  end if;

  select count(*) into active_count
  from public.vacation_requests request
  where request.user_id = new.user_id
    and request.status in ('pending', 'approved')
    and extract(year from request.start_date) = extract(year from new.start_date)
    and request.id <> new.id;

  if active_count >= 2 then
    raise exception 'Limite de 2 marcações de férias por ano atingido.'
      using errcode = '23514';
  end if;

  if new.status <> 'approved' then
    return new;
  end if;

  select sector into requester_sector
  from public.profiles
  where id = new.user_id;

  allowed_simultaneous := case requester_sector
    when 'RESIDENCIAL' then 2
    else 1
  end;

  select count(*), coalesce(max(
    least(request.end_date, new.end_date) - greatest(request.start_date, new.start_date) + 1
  ), 0)
  into conflicting_count, longest_overlap
  from public.vacation_requests request
  join public.profiles profile on profile.id = request.user_id
  where request.status = 'approved'
    and request.user_id <> new.user_id
    and request.id <> new.id
    and request.start_date <= new.end_date
    and request.end_date >= new.start_date
    and (
      profile.sector = requester_sector
      or (requester_sector = 'QOE' and profile.sector = 'BCC')
      or (requester_sector = 'BCC' and profile.sector = 'QOE')
    );

  if conflicting_count >= allowed_simultaneous and longest_overlap > 3 then
    raise exception 'Conflito de escala: sobreposição superior a 3 dias.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger vacation_requests_enforce_rules
before insert or update of user_id, start_date, end_date, status
on public.vacation_requests
for each row execute function private.enforce_vacation_request_rules();

alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.holidays enable row level security;
alter table public.vacation_requests enable row level security;
alter table public.vacation_history enable row level security;

create policy profiles_read_directory
on public.profiles for select
to authenticated
using (true);

create policy profiles_update_own_password_flag
on public.profiles for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy profiles_admin_all
on public.profiles for all
to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

create policy user_roles_read_own_or_admin
on public.user_roles for select
to authenticated
using ((select auth.uid()) = user_id or (select private.is_admin()));

create policy user_roles_admin_all
on public.user_roles for all
to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

create policy holidays_read
on public.holidays for select
to authenticated
using (true);

create policy holidays_admin_all
on public.holidays for all
to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

create policy vacation_requests_read_schedule
on public.vacation_requests for select
to authenticated
using (true);

create policy vacation_requests_create_own_pending
on public.vacation_requests for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and status = 'pending'
  and rejection_reason is null
  and admin_notes is null
  and is_launched = false
  and launched_at is null
);

create policy vacation_requests_admin_all
on public.vacation_requests for all
to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

create policy vacation_history_read_own_or_admin
on public.vacation_history for select
to authenticated
using ((select auth.uid()) = user_id or (select private.is_admin()));

create policy vacation_history_admin_all
on public.vacation_history for all
to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to authenticated, service_role;
grant select on public.profiles to authenticated;
grant update (must_change_password) on public.profiles to authenticated;
grant select on public.user_roles to authenticated;
grant select on public.holidays to authenticated;
grant insert, update, delete on public.holidays to authenticated;
grant select, insert on public.vacation_requests to authenticated;
grant update (status, admin_notes, rejection_reason, is_launched, launched_at) on public.vacation_requests to authenticated;
grant select, insert, update, delete on public.vacation_history to authenticated;

grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

alter publication supabase_realtime add table public.vacation_requests;
