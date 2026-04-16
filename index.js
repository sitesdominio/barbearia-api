require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');

// ─── Validação de Variáveis de Ambiente ────────────────────────────────────
const REQUIRED_VARS = ['API_KEY', 'FIREBASE_SERVICE_ACCOUNT'];
const missing = REQUIRED_VARS.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error('❌ ERRO: Variáveis de ambiente obrigatórias não configuradas:');
  missing.forEach(v => console.error(`   → ${v}`));
  console.error('\nConfigure essas variáveis no Easypainel > seu app > Environment.');
  console.error('Veja o arquivo .env.example para referência.\n');
  process.exit(1);
}

// ─── Firebase Admin Init ───────────────────────────────────────────────────
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  console.error('❌ ERRO: FIREBASE_SERVICE_ACCOUNT não é um JSON válido.');
  console.error('   Cole o conteúdo completo do arquivo de Service Account do Firebase.');
  console.error('   Certifique-se de que é um JSON puro, sem aspas extras ao redor.\n');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ─── Configurações da Barbearia ────────────────────────────────────────────
const CONFIG = {
  OPEN_H:   9,
  CLOSE_H:  19,
  INTERVAL: 30,
  BARBERS:  ['Pedro', 'Lucas'],
  SERVICES: {
    corte:       { nome: 'Corte de Cabelo', preco: 45, duracao: 30 },
    barba:       { nome: 'Barba',           preco: 35, duracao: 30 },
    corte_barba: { nome: 'Corte + Barba',   preco: 75, duracao: 60 },
    sobrancelha: { nome: 'Sobrancelha',     preco: 20, duracao: 15 },
  },
};

function toMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function toTime(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

async function getOcupados(dateStr, barbeiro) {
  const snap = await db.collection('agendamentos')
    .where('data', '==', dateStr)
    .where('barbeiro', '==', barbeiro)
    .get();

  const ocupados = new Set();
  snap.forEach(doc => {
    const ag = doc.data();
    if (ag.status === 'cancelado') return;
    const start = toMin(ag.horario);
    const dur   = ag.duracao || 30;
    for (let t = start; t < start + dur; t += 30) {
      ocupados.add(toTime(t));
    }
  });
  return ocupados;
}

function gerarSlots(ocupados, duracao, dateStr) {
  const slots   = [];
  const now     = new Date();
  const isToday = dateStr === now.toISOString().split('T')[0];
  const nowMin  = now.getHours() * 60 + now.getMinutes() + 30;

  for (let t = CONFIG.OPEN_H * 60; t <= CONFIG.CLOSE_H * 60 - duracao; t += CONFIG.INTERVAL) {
    const timeStr = toTime(t);
    let blocked = false;
    for (let d = 0; d < duracao; d += 30) {
      if (ocupados.has(toTime(t + d))) { blocked = true; break; }
    }
    if (isToday && t <= nowMin) blocked = true;
    if (!blocked) slots.push(timeStr);
  }
  return slots;
}

// ─── App ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Health check público (sem autenticação) — para Easypainel e N8N
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Middleware de autenticação por API Key
app.use((req, res, next) => {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ erro: 'Não autorizado. Informe x-api-key válida.' });
  }
  next();
});

// GET /servicos
app.get('/servicos', (req, res) => {
  const lista = Object.entries(CONFIG.SERVICES).map(([id, s]) => ({
    id, nome: s.nome, preco: s.preco, duracao: s.duracao,
  }));
  res.json({ barbeiros: CONFIG.BARBERS, servicos: lista });
});

// GET /horarios-disponiveis?data=YYYY-MM-DD&servico=corte&barbeiro=Pedro
app.get('/horarios-disponiveis', async (req, res) => {
  const { data, servico, barbeiro } = req.query;

  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data))
    return res.status(400).json({ erro: 'Informe data no formato YYYY-MM-DD.' });
  if (!servico || !CONFIG.SERVICES[servico])
    return res.status(400).json({ erro: 'Informe um serviço válido.', opcoes: Object.keys(CONFIG.SERVICES) });

  const dateObj = new Date(data + 'T00:00:00');
  if (dateObj.getDay() === 0)
    return res.json({ data, fechado: true, motivo: 'Domingo — barbearia fechada.' });

  const { duracao, nome } = CONFIG.SERVICES[servico];
  const barbeiros = barbeiro ? [barbeiro] : CONFIG.BARBERS;

  for (const b of barbeiros) {
    if (!CONFIG.BARBERS.includes(b))
      return res.status(400).json({ erro: `Barbeiro inválido: ${b}. Use: ${CONFIG.BARBERS.join(', ')}.` });
  }

  const resultado = {};
  for (const b of barbeiros) {
    const ocupados = await getOcupados(data, b);
    resultado[b]   = gerarSlots(ocupados, duracao, data);
  }

  res.json({ data, servico: { id: servico, nome, duracao }, barbeiros: resultado });
});

// POST /agendamento
app.post('/agendamento', async (req, res) => {
  const { cliente, telefone, servico, barbeiro, data, horario, observacao } = req.body;

  if (!cliente)  return res.status(400).json({ erro: 'Campo obrigatório: cliente.' });
  if (!telefone) return res.status(400).json({ erro: 'Campo obrigatório: telefone.' });
  if (!servico || !CONFIG.SERVICES[servico])
    return res.status(400).json({ erro: 'Serviço inválido.', opcoes: Object.keys(CONFIG.SERVICES) });
  if (!barbeiro || !CONFIG.BARBERS.includes(barbeiro))
    return res.status(400).json({ erro: `Barbeiro inválido. Use: ${CONFIG.BARBERS.join(', ')}.` });
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data))
    return res.status(400).json({ erro: 'Informe data no formato YYYY-MM-DD.' });
  if (!horario || !/^\d{2}:\d{2}$/.test(horario))
    return res.status(400).json({ erro: 'Informe horario no formato HH:MM.' });

  const dateObj = new Date(data + 'T00:00:00');
  if (dateObj.getDay() === 0)
    return res.status(400).json({ erro: 'Barbearia fechada aos domingos.' });

  const { duracao, nome: servicoNome, preco } = CONFIG.SERVICES[servico];
  const newStart = toMin(horario);
  const newEnd   = newStart + duracao;

  if (newStart < CONFIG.OPEN_H * 60 || newEnd > CONFIG.CLOSE_H * 60)
    return res.status(400).json({
      erro: `Horário fora do expediente. Atendemos das ${toTime(CONFIG.OPEN_H * 60)} às ${toTime(CONFIG.CLOSE_H * 60)}.`,
    });

  const snap = await db.collection('agendamentos')
    .where('data', '==', data)
    .where('barbeiro', '==', barbeiro)
    .get();

  let conflito = false;
  snap.forEach(doc => {
    const ag = doc.data();
    if (ag.status === 'cancelado') return;
    const s = toMin(ag.horario);
    const e = s + (ag.duracao || 30);
    if (newStart < e && newEnd > s) conflito = true;
  });

  if (conflito) {
    const ocupados       = await getOcupados(data, barbeiro);
    const horariosLivres = gerarSlots(ocupados, duracao, data);
    return res.status(409).json({
      sucesso: false,
      erro: 'Horário indisponível. Escolha outro horário.',
      horariosLivres,
    });
  }

  const agendamento = {
    cliente, telefone, servico,
    servico_nome: servicoNome,
    barbeiro, data, horario, duracao, preco,
    status:     'confirmado',
    observacao: observacao || '',
    criado_em:  new Date().toISOString(),
    origem:     'whatsapp',
  };

  const docRef = await db.collection('agendamentos').add(agendamento);
  res.status(201).json({ sucesso: true, id: docRef.id, agendamento });
});

// GET /agendamentos?data=YYYY-MM-DD&barbeiro=Pedro
app.get('/agendamentos', async (req, res) => {
  const { data, barbeiro } = req.query;

  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data))
    return res.status(400).json({ erro: 'Informe data no formato YYYY-MM-DD.' });

  let query = db.collection('agendamentos').where('data', '==', data);
  if (barbeiro) query = query.where('barbeiro', '==', barbeiro);

  const snap = await query.get();
  const lista = snap.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(a => a.status !== 'cancelado')
    .sort((a, b) => a.horario.localeCompare(b.horario));

  res.json({ data, total: lista.length, agendamentos: lista });
});

// PATCH /agendamento/:id/cancelar
app.patch('/agendamento/:id/cancelar', async (req, res) => {
  const { id } = req.params;
  const docRef = db.collection('agendamentos').doc(id);
  const snap   = await docRef.get();

  if (!snap.exists)
    return res.status(404).json({ erro: 'Agendamento não encontrado.' });

  const ag = snap.data();
  if (ag.status === 'cancelado')
    return res.status(400).json({ erro: 'Agendamento já está cancelado.' });

  await docRef.update({ status: 'cancelado', cancelado_em: new Date().toISOString() });
  res.json({ sucesso: true, mensagem: 'Agendamento cancelado com sucesso.' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Erro interno:', err);
  res.status(500).json({ erro: 'Erro interno do servidor.', detalhe: err.message });
});

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Barbearia API rodando na porta ${PORT}`);
  console.log(`   Barbeiros: ${CONFIG.BARBERS.join(', ')}`);
  console.log(`   Serviços:  ${Object.keys(CONFIG.SERVICES).join(', ')}`);
  console.log(`   Horário:   ${toTime(CONFIG.OPEN_H * 60)} - ${toTime(CONFIG.CLOSE_H * 60)}`);
});
