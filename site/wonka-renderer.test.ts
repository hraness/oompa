import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createWonkaMesh } from "./wonka-mesh";
import { initWonkaArtifact } from "./wonka-renderer";

function harness(options: { unavailable?: boolean; reduced?: boolean; saveData?: boolean } = {}) {
  const { document, window } = parseHTML('<html data-theme="dark"><body><header data-hraness-marketing="hero"><div data-wonka-artifact><canvas data-wonka-canvas></canvas><svg data-poster></svg></div><svg data-wonka-relics><defs><linearGradient id="test-spectrum"></linearGradient></defs></svg></header></body></html>');
  const root = document.querySelector<HTMLElement>("[data-wonka-artifact]")!;
  const canvas = document.querySelector<HTMLCanvasElement>("canvas")!;
  const hero = document.querySelector<HTMLElement>("header")!;
  const frames = new Map<number, FrameRequestCallback>();
  const stats = { draws: 0, deletedPrograms: 0, disconnected: 0, light: -1, compile: true, error: 0 };
  let nextFrame = 0;
  let time = 0;
  let onIntersection: (visible: boolean) => void = () => undefined;
  let onTheme: () => void = () => undefined;
  let onResize: () => void = () => undefined;
  const media = new window.EventTarget();
  Object.defineProperty(media, "matches", { value: options.reduced === true });
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, ELEMENT_ARRAY_BUFFER: 6, STATIC_DRAW: 7, FLOAT: 8,
    NO_ERROR: 0, COLOR_BUFFER_BIT: 16, DEPTH_BUFFER_BIT: 32, DEPTH_TEST: 33,
    TRIANGLES: 34, UNSIGNED_SHORT: 35,
    createProgram: () => ({}), createBuffer: () => ({}), createVertexArray: () => ({}), createShader: () => ({}),
    shaderSource() {}, compileShader() {}, attachShader() {}, linkProgram() {}, bindVertexArray() {},
    bindBuffer() {}, bufferData() {}, enableVertexAttribArray() {}, vertexAttribPointer() {},
    getShaderParameter: () => stats.compile, getProgramParameter: () => true, getAttribLocation: () => 0,
    getUniformLocation: (_program: unknown, name: string) => ({ name }), getError: () => stats.error,
    deleteShader() {}, deleteBuffer() {}, deleteVertexArray() {}, viewport() {}, clearColor() {}, clear() {},
    enable() {}, useProgram() {}, uniform2f() {},
    uniform1f: (location: { name: string }, value: number) => { if (location.name === "u_light") stats.light = value; },
    drawElements: () => { stats.draws += 1; }, isContextLost: () => false,
    deleteProgram: () => { stats.deletedPrograms += 1; },
  };
  class Pointer extends window.Event {
    pointerType = "mouse";
    clientX = 500;
    clientY = 50;
  }
  const view = {
    devicePixelRatio: 3, navigator: { connection: { saveData: options.saveData === true } },
    matchMedia: () => media, PointerEvent: Pointer,
    requestAnimationFrame: (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    addEventListener() {}, removeEventListener() {},
    IntersectionObserver: class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { onIntersection = (visible) => callback([{ isIntersecting: visible }]); }
      observe() {}
      disconnect() { stats.disconnected += 1; }
    },
    ResizeObserver: class {
      constructor(callback: () => void) { onResize = callback; }
      observe() {}
      disconnect() { stats.disconnected += 1; }
    },
    MutationObserver: class {
      constructor(callback: () => void) { onTheme = callback; }
      observe() {}
      disconnect() { stats.disconnected += 1; }
    },
  };
  Object.defineProperty(document, "defaultView", { value: view });
  Object.defineProperty(document, "hidden", { value: false, writable: true });
  Object.defineProperty(canvas, "getContext", { value: () => options.unavailable ? null : gl });
  root.getBoundingClientRect = () => ({ width: 1000, height: 840, left: 0, top: 0, right: 1000, bottom: 840, x: 0, y: 0, toJSON: () => ({}) });
  const tick = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    time += 16;
    for (const callback of callbacks) callback(time);
  };
  const event = (type: string) => new window.Event(type, { cancelable: true });
  return {
    root, canvas, hero, document, stats, frames, tick, event,
    intersect: (visible: boolean) => onIntersection(visible),
    theme: () => onTheme(), resize: () => onResize(),
    pointer: () => hero.dispatchEvent(new Pointer("pointermove")),
    hide: (hidden: boolean) => { Object.defineProperty(document, "hidden", { value: hidden, writable: true }); document.dispatchEvent(event("visibilitychange")); },
  };
}

test("unavailable WebGL keeps the original poster and installs no rendering loop", () => {
  const scene = harness({ unavailable: true });
  const cleanup = initWonkaArtifact(scene.root);
  expect(scene.root.querySelector("[data-poster]")).not.toBeNull();
  expect(scene.root.hasAttribute("data-wonka-ready")).toBe(false);
  expect(scene.frames.size).toBe(0);
  cleanup();
});

test("a visible artifact draws once, caps pixels, and settles pointer motion without an idle loop", () => {
  const scene = harness();
  const cleanup = initWonkaArtifact(scene.root);
  expect(scene.frames.size).toBe(0);
  scene.intersect(true);
  scene.tick();
  expect(scene.stats.draws).toBe(1);
  expect(scene.canvas.width * scene.canvas.height).toBeLessThanOrEqual(500_000);
  expect(scene.root.getAttribute("data-wonka-ready")).toBe("true");
  expect(scene.frames.size).toBe(0);
  const gradient = scene.hero.querySelector("linearGradient")!;
  const initialTransform = gradient.getAttribute("gradientTransform");
  expect(initialTransform).toBe("rotate(0.000 .5 .5)");
  scene.pointer();
  for (let step = 0; step < 100 && scene.frames.size; step += 1) scene.tick();
  expect(scene.stats.draws).toBeGreaterThan(1);
  expect(scene.frames.size).toBe(0);
  const transform = gradient.getAttribute("gradientTransform");
  expect(transform).not.toBeNull();
  expect(transform).toMatch(/^rotate\((-?\d+\.\d{3}) \.5 \.5\)$/u);
  expect(transform).not.toBe(initialTransform);
  const angle = Number(transform!.slice("rotate(".length).split(" ")[0]);
  expect(Number.isFinite(angle)).toBe(true);
  expect(Math.abs(angle)).toBeLessThanOrEqual(14);
  scene.tick();
  const settled = scene.stats.draws;
  scene.tick();
  expect(scene.stats.draws).toBe(settled);
  cleanup();
  expect(scene.hero.querySelector("linearGradient")?.hasAttribute("gradientTransform")).toBe(false);
});

test("hidden and offscreen artifacts suspend work, theme changes redraw, and cleanup removes observers and input", () => {
  const scene = harness();
  const cleanup = initWonkaArtifact(scene.root);
  scene.intersect(true);
  scene.tick();
  scene.pointer();
  expect(scene.frames.size).toBe(1);
  scene.hide(true);
  expect(scene.frames.size).toBe(0);
  scene.theme();
  scene.resize();
  expect(scene.frames.size).toBe(0);
  scene.hide(false);
  expect(scene.frames.size).toBe(1);
  scene.intersect(false);
  expect(scene.frames.size).toBe(0);
  scene.document.documentElement.dataset.theme = "light";
  scene.intersect(true);
  scene.tick();
  expect(scene.stats.light).toBe(1);
  cleanup();
  expect(scene.stats.deletedPrograms).toBe(1);
  expect(scene.stats.disconnected).toBe(3);
  expect(scene.frames.size).toBe(0);
  scene.pointer();
  scene.hero.dispatchEvent(scene.event("pointerleave"));
  scene.hide(false);
  expect(scene.frames.size).toBe(0);
  expect(scene.root.hasAttribute("data-wonka-ready")).toBe(false);
});

test("context loss immediately restores the poster and context restoration can draw again", () => {
  const scene = harness();
  const cleanup = initWonkaArtifact(scene.root);
  scene.intersect(true);
  scene.tick();
  const lost = scene.event("webglcontextlost");
  scene.canvas.dispatchEvent(lost);
  expect(lost.defaultPrevented).toBe(true);
  expect(scene.root.hasAttribute("data-wonka-ready")).toBe(false);
  scene.pointer();
  expect(scene.frames.size).toBe(0);
  scene.canvas.dispatchEvent(scene.event("webglcontextrestored"));
  scene.tick();
  expect(scene.root.getAttribute("data-wonka-ready")).toBe("true");
  expect(scene.stats.draws).toBe(2);
  cleanup();
});

test("shader failure preserves the poster without repeatedly compiling on input", () => {
  const scene = harness();
  scene.stats.compile = false;
  const cleanup = initWonkaArtifact(scene.root);
  scene.intersect(true);
  scene.tick();
  expect(scene.stats.draws).toBe(0);
  expect(scene.root.hasAttribute("data-wonka-ready")).toBe(false);
  scene.pointer();
  scene.resize();
  expect(scene.frames.size).toBe(0);
  cleanup();
});

for (const option of [{ reduced: true }, { saveData: true }]) {
  test(`${Object.keys(option)[0]} preserves one still frame without pointer animation`, () => {
    const scene = harness(option);
    const cleanup = initWonkaArtifact(scene.root);
    scene.intersect(true);
    scene.tick();
    scene.pointer();
    expect(scene.frames.size).toBe(0);
    expect(scene.stats.draws).toBe(1);
    cleanup();
  });
}

test("the authored hat stays within 16-bit geometry and has finite unit surface normals", () => {
  const mesh = createWonkaMesh();
  expect(mesh.vertices.length / 8).toBeLessThan(65_536);
  expect(mesh.indices.length / 3).toBeLessThan(12_000);
  for (const index of mesh.indices) expect(index).toBeLessThan(mesh.vertices.length / 8);
  for (let index = 0; index < mesh.vertices.length; index += 8) {
    const values = mesh.vertices.slice(index, index + 8);
    expect([...values].every(Number.isFinite)).toBe(true);
    expect(Math.hypot(values[3]!, values[4]!, values[5]!)).toBeCloseTo(1, 4);
  }
});
