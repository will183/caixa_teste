// =====================================================================
// Caixa da Igreja — front-end (HTML/CSS/JS puro + Supabase)
// =====================================================================

const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ----- Chaves do armazenamento local (funciona sem internet) -----
const FILA_KEY = 'caixa-fila-v1';           // vendas aguardando envio
const REJEITADAS_KEY = 'caixa-rejeitadas-v1'; // vendas que o servidor recusou
const CACHE_KEY = 'caixa-produtos-v1';      // catálogo para mostrar offline
const USUARIO_KEY = 'caixa-usuario-v1';     // perfil para abrir offline

// ----- Utilidades -----
const $ = id => document.getElementById(id);
const brl = c => (Number(c) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const centavos = s => {
  const n = parseFloat(String(s ?? '').trim().replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? 0 : Math.round(n * 100);
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const hojeSP = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // AAAA-MM-DD
const hora = iso => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
const lerJSON = (k, padrao) => { try { return JSON.parse(localStorage.getItem(k)) ?? padrao; } catch { return padrao; } };
const gravarJSON = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const isRede = e => e instanceof TypeError || /failed to fetch|network|load failed/i.test(e?.message || '');

function aviso(texto, tipo = 'erro') {
  const el = $('aviso');
  el.textContent = texto;
  el.className = 'aviso ' + tipo;
  clearTimeout(aviso._t);
  aviso._t = setTimeout(() => el.classList.add('hidden'), 6000);
}

// ----- Estado -----
let usuario = null;   // { id, nome, perfil, ativo }
let produtos = [];    // catálogo
let caixaAtual = null;
let carrinho = {};    // produto_id -> quantidade

const prod = id => produtos.find(p => p.id === Number(id));
const fila = () => lerJSON(FILA_KEY, []);
const pendentesQtd = id => fila().reduce((s, v) => s + (v.itens.find(i => i.produto_id === id)?.quantidade || 0), 0);
const estoqueDisponivel = p => p.estoque - pendentesQtd(p.id);

// =====================================================================
// LOGIN E SESSÃO
// =====================================================================
$('formLogin').addEventListener('submit', async e => {
  e.preventDefault();
  $('erroLogin').textContent = '';
  const { error } = await sb.auth.signInWithPassword({
    email: $('email').value.trim(),
    password: $('senha').value,
  });
  if (error) { console.error(error); $('erroLogin').textContent = 'Erro: ' + error.message; };
});

$('sair').onclick = async () => {
  if (fila().length && !confirm('Há vendas ainda não enviadas. Elas ficam salvas neste aparelho. Sair mesmo assim?')) return;
  await sb.auth.signOut();
};

// Evita chamar o Auth dentro do próprio callback (recomendação do supabase-js)
sb.auth.onAuthStateChange((_evento, sessao) => setTimeout(() => entrarComSessao(sessao), 0));

async function entrarComSessao(sessao) {
  if (!sessao) return mostrarLogin();

  let perfil = null;
  try {
    const { data, error } = await sb.from('perfis')
      .select('id, nome, perfil, ativo')
      .eq('id', sessao.user.id)
      .maybeSingle();
    if (error) throw error;
    perfil = data;
  } catch (e) {
    if (!isRede(e)) { console.error(e); aviso('Perfil: ' + e.message); return mostrarLogin(); }
    // sem internet: usa o último perfil conhecido deste aparelho
    perfil = lerJSON(USUARIO_KEY, null);
    if (!perfil) return mostrarLogin();
  }

  if (!perfil || !perfil.ativo) {
    aviso('Seu acesso não está liberado. Fale com o administrador.');
    return sb.auth.signOut();
  }

  usuario = perfil;
  gravarJSON(USUARIO_KEY, perfil);
  mostrarApp();
  await Promise.all([carregarProdutos(), carregarCaixa()]);
  sincronizarFila();
}

function mostrarLogin() {
  usuario = null;
  $('login').classList.remove('hidden');
  $('app').classList.add('hidden');
  $('sessao').classList.add('hidden');
}

function mostrarApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('sessao').classList.remove('hidden');
  $('usuarioInfo').textContent = usuario.nome + (usuario.perfil === 'admin' ? ' (admin)' : '');
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', usuario.perfil !== 'admin'));
  atualizarPendencias();
}

// =====================================================================
// ABAS
// =====================================================================
document.querySelectorAll('nav button').forEach(b => b.onclick = () => mostrarAba(b.dataset.aba));

function mostrarAba(aba) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('ativo', b.dataset.aba === aba));
  document.querySelectorAll('main section').forEach(s => s.classList.toggle('hidden', s.id !== 'aba-' + aba));
  if (aba === 'relatorio') carregarRelatorio();
  if (aba === 'caixa') carregarCaixa();
}

// =====================================================================
// PRODUTOS
// =====================================================================
async function carregarProdutos() {
  try {
    const { data, error } = await sb.from('produtos')
      .select('id, nome, preco, estoque, ativo')
      .order('nome');
    if (error) throw error;
    produtos = data;
    gravarJSON(CACHE_KEY, data);
  } catch (e) {
    produtos = lerJSON(CACHE_KEY, []);
    if (!produtos.length) aviso('Não foi possível carregar os itens.');
  }
  renderGrade();
  renderCarrinho();
  renderCadastro();
}

function renderGrade() {
  const ativos = produtos.filter(p => p.ativo);
  $('grade').innerHTML = ativos.map(p => {
    const disp = estoqueDisponivel(p);
    const esgotado = disp <= 0;
    return `<button class="prod ${esgotado ? 'esgotado' : ''}" ${esgotado ? 'disabled' : ''} data-id="${p.id}">
      <b>${esc(p.nome)}</b><span>${brl(p.preco)}</span>
      <small>${esgotado ? 'Esgotado' : 'Estoque: ' + disp}</small>
    </button>`;
  }).join('') || '<p class="pequeno">Nenhum item cadastrado.</p>';
}

$('grade').addEventListener('click', e => {
  const b = e.target.closest('.prod');
  if (b) adicionar(Number(b.dataset.id));
});

// =====================================================================
// VENDA
// =====================================================================
function adicionar(id) {
  const p = prod(id);
  const atual = carrinho[id] || 0;
  if (atual >= estoqueDisponivel(p)) return aviso(`Estoque insuficiente de "${p.nome}".`);
  carrinho[id] = atual + 1;
  renderCarrinho();
}

function ajustar(id, delta) {
  const p = prod(id);
  const nova = (carrinho[id] || 0) + delta;
  if (nova > estoqueDisponivel(p)) return aviso(`Estoque insuficiente de "${p.nome}".`);
  if (nova <= 0) delete carrinho[id]; else carrinho[id] = nova;
  renderCarrinho();
}

const totalCarrinho = () =>
  Object.entries(carrinho).reduce((s, [id, q]) => s + (prod(id)?.preco || 0) * q, 0);

function renderCarrinho() {
  const ids = Object.keys(carrinho);
  $('carrinho').innerHTML = ids.length ? ids.map(id => {
    const p = prod(id);
    if (!p) return '';
    return `<div class="linha">
      <div><b>${esc(p.nome)}</b><div class="pequeno">${brl(p.preco)} un.</div></div>
      <div class="qtd">
        <button data-d="-1" data-id="${id}">−</button>
        <b>${carrinho[id]}</b>
        <button data-d="1" data-id="${id}">+</button>
      </div>
      <b>${brl(p.preco * carrinho[id])}</b>
    </div>`;
  }).join('') : '<p class="pequeno">Toque nos produtos para adicionar.</p>';
  $('totalVenda').textContent = brl(totalCarrinho());
  atualizarTroco();
}

$('carrinho').addEventListener('click', e => {
  const b = e.target.closest('button[data-d]');
  if (b) ajustar(Number(b.dataset.id), Number(b.dataset.d));
});

function atualizarTroco() {
  const dinheiro = $('pagamento').value === 'dinheiro';
  $('areaDinheiro').classList.toggle('hidden', !dinheiro);
  const total = totalCarrinho();
  const rec = centavos($('recebido').value);
  $('troco').textContent = !dinheiro || !rec ? ''
    : rec >= total ? 'Troco: ' + brl(rec - total)
    : 'Faltam: ' + brl(total - rec);
}
$('pagamento').onchange = atualizarTroco;
$('recebido').oninput = atualizarTroco;

$('limpar').onclick = () => {
  if (!Object.keys(carrinho).length) return;
  if (!confirm('Limpar a venda atual?')) return;
  carrinho = {};
  $('recebido').value = '';
  renderCarrinho();
};

const erroVenda = msg => { $('erroVenda').textContent = msg; };

$('finalizar').onclick = async () => {
  erroVenda('');
  const itens = Object.entries(carrinho).map(([id, q]) => ({ produto_id: Number(id), quantidade: q }));
  const total = totalCarrinho();
  const pagamento = $('pagamento').value;
  const recebido = pagamento === 'dinheiro' ? centavos($('recebido').value) : total;

  if (!itens.length) return erroVenda('Adicione itens à venda.');
  if (recebido < total) return erroVenda('Valor recebido menor que o total.');
  if (!caixaAtual && navigator.onLine) return erroVenda('Abra o caixa antes de vender.');

  const venda = { uuid: crypto.randomUUID(), pagamento, recebido, itens, total };

  $('finalizar').disabled = true;
  try {
    const r = await enviarVenda(venda);
    if (r.rede) {
      enfileirar(venda);
      concluirVenda(venda, true);
    } else if (r.erro) {
      erroVenda(r.erro);
    } else {
      concluirVenda(venda, false);
    }
  } finally {
    $('finalizar').disabled = false;
  }
};

// Envia uma venda ao servidor. Retorna { dados } | { erro } | { rede: true }
async function enviarVenda(v) {
  try {
    const { data, error } = await sb.rpc('registrar_venda', {
      p_uuid: v.uuid,
      p_pagamento: v.pagamento,
      p_recebido: v.recebido,
      p_itens: v.itens,
    });
    if (error) return isRede(error) ? { rede: true } : { erro: error.message };
    return { dados: data };
  } catch (e) {
    return { rede: true };
  }
}

function concluirVenda(v, offline) {
  const troco = v.recebido - v.total;
  carrinho = {};
  $('recebido').value = '';
  renderCarrinho();
  renderGrade();

  if (offline) {
    aviso('Venda salva neste aparelho (sem internet). Será enviada quando a conexão voltar.', 'ok');
  } else {
    aviso('Venda registrada!' + (troco > 0 ? ' Troco: ' + brl(troco) : ''), 'ok');
    carregarProdutos();
  }
  atualizarPendencias();
}

// =====================================================================
// FILA OFFLINE
// =====================================================================
function enfileirar(venda) {
  gravarJSON(FILA_KEY, [...fila(), venda]);
  atualizarPendencias();
}

function atualizarPendencias() {
  const n = fila().length;
  $('pendencias').textContent = n ? `${n} venda(s) aguardando envio` : '';
  $('pendencias').classList.toggle('hidden', !n);
}

let sincronizando = false;
async function sincronizarFila() {
  if (sincronizando || !usuario || !navigator.onLine || !fila().length) return atualizarPendencias();
  sincronizando = true;
  const rejeitadas = lerJSON(REJEITADAS_KEY, []);
  try {
    while (true) {
      const atual = fila();
      if (!atual.length) break;
      const v = atual[0];
      const r = await enviarVenda(v);
      if (r.rede) break;                      // ainda sem conexão: tenta depois
      if (r.erro) {                            // o servidor recusou (ex.: estoque)
        rejeitadas.push({ ...v, motivo: r.erro, em: new Date().toISOString() });
      }
      // venda aceita ou recusada: sai da fila
      gravarJSON(FILA_KEY, fila().filter(x => x.uuid !== v.uuid));
    }
  } finally {
    gravarJSON(REJEITADAS_KEY, rejeitadas);
    sincronizando = false;
    atualizarPendencias();
  }
  if (rejeitadas.length) aviso(`${rejeitadas.length} venda(s) não foram aceitas pelo servidor. Veja no Relatório.`);
  carregarProdutos();
  carregarCaixa();
}

window.addEventListener('online', () => { aviso('Conexão restabelecida. Enviando vendas...', 'ok'); sincronizarFila(); });
setInterval(sincronizarFila, 60000);

// =====================================================================
// CAIXA
// =====================================================================
async function carregarCaixa() {
  try {
    const { data, error } = await sb.from('caixas')
      .select('*')
      .is('fechado_em', null)
      .maybeSingle();
    if (error) throw error;
    caixaAtual = data;
  } catch (e) {
    // sem internet: mantém o último estado conhecido
  }
  renderCaixa();
}

function renderCaixa() {
  $('caixaStatus').innerHTML = caixaAtual
    ? `<b>Caixa aberto</b><div class="pequeno">desde ${hora(caixaAtual.aberto_em)} · troco inicial ${brl(caixaAtual.saldo_inicial)}</div>`
    : `<b>Caixa fechado</b><div class="pequeno">Abra o caixa para começar a vender.</div>`;
  $('formAbrir').classList.toggle('hidden', !!caixaAtual);
  $('formFechar').classList.toggle('hidden', !caixaAtual);
}

$('formAbrir').onsubmit = async e => {
  e.preventDefault();
  const { error } = await sb.rpc('abrir_caixa', { p_saldo: centavos($('saldoInicial').value) });
  if (error) return aviso(error.message);
  $('saldoInicial').value = '';
  aviso('Caixa aberto!', 'ok');
  carregarCaixa();
};

$('formFechar').onsubmit = async e => {
  e.preventDefault();
  if (fila().length && !confirm('Há vendas aguardando envio. Fechar o caixa mesmo assim?')) return;
  const { data, error } = await sb.rpc('fechar_caixa', { p_contado: centavos($('contado').value) });
  if (error) return aviso(error.message);

  const dif = data.diferenca;
  const situacao = dif === 0 ? 'confere' : dif > 0 ? 'sobra' : 'falta';
  $('resultadoFechamento').innerHTML = `
    <p>Esperado em dinheiro: <b>${brl(data.esperado)}</b></p>
    <p>Contado: <b>${brl(data.saldo_contado)}</b></p>
    <p>Diferença: <b>${brl(dif)}</b> (${situacao})</p>`;
  $('contado').value = '';
  carregarCaixa();
};

// =====================================================================
// RELATÓRIO (admin)
// =====================================================================
$('dataRel').value = hojeSP();
$('dataRel').onchange = carregarRelatorio;
$('imprimir').onclick = () => window.print();

async function carregarRelatorio() {
  const dia = $('dataRel').value;
  const inicio = `${dia}T00:00:00-03:00`;                       // Brasil sem horário de verão
  const fim = new Date(new Date(inicio).getTime() + 86400000).toISOString();

  const [resumo, vendas] = await Promise.all([
    sb.rpc('relatorio_diario', { p_data: dia }),
    sb.from('vendas')
      .select('id, total, pagamento, status, criado_em, venda_itens(nome_produto, quantidade)')
      .gte('criado_em', inicio)
      .lt('criado_em', fim)
      .order('criado_em', { ascending: false }),
  ]);

  if (resumo.error) {
    $('relatorio').innerHTML = `<p class="erro">${esc(resumo.error.message)}</p>`;
    return;
  }

  const r = resumo.data;
  const forma = { dinheiro: 'Dinheiro', pix: 'Pix', cartao: 'Cartão' };
  const admin = usuario?.perfil === 'admin';

  let html = `
    <h2>Relatório de caixa</h2>
    <p class="pequeno">Data: ${dia.split('-').reverse().join('/')}</p>
    <table>
      <tr><th>Total arrecadado</th><th class="r">${brl(r.total_arrecadado)}</th></tr>
      <tr><td>Vendas concluídas</td><td class="r">${r.quantidade_vendas}</td></tr>
      <tr><td>Vendas canceladas</td><td class="r">${r.canceladas}</td></tr>
    </table>

    <h3>Por forma de pagamento</h3>
    <table>${(r.por_pagamento || []).map(p =>
      `<tr><td>${forma[p.pagamento] || esc(p.pagamento)}</td><td class="r">${brl(p.total)}</td></tr>`).join('')
      || '<tr><td class="pequeno">Sem vendas.</td></tr>'}</table>

    <h3>Por item</h3>
    <table><tr><th>Item</th><th class="r">Qtd</th><th class="r">Valor</th></tr>
    ${(r.por_item || []).map(i =>
      `<tr><td>${esc(i.nome)}</td><td class="r">${i.quantidade}</td><td class="r">${brl(i.valor)}</td></tr>`).join('')}
    </table>

    <h3>Vendas</h3>
    <table>${(vendas.data || []).map(v => `
      <tr class="${v.status === 'cancelada' ? 'cancelada' : ''}">
        <td>${hora(v.criado_em)}</td>
        <td>${(v.venda_itens || []).map(i => i.quantidade + 'x ' + esc(i.nome_produto)).join(', ')}
            <div class="pequeno">${forma[v.pagamento] || v.pagamento}${v.status === 'cancelada' ? ' · CANCELADA' : ''}</div></td>
        <td class="r">${brl(v.total)}</td>
        <td class="noprint">${admin && v.status === 'concluida'
          ? `<button class="x" data-cancelar="${v.id}">cancelar</button>` : ''}</td>
      </tr>`).join('') || '<tr><td class="pequeno">Nenhuma venda nesta data.</td></tr>'}
    </table>`;

  const rejeitadas = lerJSON(REJEITADAS_KEY, []);
  if (rejeitadas.length) {
    html += `
      <h3>Vendas não aceitas pelo servidor</h3>
      <table>${rejeitadas.map(v =>
        `<tr><td>${hora(v.em)}</td><td>${esc(v.motivo)}</td><td class="r">${brl(v.total)}</td></tr>`).join('')}
      </table>
      <button class="btn sec noprint" id="limparRejeitadas">Dispensar esta lista</button>`;
  }

  $('relatorio').innerHTML = html;
}

$('relatorio').addEventListener('click', async e => {
  if (e.target.id === 'limparRejeitadas') {
    if (!confirm('Dispensar a lista de vendas não aceitas? Confira os valores antes.')) return;
    localStorage.removeItem(REJEITADAS_KEY);
    return carregarRelatorio();
  }

  const b = e.target.closest('[data-cancelar]');
  if (!b) return;
  if (!confirm('Cancelar esta venda? Os itens voltam ao estoque.')) return;

  const { error } = await sb.rpc('cancelar_venda', { p_venda: Number(b.dataset.cancelar) });
  if (error) return aviso(error.message);
  aviso('Venda cancelada e estoque devolvido.', 'ok');
  carregarRelatorio();
  carregarProdutos();
});

// =====================================================================
// CADASTRO (admin)
// =====================================================================
function renderCadastro() {
  if (usuario?.perfil !== 'admin') return;
  $('listaCadastro').innerHTML = produtos.map(p => `
    <div class="linha">
      <div>
        <b>${esc(p.nome)}</b> — ${brl(p.preco)}
        <div class="estq ${p.estoque <= 2 ? 'baixo' : ''}">Estoque: ${p.estoque}${p.ativo ? '' : ' · inativo'}</div>
      </div>
      <div class="acoes">
        <button class="pequeno-btn" data-acao="estoque" data-id="${p.id}">+ estoque</button>
        <button class="pequeno-btn" data-acao="preco" data-id="${p.id}">preço</button>
        <button class="pequeno-btn" data-acao="ativo" data-id="${p.id}">${p.ativo ? 'desativar' : 'ativar'}</button>
      </div>
    </div>`).join('') || '<p class="pequeno">Nenhum item cadastrado.</p>';
}

$('listaCadastro').addEventListener('click', async e => {
  const b = e.target.closest('[data-acao]');
  if (!b) return;
  const p = prod(b.dataset.id);
  if (!p) return;

  let r;
  if (b.dataset.acao === 'estoque') {
    const q = parseInt(prompt(`Quantas unidades de "${p.nome}" entraram? (use número negativo para baixa ou quebra)`, '1'), 10);
    if (!q) return;
    r = await sb.rpc('movimentar_estoque', { p_produto: p.id, p_quantidade: q });
  } else if (b.dataset.acao === 'preco') {
    const v = centavos(prompt(`Novo valor para "${p.nome}" (R$):`, (p.preco / 100).toFixed(2).replace('.', ',')));
    if (v <= 0) return;
    r = await sb.rpc('atualizar_produto', { p_id: p.id, p_nome: p.nome, p_preco: v, p_ativo: p.ativo });
  } else {
    r = await sb.rpc('atualizar_produto', { p_id: p.id, p_nome: p.nome, p_preco: p.preco, p_ativo: !p.ativo });
  }

  if (r.error) return aviso(r.error.message);
  aviso('Salvo.', 'ok');
  carregarProdutos();
});

$('formProduto').onsubmit = async e => {
  e.preventDefault();
  const { error } = await sb.rpc('cadastrar_produto', {
    p_nome: $('pNome').value.trim(),
    p_preco: centavos($('pPreco').value),
    p_estoque: parseInt($('pEstoque').value || '0', 10),
  });
  if (error) return aviso(error.message);
  e.target.reset();
  $('pEstoque').value = '0';
  aviso('Item cadastrado.', 'ok');
  carregarProdutos();
};
