alter table public.vacation_requests
  drop constraint vacation_requests_valid_period;

alter table public.vacation_requests
  add constraint vacation_requests_valid_period
  check (period_number between 1 and 2);
