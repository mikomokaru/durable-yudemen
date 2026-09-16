import { serializeCpsatObservation, type CpsatObservation } from "./observation";

/** 同期の記録口。失敗は通知するが Timer 操作へ throw しない。時計・ID の生成も行わない。 */
export function observeCpsat(
  row: CpsatObservation,
  write: (line: string) => void = (line) => console.log(line),
): boolean {
  try {
    const line = serializeCpsatObservation(row);
    if (line === null) return false;
    write(line);
    return true;
  } catch {
    return false;
  }
}
