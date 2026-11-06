import { useEffect, useRef } from 'react';

/**
 * 流动背景：fbm（分形布朗噪声）+ 域扭曲生成流体纹理，思路与 deepseek.com 首页一致。
 *
 * 几条硬约束（沿用参考站踩过的坑）：
 * - DPR 与分辨率双重降采样，像素量控制在 ~50 万以内，着色器再轻也能跑满帧
 * - 空闲暂停 rAF：对话开始后传 paused，停止调度，只保留最后一帧
 * - 标签页隐藏 / 移出视口时停止
 * - prefers-reduced-motion：只画一帧静态图
 * - WebGL 不可用：隐藏 canvas，露出 CSS 色雾兜底
 */

const VERT = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG = `
precision mediump float;

uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_base;
uniform vec3 u_tintA;
uniform vec3 u_tintB;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    v += amp * noise(p);
    p = p * 2.03 + vec2(11.7, 7.3);
    amp *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  float aspect = u_res.x / max(u_res.y, 1.0);
  vec2 p = vec2(uv.x * aspect, uv.y) * 1.35;

  float t = u_time * 0.075;

  // 域扭曲：用两层低频噪声扰动采样坐标，得到流体的"卷曲"手感
  vec2 q = vec2(
    fbm(p + vec2(0.0, t * 1.4)),
    fbm(p + vec2(5.2, 1.3) - vec2(t, 0.0))
  );
  float f = fbm(p + q * 1.35 + vec2(t * 0.8, -t * 0.5));

  vec3 col = u_base;
  // 中心略留白但不留空：流动感向四周渐强，文字区仍是最淡的一侧
  float d = distance(uv, vec2(0.5, 0.45));
  float falloff = smoothstep(0.05, 0.68, d);
  col = mix(col, u_tintA, smoothstep(0.30, 0.76, f) * mix(0.55, 1.0, falloff));
  col = mix(col, u_tintB, smoothstep(0.48, 0.90, f) * mix(0.40, 1.0, falloff) * 0.75);

  // 最外圈再淡回白，避免边缘出现硬色带
  col = mix(col, vec3(1.0), smoothstep(0.74, 1.18, d) * 0.35);

  gl_FragColor = vec4(col, 1.0);
}
`;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function WaveBackground({ paused = false }: { paused?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const controlRef = useRef<{ start: () => void; stop: () => void } | null>(null);

  // 对话开始/结束时精确启停，不轮询
  useEffect(() => {
    if (paused) controlRef.current?.stop();
    else controlRef.current?.start();
  }, [paused]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // 移动端不跑着色器，交给 CSS 色雾（省电，观感差异在这个透明度下可忽略）
    const smallScreen = window.innerWidth < 768;
    if (smallScreen) return;

    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: 'low-power',
    }) as WebGLRenderingContext | null;
    if (!gl) return;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, 'u_res');
    const uTime = gl.getUniformLocation(program, 'u_time');
    const uBase = gl.getUniformLocation(program, 'u_base');
    const uTintA = gl.getUniformLocation(program, 'u_tintA');
    const uTintB = gl.getUniformLocation(program, 'u_tintB');

    // 色带与 --base / --line / --surface 同源，保证和设计令牌不漂移
    gl.uniform3fv(uBase, hexToRgb('#f4f8ff'));
    gl.uniform3fv(uTintA, hexToRgb('#a9bcff'));
    gl.uniform3fv(uTintB, hexToRgb('#c2dcd5'));

    let width = 0;
    let height = 0;
    const resize = () => {
      // 0.55 倍再乘 DPR 上限，像素量约为原生的 1/3，肉眼靠柔和度换性能
      const scale = Math.min(window.devicePixelRatio || 1, 1.5) * 0.55;
      width = Math.max(1, Math.floor(canvas.clientWidth * scale));
      height = Math.max(1, Math.floor(canvas.clientHeight * scale));
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      gl.uniform2f(uRes, width, height);
      draw(performance.now() / 1000);
    };

    let raf = 0;
    let running = false;
    let startTime = performance.now() / 1000;
    let lastDraw = 0;

    const draw = (time: number) => {
      gl.uniform1f(uTime, time - startTime);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      lastDraw = time;
    };

    const frame = (now: number) => {
      if (pausedRef.current) {
        running = false;
        return;
      }
      // 30fps 上限：背景不需要 60 帧，省一半 GPU
      if (now / 1000 - lastDraw >= 1 / 30) draw(now / 1000);
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (running || pausedRef.current) return;
      running = true;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (!running) return;
      running = false;
      cancelAnimationFrame(raf);
    };

    resize();
    if (!reduceMotion) start();
    controlRef.current = { start, stop };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else start();
    };

    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      controlRef.current = null;
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, []);

  return (
    <div
      className={`wave-layer transition-opacity duration-700 ${paused ? 'opacity-45' : 'opacity-100'}`}
      aria-hidden="true"
    >
      <div className="wave-fallback" />
      <canvas ref={canvasRef} className="wave-canvas" />
    </div>
  );
}
