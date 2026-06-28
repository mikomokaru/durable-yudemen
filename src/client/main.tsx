import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// CSS は副作用 import で読み込む（バンドラがスタイルを取り込む）。視認性スタイルの唯一の取り込み点。
// oxlint-disable-next-line import/no-unassigned-import
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
