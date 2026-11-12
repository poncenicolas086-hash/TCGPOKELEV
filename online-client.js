// La anon key es pública; RLS y las RPC protegen los datos y las operaciones críticas.
import { createClient } from '@supabase/supabase-js';

const env = import.meta.env || {};
const configured = window.TCG_SUPABASE_CONFIG || {};
const url = configured.url || env.VITE_SUPABASE_URL;
const anonKey = configured.anonKey || env.VITE_SUPABASE_ANON_KEY;

const supabase = url && anonKey && !url.includes('TU-PROYECTO')
  ? createClient(url, anonKey)
  : null;
export let TCGOnline = null;

if (!supabase) {
  console.warn('TCG LEVI: configurar VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY para activar el modo online.');
} else {
  const db = supabase;
  const api = {
    db,
    async signIn(email, password) {
      const { data, error } = await db.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return data;
    },
    async signOut() {
      const { error } = await db.auth.signOut();
      if (error) throw error;
    },
    async session() {
      const { data, error } = await db.auth.getSession();
      if (error) throw error;
      return data.session;
    },
    async profile() {
      const { data: { user }, error: authError } = await db.auth.getUser();
      if (authError) throw authError;
      if (!user) return null;
      const { data, error } = await db.from('profiles')
        .select('id,username,display_name,avatar_url,total_packs,created_at')
        .eq('id', user.id).single();
      if (error) throw error;
      return data;
    },
    async collection() {
      const { data, error } = await db.from('user_cards')
        .select('card_id,quantity,reserved,obtained_at,cards(id,name,expansion,rarity,image_path)')
        .order('card_id');
      if (error) throw error;
      return data;
    },
    async openPack() {
      const { data, error } = await db.rpc('open_pack');
      if (error) throw error;
      return data;
    },
    async searchPlayers(term) {
      const { data: { user }, error: authError } = await db.auth.getUser();
      if (authError) throw authError;
      const query = db.from('profiles').select('id,username,display_name,avatar_url')
        .ilike('username', `%${term.trim()}%`).limit(20);
      if (user) query.neq('id', user.id);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
    async createTrade(recipientId, offer, request, message = '') {
      const { data, error } = await db.rpc('create_trade', {
        p_recipient: recipientId,
        p_offer: offer,
        p_request: request,
        p_message: message
      });
      if (error) throw error;
      return data;
    },
    async respondTrade(tradeId, accept) {
      const { error } = await db.rpc('respond_trade', { p_trade: tradeId, p_accept: accept });
      if (error) throw error;
    },
    async cancelTrade(tradeId) {
      const { error } = await db.rpc('cancel_trade', { p_trade: tradeId });
      if (error) throw error;
    },
    async trades() {
      const { data: trades, error } = await db.from('trades')
        .select('*,trade_items(*,cards(id,name,expansion,rarity,image_path))')
        .order('created_at', { ascending: false });
      if (error) throw error;
      if (!trades?.length) return [];
      const playerIds = [...new Set(trades.flatMap(trade => [trade.proposer_id, trade.recipient_id]))];
      const { data: profiles, error: profileError } = await db.from('profiles')
        .select('id,username,display_name').in('id', playerIds);
      if (profileError) throw profileError;
      const byId = new Map((profiles || []).map(profile => [profile.id, profile]));
      return trades.map(trade => ({
        ...trade,
        proposer: byId.get(trade.proposer_id),
        recipient: byId.get(trade.recipient_id)
      }));
    },
    async notifications() {
      const { data, error } = await db.from('notifications').select('*')
        .order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      return data;
    },
    async markNotificationsRead(ids) {
      if (!ids.length) return;
      const { error } = await db.from('notifications').update({ read_at: new Date().toISOString() })
        .in('id', ids).is('read_at', null);
      if (error) throw error;
    },
    watchNotifications(userId, callback) {
      return db.channel(`tcg-notifications-${userId}`)
        .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'notifications',
          filter: `user_id=eq.${userId}`
        }, payload => callback(payload.new))
        .subscribe();
    },
    async stopWatching(channel) {
      if (channel) await db.removeChannel(channel);
    }
  };
  TCGOnline = api;
  window.TCGOnline = api;
}
