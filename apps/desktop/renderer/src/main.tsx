import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { ThemeProvider } from "@/context/ThemeContext";
import { OpenCorpoProvider } from "@/context/OpenCorpoContext";
import "./index.css";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <OpenCorpoProvider>
        <HashRouter>
          <App />
        </HashRouter>
      </OpenCorpoProvider>
    </ThemeProvider>
  </React.StrictMode>
);
