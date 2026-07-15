begin;

set local role service_role;

insert into public.items(source, external_id, title)
values ('db-role-probe', 'db-role-probe', 'Database role probe');

with changed as (
  update public.items
  set title = 'Database role probe updated'
  where source = 'db-role-probe' and external_id = 'db-role-probe'
  returning 1
)
select 1 / count(*)::integer from changed;

select 1 / count(*)::integer
from public.items
where source = 'db-role-probe'
  and external_id = 'db-role-probe'
  and title = 'Database role probe updated';

with removed as (
  delete from public.items
  where source = 'db-role-probe' and external_id = 'db-role-probe'
  returning 1
)
select 1 / count(*)::integer from removed;

rollback;
