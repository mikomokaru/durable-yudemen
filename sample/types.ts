// 共有型
export type Noodle = {
  id: string;
  name: string;
  sec: number;
};

export type SlotStatus = "idle" | "running" | "boiled";

export interface SlotState {
  status: SlotStatus;
  remaining: number;
  noodle: Noodle | null;
}
