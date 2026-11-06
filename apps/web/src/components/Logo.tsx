/**
 * 「知言」标识：矢入框 —— 「知」的本字结构。
 * 矢（提问/求知）射入框（容器/知识库），箭头用强调色，其余用主文字色。
 *
 * 双变体：
 * - line：≥28px 使用，线条轻，适合放在白色容器里
 * - solid：<28px 自动切换（也可显式指定），实心强调色底 + 白色图形，
 *   16–24px 下比线性版清晰得多，同时与 favicon 完全一致
 */
type Variant = 'line' | 'solid';

export function Logo({
  size = 24,
  stroke = 3.2,
  variant,
  className = '',
}: {
  size?: number;
  /** 仅 line 变体生效：viewBox 单位下的线宽 */
  stroke?: number;
  variant?: Variant;
  className?: string;
}) {
  const mode: Variant = variant ?? (size < 28 ? 'solid' : 'line');

  if (mode === 'solid') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 56 56"
        fill="none"
        className={className}
        aria-hidden="true"
        focusable="false"
      >
        <rect width="56" height="56" rx="15" fill="#4d6bfe" />
        <rect x="25" y="13" width="24" height="28" rx="6" stroke="#ffffff" strokeWidth="4" />
        <path d="M8 27H19" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" />
        <path
          d="M15 22L20 27L15 32"
          stroke="#ffffff"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  const accentStroke = stroke + 0.4;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 56 56"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="23"
        y="11"
        width="28"
        height="32"
        rx="7"
        stroke="currentColor"
        strokeWidth={stroke}
      />
      <path
        d="M5 27H18"
        stroke="#4d6bfe"
        strokeWidth={accentStroke}
        strokeLinecap="round"
      />
      <path
        d="M13 22L18 27L13 32"
        stroke="#4d6bfe"
        strokeWidth={accentStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
