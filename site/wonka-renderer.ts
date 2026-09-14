import { createWonkaMesh } from "./wonka-mesh";

const vertexSource = `#version 300 es
precision highp float;
in vec3 a_position;
in vec3 a_normal;
in vec2 a_uv;
uniform vec2 u_tilt;
uniform float u_aspect;
out vec3 v_position;
out vec3 v_normal;
out vec2 v_uv;

mat3 rotateX(float a) { float c = cos(a), s = sin(a); return mat3(1.,0.,0., 0.,c,s, 0.,-s,c); }
mat3 rotateY(float a) { float c = cos(a), s = sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
mat3 rotateZ(float a) { float c = cos(a), s = sin(a); return mat3(c,s,0., -s,c,0., 0.,0.,1.); }
void main() {
  mat3 turn = rotateZ(-0.17) * rotateX(0.34 + u_tilt.y) * rotateY(-0.52 + u_tilt.x);
  vec3 position = turn * a_position;
  float perspective = 1. / (1. - position.z * 0.12);
  float framing = 1.47 * max(1., 1.03 / u_aspect);
  gl_Position = vec4(position.x * perspective / (u_aspect * framing), (position.y - 0.06) * perspective / framing, -position.z * 0.25, 1.);
  v_position = a_position;
  v_normal = turn * a_normal;
  v_uv = a_uv;
}`;

const fragmentSource = `#version 300 es
precision highp float;
in vec3 v_position;
in vec3 v_normal;
in vec2 v_uv;
uniform float u_light;
out vec4 outColor;

float hairline(float coordinate, float width) {
  float cell = abs(fract(coordinate + 0.5) - 0.5);
  float aa = max(fwidth(coordinate), 0.0001);
  return 1. - smoothstep(width - aa, width + aa, cell);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float stroke(vec2 p, vec2 a, vec2 b, float width) {
  vec2 pa = p - a, ba = b - a;
  float distance = length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0., 1.));
  return 1. - smoothstep(width, width + 0.065, distance);
}
void main() {
  vec3 n = normalize(v_normal) * (gl_FrontFacing ? 1. : -1.);
  float face = max(n.z, 0.);
  float rim = pow(1. - face, 2.5);
  float light = max(dot(n, normalize(vec3(-0.5, 0.85, 1.2))), 0.);
  float specular = pow(max(dot(n, normalize(vec3(-0.45, 0.8, 2.))), 0.), 18.);
  vec3 body = mix(vec3(0.14, 0.16, 0.22), vec3(0.77, 0.79, 0.83), u_light);
  vec3 silver = mix(vec3(0.55, 0.63, 0.71), vec3(0.31, 0.38, 0.45), u_light);
  vec3 gold = mix(vec3(0.63, 0.49, 0.31), vec3(0.46, 0.34, 0.20), u_light);
  vec3 color = body * (0.64 + light * 0.38);
  color += specular * mix(0.10, 0.065, u_light);

  // Closely spaced contours describe the curved object; cipher marks stay rare.
  float contours = hairline(v_position.y * 47. + sin(v_uv.x * 6.283) * 0.16, 0.075);
  float meridians = hairline(v_uv.x * 144., 0.048);
  // Keep the crown's closed fabric top smooth; latitude bands there read as holes.
  float crownTop = smoothstep(1.04, 1.05, v_position.y);
  contours *= 1. - crownTop;
  meridians *= 1. - crownTop;
  float engraving = contours * 0.25 + meridians * 0.09;
  color = mix(color, silver, engraving * (0.35 + light * 0.6));
  vec2 grid = vec2(v_uv.x * 62., v_position.y * 29.);
  vec2 cell = fract(grid);
  float seed = hash(floor(grid));
  float glyph = stroke(cell, vec2(0.3, 0.23), vec2(0.3, 0.74), 0.026);
  glyph = max(glyph, stroke(cell, vec2(0.3, 0.48), vec2(0.7, 0.48), 0.026));
  glyph = max(glyph, stroke(cell, vec2(0.48, 0.23), vec2(0.69, 0.38), 0.022));
  glyph *= step(0.965, seed) * smoothstep(-0.22, 0., v_position.y) * (1. - smoothstep(0.8, 1., v_position.y));
  color = mix(color, silver, glyph * 0.30);

  float band = smoothstep(-0.64, -0.625, v_position.y) * (1. - smoothstep(-0.40, -0.385, v_position.y));
  float bandEdge = exp(-abs(v_position.y + 0.63) * 340.) + exp(-abs(v_position.y + 0.395) * 340.);
  color = mix(color, gold * (0.72 + light * 0.22), band * 0.42);
  color = mix(color, gold, clamp(bandEdge * 0.52, 0., 1.));

  float phase = face * 7. + v_position.y * 0.7 + v_uv.x * 3.;
  vec3 diffraction = 0.5 + 0.5 * cos(phase + vec3(0., 2.1, 4.2));
  diffraction = mix(vec3(0.61, 0.70, 0.72), diffraction, 0.32);
  color = mix(color, silver, 0.34 + engraving * 0.3);
  color = mix(color, diffraction, rim * 0.34 * (0.5 + light * 0.5));
  // Let light describe the object instead of painting an opaque prop behind copy.
  float ink = 0.11 + contours * 0.24 + meridians * 0.08 + rim * 0.31 + glyph * 0.18;
  ink += band * 0.16 + bandEdge * 0.12;
  outColor = vec4(color, clamp(ink, 0., 0.68));
}`;

interface Renderer {
  program: WebGLProgram;
  vertices: WebGLBuffer;
  indices: WebGLBuffer;
  array: WebGLVertexArrayObject;
  count: number;
  tilt: WebGLUniformLocation | null;
  aspect: WebGLUniformLocation | null;
  light: WebGLUniformLocation | null;
}

function createRenderer(gl: WebGL2RenderingContext): Renderer | null {
  const shaders: WebGLShader[] = [];
  const program = gl.createProgram();
  const vertices = gl.createBuffer();
  const indices = gl.createBuffer();
  const array = gl.createVertexArray();
  let complete = false;
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]] as const) {
      const shader = gl.createShader(type);
      if (!shader) return null;
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return null;
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    const mesh = createWonkaMesh();
    gl.bindVertexArray(array);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    for (const [name, size, offset] of [["a_position", 3, 0], ["a_normal", 3, 12], ["a_uv", 2, 24]] as const) {
      const location = gl.getAttribLocation(program, name);
      if (location < 0) return null;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 32, offset);
    }
    if (gl.getError() !== gl.NO_ERROR) return null;
    complete = true;
    return { program, vertices, indices, array, count: mesh.indices.length, tilt: gl.getUniformLocation(program, "u_tilt"), aspect: gl.getUniformLocation(program, "u_aspect"), light: gl.getUniformLocation(program, "u_light") };
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
    if (!complete) {
      gl.deleteProgram(program);
      gl.deleteBuffer(vertices);
      gl.deleteBuffer(indices);
      gl.deleteVertexArray(array);
    }
  }
}

/** Enhance an already visible poster; idle means no animation frames or GPU work. */
export function initWonkaArtifact(root: HTMLElement): () => void {
  const canvas = root.querySelector<HTMLCanvasElement>("canvas[data-wonka-canvas]");
  if (!canvas) return () => undefined;
  const document = root.ownerDocument;
  const view = document.defaultView;
  if (!view) return () => undefined;
  let gl: WebGL2RenderingContext | null;
  try {
    gl = canvas.getContext("webgl2", { alpha: true, antialias: true, depth: true, premultipliedAlpha: false, powerPreference: "low-power", failIfMajorPerformanceCaveat: true });
  } catch {
    return () => undefined;
  }
  if (!gl) return () => undefined;
  const context = gl;
  let renderer: Renderer | null = null;
  let disposed = false;
  let visible = typeof view.IntersectionObserver !== "function";
  let lost = false;
  let failed = false;
  let frame = 0;
  let previousTime = 0;
  let x = 0;
  let y = 0;
  let targetX = 0;
  let targetY = 0;
  const motion = view.matchMedia("(prefers-reduced-motion: reduce)");
  const connection: unknown = Reflect.get(view.navigator, "connection");
  const saveData = typeof connection === "object" && connection !== null && Reflect.get(connection, "saveData") === true;
  const staticFrame = () => motion.matches || saveData;

  const release = () => {
    if (!renderer) return;
    context.deleteProgram(renderer.program);
    context.deleteBuffer(renderer.vertices);
    context.deleteBuffer(renderer.indices);
    context.deleteVertexArray(renderer.array);
    renderer = null;
  };
  const stop = () => {
    view.cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
  };
  const request = () => {
    if (!disposed && !lost && !failed && visible && !document.hidden && frame === 0) frame = view.requestAnimationFrame(draw);
  };
  const draw = (time: number) => {
    frame = 0;
    if (disposed || lost || !visible || document.hidden) return;
    const bounds = root.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const ratio = Math.min(view.devicePixelRatio || 1, 1.5, Math.sqrt(500_000 / (bounds.width * bounds.height)));
    const width = Math.max(1, Math.floor(bounds.width * ratio));
    const height = Math.max(1, Math.floor(bounds.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    if (staticFrame()) { targetX = 0; targetY = 0; x = 0; y = 0; }
    const delta = previousTime ? Math.min(time - previousTime, 64) : 16;
    previousTime = time;
    const easing = 1 - Math.exp(-delta / 110);
    x += (targetX - x) * easing;
    y += (targetY - y) * easing;
    try {
      renderer ??= createRenderer(context);
      if (!renderer) { failed = true; return; }
      context.viewport(0, 0, width, height);
      context.clearColor(0, 0, 0, 0);
      context.clear(context.COLOR_BUFFER_BIT | context.DEPTH_BUFFER_BIT);
      context.enable(context.DEPTH_TEST);
      context.useProgram(renderer.program);
      context.bindVertexArray(renderer.array);
      context.uniform2f(renderer.tilt, x, y);
      context.uniform1f(renderer.aspect, bounds.width / bounds.height);
      context.uniform1f(renderer.light, document.documentElement.dataset.theme === "light" ? 1 : 0);
      context.drawElements(context.TRIANGLES, renderer.count, context.UNSIGNED_SHORT, 0);
      if (context.getError() !== context.NO_ERROR || context.isContextLost()) { failed = true; root.removeAttribute("data-wonka-ready"); release(); return; }
      root.setAttribute("data-wonka-ready", "true");
      for (const { gradient } of relics) gradient.setAttribute("gradientTransform", `rotate(${(x * 125 + y * 45).toFixed(3)} .5 .5)`);
    } catch {
      failed = true;
      root.removeAttribute("data-wonka-ready");
      release();
      return;
    }
    if (!staticFrame() && Math.abs(targetX - x) + Math.abs(targetY - y) > 0.0001) request();
    else previousTime = 0;
  };
  const reset = () => { targetX = 0; targetY = 0; request(); };
  const pointer = (event: Event) => {
    if (!(event instanceof view.PointerEvent) || event.pointerType === "touch" || staticFrame() || !visible) return;
    const bounds = root.getBoundingClientRect();
    targetX = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1)) * 0.09;
    targetY = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1)) * 0.055;
    request();
  };
  const onVisibility = () => { if (document.hidden) stop(); else request(); };
  const onLost = (event: Event) => { event.preventDefault(); lost = true; stop(); renderer = null; root.removeAttribute("data-wonka-ready"); };
  const onRestored = () => { lost = false; failed = false; request(); };
  const hero = root.closest<HTMLElement>('[data-hraness-marketing="hero"]') ?? root;
  const relics = [...hero.querySelectorAll<SVGLinearGradientElement>('[data-wonka-relics] linearGradient[id$="-spectrum"]')]
    .map((gradient) => ({ gradient, initialTransform: gradient.getAttribute("gradientTransform") }));
  const intersection = typeof view.IntersectionObserver === "function" ? new view.IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    if (visible) request(); else stop();
  }) : null;
  const resize = typeof view.ResizeObserver === "function" ? new view.ResizeObserver(request) : null;
  const theme = new view.MutationObserver(request);
  intersection?.observe(root);
  resize?.observe(root);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette"] });
  hero.addEventListener("pointermove", pointer, { passive: true });
  hero.addEventListener("pointerleave", reset, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  motion.addEventListener("change", reset);
  view.addEventListener("resize", request, { passive: true });
  request();
  return () => {
    disposed = true;
    stop();
    intersection?.disconnect();
    resize?.disconnect();
    theme.disconnect();
    hero.removeEventListener("pointermove", pointer);
    hero.removeEventListener("pointerleave", reset);
    document.removeEventListener("visibilitychange", onVisibility);
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
    motion.removeEventListener("change", reset);
    view.removeEventListener("resize", request);
    release();
    root.removeAttribute("data-wonka-ready");
    for (const { gradient, initialTransform } of relics) {
      if (initialTransform === null) gradient.removeAttribute("gradientTransform");
      else gradient.setAttribute("gradientTransform", initialTransform);
    }
  };
}
