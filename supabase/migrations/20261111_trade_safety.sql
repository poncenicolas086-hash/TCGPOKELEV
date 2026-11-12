begin;

-- Las escrituras de colecciones y trades solo se realizan mediante RPC.
revoke insert, update, delete on public.user_cards, public.trades, public.trade_items
  from public, anon, authenticated;
revoke update on public.notifications from public, anon, authenticated;
revoke update (user_id, trade_id, kind, message, read_at, created_at)
  on public.notifications from public, anon, authenticated;
grant update (read_at) on public.notifications to authenticated;

-- Evita que el cliente cambie contadores autoritativos del perfil.
revoke update on public.profiles from public, anon, authenticated;
revoke update (username, display_name, avatar_url, total_packs, created_at)
  on public.profiles from public, anon, authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;

do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_catalog.pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public' and tablename = 'notifications'
     ) then
    execute 'alter publication supabase_realtime add table public.notifications';
  end if;
end;
$$;

create or replace function public.create_trade(
  p_recipient uuid,
  p_offer jsonb,
  p_request jsonb default '[]'::jsonb,
  p_message text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_trade uuid;
  v_card integer;
  v_total bigint;
  v_entry jsonb;
begin
  if v_me is null then raise exception 'Debes iniciar sesión'; end if;
  if p_recipient is null or p_recipient = v_me then raise exception 'Destinatario inválido'; end if;
  if not exists (select 1 from public.profiles where id = p_recipient) then
    raise exception 'Jugador inexistente';
  end if;
  if jsonb_typeof(coalesce(p_offer, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_request, '[]'::jsonb)) <> 'array' then
    raise exception 'Las cartas deben enviarse como listas';
  end if;
  if jsonb_array_length(coalesce(p_offer, '[]'::jsonb)) = 0
     or jsonb_array_length(coalesce(p_request, '[]'::jsonb)) = 0 then
    raise exception 'Cada jugador debe ofrecer al menos una carta';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_offer) entry(value)
    where jsonb_typeof(entry.value) <> 'object'
       or entry.value->>'card_id' is null or entry.value->>'quantity' is null
  ) or exists (
    select 1 from jsonb_array_elements(p_request) entry(value)
    where jsonb_typeof(entry.value) <> 'object'
       or entry.value->>'card_id' is null or entry.value->>'quantity' is null
  ) then
    raise exception 'Cada carta requiere card_id y quantity';
  end if;

  insert into public.trades(proposer_id, recipient_id, message)
    values (v_me, p_recipient, left(p_message, 300)) returning id into v_trade;

  -- Sumar IDs repetidos y bloquear siempre en orden estable, incluso con peticiones manipuladas.
  for v_card, v_total in
    select (entry.value->>'card_id')::integer,
           sum((entry.value->>'quantity')::bigint)
    from jsonb_array_elements(p_offer) entry(value)
    group by (entry.value->>'card_id')::integer
    order by 1
  loop
    if v_card is null or v_total < 1 or v_total > 2147483647 then
      raise exception 'Cantidad o carta ofrecida inválida';
    end if;
    update public.user_cards
       set reserved = reserved + v_total::integer
     where user_id = v_me and card_id = v_card
       and quantity - reserved >= v_total;
    if not found then
      raise exception 'No tienes suficientes copias disponibles de la carta %', v_card;
    end if;
    insert into public.trade_items(trade_id, owner_id, card_id, quantity)
      values (v_trade, v_me, v_card, v_total::integer);
  end loop;

  -- No se bloquea ni reserva la colección ajena al crear; vuelve a validarse al aceptar.
  for v_card, v_total in
    select (entry.value->>'card_id')::integer,
           sum((entry.value->>'quantity')::bigint)
    from jsonb_array_elements(p_request) entry(value)
    group by (entry.value->>'card_id')::integer
    order by 1
  loop
    if v_card is null or v_total < 1 or v_total > 2147483647 then
      raise exception 'Cantidad o carta solicitada inválida';
    end if;
    perform 1 from public.user_cards
     where user_id = p_recipient and card_id = v_card
       and quantity - reserved >= v_total;
    if not found then
      raise exception 'El destinatario no tiene suficientes copias disponibles de la carta %', v_card;
    end if;
    insert into public.trade_items(trade_id, owner_id, card_id, quantity)
      values (v_trade, p_recipient, v_card, v_total::integer);
  end loop;

  insert into public.notifications(user_id, trade_id, kind, message)
    values (p_recipient, v_trade, 'trade_received', 'Recibiste una propuesta de intercambio');
  return v_trade;
end;
$$;

create or replace function public.respond_trade(p_trade uuid, p_accept boolean)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.trades%rowtype;
  i record;
  v_key record;
  v_status text;
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Debes iniciar sesión'; end if;
  select * into t from public.trades where id = p_trade for update;
  if not found or v_me not in (t.proposer_id, t.recipient_id) then
    raise exception 'Intercambio no encontrado o no autorizado';
  end if;
  if t.status <> 'pending' then raise exception 'El intercambio ya no está pendiente'; end if;
  if v_me <> t.recipient_id then raise exception 'Solo el destinatario puede responder'; end if;
  if p_accept is null then raise exception 'Respuesta inválida'; end if;

  if p_accept then
    if not exists (select 1 from public.trade_items where trade_id = p_trade and owner_id = t.proposer_id)
       or not exists (select 1 from public.trade_items where trade_id = p_trade and owner_id = t.recipient_id)
       or exists (select 1 from public.trade_items where trade_id = p_trade and owner_id not in (t.proposer_id, t.recipient_id)) then
      raise exception 'La propuesta de intercambio no es válida';
    end if;

    -- Advisory locks también cubren destinos sin fila de inventario, en orden global estable.
    for v_key in
      select keys.user_id, keys.card_id from (
        select owner_id as user_id, card_id
          from public.trade_items where trade_id = p_trade
        union
        select case when owner_id = t.proposer_id then t.recipient_id else t.proposer_id end,
               card_id
          from public.trade_items where trade_id = p_trade
      ) keys
      order by keys.user_id, keys.card_id
    loop
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_key.user_id::text || ':' || v_key.card_id::text, 0)
      );
    end loop;

    -- Bloquea todas las filas existentes implicadas antes de comprobar disponibilidad.
    for i in
      select owner_id, card_id, sum(quantity)::bigint as quantity
      from public.trade_items where trade_id = p_trade
      group by owner_id, card_id order by owner_id, card_id
    loop
      if i.quantity < 1 or i.quantity > 2147483647 then
        raise exception 'Cantidad de intercambio inválida';
      end if;
      if i.owner_id = t.proposer_id then
        perform 1 from public.user_cards
         where user_id = i.owner_id and card_id = i.card_id
           and reserved >= i.quantity and quantity >= i.quantity for update;
      else
        perform 1 from public.user_cards
         where user_id = i.owner_id and card_id = i.card_id
           and quantity - reserved >= i.quantity for update;
      end if;
      if not found then raise exception 'Una de las cartas ya no está disponible'; end if;
    end loop;

    for i in
      select owner_id, card_id, sum(quantity)::bigint as quantity
      from public.trade_items where trade_id = p_trade
      group by owner_id, card_id order by owner_id, card_id
    loop
      if i.owner_id = t.proposer_id then
        update public.user_cards
           set quantity = quantity - i.quantity::integer,
               reserved = reserved - i.quantity::integer
         where user_id = i.owner_id and card_id = i.card_id;
        insert into public.user_cards(user_id, card_id, quantity)
          values (t.recipient_id, i.card_id, i.quantity::integer)
          on conflict (user_id, card_id) do update
            set quantity = public.user_cards.quantity + excluded.quantity;
      else
        update public.user_cards
           set quantity = quantity - i.quantity::integer
         where user_id = i.owner_id and card_id = i.card_id;
        insert into public.user_cards(user_id, card_id, quantity)
          values (t.proposer_id, i.card_id, i.quantity::integer)
          on conflict (user_id, card_id) do update
            set quantity = public.user_cards.quantity + excluded.quantity;
      end if;
    end loop;
    v_status := 'accepted';
  else
    for i in
      select owner_id, card_id, sum(quantity)::bigint as quantity
      from public.trade_items where trade_id = p_trade and owner_id = t.proposer_id
      group by owner_id, card_id order by owner_id, card_id
    loop
      update public.user_cards set reserved = reserved - i.quantity::integer
       where user_id = i.owner_id and card_id = i.card_id and reserved >= i.quantity;
      if not found then raise exception 'No se pudo liberar la reserva del intercambio'; end if;
    end loop;
    v_status := 'rejected';
  end if;

  update public.trades set status = v_status, updated_at = pg_catalog.now() where id = p_trade;
  insert into public.notifications(user_id, trade_id, kind, message)
    values (t.proposer_id, p_trade, 'trade_' || v_status,
      case when p_accept then 'Tu intercambio fue aceptado' else 'Tu intercambio fue rechazado' end);
end;
$$;

create or replace function public.cancel_trade(p_trade uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.trades%rowtype;
  i record;
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Debes iniciar sesión'; end if;
  select * into t from public.trades where id = p_trade for update;
  if not found or t.proposer_id <> v_me then raise exception 'No autorizado'; end if;
  if t.status <> 'pending' then raise exception 'El intercambio ya no está pendiente'; end if;

  for i in
    select owner_id, card_id, sum(quantity)::bigint as quantity
    from public.trade_items where trade_id = p_trade and owner_id = t.proposer_id
    group by owner_id, card_id order by owner_id, card_id
  loop
    update public.user_cards set reserved = reserved - i.quantity::integer
     where user_id = i.owner_id and card_id = i.card_id and reserved >= i.quantity;
    if not found then raise exception 'No se pudo liberar la reserva del intercambio'; end if;
  end loop;

  update public.trades set status = 'cancelled', updated_at = pg_catalog.now() where id = p_trade;
  insert into public.notifications(user_id, trade_id, kind, message)
    values (t.recipient_id, p_trade, 'trade_cancelled', 'El jugador canceló la propuesta de intercambio');
end;
$$;

revoke all on function public.create_trade(uuid, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.respond_trade(uuid, boolean) from public, anon, authenticated;
revoke all on function public.cancel_trade(uuid) from public, anon, authenticated;
grant execute on function public.create_trade(uuid, jsonb, jsonb, text) to authenticated;
grant execute on function public.respond_trade(uuid, boolean) to authenticated;
grant execute on function public.cancel_trade(uuid) to authenticated;

commit;
