// Minimal typings for the parts of d3-force-3d used by the 2D and 3D graphs.
declare module "d3-force-3d" {
  interface PositionForce {
    (alpha: number): void;
    strength(strength: number): PositionForce;
  }
  export function forceX(x?: number): PositionForce;
  export function forceY(y?: number): PositionForce;
  export function forceZ(z?: number): PositionForce;
  interface CollideForce<N> {
    (alpha: number): void;
    radius(radius: number | ((node: N) => number)): CollideForce<N>;
  }
  export function forceCollide<N>(radius?: number | ((node: N) => number)): CollideForce<N>;
}
