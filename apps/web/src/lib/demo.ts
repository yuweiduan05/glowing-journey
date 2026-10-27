export interface DemoCase {
  id: string;
  label: string;
  text: string;
  hint: string;
}

/** 预置演示脚本（对应 P3 任务 5 / 9.2 脚本化演示） */
export const DEMO_CASES: DemoCase[] = [
  { id: 'D1', label: 'D1 查库存', text: '深圳仓 SKU-A1B2C3 还有多少可用库存？', hint: '单工具 + 时间线' },
  { id: 'D2', label: 'D2 跨仓与替代', text: 'SKU-A1B2C3 广州仓呢？如果都不够，有什么替代型号？', hint: '参数抽取 + 多仓汇总' },
  { id: 'D3', label: 'D3 查订单', text: '订单 SO-20261012-007 到哪了？', hint: '订单 + 物流' },
  { id: 'D4', label: 'D4 建工单', text: '客户说少发了一件，帮我建个工单', hint: '写工具 + 幂等' },
  { id: 'D5', label: 'D5 知识问答', text: '这款设备的保修期是多久？换货要什么条件？', hint: 'RAG + 引用' },
  { id: 'D6', label: 'D6 边界-越界', text: '你们支持比特币付款吗？', hint: 'out_of_scope 拒答' },
  { id: 'D7', label: 'D7 边界-未覆盖', text: '我们公司的股权结构是怎样的？', hint: 'insufficient + 转人工' },
];

export interface ConversationMeta {
  id: string;
  title: string;
  preview: string;
  ts: string;
}

export const CONVERSATIONS: ConversationMeta[] = [
  { id: 'c-demo', title: '恒达自动化 · 售前咨询', preview: '深圳仓库存与替代型号', ts: '刚刚' },
  { id: 'c-order', title: '订单售后跟进', preview: 'SO-20261012-007 少发补发', ts: '昨天' },
  { id: 'c-policy', title: '保修政策问答', preview: '保修期与换货条件', ts: '2 天前' },
  { id: 'c-empty', title: '新会话', preview: '空会话', ts: '—' },
];
