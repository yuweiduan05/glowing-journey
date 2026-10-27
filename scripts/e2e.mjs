#!/usr/bin/env node
/**
 * 端到端回归（不依赖浏览器）：直接打网关的 SSE 接口，断言「工具选择 + 关键数值 + 边界 + 错误码」。
 * 运行：node scripts/e2e.mjs   （需 8081/8082/8083 已启动）
 */
const BASE = process.env.GATEWAY_BASE ?? 'http://127.0.0.1:8081';

function parseSse(raw) {
  const events = [];
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n');
    let event = '';
    const data = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (event && data.length) {
      try {
        events.push({ event, data: JSON.parse(data.join('\n')) });
      } catch {
        /* ignore */
      }
    }
  }
  return events;
}

async function ask(content, { messages = [], chain = 'proxy', conversationId = 'c-e2e', chaos } = {}) {
  const url = `${BASE}/v1/chat/completions${chaos ? `?chaos=${chaos}` : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer demo-token',
      'X-Chain': chain,
      'X-Conversation-Id': conversationId,
    },
    body: JSON.stringify({
      messages: [...messages, { role: 'user', content }],
      stream: true,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    return { text: '', tools: [], boundary: null, error: await res.text(), events: [] };
  }

  const raw = await res.text();
  const events = parseSse(raw);
  const tools = events.filter((e) => e.event === 'tool_call').map((e) => e.data.name);
  const toolResults = events.filter((e) => e.event === 'tool_result').map((e) => e.data);
  const text = events.filter((e) => e.event === 'token').map((e) => e.data.delta).join('');
  const error = events.find((e) => e.event === 'error')?.data;
  const handoff = events.find((e) => e.event === 'handoff')?.data;
  const done = events.find((e) => e.event === 'done')?.data;
  return { text, tools, toolResults, error, handoff, done, events, eventNames: events.map((e) => e.event) };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

const d1 = await ask('深圳仓 SKU-A1B2C3 还有多少可用库存？');
check(
  'D1 库存',
  d1.tools.includes('query_inventory') && d1.text.includes('17') && d1.text.includes('安全库存'),
  d1.text.replace(/\n/g, ' ').slice(0, 60),
);

const d2 = await ask('SKU-A1B2C3 广州仓呢？如果都不够，有什么替代型号？', {
  messages: [{ role: 'user', content: '深圳仓 SKU-A1B2C3 还有多少可用库存？' }],
});
check(
  'D2 跨仓/替代',
  d2.tools.includes('query_inventory') && /WH-GZ|广州/.test(d2.text) && /SKU-[A-Z0-9]{6}/.test(d2.text),
  d2.text.replace(/\n/g, ' ').slice(0, 60),
);

const d3 = await ask('订单 SO-20261012-007 到哪了？');
check(
  'D3 订单/少发',
  d3.tools.includes('query_order') && d3.text.includes('已发货') && d3.text.includes('少发'),
  d3.text.replace(/\n/g, ' ').slice(0, 60),
);

const conv = `c-e2e-${Date.now()}`;
const d4a = await ask('客户说少发了一件，帮我建个工单', {
  conversationId: conv,
  messages: [{ role: 'user', content: '订单 SO-20261012-007 到哪了？' }],
});
const d4b = await ask('客户说少发了一件，帮我建个工单', {
  conversationId: conv,
  messages: [
    { role: 'user', content: '订单 SO-20261012-007 到哪了？' },
    { role: 'assistant', content: '订单已发货，存在少发。' },
  ],
});
const ticketNo = d4a.text.match(/TK-\d{8}-\d{4}/)?.[0];
check(
  'D4 建单 + 幂等',
  Boolean(ticketNo) && d4b.text.includes(ticketNo ?? '__none__') && /幂等|未重复创建/.test(d4b.text),
  `${ticketNo} / 二次:${/幂等|未重复创建/.test(d4b.text)}`,
);

const d5 = await ask('这款设备的保修期是多久？换货要什么条件？');
const citation = d5.events.find((e) => e.event === 'citation')?.data?.sources ?? [];
check(
  'D5 知识问答 + 引用',
  d5.tools.includes('search_knowledge') && citation.length >= 2 && d5.text.includes('[1]'),
  `引用 ${citation.length} 条`,
);

const d6 = await ask('你们支持比特币付款吗？');
check(
  'D6 越界拒答',
  d6.handoff?.reason?.includes('超出业务范围') &&
    d6.tools.every((t) => t === 'search_knowledge') &&
    /服务范围/.test(d6.text),
  `工具=${d6.tools.join(',') || '无'}`,
);

const d7 = await ask('我们公司的股权结构是怎样的？');
check('D7 未覆盖 + 转人工', d7.handoff?.reason?.includes('知识库未覆盖'), d7.text.slice(0, 30));

const d8 = await ask('深圳仓 SKU-A1B2C3 还有多少可用库存？', { chaos: '500' });
const failedTool = d8.toolResults.find((r) => r.status === 'error');
check(
  'D8 故障注入',
  Boolean(failedTool) && failedTool.error.code === 'TOOL_UPSTREAM_ERROR' && Boolean(d8.done),
  failedTool ? `${failedTool.error.code}（proxy 重试后仍失败，前端可重试）` : '未捕获工具失败',
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
