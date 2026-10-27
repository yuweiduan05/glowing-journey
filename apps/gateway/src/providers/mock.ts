/**
 * 确定性 Mock 模型（MODEL_PROVIDER=mock）
 *
 * 为什么需要它：路线规划 6.1 把「模型 Key / 网络在演示现场失效」列为致命风险，
 * 兜底方案是「本地 mock 模型 + 预置录屏」。本实现让整条链路（SSE、tool_calls、
 * 多轮编排、汇总）在没有 Key 的情况下也能真实跑通，而不是前端假数据。
 *
 * 它按规则模拟模型的三个动作：选工具 → 读工具结果 → 生成回复。
 * 换成真实供应商后，这段逻辑不在链路上（由模型自行决定）。
 */
import type { ChatMessage } from '@app/shared';
import { estimateUsage, type ModelChunk, type ModelInvoker, type ModelRequest, type ToolCall } from './types.js';

const SKU_RE = /SKU-[A-Z0-9]{6}/g;
const ORDER_RE = /SO-\d{8}-\d{3}/g;
const PHONE_RE = /尾号\s*(\d{4})/;

const WAREHOUSE_WORDS: Array<[RegExp, string]> = [
  [/深圳|SZ/i, 'WH-SZ'],
  [/广州|GZ/i, 'WH-GZ'],
  [/上海|SH/i, 'WH-SH'],
];

const TICKET_WORDS = /(建|开|提|下).{0,4}工单|少发|缺件|漏发|破损|坏了|投诉|售后/;
const KNOWLEDGE_WORDS =
  /保修|质保|换货|退货|政策|条款|参数|规格|说明书|怎么|如何|多久|流程|支持|发票|开票|培训|安装/;

interface ToolResultPayload {
  name: string;
  data: Record<string, unknown>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function findWarehouse(text: string): string | undefined {
  for (const [re, code] of WAREHOUSE_WORDS) if (re.test(text)) return code;
  return undefined;
}

function lastMatch(text: string, re: RegExp): string | undefined {
  const all = [...text.matchAll(re)].map((m) => m[0]);
  return all.length ? all[all.length - 1] : undefined;
}

function collectToolResults(messages: ChatMessage[]): ToolResultPayload[] {
  // 从最后一条 user 消息之后收集工具结果
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      start = i;
      break;
    }
  }
  const out: ToolResultPayload[] = [];
  for (let i = start; i < messages.length; i += 1) {
    const m = messages[i]!;
    if (m.role === 'tool' && m.content) {
      try {
        out.push({ name: m.name ?? 'unknown', data: JSON.parse(m.content) as Record<string, unknown> });
      } catch {
        /* 忽略不可解析的结果 */
      }
    }
  }
  return out;
}

function planToolCalls(messages: ChatMessage[]): { calls: ToolCall[]; note: string } {
  const userMessages = messages.filter((m) => m.role === 'user').map((m) => m.content ?? '');
  const latest = userMessages[userMessages.length - 1] ?? '';
  // 附件正文不参与意图判断：否则「总结这个附件」会因为文件里恰好有 SKU 被当成库存查询。
  // 实体抽取也优先只看提问；只有明确提到「库存 / 型号 / 这些数据」时才从附件里找。
  const askText = latest.split('【附件：')[0]?.trim() || latest;
  const history = userMessages.map((t) => t.split('【附件：')[0] ?? t).join('\n');
  const results = collectToolResults(messages);

  // 第二轮起：拿到工具结果后决定是否继续调用（多工具链式）
  if (results.length > 0) {
    const inv = results.find((r) => r.name === 'query_inventory');
    const hasTicket = results.some((r) => r.name === 'create_ticket');
    const wantsTicket = TICKET_WORDS.test(askText);
    const belowSafety = Boolean(inv?.data.below_safety);
    const sku = inv?.data.sku as string | undefined;

    if (inv && wantsTicket && belowSafety && !hasTicket && sku) {
      return {
        calls: [
          {
            id: `call_${Math.random().toString(36).slice(2, 10)}`,
            name: 'create_ticket',
            arguments: JSON.stringify({
              category: 'LOGISTICS',
              severity: 'S3',
              summary: `${sku} 可用库存为 ${inv.data.available} 件，低于安全库存 ${inv.data.safety_stock} 件，客户要求补货并确认交期。`,
              sku,
            }),
          },
        ],
        note: '库存不足，按业务规则转售后建单',
      };
    }
    return { calls: [], note: '汇总工具结果' };
  }

  // 实体抽取以「本轮问题」为主，只有追问或建单才回退到历史：
  // 否则先问库存、再问保修时，会把上一轮的 SKU 又查一遍，
  // 回答里平白多出一段库存结论（看起来像答非所问）。
  const contextual = TICKET_WORDS.test(askText) || /它|这个|那个|该型号|这货|还有|顺便|再|呢/.test(askText);
  const explicitSku = lastMatch(askText, SKU_RE) ?? (contextual ? lastMatch(history, SKU_RE) : undefined);
  let skus: string[] = explicitSku ? [explicitSku] : [];
  // 「这些 SKU 库存够吗」：提问里没有具体型号时，把附件里的 SKU 各查一次（最多 3 个），
  // 只查最后一个会让人以为附件里只有一个型号。
  if (!skus.length && /库存|SKU|型号|这些数据/i.test(askText)) {
    skus = [...new Set([...latest.matchAll(SKU_RE)].map((m) => m[0]))].slice(0, 3);
  }
  const sku = skus[0];
  const orderNo = lastMatch(askText, ORDER_RE) ?? (contextual ? lastMatch(history, ORDER_RE) : undefined);
  const tail = askText.match(PHONE_RE)?.[1];
  const warehouse = findWarehouse(askText);
  const id = () => `call_${Math.random().toString(36).slice(2, 10)}`;

  // 1) 建工单优先（写操作，独占一轮，不与其他工具混发）
  if (TICKET_WORDS.test(askText) && (orderNo || sku)) {
    const category = /少发|缺件|漏发|物流|没收到/.test(askText)
      ? 'LOGISTICS'
      : /破损|坏|质量/.test(latest)
        ? 'QUALITY'
        : /退/.test(latest)
          ? 'RETURN'
          : 'OTHER';
    const summary = orderNo
      ? `客户反馈订单 ${orderNo} ${/少发|缺件|漏发/.test(askText) ? '存在少发件，需补发并给出处理时效' : '存在售后问题，需人工跟进处理'}。`
      : `客户反馈 ${sku} 存在售后问题，需核实批次并给出处理方案。`;
    return {
      calls: [
        {
          id: id(),
          name: 'create_ticket',
          arguments: JSON.stringify({ category, severity: 'S3', summary, order_no: orderNo, sku }),
        },
      ],
      note: '识别为售后写操作，创建工单',
    };
  }

  // 2) 业务查询与知识问答可在同一轮并行发出（混合问题如「保修多久？顺便看库存」）。
  //    知识意图只认显式知识词，不靠问号兜底——否则「订单到哪了？」会被误配上知识检索。
  const calls: ToolCall[] = [];
  for (const s of skus) {
    calls.push({
      id: id(),
      name: 'query_inventory',
      arguments: JSON.stringify({
        sku: s,
        ...(warehouse ? { warehouse_code: warehouse } : {}),
        include_reserved: true,
      }),
    });
  }
  if (orderNo || tail) {
    calls.push({
      id: id(),
      name: 'query_order',
      arguments: JSON.stringify(orderNo ? { order_no: orderNo } : { phone_tail: tail }),
    });
  }
  if (KNOWLEDGE_WORDS.test(askText)) {
    calls.push({
      id: id(),
      name: 'search_knowledge',
      arguments: JSON.stringify({ question: askText.slice(0, 500), top_k: 4 }),
    });
  }
  if (calls.length) {
    return { calls, note: `识别为混合意图：${calls.map((c) => c.name).join(' + ')}` };
  }

  // 3) 纯知识问题：显式知识词或带问号的自然语言都进知识库
  if (KNOWLEDGE_WORDS.test(askText) || /[?？]/.test(askText)) {
    return {
      calls: [
        {
          id: id(),
          name: 'search_knowledge',
          arguments: JSON.stringify({ question: askText.slice(0, 500), top_k: 4 }),
        },
      ],
      note: '识别为知识型问题，检索企业知识库',
    };
  }

  return { calls: [], note: '未识别到明确的工具意图' };
}

const STATUS_CN: Record<string, string> = {
  CREATED: '已创建',
  PAID: '已付款',
  PICKING: '拣货中',
  SHIPPED: '已发货',
  DELIVERED: '已签收',
  CLOSED: '已关闭',
  REFUNDING: '退款中',
};

const WAREHOUSE_CN: Record<string, string> = {
  'WH-SZ': '深圳仓',
  'WH-GZ': '广州仓',
  'WH-SH': '上海仓',
  ALL: '三仓汇总',
};

function warehouseName(code: unknown): string {
  const key = String(code ?? '');
  return WAREHOUSE_CN[key] ?? key;
}

function money(n: unknown): string {
  return `¥${Number(n ?? 0).toFixed(2)}`;
}

const COMPAT_CN: Record<string, string> = {
  direct: '直接替代',
  similar: '相似替代',
  upgrade: '升级替代',
};

/**
 * 回答统一采用「结论先行」：
 * 第一句就把用户要的答案说清楚（加粗），后面才是依据与例外。
 *
 * 旧实现把所有字段平铺成一段话（"在库 X，预占 Y，可用 Z，安全库存…"），
 * 用户得读完才知道结论；这是「回答不好」的主要来源，与模型能力无关。
 */
function composeInventory(d: Record<string, unknown>): string {
  const wh = warehouseName(d.warehouse);
  const available = Number(d.available ?? 0);
  const safety = Number(d.safety_stock ?? 0);
  const verdict = d.below_safety
    ? `已低于安全库存 ${safety} 件，建议尽快补货`
    : `安全库存 ${safety} 件，水位正常`;

  const out: string[] = [
    `**${String(d.name ?? '')}（${String(d.sku ?? '')}）${wh}可用 ${available} 件**，${verdict}。`,
    '',
    `- 在库 ${d.on_hand} 件，预占 ${d.reserved} 件`,
  ];

  if (Number(d.in_transit) > 0) {
    out.push(`- 在途 ${d.in_transit} 件，预计 ${d.restock_eta ?? '待确认'} 到货`);
  } else {
    out.push('- 当前没有在途补货');
  }

  const subs = (d.substitutes as Array<Record<string, unknown>> | undefined) ?? [];
  if (subs.length) {
    out.push(
      `- 可替代：${subs
        .map((x) => `${x.sku} 可用 ${x.available} 件（${COMPAT_CN[String(x.compatibility)] ?? '相似替代'}）`)
        .join('、')}`,
    );
  }

  const byWh = d.by_warehouse as Array<Record<string, unknown>> | undefined;
  if (byWh?.length) {
    out.push(`- 分仓可用：${byWh.map((w) => `${warehouseName(w.warehouse)} ${w.available} 件`).join('、')}`);
  }

  return out.join('\n');
}

function composeOrder(d: Record<string, unknown>): string {
  const status = STATUS_CN[String(d.status)] ?? String(d.status ?? '');
  const ship = d.shipment as Record<string, unknown> | undefined;
  const lines = (d.lines as Array<Record<string, unknown>> | undefined) ?? [];
  const short = lines.filter((l) => Number(l.shipped_qty) < Number(l.qty));

  const head = ship
    ? `**订单 ${String(d.order_no)} ${status}**，${String(ship.carrier)} ${String(ship.tracking_no)}，预计 ${String(ship.eta ?? '待确认')} 送达。`
    : `**订单 ${String(d.order_no)} 当前${status}**。`;

  const out: string[] = [head];
  if (lines.length) {
    out.push('');
    if (short.length) {
      // 少发是这类问题的真正诉求，放在分点的第一条
      out.push(
        `- **${short.map((l) => `${l.sku} 少发 ${Number(l.qty) - Number(l.shipped_qty)} 件（订购 ${l.qty}，已发 ${l.shipped_qty}）`).join('；')}**`,
      );
      out.push(`- 其余 ${lines.length - short.length} 行商品数量一致`);
    } else {
      out.push(`- ${lines.length} 行商品均已按订购数量发出`);
    }
  }

  const amt = d.amounts as Record<string, unknown> | undefined;
  if (amt) {
    out.push(
      `- 应付 ${money(amt.payable)}（商品 ${money(amt.goods)}，优惠 -${money(amt.discount)}，运费 ${money(amt.freight)}）`,
    );
  }
  const tickets = (d.ticket_ids as string[] | undefined) ?? [];
  if (tickets.length) out.push(`- 关联工单：${tickets.join('、')}`);

  return out.join('\n');
}

function composeTicket(d: Record<string, unknown>): string {
  const head = d.deduplicated
    ? `**该问题已有工单 ${String(d.ticket_no)}，本次未重复创建**（幂等重放）。`
    : `**已创建工单 ${String(d.ticket_no)}**，责任组 ${String(d.owner_group)}，SLA 截止 ${String(d.sla_due_at)}。`;
  const tail = d.deduplicated
    ? '- 如需追加材料，直接回复本对话即可，我会补充到这张工单'
    : '- 如需追加材料，直接回复本对话，我不会重复建单，只会补充到当前工单';
  return `${head}\n${tail}`;
}

function composeFinal(results: ToolResultPayload[]): string {
  const chunks: string[] = [];
  for (const r of results) {
    if (r.name === 'query_inventory') chunks.push(composeInventory(r.data));
    else if (r.name === 'query_order') chunks.push(composeOrder(r.data));
    else if (r.name === 'create_ticket') chunks.push(composeTicket(r.data));
    else if (r.name === 'search_knowledge') chunks.push(String(r.data.answer ?? ''));
    else if (r.data && (r.data as { code?: string }).code) {
      chunks.push(`**这次没能取到数据**：${String((r.data as { message?: string }).message ?? '未知错误')}。`);
    }
  }
  if (!chunks.length) return '我暂时没有获取到可用信息，请补充订单号或型号后再试。';
  return chunks.filter(Boolean).join('\n\n');
}

/* ------------------------------------------------------------------ *
 * 思考文本（reasoning）
 *
 * 真实模型（o1 / DeepSeek-R1 / Claude extended thinking）会先产出推理再给结论。
 * mock 没有推理能力，这里按「意图 → 工具选择 → 结果核对」写出确定性的思考轨迹，
 * 目的是让前端的思考展示、折叠、耗时统计在无 Key 环境下也能被真实驱动，
 * 而不是前端伪造一段假文本。
 * ------------------------------------------------------------------ */

function brief(text: string, max = 34): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const TOOL_REASON: Record<string, string> = {
  query_inventory:
    '这是库存查询。可用量 = 在库 − 预占，不能直接报在库数；还要看安全库存，低于阈值就得提醒补货。',
  query_order: '这是订单查询。按订单号取状态与物流，再逐行核对已发数量，少发要单独指出来。',
  create_ticket:
    '这是售后写操作。先确认订单归属，再按问题类型定类别与责任组；同一个问题不能重复建单。',
  search_knowledge:
    '这是政策类问题。先检索知识库，只有片段能支撑结论时才回答；撑不住就按未覆盖处理。',
};

function composeReasoning(
  messages: ChatMessage[],
  calls: ToolCall[],
  results: ToolResultPayload[],
): string {
  const latest = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const askText = latest.split('【附件：')[0]?.trim() || latest;
  const out: string[] = [];

  if (results.length === 0) {
    out.push(`先看用户在问什么：「${brief(askText)}」。`);
    const explained = new Set<string>();
    for (const call of calls) {
      if (explained.has(call.name)) continue;
      explained.add(call.name);
      const hint = TOOL_REASON[call.name];
      if (hint) out.push(hint);
    }
    if (calls.length > 1) {
      out.push(`这两个查询互不依赖，可以并行发出，不用一轮一轮等。`);
    }
    if (needsOrderInfo(askText)) {
      out.push('用户要建售后工单，但没给订单号或 SKU。没有订单就没法确认归属和责任组，不能凭空建单，先问清楚。');
    }
    const files = listAttachments(latest);
    if (files.length) {
      out.push(`用户带了 ${files.length} 个附件，先看文件名与开头几行，再决定要不要查业务数据。`);
    }
    out.push('参数从上下文补全即可；customer_id 由网关凭证注入，我不需要也不应该自己填。');
    return out.join('\n');
  }

  out.push('结果回来了，逐项核对：');
  for (const r of results) {
    if (r.name === 'query_inventory') {
      out.push(
        `库存：在库 ${r.data.on_hand}、预占 ${r.data.reserved}，可用 ${r.data.available}；安全库存 ${r.data.safety_stock}。`,
      );
      if (r.data.below_safety) out.push('可用量已经低于安全库存，回答里要明确提醒补货，不能只丢一个数字。');
      if (Number(r.data.in_transit) > 0) out.push(`在途 ${r.data.in_transit} 件，到货时间一并给出更有用。`);
      const subs = (r.data.substitutes as unknown[] | undefined) ?? [];
      if (subs.length) out.push('替代型号要标清是本仓口径，避免客户以为可以直接调货。');
    } else if (r.name === 'query_order') {
      const lines = (r.data.lines as Array<Record<string, unknown>> | undefined) ?? [];
      out.push(`订单状态 ${STATUS_CN[String(r.data.status)] ?? r.data.status}，共 ${lines.length} 行商品。`);
      if (lines.some((l) => Number(l.shipped_qty) < Number(l.qty))) {
        out.push('存在少发——这是客户最关心的点，必须放在第一句。');
      }
    } else if (r.name === 'create_ticket') {
      out.push(
        r.data.deduplicated
          ? '幂等键命中，返回的是已有工单，没有重复创建。'
          : '工单已创建，工单号、责任组和 SLA 一次说清。',
      );
    } else if (r.name === 'search_knowledge') {
      const sources = (r.data.sources as unknown[] | undefined) ?? [];
      out.push(`知识库边界=${r.data.boundary}，命中 ${sources.length} 条片段。`);
      if (r.data.boundary !== 'in_kb') {
        out.push('证据不足，不能硬答；按边界策略说明并建议转人工。');
      } else {
        out.push('先从片段里挑出直接回答问题的那个句子当结论，其余降级为补充条件。');
      }
    }
  }
  out.push('按「先结论、后依据」组织回答，把编号留给引用。');
  return out.join('\n');
}

interface ParsedAttachment {
  name: string;
  body: string;
}

/** 解析前端拼进来的附件块（【附件：name（size）】+ 围栏正文） */
function listAttachments(text: string): ParsedAttachment[] {
  const out: ParsedAttachment[] = [];
  for (const part of text.split('【附件：').slice(1)) {
    const headEnd = part.indexOf('】');
    if (headEnd < 0) continue;
    const header = part.slice(0, headEnd);
    const rest = part.slice(headEnd + 1).replace(/^\n/, '');
    const body = rest
      .replace(/^```+\n?/, '')
      .replace(/\n?```+[\s\S]*$/, '');
    out.push({ name: header.split(/[（(]/)[0]!.trim(), body });
  }
  return out;
}

/**
 * mock 没有真正的文件理解能力，这里给一个确定性的「读取回执」：
 * 只陈述文件名、行数和前几行，不编造结论。
 * 接真实模型后走不到这段逻辑。
 */
function summarizeAttachments(text: string): string {
  const files = listAttachments(text);
  if (!files.length) return '';
  const blocks = files.map((f) => {
    const lines = f.body.split('\n').filter((l) => l.trim());
    const preview = lines.slice(0, 3).map((l) => `- ${l.trim().slice(0, 48)}`);
    return [`**已读取 ${f.name}**，共 ${lines.length} 行。`, ...preview].join('\n');
  });
  return `${blocks.join('\n\n')}\n\n需要查具体库存或订单，直接说 SKU / 订单号即可。`;
}

/** 「要建单但没说哪一笔」：这时追问比罗列能力更有用 */
function needsOrderInfo(text: string): boolean {
  return TICKET_WORDS.test(text) && !lastMatch(text, ORDER_RE) && !lastMatch(text, SKU_RE);
}

export const CLARIFY_TICKET =
  '**建单前需要先确认是哪一笔订单**。请补充订单号（例如 SO-20261012-007）或产品 SKU，' +
  '我会按少发 / 破损 / 退货等类别建单，并给出责任组与 SLA。';

const FALLBACK_TEXT =
  '我可以帮你做四类事：① 查库存（例如「深圳仓 SKU-A1B2C3 还有多少可用库存？」）；② 查订单（例如「订单 SO-20261012-007 到哪了？」）；③ 建售后工单（例如「客户说少发了一件，帮我建个工单」）；④ 查知识库（例如「这款设备的保修期是多久？」）。';

export class MockProvider implements ModelInvoker {
  readonly name = 'mock-deterministic';

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelChunk> {
    await sleep(80, signal);

    const plan = planToolCalls(req.messages);

    // 先「想」再动作：真实模型也是先产出 reasoning，再吐 tool_calls / 正文。
    // 放在 done 之前，前端才能看到「思考中 → 首 token 到达后折叠」的完整过程。
    const reasoning = composeReasoning(req.messages, plan.calls, collectToolResults(req.messages));
    // 每段 8 字 / 30ms：一段思考约 1 秒，肉眼能看清在「想」，
    // 又不至于像真实推理模型那样让演示等十几秒。
    // 需要更慢的演示节奏时（例如讲解思考过程）可用 MOCK_REASONING_DELAY_MS 调大。
    const reasoningDelay = Number(process.env.MOCK_REASONING_DELAY_MS ?? 30);
    for (let i = 0; i < reasoning.length; i += 8) {
      if (signal.aborted) return;
      yield { type: 'reasoning', delta: reasoning.slice(i, i + 8) };
      await sleep(reasoningDelay, signal);
    }

    if (plan.calls.length > 0) {
      yield {
        type: 'done',
        text: '',
        toolCalls: plan.calls,
        finishReason: 'tool_calls',
        usage: estimateUsage(req.messages, ''),
      };
      return;
    }

    const results = collectToolResults(req.messages);
    const latest = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const askText = latest.split('【附件：')[0]?.trim() || latest;
    const text = results.length
      ? composeFinal(results)
      : needsOrderInfo(askText)
        ? CLARIFY_TICKET
        : listAttachments(latest).length
          ? summarizeAttachments(latest)
          : FALLBACK_TEXT;

    // 模拟逐字流式输出
    for (let i = 0; i < text.length; i += 14) {
      if (signal.aborted) return;
      yield { type: 'text', delta: text.slice(i, i + 14) };
      await sleep(12, signal);
    }

    yield {
      type: 'done',
      text,
      toolCalls: [],
      finishReason: 'stop',
      usage: estimateUsage(req.messages, text),
    };
  }
}
