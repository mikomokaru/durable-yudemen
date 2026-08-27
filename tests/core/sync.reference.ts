import type { Timer } from "../../src/engine/timer";

interface ReferenceWindow {
  readonly left: number;
  readonly right: number;
}

export function referenceProximityClusters(
  timers: readonly Timer[],
  toleranceRatio: number,
): readonly (readonly Timer[])[] {
  const windows: readonly ReferenceWindow[] = timers.map((timer) => {
    const half = ((timer.endTime - timer.startTime) * toleranceRatio) / 100;
    return { left: timer.endTime - half, right: timer.endTime + half };
  });
  const visited = new Set<number>();
  const clusters: Timer[][] = [];

  // Production の区間掃引と同じ欠陥を共有しないよう、全対の辺から到達可能性を直接たどる。
  for (let origin = 0; origin < timers.length; origin++) {
    if (visited.has(origin)) continue;
    visited.add(origin);
    const pending = [origin];
    const cluster: Timer[] = [];

    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) continue;
      const timer = timers[current];
      const currentWindow = windows[current];
      if (timer === undefined || currentWindow === undefined) continue;
      cluster.push(timer);

      for (let candidate = 0; candidate < timers.length; candidate++) {
        if (visited.has(candidate)) continue;
        const candidateWindow = windows[candidate];
        if (candidateWindow === undefined) continue;
        const overlaps = currentWindow.left <= candidateWindow.right && candidateWindow.left <= currentWindow.right;
        if (!overlaps) continue;
        visited.add(candidate);
        pending.push(candidate);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

export function referenceSyncSets(
  timers: readonly Timer[],
  params: { readonly arms: number; readonly toleranceRatio: number },
): readonly (readonly Timer[])[] {
  return referenceProximityClusters(timers, params.toleranceRatio).flatMap((cluster) => {
    const ordered = [...cluster].sort((a, b) => a.endTime - b.endTime || a.seq - b.seq);
    const sets: Timer[][] = [];
    for (let index = 0; index < ordered.length; index += params.arms) {
      sets.push(ordered.slice(index, index + params.arms));
    }
    return sets;
  });
}
