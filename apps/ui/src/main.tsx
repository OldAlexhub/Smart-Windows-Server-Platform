import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BRAND } from "@nexus/shared/brand";
import { App } from "./App";
import { applyTheme, loadTheme } from "./lib/theme";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/pipelines.css";

document.title = BRAND.productName;
applyTheme(loadTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
