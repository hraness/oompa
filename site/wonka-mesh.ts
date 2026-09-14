/** An original, lightly flared top hat. Interleaved position, normal and UV. */
export interface WonkaMesh {
  vertices: Float32Array;
  indices: Uint16Array;
}

type Point = readonly [number, number, number];
type Surface = (angle: number, progress: number) => Point;

export function createWonkaMesh(): WonkaMesh {
  const vertices: number[] = [];
  const indices: number[] = [];
  const tau = Math.PI * 2;

  const addSurface = (surface: Surface, rows: number, columns: number, reverse = false) => {
    const offset = vertices.length / 8;
    for (let row = 0; row <= rows; row += 1) {
      const progress = row / rows;
      for (let column = 0; column <= columns; column += 1) {
        const angle = column / columns * tau;
        const point = surface(angle, progress);
        const ahead = surface(angle + 0.0001, progress);
        const below = surface(angle, Math.max(0, progress - 0.0001));
        const above = surface(angle, Math.min(1, progress + 0.0001));
        const a = [above[0] - below[0], above[1] - below[1], above[2] - below[2]] as const;
        const b = [ahead[0] - point[0], ahead[1] - point[1], ahead[2] - point[2]] as const;
        const normal = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] as const;
        const length = Math.hypot(...normal) || 1;
        const direction = reverse ? -1 : 1;
        vertices.push(...point, ...normal.map((value) => value / length * direction), column / columns, progress);
        if (row === rows || column === columns) continue;
        const first = offset + row * (columns + 1) + column;
        const next = first + columns + 1;
        if (reverse) indices.push(first, first + 1, next, first + 1, next + 1, next);
        else indices.push(first, next, first + 1, first + 1, next, next + 1);
      }
    }
  };

  const crown: Surface = (angle, progress) => {
    const radius = 0.62 + 0.11 * progress + 0.04 * Math.cos(tau * progress);
    return [radius * Math.cos(angle) + 0.055 * progress * progress, -0.68 + 1.73 * progress, radius * Math.sin(angle) * 0.84];
  };
  const brimHeight = (angle: number, progress: number) => -0.7 + 0.19 * progress ** 5 * Math.cos(angle) ** 2 - 0.035 * progress ** 2 + 0.026 * Math.sin(angle) * progress ** 2;
  addSurface(crown, 32, 80);
  addSurface((angle, progress) => {
    const radius = 0.77 * (1 - progress * 0.9999);
    return [radius * Math.cos(angle) + 0.055, 1.05 + 0.048 * Math.sin(progress * Math.PI / 2), radius * Math.sin(angle) * 0.84];
  }, 10, 80);
  addSurface((angle, progress) => {
    const radius = 0.02 + progress * 1.24;
    return [radius * Math.cos(angle), brimHeight(angle, progress), radius * Math.sin(angle) * 0.79];
  }, 18, 96, true);
  addSurface((angle, progress) => [1.26 * Math.cos(angle), brimHeight(angle, 1) - progress * 0.034, 1.26 * Math.sin(angle) * 0.79], 2, 96, true);

  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}
