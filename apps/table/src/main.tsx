/**
 * main.tsx — browser entry. React 19 createRoot + the dark table stylesheet.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./ui/table.css";

const host = document.getElementById("root");
if (host === null) throw new Error("main: #root missing from index.html");

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
