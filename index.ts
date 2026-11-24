// supabase functions deploy draw
// supabase secrets set BREVO_API_KEY=... BREVO_SENDER=seu-email-validado-no-brevo@dominio.com
import { createClient } from 'npm:@supabase/supabase-js@2';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const e = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const safeLinks = (value: unknown) => String(value ?? '').split(/\r?\n/).map(s => {
  try { const u = new URL(s.trim()); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : ''; }
  catch { return ''; }
}).filter(Boolean);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  console.log('Draw function request received');
  const url = Deno.env.get('SUPABASE_URL')!;
  const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const { data: { user }, error: authError } = await asUser.auth.getUser();
  if (authError) {
    console.error('Could not validate the draw request user', authError.message);
    return json({ error: 'Não foi possível validar sua sessão. Entre novamente e tente de novo.' }, 401);
  }
  const { room_id } = await req.json();
  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: room, error: roomError } = await db.from('rooms').select('*').eq('id', room_id).single();
  if (roomError) {
    console.error('Could not load the room for the draw', roomError.message);
    return json({ error: 'Não foi possível carregar a sala para o sorteio.' }, 500);
  }
  if (!user || !room || room.admin_id !== user.id) return json({ error: 'Só o adm pode sortear.' }, 403);
  const { data: ps, error: participantsError } = await db.from('participants').select('*').eq('room_id', room_id);
  if (participantsError) {
    console.error('Could not load participants for the draw', participantsError.message);
    return json({ error: 'Não foi possível carregar as pessoas da sala.' }, 500);
  }
  if (!ps || ps.length < 3) return json({ error: 'Precisa de pelo menos 3 pessoas.' }, 400);
  if (ps.some(p => !p.email)) return json({ error: 'Há participantes sem e-mail cadastrado. Atualize os perfis antes de sortear.' }, 400);
  const brevoKey = Deno.env.get('BREVO_API_KEY');
  const brevoSender = Deno.env.get('BREVO_SENDER');
  if (!brevoKey || !brevoSender) {
    console.error('BREVO_API_KEY or BREVO_SENDER is not configured');
    return json({ error: 'Configure BREVO_API_KEY e BREVO_SENDER nos Secrets das Edge Functions.' }, 500);
  }

  const { data: savedPairs, error: savedPairsError } = await db.from('assignments')
    .select('giver,receiver,email_sent_at').eq('room_id', room_id);
  if (savedPairsError) {
    console.error('Could not load saved draw assignments', savedPairsError.message);
    return json({ error: 'Não foi possível carregar o sorteio.' }, 500);
  }
  let pairs = savedPairs || [];
  if (pairs.length === 0) {
    if (room.drawn) return json({ error: 'O sorteio está fechado, mas não há pares salvos para reenviar.' }, 500);
    const o = [...ps];
    for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
    pairs = o.map((g, i) => ({ room_id, giver: g.id, receiver: o[(i + 1) % o.length].id, email_sent_at: null }));
    const { error } = await db.from('assignments').insert(pairs);
    if (error) {
      console.error('Could not save draw assignments', error.message);
      return json({ error: 'Não foi possível salvar o sorteio.' }, 500);
    }
  } else if (pairs.length !== ps.length) {
    console.error('Saved draw assignment count does not match the participant count');
    return json({ error: 'O sorteio salvo está incompleto. Verifique os logs da função draw.' }, 500);
  }
  const pendingPairs = pairs.filter(p => !p.email_sent_at);
  const previouslySent = pairs.length - pendingPairs.length;
  console.log('Draw email status', { participants: ps.length, pending: pendingPairs.length, previouslySent });
  if (!room.drawn) {
    const { error: drawUpdateError } = await db.from('rooms').update({ drawn: true }).eq('id', room_id);
    if (drawUpdateError) {
      console.error('Could not lock the room after saving draw assignments', drawUpdateError.message);
      return json({ error: 'Não foi possível fechar a lista da sala.' }, 500);
    }
  }

  const by = Object.fromEntries(ps.map(p => [p.id, p]));
  const money = (v: unknown) => (v ? `R$ ${e(v)}` : 'a combinar');
  const failed: string[] = [];
  let brevoStatus: number | null = null;
  let networkError = false;
  let accepted = 0;
  for (const { giver, receiver } of pendingPairs) {
    const g = by[giver], r = by[receiver];
    const links = safeLinks(r.product_links);
    const productLinks = links.length
      ? `<p><b>🔗 Links de produtos:</b></p><ul>${links.map(link => `<li><a href="${e(link)}">${e(link)}</a></li>`).join('')}</ul>`
      : '';
    const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;background:#fff8f2;border:3px solid #1f5c45;border-radius:24px;padding:24px;text-align:center;color:#4a2a2a">
      <h1 style="color:#b8243b">🎄 Oi, ${e(g.name)}!</h1><p>O sorteio de <b>${e(room.title)}</b> foi feito. Seu amigo oculto é:</p>
      ${r.photo_url ? `<img src="${e(r.photo_url)}" width="140" height="140" style="border-radius:50%;object-fit:cover;border:4px solid #1f5c45">` : '<div style="font-size:64px">🎅</div>'}
      <h2 style="color:#1f5c45;margin:8px 0">${e(r.name)}${r.age ? `, ${e(r.age)} anos` : ''}</h2>
      <p><b>💚 Gosta de:</b> ${e(r.likes) || '—'}</p><p><b>🎁 Quer ganhar:</b> ${e(r.wishes) || '—'}</p>${productLinks}
      <p style="background:#ffd9dc;border-radius:16px;padding:10px">💰 ${money(room.min_value)} a ${money(room.max_value)}<br>📅 ${e(room.event_date) || 'data a definir'} · 📍 ${e(room.location) || 'local a definir'}</p>
      <p>Shhh, é segredo! 🤫</p></div>`;
    let res: Response;
    try {
      res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': brevoKey, 'content-type': 'application/json' },
        body: JSON.stringify({ sender: { name: 'Amigo Oculto', email: brevoSender }, to: [{ email: g.email, name: g.name }], subject: `🎁 Seu amigo oculto: ${room.title}`, htmlContent: html }),
      });
    } catch (error) {
      networkError = true;
      failed.push(g.name);
      console.error('Network error calling Brevo', error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!res.ok) {
      failed.push(g.name);
      if (brevoStatus === null) brevoStatus = res.status;
      console.error('Brevo rejected an email request', { status: res.status });
      continue;
    }
    accepted++;
    console.log('Brevo accepted an email request', { status: res.status });
    const { error: sentUpdateError } = await db.from('assignments')
      .update({ email_sent_at: new Date().toISOString() }).eq('room_id', room_id).eq('giver', giver);
    if (sentUpdateError) {
      failed.push(g.name);
      console.error('Could not record successful email delivery', sentUpdateError.message);
    }
  }
  if (failed.length) return json({ sent: accepted, previously_sent: previouslySent, failed, brevo_status: brevoStatus, network_error: networkError });
  return json({ sent: accepted, previously_sent: previouslySent, failed, brevo_status: brevoStatus, network_error: networkError });
});
