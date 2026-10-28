/**
 * Liê — atendente do Ateliê Web.
 *
 * Esta função roda no Firebase. Sempre que um visitante manda mensagem no
 * chat do site (coleção "conversas/{id}/mensagens", campo de = "visitante"),
 * ela lê a conversa, pergunta ao Claude e grava a resposta da Liê na mesma
 * conversa (de = "lie"). O CRM e o site mostram a resposta na hora.
 *
 * A Liê fica quieta quando:
 *   - config/lie.ativa == false   (botão geral no CRM)
 *   - conversas/{id}.liePausada == true   (você assumiu a conversa)
 */
const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const Anthropic = require("@anthropic-ai/sdk");

admin.initializeApp();
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

// ---------- ajustes rápidos ----------
const MODELO = "claude-sonnet-5-5";   // troque por "claude-haiku-5-5" para ficar mais barato
const ESPERA_MS = 3500;               // espera o visitante terminar de digitar antes de responder
const MAX_MSGS = 40;                  // quantas mensagens da conversa a Liê lê

const INSTRUCOES = `Você é a Liê, atendente do Ateliê Web no chat do site. Você conversa com visitantes que podem virar clientes.

QUEM É O ATELIÊ WEB
Desenvolvimento de sistemas e ferramentas sob encomenda:
- Sites institucionais e landing pages (quem somos, portfólio, contato, botão de WhatsApp)
- Sistemas de gestão na web: CRM, controle de propostas, controles internos
- Apps de agendamento (ex.: barbearia, clínica)
- Painéis e dashboards de resultados
- Ferramentas para equipes de vendas
- Agentes de IA para atendimento no WhatsApp
Como funciona: conversa inicial gratuita, proposta formal com escopo, prazo e valor, prévia visual clicável antes de programar, desenvolvimento e publicação, suporte depois da entrega.
Valores: dependem do escopo e vêm na proposta formal. Nunca dê preço, nem faixa.
Prazo para enviar a proposta, horário de atendimento e formas de pagamento: ainda não confirmados. Não informe; diga que a Juliana confirma.

JEITO DE FALAR (soar como uma pessoa de verdade da equipe)
- Português do dia a dia de alguém simpático do Rio: "pra", "tá", "tô", "beleza", "show", "perfeito". Nada de linguagem de empresa ("prezado", "informamos", "estamos à disposição").
- MENOS TEXTO SEMPRE: cada mensagem com 1 ou 2 linhas. No máximo 2 mensagens seguidas, separadas por uma linha em branco. Nunca mande listas nem parágrafos.
- Use o nome da pessoa quando souber, sem exagerar. Reaja ao que ela contou antes de perguntar.
- Varie as palavras. Emoji só de vez em quando, no máximo um por mensagem.
- O site já mostrou ao visitante a saudação "Oi! Aqui é a Liê, do Ateliê Web 😊 Me conta, o que você precisa?". Não se apresente de novo.
- Não diga que é assistente virtual, robô ou IA por conta própria. Mas nunca minta: se perguntarem de verdade se é robô ou IA, diga com leveza que sim, que é a assistente do Ateliê e que a Juliana acompanha tudo, e ofereça chamar ela.

CHAMADA PARA AÇÃO (o mais importante)
- O visitante tem preguiça de processo. Poucas perguntas, fáceis, e ele pode responder numa frase só.
- Quando ele mostrar interesse, responda a dúvida numa frase e já puxe a proposta com UMA pergunta: o nome dele e o que ele quer que o projeto faça. Se ele já contou o que precisa, pergunte só o nome.
- Depois, UMA pergunta de complemento: o WhatsApp dele pra mandar a proposta, e se tem prazo ou alguma observação. Ex.: "Show! Me passa seu WhatsApp pra eu te mandar a proposta? E se tiver prazo ou alguma observação, já manda junto."
- Não pergunte sobre investimento. Se ele falar sozinho, registre.
- Nunca faça mais de 2 perguntas antes de registrar. Se ele pular algo, registre com o que tiver.
- Assim que tiver o nome e o que a pessoa precisa, e a segunda pergunta tiver sido feita (respondida ou não), use registrar_pedido. Depois confirme numa frase curta que a Juliana vai mandar a proposta.
- Assim que souber o nome da pessoa, use anotar_nome.

QUANDO CHAMAR A JULIANA (chamar_juliana)
- A pessoa pediu pra falar com alguém, ficou irritada, quer fechar contrato ou pagar, ou perguntou algo que você não sabe.
- Depois de chamar, diga numa frase que a Juliana vai responder por aqui em breve. Depois disso você não responde mais nessa conversa.

As mensagens marcadas com [Juliana] foram escritas pela Juliana, dona do Ateliê. Siga o que ela combinou.
Se o assunto não tiver nada a ver com o Ateliê Web, responda com gentileza e traga a conversa de volta.
Use as ferramentas em silêncio: não escreva nada antes de usá-las e não fale o nome delas.`;

const FERRAMENTAS = [
  {
    name: "anotar_nome",
    description: "Guarda o nome do visitante para aparecer na lista de conversas do CRM. Use assim que souber o nome.",
    input_schema: { type: "object", properties: { nome: { type: "string" } }, required: ["nome"] },
  },
  {
    name: "registrar_pedido",
    description: "Registra o pedido de orçamento na aba Pedidos do site do CRM. Use quando souber o nome e o que a pessoa precisa. Retorna ok.",
    input_schema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "Nome do cliente" },
        empresa: { type: "string", description: "Nome do negócio, se informado" },
        whatsapp: { type: "string", description: "WhatsApp com DDD, se informado" },
        email: { type: "string", description: "E-mail, se informado" },
        tipo: { type: "string", description: "Tipo de projeto: site, sistema de gestão, app de agendamento, agente de WhatsApp, painel, outro" },
        descricao: { type: "string", description: "O que o cliente precisa, em uma ou duas frases" },
        prazo: { type: "string", description: "Prazo desejado, se informado" },
        observacoes: { type: "string", description: "Observações, referências, o que não pode faltar" },
        investimento: { type: "string", description: "Faixa de investimento, só se o cliente falou" },
      },
      required: ["nome", "tipo", "descricao"],
    },
  },
  {
    name: "chamar_juliana",
    description: "Avisa a Juliana para assumir a conversa e pausa a Liê nela. Use quando a pessoa pedir alguém, estiver insatisfeita, quiser fechar ou pagar, ou você não souber responder.",
    input_schema: {
      type: "object",
      properties: { motivo: { type: "string", description: "Por que chamar, em poucas palavras" } },
      required: ["motivo"],
    },
  },
];

const s = (v, max = 500) => (v == null ? "" : String(v).trim().slice(0, max));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Monta a conversa no formato do Claude: visitante = user; Liê e Juliana = assistant.
function montarHistorico(docs) {
  const out = [];
  for (const d of docs) {
    const m = d.data();
    const texto = s(m.texto, 2000);
    if (!texto) continue;
    const role = m.de === "visitante" ? "user" : "assistant";
    const conteudo = m.de === "atelie" ? `[Juliana] ${texto}` : texto;
    const ult = out[out.length - 1];
    if (ult && ult.role === role) ult.content += "\n" + conteudo;
    else out.push({ role, content: conteudo });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

async function executarFerramenta(nome, entrada, ctx) {
  const ref = db.collection("conversas").doc(ctx.cid);
  if (nome === "anotar_nome") {
    const n = s(entrada.nome, 80);
    if (!n) throw new Error("nome vazio");
    await ref.update({ nome: n });
    return { ok: true };
  }
  if (nome === "registrar_pedido") {
    const n = s(entrada.nome, 100);
    const tipo = s(entrada.tipo, 80);
    const desc = s(entrada.descricao, 1500);
    if (!n || !tipo || !desc) throw new Error("Faltam dados: nome, tipo e descrição.");
    if (ctx.pedidoId) {
      // já registrado nesta conversa: atualiza em vez de duplicar
      await db.collection("pedidos").doc(ctx.pedidoId).set(montarPedido(entrada, ctx), { merge: true });
      return { ok: true, atualizado: true };
    }
    const doc = await db.collection("pedidos").add({ ...montarPedido(entrada, ctx), status: "novo", criadoEm: FV.serverTimestamp() });
    ctx.pedidoId = doc.id;
    await ref.update({ pedidoId: doc.id, nome: n, interesse: tipo });
    return { ok: true };
  }
  if (nome === "chamar_juliana") {
    ctx.chamou = true;
    await ref.update({ liePausada: true, pendente: true, lieMotivo: s(entrada.motivo, 140) });
    return { ok: true, aviso: "A Juliana foi avisada. Diga ao visitante que ela responde por aqui em breve." };
  }
  throw new Error("ferramenta desconhecida");
}

function montarPedido(e, ctx) {
  const linhas = [
    s(e.descricao, 1500),
    e.prazo ? `Prazo: ${s(e.prazo, 200)}` : "",
    e.observacoes ? `Observações: ${s(e.observacoes, 800)}` : "",
    e.investimento ? `Investimento: ${s(e.investimento, 200)}` : "",
    "Origem: chat do site (Liê)",
  ].filter(Boolean);
  return {
    nome: s(e.nome, 100),
    empresa: s(e.empresa, 100),
    whatsapp: s(e.whatsapp, 30),
    email: s(e.email, 120),
    tipo: s(e.tipo, 80),
    mensagem: linhas.join("\n").slice(0, 3000),
    origem: "lie",
    conversaId: ctx.cid,
  };
}

exports.lieResponde = functions
  .runWith({ secrets: ["ANTHROPIC_API_KEY"], timeoutSeconds: 120, maxInstances: 10 })
  .firestore.document("conversas/{cid}/mensagens/{mid}")
  .onCreate(async (snap, context) => {
    const msg = snap.data() || {};
    if (msg.de !== "visitante") return;
    const cid = context.params.cid;
    const convRef = db.collection("conversas").doc(cid);

    // Liê ligada?
    const cfg = await db.doc("config/lie").get();
    if (cfg.exists && cfg.data().ativa === false) return;

    // Espera o visitante terminar de mandar mensagens seguidas; só a última responde.
    await dormir(ESPERA_MS);
    const ultima = await convRef.collection("mensagens").orderBy("em", "desc").limit(1).get();
    if (ultima.empty || ultima.docs[0].id !== snap.id) return;

    const conv = await convRef.get();
    if (!conv.exists) return;
    const c = conv.data();
    if (c.liePausada) return;

    const hist = await convRef.collection("mensagens").orderBy("em", "desc").limit(MAX_MSGS).get();
    const mensagens = montarHistorico(hist.docs.reverse());
    if (!mensagens.length) return;

    const ctx = { cid, pedidoId: c.pedidoId || null, chamou: false };
    await convRef.update({ digitando: true });

    try {
      const cliente = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
      const sistema = `${INSTRUCOES}\n\nAgora: ${agora}.${ctx.pedidoId ? "\nO pedido desta conversa já foi registrado. Se surgir informação nova, use registrar_pedido de novo para atualizar." : ""}`;

      let resposta = "";
      for (let rodada = 0; rodada < 4; rodada++) {
        const r = await cliente.messages.create({
          model: MODELO,
          max_tokens: 600,
          system: sistema,
          tools: FERRAMENTAS,
          messages: mensagens,
        });
        const textos = r.content.filter((b) => b.type === "text").map((b) => b.text.trim()).filter(Boolean);
        if (r.stop_reason !== "tool_use") { resposta = textos.join("\n\n"); break; }

        mensagens.push({ role: "assistant", content: r.content });
        const resultados = [];
        for (const b of r.content) {
          if (b.type !== "tool_use") continue;
          let conteudo, erro = false;
          try { conteudo = JSON.stringify(await executarFerramenta(b.name, b.input || {}, ctx)); }
          catch (e) { conteudo = "Erro: " + e.message; erro = true; }
          resultados.push({ type: "tool_result", tool_use_id: b.id, content: conteudo, is_error: erro });
        }
        mensagens.push({ role: "user", content: resultados });
      }

      // Se o visitante mandou outra mensagem enquanto a Liê pensava, deixa a próxima rodada responder.
      const depois = await convRef.collection("mensagens").orderBy("em", "desc").limit(1).get();
      if (!depois.empty && depois.docs[0].id !== snap.id && depois.docs[0].data().de === "visitante") {
        await convRef.update({ digitando: false });
        return;
      }

      const partes = resposta.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).slice(0, 3);
      for (let i = 0; i < partes.length; i++) {
        if (i > 0) await dormir(Math.min(2500, 600 + partes[i].length * 20));
        await convRef.collection("mensagens").add({ de: "lie", texto: partes[i].slice(0, 2000), em: FV.serverTimestamp() });
      }
      const fim = { digitando: false, atualizadoEm: FV.serverTimestamp() };
      if (partes.length) fim.ultimaMsg = ("Liê: " + partes[partes.length - 1]).slice(0, 140);
      if (!ctx.chamou) fim.pendente = false;
      await convRef.update(fim);
    } catch (e) {
      console.error("Liê falhou", cid, e);
      // Deixa a conversa marcada para a Juliana responder.
      await convRef.update({ digitando: false, pendente: true, lieErro: s(e.message, 200) });
    }
  });
