import { TCGOnline } from './online-client.js';

const root = document.getElementById('tradeApp');
const catalog = window.CARTAS || [];
const catalogById = new Map(catalog.map(card => [card.id, card]));
const state = {
  user: null,
  profile: null,
  collection: [],
  trades: [],
  notifications: [],
  selectedPlayer: null,
  offer: {},
  request: {},
  searchTimer: null,
  channel: null,
  tab: 'create',
  filters: { players: '', offer: '', request: '' },
  playerResults: [],
  busy: false,
  error: ''
};

const h = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const rarityColor = { C: '#8C9BAE', UC: '#4ADE80', R: '#3399FF', SR: '#A855F7', UR: '#FFCB05' };
const cardInfo = row => catalogById.get(row.card_id ?? row.id) || {
  id: row.card_id ?? row.id,
  n: row.name || row.cards?.name || `Carta ${row.card_id ?? row.id}`,
  e: row.expansion || row.cards?.expansion || '',
  r: row.rarity || row.cards?.rarity || '',
  f: row.image_path || row.cards?.image_path || ''
};
const cardImage = row => cardInfo(row).f || row.cards?.image_path || '';
const available = row => Math.max(0, Number(row.quantity) - Number(row.reserved || 0));
const statusNames = { pending: 'Pendiente', accepted: 'Completado', rejected: 'Rechazado', cancelled: 'Cancelado' };
const toast = message => {
  const element = document.getElementById('ts');
  element.textContent = message;
  element.style.opacity = '1';
  setTimeout(() => { element.style.opacity = '0'; }, 2600);
};

function cardRow(row, quantity, controls = '') {
  const card = cardInfo(row);
  return `<div class="trade-row">
    <img src="${h(cardImage(row))}" alt="${h(card.n)}" loading="lazy">
    <span class="trade-card-copy"><b>${h(card.n)}</b><small>${h(card.e)} · <i style="color:${rarityColor[card.r] || 'var(--t2)'}">${h(card.r || 'Carta')}</i></small></span>
    ${controls || `<span class="trade-qty">x${h(quantity)}</span>`}
  </div>`;
}

function selectedRows(selection) {
  return Object.entries(selection).filter(([, quantity]) => quantity > 0).map(([id, quantity]) => ({
    card_id: Number(id), quantity
  }));
}

function renderAccount() {
  if (!TCGOnline) return `<section class="trade-account"><div><b>Modo online no configurado</b><div class="trade-note">Configure VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY en Vercel y vuelva a desplegar.</div></div></section>`;
  if (!state.user) return `<section class="trade-account"><form id="trade-login">
    <input name="email" type="email" autocomplete="username" placeholder="Correo de invitación" required>
    <input name="password" type="password" autocomplete="current-password" placeholder="Contraseña" required>
    <button class="btn" type="submit" ${state.busy ? 'disabled' : ''}>Iniciar sesión</button>
    <span class="trade-note">Acceso solo por invitación.</span>
  </form></section>`;
  const unread = state.notifications.filter(item => !item.read_at);
  return `<section class="trade-account"><div><b>${h(state.profile?.display_name || state.profile?.username || state.user.email)}</b>
    <small> · ${state.collection.reduce((sum, item) => sum + available(item), 0)} cartas disponibles</small></div>
    <details class="trade-notifications"><summary>Notificaciones${unread.length ? `<span class="trade-badge">${unread.length}</span>` : ''}</summary>
      ${state.notifications.length ? state.notifications.slice(0, 8).map(item => `<div class="trade-note">${h(item.message)} · ${new Date(item.created_at).toLocaleString()}</div>`).join('') : '<div class="trade-note">No hay notificaciones.</div>'}
      ${unread.length ? '<button class="chip" data-action="read-notifications">Marcar como leídas</button>' : ''}
    </details><button class="btn secondary" data-action="logout">Cerrar sesión</button></section>`;
}

function renderTabs() {
  const labels = [['create', 'Crear'], ['received', 'Recibidos'], ['sent', 'Enviados'], ['history', 'Historial']];
  return `<nav class="trade-tabs" aria-label="Secciones de intercambios">${labels.map(([key, label]) =>
    `<button class="${state.tab === key ? 'active' : ''}" data-tab="${key}">${label}${key === 'received' && state.user ? `<span class="trade-badge">${state.trades.filter(trade => trade.status === 'pending' && trade.recipient_id === state.user.id).length}</span>` : ''}</button>`
  ).join('')}</nav>`;
}

function renderPlayerSearch() {
  const results = state.playerResults.map(player => `<div class="trade-player"><span><b>${h(player.display_name || player.username)}</b><small> @${h(player.username)}</small></span>
    <button class="chip" data-action="choose-player" data-id="${h(player.id)}">Elegir</button></div>`).join('');
  const chosen = state.selectedPlayer ? `<div class="trade-note success">Destinatario: <b>${h(state.selectedPlayer.display_name || state.selectedPlayer.username)}</b> (@${h(state.selectedPlayer.username)})
    <button class="chip" data-action="clear-player" aria-label="Quitar destinatario">Quitar</button></div>` : '';
  return `<section class="trade-panel"><h2>1. Elegí un jugador</h2>
    <input class="trade-search" name="players" data-filter="players" value="${h(state.filters.players)}" placeholder="Buscar por nombre de usuario" autocomplete="off" ${state.selectedPlayer ? 'disabled' : ''}>
    ${chosen}<div class="trade-results">${results || (state.filters.players.length >= 2 ? '<div class="trade-empty">No se encontraron jugadores.</div>' : '')}</div>
  </section>`;
}

function pickerRows(kind, rows) {
  const selection = state[kind];
  const filter = state.filters[kind].trim().toLocaleLowerCase();
  const matched = rows.filter(row => {
    const card = cardInfo(row);
    return !filter || `${card.n} ${card.e} ${card.r}`.toLocaleLowerCase().includes(filter);
  }).slice(0, 60);
  if (!matched.length) return '<div class="trade-empty">No hay cartas para mostrar con ese filtro.</div>';
  return matched.map(row => {
    const card = cardInfo(row);
    const qty = selection[card.id] || 0;
    const max = kind === 'offer' ? available(row) : 99;
    return `<div class="trade-row"><img src="${h(cardImage(row))}" alt="${h(card.n)}" loading="lazy">
      <span class="trade-card-copy"><b>${h(card.n)}</b><small>${h(card.e)} · <i style="color:${rarityColor[card.r] || 'var(--t2)'}">${h(card.r)}</i>${kind === 'offer' ? ` · Disponibles: ${max}` : ''}</small></span>
      <span class="trade-stepper"><button data-action="decrease" data-kind="${kind}" data-id="${card.id}" aria-label="Quitar una copia" ${qty <= 0 ? 'disabled' : ''}>−</button><b>${qty}</b><button data-action="increase" data-kind="${kind}" data-id="${card.id}" data-max="${max}" aria-label="Agregar una copia" ${qty >= max ? 'disabled' : ''}>+</button></span>
    </div>`;
  }).join('');
}

function renderCreate() {
  const owned = state.collection.filter(item => available(item) > 0).map(item => ({ ...item, card_id: item.card_id }));
  const wanted = catalog.map(card => ({ ...card, card_id: card.id }));
  const offers = selectedRows(state.offer);
  const requests = selectedRows(state.request);
  const previewSide = (rows, label) => `<div class="trade-flow-side"><strong>${label}</strong>${rows.length ? rows.map(item => cardRow(item, item.quantity)).join('') : '<div class="trade-empty">Todavía no seleccionaste cartas.</div>'}</div>`;
  return `<form id="trade-create">
    ${renderPlayerSearch()}
    <div class="trade-pickers">
      <section class="trade-panel trade-picker"><div class="trade-picker-head"><h3>2. LO QUE OFREZCO</h3><span class="trade-qty">${offers.length} cartas</span></div>
        <input class="trade-search" data-filter="offer" value="${h(state.filters.offer)}" placeholder="Filtrar mi colección">
        <div class="trade-picker-list">${pickerRows('offer', owned)}</div>
      </section>
      <section class="trade-panel trade-picker"><div class="trade-picker-head"><h3>3. LO QUE RECIBO</h3><span class="trade-qty">${requests.length} cartas</span></div>
        <input class="trade-search" data-filter="request" value="${h(state.filters.request)}" placeholder="Buscar en el catálogo">
        <div class="trade-picker-list">${pickerRows('request', wanted)}</div>
      </section>
    </div>
    <section class="trade-panel trade-preview"><h3>Vista previa</h3><div class="trade-flow">
      ${previewSide(offers, 'LO QUE OFREZCO')}<div class="trade-arrow" aria-hidden="true">→</div>${previewSide(requests, 'LO QUE RECIBO')}
    </div><div class="trade-actions"><textarea class="trade-message" name="message" maxlength="300" placeholder="Mensaje opcional (300 caracteres)"></textarea>
      <button class="btn" type="submit" ${state.busy || !state.user ? 'disabled' : ''}>Enviar propuesta</button>
      ${state.error ? `<span class="trade-note error" role="alert">${h(state.error)}</span>` : ''}</div>
    </section>
  </form>`;
}

function participantName(trade, id) {
  const profile = id === trade.proposer_id ? trade.proposer : trade.recipient;
  return profile?.display_name || profile?.username || 'Jugador';
}

function tradeFlow(trade) {
  const items = trade.trade_items || [];
  const offer = items.filter(item => item.owner_id === trade.proposer_id);
  const request = items.filter(item => item.owner_id === trade.recipient_id);
  const side = (rows, title) => `<div class="trade-flow-side"><strong>${title}</strong>${rows.map(item => cardRow(item, item.quantity)).join('') || '<div class="trade-empty">Sin cartas</div>'}</div>`;
  return `<div class="trade-flow">${side(offer, 'LO QUE OFRECE')}
    <div class="trade-arrow" aria-hidden="true">→</div>${side(request, 'LO QUE RECIBE')}</div>`;
}

function renderTradeList(mode) {
  const filtered = state.trades.filter(trade => {
    if (mode === 'received') return trade.recipient_id === state.user.id && trade.status === 'pending';
    if (mode === 'sent') return trade.proposer_id === state.user.id && trade.status === 'pending';
    return trade.status !== 'pending';
  });
  if (!filtered.length) return '<div class="trade-empty">No hay intercambios en esta sección.</div>';
  return `<div class="trade-list">${filtered.map(trade => {
    const isIncoming = trade.recipient_id === state.user.id;
    const other = isIncoming ? trade.proposer_id : trade.recipient_id;
    const heading = mode === 'received' ? `De ${participantName(trade, other)}` : mode === 'sent' ? `Para ${participantName(trade, other)}` : `${participantName(trade, trade.proposer_id)} ↔ ${participantName(trade, trade.recipient_id)}`;
    const action = mode === 'received' ? `<div class="trade-actions"><button class="btn" data-action="respond" data-accept="true" data-id="${h(trade.id)}">Aceptar</button><button class="btn secondary" data-action="respond" data-accept="false" data-id="${h(trade.id)}">Rechazar</button></div>` : mode === 'sent' ? `<div class="trade-actions"><button class="btn secondary" data-action="cancel" data-id="${h(trade.id)}">Cancelar propuesta</button></div>` : '';
    return `<article class="trade-item"><div class="trade-item-head"><div><b>${h(heading)}</b><small> · ${new Date(trade.created_at).toLocaleString()}</small>${trade.message ? `<div class="trade-note">${h(trade.message)}</div>` : ''}</div><span class="trade-status">${h(statusNames[trade.status] || trade.status)}</span></div>
      ${tradeFlow(trade)}${action}</article>`;
  }).join('')}</div>`;
}

function render() {
  root.innerHTML = `<div class="trade-top"><div><h1>Intercambios</h1><p>Propuestas directas, con transferencia segura entre colecciones.</p></div></div>
    ${renderAccount()}${renderTabs()}
    ${!TCGOnline ? '<section class="trade-panel"><div class="trade-note error">No se pudo inicializar Supabase. Verificá las variables de entorno de Vercel y volvé a desplegar.</div></section>' : !state.user ? '<section class="trade-panel"><div class="trade-empty">Iniciá sesión con una cuenta invitada para crear y gestionar intercambios.</div></section>' : state.tab === 'create' ? renderCreate() : `<section class="trade-panel">${renderTradeList(state.tab)}</section>`}`;
}

async function refresh() {
  if (!state.user) { render(); return; }
  try {
    const [profile, collection, trades, notifications] = await Promise.all([
      TCGOnline.profile(), TCGOnline.collection(), TCGOnline.trades(), TCGOnline.notifications()
    ]);
    state.profile = profile;
    state.collection = collection || [];
    state.trades = trades || [];
    state.notifications = notifications || [];
    state.error = '';
    window.dispatchEvent(new CustomEvent('tcg-online-state', {
      detail: { user: state.user, profile: state.profile, collection: state.collection }
    }));
  } catch (error) {
    state.error = error.message || 'No se pudieron cargar los datos online.';
  }
  render();
}

async function startSession() {
  if (!TCGOnline) return;
  const session = await TCGOnline.session();
  state.user = session?.user || null;
  window.dispatchEvent(new CustomEvent('tcg-online-state', {
    detail: { user: state.user, profile: null, collection: null }
  }));
  state.selectedPlayer = null;
  state.offer = {};
  state.request = {};
  if (state.channel) { await TCGOnline.stopWatching(state.channel); state.channel = null; }
  if (state.user) {
    state.channel = TCGOnline.watchNotifications(notification => {
      toast(notification.message || 'Tenés una nueva notificación.');
      refresh();
    });
  }
  await refresh();
}

function updatePicker(kind, cardId, delta, max) {
  const current = state[kind][cardId] || 0;
  const next = Math.max(0, Math.min(Number(max), current + delta));
  if (next) state[kind][cardId] = next;
  else delete state[kind][cardId];
  state.error = '';
  render();
}

root.addEventListener('input', event => {
  const filter = event.target.dataset.filter;
  if (!filter) return;
  state.filters[filter] = event.target.value;
  if (filter === 'players') {
    clearTimeout(state.searchTimer);
    const term = event.target.value.trim();
    state.searchTimer = setTimeout(async () => {
      if (!TCGOnline || term.length < 2) { state.playerResults = []; render(); return; }
      try {
        state.playerResults = await TCGOnline.searchPlayers(term);
        render();
      } catch (error) { state.error = error.message; render(); }
    }, 250);
    return;
  }
  const list = event.target.parentElement.querySelector('.trade-picker-list');
  const kind = filter;
  const rows = kind === 'offer'
    ? state.collection.filter(item => available(item) > 0)
    : catalog.map(card => ({ ...card, card_id: card.id }));
  list.innerHTML = pickerRows(kind, rows);
});

root.addEventListener('submit', async event => {
  event.preventDefault();
  if (event.target.id === 'trade-login') {
    const values = new FormData(event.target);
    state.busy = true; render();
    try { await TCGOnline.signIn(values.get('email'), values.get('password')); await startSession(); }
    catch (error) { state.error = error.message || 'No se pudo iniciar sesión.'; toast(state.error); render(); }
    finally { state.busy = false; render(); }
    return;
  }
  if (event.target.id === 'trade-create') {
    const offer = selectedRows(state.offer);
    const request = selectedRows(state.request);
    if (!state.selectedPlayer) { state.error = 'Elegí un jugador destinatario.'; render(); return; }
    if (!offer.length || !request.length) { state.error = 'Seleccioná al menos una carta para ofrecer y otra para recibir.'; render(); return; }
    const values = new FormData(event.target);
    state.busy = true; state.error = ''; render();
    try {
      await TCGOnline.createTrade(state.selectedPlayer.id, offer, request, values.get('message'));
      toast('Propuesta enviada.');
      state.tab = 'sent'; state.selectedPlayer = null; state.offer = {}; state.request = {};
      await refresh();
    } catch (error) { state.error = error.message || 'No se pudo enviar la propuesta.'; toast(state.error); }
    finally { state.busy = false; render(); }
  }
});

root.addEventListener('click', async event => {
  const tab = event.target.closest('[data-tab]');
  if (tab) { state.tab = tab.dataset.tab; state.error = ''; render(); return; }
  const button = event.target.closest('[data-action]');
  if (!button || !TCGOnline) return;
  const { action, id } = button.dataset;
  try {
    if (action === 'choose-player') {
      state.selectedPlayer = state.playerResults.find(player => player.id === id) || null;
      state.playerResults = []; state.filters.players = ''; render();
    } else if (action === 'clear-player') {
      state.selectedPlayer = null; render();
    } else if (action === 'increase' || action === 'decrease') {
      updatePicker(button.dataset.kind, Number(id), action === 'increase' ? 1 : -1, Number(button.dataset.max || 0));
    } else if (action === 'logout') {
      await TCGOnline.signOut(); state.user = null; state.profile = null; state.collection = []; state.trades = []; state.notifications = []; await startSession();
    } else if (action === 'respond') {
      button.disabled = true;
      await TCGOnline.respondTrade(id, button.dataset.accept === 'true');
      toast(button.dataset.accept === 'true' ? 'Intercambio completado.' : 'Propuesta rechazada.');
      await refresh();
    } else if (action === 'cancel') {
      button.disabled = true;
      await TCGOnline.cancelTrade(id); toast('Propuesta cancelada.'); await refresh();
    } else if (action === 'read-notifications') {
      const unreadIds = state.notifications.filter(item => !item.read_at).map(item => item.id);
      await TCGOnline.markNotificationsRead(unreadIds); await refresh();
    }
  } catch (error) {
    state.error = error.message || 'La operación no pudo completarse.';
    toast(state.error); await refresh();
  }
});

render();
if (TCGOnline) startSession().catch(error => { state.error = error.message; render(); });
