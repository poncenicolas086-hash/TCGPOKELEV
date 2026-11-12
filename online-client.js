// Capa cliente online para TCG LEVI. Requiere supabase-config.js.
// No contiene secretos: solo URL + publishable/anon key, protegida por RLS.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cfg = window.TCG_SUPABASE_CONFIG;
if (!cfg?.url || !cfg?.anonKey || cfg.url.includes('TU-PROYECTO')) {
  console.warn('TCG LEVI: completar supabase-config.js para activar el modo online.');
} else {
  const db = createClient(cfg.url, cfg.anonKey);
  const api = {
    db,
    async signIn(email, password) {
      const { data, error } = await db.auth.signInWithPassword({ email, password });
      if (error) throw error; return data;
    },
    async signOut() { const { error } = await db.auth.signOut(); if (error) throw error; },
    async session() { const { data, error } = await db.auth.getSession(); if (error) throw error; return data.session; },
    async profile() {
      const { data: { user } } = await db.auth.getUser(); if (!user) return null;
      const { data, error } = await db.from('profiles').select('*').eq('id', user.id).single();
      if (error) throw error; return data;
    },
    async collection() {
      const { data, error } = await db.from('user_cards').select('card_id,quantity,reserved,cards(id,name,expansion,rarity,image_path)').order('card_id');
      if (error) throw error; return data;
    },
    async openPack() { const { data, error } = await db.rpc('open_pack'); if (error) throw error; return data; },
    async searchPlayers(term) {
      const { data, error } = await db.from('profiles').select('id,username,display_name,avatar_url').ilike('username', `%${term}%`).limit(20);
      if (error) throw error; return data;
    },
    async createTrade(recipientId, offer, request, message='') {
      const { data, error } = await db.rpc('create_trade', { p_recipient: recipientId, p_offer: offer, p_request: request, p_message: message });
      if (error) throw error; return data;
    },
    async respondTrade(tradeId, accept) {
      const { error } = await db.rpc('respond_trade', { p_trade: tradeId, p_accept: accept }); if (error) throw error;
    },
    async cancelTrade(tradeId) {
      const { error } = await db.rpc('cancel_trade', { p_trade: tradeId }); if (error) throw error;
    },
    async trades() {
      const { data, error } = await db.from('trades').select('*,trade_items(*,cards(*))').order('created_at', { ascending: false });
      if (error) throw error; return data;
    },
    async notifications() {
      const { data, error } = await db.from('notifications').select('*').order('created_at', { ascending: false }).limit(50);
      if (error) throw error; return data;
    },
    watchNotifications(callback) {
      return db.channel('tcg-notifications').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, payload => callback(payload.new)).subscribe();
    }
  };
  window.TCGOnline = api;
  window.dispatchEvent(new CustomEvent('tcg-online-ready', { detail: api }));
}
