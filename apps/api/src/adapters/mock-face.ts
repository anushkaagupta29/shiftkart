import { createHash } from 'node:crypto';

// Mock biometrics. A real liveness/face-match vendor (HyperVerge, IDfy, ...) replaces this,
// sandbox first. Here each "person" gets a stable random-looking unit vector, so the same
// person always matches themselves and different people score near zero.
export const EMBEDDING_DIM = 64;

export function mockEmbedding(personId: string): number[] {
  const v: number[] = [];
  let block = Buffer.alloc(0);
  for (let i = 0; v.length < EMBEDDING_DIM; i++) {
    if (block.length < 2) block = createHash('sha256').update(`${personId}:${i}`).digest();
    v.push((block.readUInt16BE(0) / 65535) * 2 - 1);
    block = block.subarray(2);
  }
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

export function cosineScore(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return Math.round((dot / Math.sqrt(na * nb)) * 100);
}

export const toPgVector = (v: number[]) => `[${v.map((x) => x.toFixed(6)).join(',')}]`;
export const fromPgVector = (s: string) => JSON.parse(s) as number[];

export type SelfieCheck = { live: boolean; embedding: number[] };

export interface LivenessProvider {
  /** In production `capture` is an image/video reference from the vendor SDK. */
  check(capture: { mockPersonId: string; mockSpoof?: boolean }): Promise<SelfieCheck>;
}

export class MockLiveness implements LivenessProvider {
  async check(capture: { mockPersonId: string; mockSpoof?: boolean }): Promise<SelfieCheck> {
    return { live: !capture.mockSpoof, embedding: mockEmbedding(capture.mockPersonId) };
  }
}
