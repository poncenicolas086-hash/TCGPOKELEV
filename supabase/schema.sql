-- TCG LEVI - esquema inicial online (Supabase / PostgreSQL)
-- Ejecutar una sola vez en Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null check (char_length(username) between 3 and 20),
  display_name text not null default 'Entrenador',
  avatar_url text,
  total_packs bigint not null default 0 check (total_packs >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.cards (
  id integer primary key,
  name text not null,
  expansion text not null,
  rarity text not null check (rarity in ('C','UC','R','SR','UR')),
  image_path text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.user_cards (
  user_id uuid not null references public.profiles(id) on delete cascade,
  card_id integer not null references public.cards(id),
  quantity integer not null default 0 check (quantity >= 0),
  reserved integer not null default 0 check (reserved >= 0 and reserved <= quantity),
  obtained_at timestamptz not null default now(),
  primary key (user_id, card_id)
);

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  proposer_id uuid not null references public.profiles(id),
  recipient_id uuid not null references public.profiles(id),
  status text not null default 'pending' check (status in ('pending','accepted','rejected','cancelled')),
  message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (proposer_id <> recipient_id)
);

create table if not exists public.trade_items (
  id bigint generated always as identity primary key,
  trade_id uuid not null references public.trades(id) on delete cascade,
  owner_id uuid not null references public.profiles(id),
  card_id integer not null references public.cards(id),
  quantity integer not null check (quantity > 0)
);

create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  trade_id uuid references public.trades(id) on delete cascade,
  kind text not null,
  message text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists trades_recipient_status_idx on public.trades(recipient_id, status, created_at desc);
create index if not exists trades_proposer_status_idx on public.trades(proposer_id, status, created_at desc);
create index if not exists notifications_user_unread_idx on public.notifications(user_id, created_at desc) where read_at is null;

-- Perfil automático para usuarios creados mediante invitación de Supabase Auth.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_username text;
begin
  v_username := coalesce(nullif(new.raw_user_meta_data->>'username',''), split_part(new.email,'@',1));
  v_username := left(regexp_replace(v_username, '[^a-zA-Z0-9_]', '', 'g'), 20);
  if length(v_username) < 3 then v_username := 'player_' || left(replace(new.id::text,'-',''), 8); end if;
  insert into public.profiles(id, username, display_name)
  values(new.id, v_username, coalesce(nullif(new.raw_user_meta_data->>'display_name',''), v_username))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created_tcg on auth.users;
create trigger on_auth_user_created_tcg after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.cards enable row level security;
alter table public.user_cards enable row level security;
alter table public.trades enable row level security;
alter table public.trade_items enable row level security;
alter table public.notifications enable row level security;

-- Los perfiles son visibles para usuarios autenticados (necesario para buscar jugadores).
drop policy if exists "profiles readable by authenticated" on public.profiles;
create policy "profiles readable by authenticated" on public.profiles for select to authenticated using (true);
drop policy if exists "profile owner updates own profile" on public.profiles;
create policy "profile owner updates own profile" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- Catálogo legible por usuarios conectados; escritura reservada al service_role.
drop policy if exists "cards readable by authenticated" on public.cards;
create policy "cards readable by authenticated" on public.cards for select to authenticated using (true);

-- La colección solo puede leerla su propietario. No se permite modificarla directamente desde el cliente.
drop policy if exists "own collection readable" on public.user_cards;
create policy "own collection readable" on public.user_cards for select to authenticated using (auth.uid() = user_id);

-- Solo los participantes ven intercambios y sus artículos. Las escrituras se hacen mediante RPC.
drop policy if exists "trade participants can read" on public.trades;
create policy "trade participants can read" on public.trades for select to authenticated using (auth.uid() in (proposer_id, recipient_id));
drop policy if exists "trade item participants can read" on public.trade_items;
create policy "trade item participants can read" on public.trade_items for select to authenticated using (
  exists(select 1 from public.trades t where t.id = trade_id and auth.uid() in (t.proposer_id,t.recipient_id))
);
drop policy if exists "own notifications readable" on public.notifications;
create policy "own notifications readable" on public.notifications for select to authenticated using (auth.uid() = user_id);
drop policy if exists "own notifications mark read" on public.notifications;
create policy "own notifications mark read" on public.notifications for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Crear propuesta y reservar copias. Permite ofrecer incluso la última copia.
create or replace function public.create_trade(p_recipient uuid, p_offer jsonb, p_request jsonb default '[]'::jsonb, p_message text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_me uuid := auth.uid(); v_trade uuid; v_item jsonb; v_card integer; v_qty integer; v_owner uuid;
begin
  if v_me is null then raise exception 'Debes iniciar sesión'; end if;
  if p_recipient = v_me then raise exception 'No puedes intercambiar contigo mismo'; end if;
  if not exists(select 1 from profiles where id=p_recipient) then raise exception 'Jugador inexistente'; end if;
  if jsonb_array_length(coalesce(p_offer,'[]'::jsonb)) = 0 or jsonb_array_length(coalesce(p_request,'[]'::jsonb)) = 0 then
    raise exception 'Cada jugador debe ofrecer al menos una carta';
  end if;
  insert into trades(proposer_id,recipient_id,message) values(v_me,p_recipient,left(p_message,300)) returning id into v_trade;
  for v_item in select value from jsonb_array_elements(p_offer) loop
    v_card := (v_item->>'card_id')::integer; v_qty := (v_item->>'quantity')::integer;
    if v_qty < 1 then raise exception 'Cantidad inválida'; end if;
    update user_cards set reserved=reserved+v_qty
      where user_id=v_me and card_id=v_card and quantity-reserved >= v_qty;
    if not found then raise exception 'No tienes suficientes copias disponibles de la carta %',v_card; end if;
    insert into trade_items(trade_id,owner_id,card_id,quantity) values(v_trade,v_me,v_card,v_qty);
  end loop;
  for v_item in select value from jsonb_array_elements(p_request) loop
    v_card := (v_item->>'card_id')::integer; v_qty := (v_item->>'quantity')::integer;
    if v_qty < 1 then raise exception 'Cantidad inválida'; end if;
    -- Las cartas solicitadas no se reservan sin consentimiento del destinatario.
    insert into trade_items(trade_id,owner_id,card_id,quantity) values(v_trade,p_recipient,v_card,v_qty);
  end loop;
  insert into notifications(user_id,trade_id,kind,message) values(p_recipient,v_trade,'trade_received','Tienes una nueva propuesta de intercambio');
  return v_trade;
end; $$;

create or replace function public.respond_trade(p_trade uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare t trades%rowtype; i record; v_status text;
begin
  select * into t from trades where id=p_trade for update;
  if not found or auth.uid() not in (t.proposer_id,t.recipient_id) then raise exception 'Intercambio no encontrado o no autorizado'; end if;
  if t.status <> 'pending' then raise exception 'El intercambio ya no está pendiente'; end if;
  if p_accept and auth.uid() <> t.recipient_id then raise exception 'Solo el destinatario puede aceptar'; end if;
  if not p_accept and auth.uid() <> t.recipient_id then raise exception 'Solo el destinatario puede rechazar'; end if;
  if p_accept then
    -- Ejecutar la transferencia dentro de la misma transacción.
    for i in select * from trade_items where trade_id=p_trade order by owner_id,card_id loop
      if i.owner_id=t.proposer_id then
        perform 1 from user_cards where user_id=i.owner_id and card_id=i.card_id and reserved >= i.quantity and quantity >= i.quantity for update;
      else
        perform 1 from user_cards where user_id=i.owner_id and card_id=i.card_id and quantity-reserved >= i.quantity for update;
      end if;
      if not found then raise exception 'Una de las cartas ofrecidas ya no está disponible'; end if;
    end loop;
    for i in select * from trade_items where trade_id=p_trade loop
      if i.owner_id=t.proposer_id then
        update user_cards set quantity=quantity-i.quantity,reserved=reserved-i.quantity where user_id=i.owner_id and card_id=i.card_id;
      else
        update user_cards set quantity=quantity-i.quantity where user_id=i.owner_id and card_id=i.card_id;
      end if;
      insert into user_cards(user_id,card_id,quantity) values
        (case when i.owner_id=t.proposer_id then t.recipient_id else t.proposer_id end,i.card_id,i.quantity)
      on conflict(user_id,card_id) do update set quantity=user_cards.quantity+excluded.quantity;
    end loop;
    v_status := 'accepted';
  else
    for i in select * from trade_items where trade_id=p_trade and owner_id=t.proposer_id loop
      update user_cards set reserved=greatest(0,reserved-i.quantity) where user_id=i.owner_id and card_id=i.card_id;
    end loop;
    v_status := 'rejected';
  end if;
  update trades set status=v_status,updated_at=now() where id=p_trade;
  insert into notifications(user_id,trade_id,kind,message) values
    (t.proposer_id,p_trade,'trade_'||v_status,case when p_accept then 'Tu intercambio fue aceptado' else 'Tu intercambio fue rechazado' end);
end; $$;

create or replace function public.cancel_trade(p_trade uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare t trades%rowtype; i record;
begin
  select * into t from trades where id=p_trade for update;
  if not found or t.proposer_id <> auth.uid() then raise exception 'No autorizado'; end if;
  if t.status <> 'pending' then raise exception 'El intercambio ya no está pendiente'; end if;
  for i in select * from trade_items where trade_id=p_trade and owner_id=t.proposer_id loop
    update user_cards set reserved=greatest(0,reserved-i.quantity) where user_id=i.owner_id and card_id=i.card_id;
  end loop;
  update trades set status='cancelled',updated_at=now() where id=p_trade;
end; $$;

-- Apertura autoritativa: el cliente nunca decide cartas ni probabilidades.
create or replace function public.open_pack() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid := auth.uid(); v_total bigint; v_guarantee text; v_ids integer[] := '{}'; v_id integer; v_rarity text; v_i integer;
begin
  if v_user is null then raise exception 'Debes iniciar sesión'; end if;
  update profiles set total_packs=total_packs+1 where id=v_user returning total_packs into v_total;
  if v_total is null then raise exception 'Perfil no encontrado'; end if;
  if v_total > 1 and v_total % 100 = 1 then v_guarantee := 'UR'; elsif v_total > 1 and v_total % 10 = 1 then v_guarantee := 'SR'; end if;
  for v_i in 1..5 loop
    if v_i=1 and v_guarantee is not null then
      select id into v_id from cards where (case rarity when 'C' then 1 when 'UC' then 2 when 'R' then 3 when 'SR' then 4 when 'UR' then 5 end) >=
        (case v_guarantee when 'SR' then 4 else 5 end) and not(id=any(v_ids)) order by random() limit 1;
    else
      select chosen.rarity into v_rarity from (
        select r.rarity, r.weight from (values ('C',55.0),('UC',28.0),('R',11.0),('SR',4.5),('UR',1.5)) r(rarity,weight)
        where exists(select 1 from cards c where c.rarity=r.rarity and not(c.id=any(v_ids)))
        order by -ln(greatest(random(),0.000001))/r.weight limit 1
      ) chosen;
      select id into v_id from cards where rarity=v_rarity and not(id=any(v_ids)) order by random() limit 1;
    end if;
    if v_id is null then select id into v_id from cards where not(id=any(v_ids)) order by random() limit 1; end if;
    if v_id is null then raise exception 'No hay suficientes cartas en el catálogo'; end if;
    v_ids := array_append(v_ids,v_id);
    insert into user_cards(user_id,card_id,quantity) values(v_user,v_id,1)
      on conflict(user_id,card_id) do update set quantity=user_cards.quantity+1;
  end loop;
  return jsonb_build_object('total_packs',v_total,'guarantee',v_guarantee,'card_ids',to_jsonb(v_ids));
end; $$;

revoke all on function public.create_trade(uuid,jsonb,jsonb,text) from public;
revoke all on function public.respond_trade(uuid,boolean) from public;
revoke all on function public.cancel_trade(uuid) from public;
revoke all on function public.open_pack() from public;
grant execute on function public.create_trade(uuid,jsonb,jsonb,text) to authenticated;
grant execute on function public.respond_trade(uuid,boolean) to authenticated;
grant execute on function public.cancel_trade(uuid) to authenticated;
grant execute on function public.open_pack() to authenticated;

grant select on public.profiles, public.cards, public.user_cards, public.trades, public.trade_items, public.notifications to authenticated;
grant update(read_at) on public.notifications to authenticated;
