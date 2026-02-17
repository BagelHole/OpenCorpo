import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useOpenCorpo } from "@/context/OpenCorpoContext";
import type { UiBaseBlock, UiBasePage } from "@/lib/api";

type TerminalUiEvent = {
  cursor: number;
  stream: "stdout" | "stderr" | "status";
  data: string;
  ts: string;
};

function toneToBadgeTone(tone: "default" | "success" | "warning" | "danger" | undefined) {
  if (tone === "success" || tone === "warning" || tone === "danger") return tone;
  return "default";
}

function toneToNoteClass(tone: "default" | "success" | "warning" | "danger" | undefined) {
  if (tone === "success") return "border-[var(--oc-success)]/40 bg-[var(--oc-success-bg)] text-[var(--oc-success)]";
  if (tone === "warning") return "border-[var(--oc-warning)]/40 bg-[var(--oc-warning-bg)] text-[var(--oc-warning)]";
  if (tone === "danger") return "border-[var(--oc-danger)]/40 bg-[var(--oc-danger-bg)] text-[var(--oc-danger)]";
  return "border-[var(--oc-border)] bg-[var(--oc-bg)] text-[var(--oc-ink-muted)]";
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveJobSource(
  output: Record<string, unknown> | null | undefined,
  source: "auto" | "output" | "outputs" | undefined
) {
  if (source === "output") return output;
  if (source === "outputs") return Array.isArray(output?.outputs) ? output.outputs : [];
  return Array.isArray(output?.outputs) ? output.outputs : output;
}

function compactObjectLine(row: Record<string, unknown>): string | null {
  const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : "";
  const label = typeof row.label === "string" && row.label.trim() ? row.label.trim() : "";
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : "";
  const url = typeof row.url === "string" && row.url.trim() ? row.url.trim() : "";
  const value = typeof row.value === "string" && row.value.trim() ? row.value.trim() : "";

  const head = title || label || name;
  if (head && url) return `${head} - ${url}`;
  if (head && value) return `${head}: ${value}`;
  if (head) return head;
  if (url) return url;
  if (value) return value;

  const entries = Object.entries(row).slice(0, 4);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${k}: ${stringifyValue(v)}`).join(" | ");
}

function collectLines(value: unknown, out: string[], maxItems: number) {
  if (out.length >= maxItems || value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectLines(item, out, maxItems);
      if (out.length >= maxItems) break;
    }
    return;
  }

  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (Array.isArray(row.results)) {
      collectLines(row.results, out, maxItems);
      return;
    }
    if (Array.isArray(row.outputs)) {
      collectLines(row.outputs, out, maxItems);
      return;
    }
    if ("result" in row) {
      collectLines(row.result, out, maxItems);
      return;
    }
    const line = compactObjectLine(row);
    if (line) out.push(line);
    return;
  }

  const line = stringifyValue(value).trim();
  if (line) out.push(line);
}

function collectRecords(
  value: unknown,
  out: Array<Record<string, string>>,
  maxRows: number
) {
  if (out.length >= maxRows || value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectRecords(item, out, maxRows);
      if (out.length >= maxRows) break;
    }
    return;
  }

  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (Array.isArray(row.results)) {
      collectRecords(row.results, out, maxRows);
      return;
    }
    if (Array.isArray(row.outputs)) {
      collectRecords(row.outputs, out, maxRows);
      return;
    }
    if ("result" in row) {
      collectRecords(row.result, out, maxRows);
      return;
    }
    const flat: Record<string, string> = {};
    for (const [key, cell] of Object.entries(row)) {
      const text = stringifyValue(cell).trim();
      if (text) flat[key] = text;
    }
    if (Object.keys(flat).length > 0) out.push(flat);
    return;
  }

  const text = stringifyValue(value).trim();
  if (text) out.push({ value: text });
}

function buttonVariantFromStyle(
  style: "primary" | "secondary" | "outline" | undefined
): "default" | "secondary" | "outline" {
  if (style === "secondary") return "secondary";
  if (style === "outline") return "outline";
  return "default";
}

function isSafeWidgetPackageSpec(value: string) {
  const spec = value.trim();
  if (!spec || spec.length > 128) return false;
  if (/\s/.test(spec)) return false;
  if (
    spec.includes(":") ||
    spec.includes("#") ||
    spec.startsWith(".") ||
    spec.startsWith("/") ||
    spec.startsWith("\\")
  ) {
    return false;
  }
  return /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(?:@[A-Za-z0-9*^~<>=|.-]+)?$/.test(spec);
}

function unversionWidgetPackageSpec(spec: string) {
  if (!spec) return spec;
  if (spec.startsWith("@")) {
    const secondAt = spec.indexOf("@", 1);
    return secondAt > 0 ? spec.slice(0, secondAt) : spec;
  }
  const at = spec.indexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

function buildTradingViewAdvancedChartUrl(props: Record<string, unknown> | undefined) {
  const symbol = typeof props?.symbol === "string" && props.symbol.trim() ? props.symbol.trim() : "NASDAQ:AAPL";
  const interval =
    typeof props?.interval === "string" && props.interval.trim() ? props.interval.trim() : "D";
  const colorThemeRaw =
    typeof props?.colorTheme === "string"
      ? props.colorTheme.trim().toLowerCase()
      : typeof props?.theme === "string"
        ? props.theme.trim().toLowerCase()
        : "light";
  const theme = colorThemeRaw === "dark" ? "dark" : "light";
  const locale = typeof props?.locale === "string" && props.locale.trim() ? props.locale.trim() : "en";

  const query = new URLSearchParams({
    symbol,
    interval,
    theme,
    locale,
    allow_symbol_change: "true",
    saveimage: "true",
    withdateranges: "true",
    hide_top_toolbar: "false",
    hide_side_toolbar: "false"
  });

  return `https://s.tradingview.com/widgetembed/?${query.toString()}`;
}

function buildReactWidgetSrcDoc(
  packageSpec: string,
  exportName: string | undefined,
  props: Record<string, unknown> | undefined,
  frameId: string
) {
  const propsJson = JSON.stringify(props ?? {});
  const processShimModule =
    "data:text/javascript,export const env={};export const argv=[];const noop=()=>{};const stream={isTTY:false,resume(){},pause(){},setEncoding(){},read(){return null;},pipe(){return this;},unpipe(){return this;},on(){return this;},once(){return this;},off(){return this;},addListener(){return this;},removeListener(){return this;},emit(){return false;},write(){return true;},end(){},destroy(){},removeAllListeners(){return this;}};export const stdin={...stream};export const stdout={...stream};export const stderr={...stream};export const nextTick=(fn,...args)=>queueMicrotask(()=>fn(...args));const proc={browser:true,env,argv,stdin,stdout,stderr,nextTick,cwd:()=>\"/\",platform:\"browser\",versions:{}};export default proc;";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      html, body { margin: 0; padding: 0; width: 100%; font-family: ui-sans-serif, system-ui, sans-serif; background: transparent; color: #e5e7eb; }
      #root { width: 100%; min-height: 1px; }
      #error { display:none; color:#b91c1c; font-size:13px; padding:12px; white-space:pre-wrap; }
    </style>
    <script type="importmap">
      {
        "imports": {
          "react": "https://esm.sh/react@18.3.1",
          "react/jsx-runtime": "https://esm.sh/react@18.3.1/jsx-runtime",
          "react/jsx-dev-runtime": "https://esm.sh/react@18.3.1/jsx-dev-runtime",
          "react-dom": "https://esm.sh/react-dom@18.3.1",
          "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
          "node:process": ${JSON.stringify(processShimModule)},
          "/node/process.mjs": ${JSON.stringify(processShimModule)},
          "https://esm.sh/node/process.mjs": ${JSON.stringify(processShimModule)}
        }
      }
    </script>
  </head>
  <body>
    <div id="root"></div>
    <div id="error"></div>
    <script type="module">
      const rootEl = document.getElementById("root");
      const errorEl = document.getElementById("error");
      const frameId = ${JSON.stringify(frameId)};
      const packageSpec = ${JSON.stringify(packageSpec)};
      const exportName = ${JSON.stringify(exportName ?? "")};
      const props = JSON.parse(${JSON.stringify(propsJson)});
      let resolvedTarget = null;
      let attemptedClassFallback = false;
      let attemptedRenderPropFallback = false;
      let reactRoot = null;
      let reactRuntime = null;

      function ensureProcessShim() {
        const noop = () => {};
        const stdinShim = {
          isTTY: false,
          resume: noop,
          pause: noop,
          on: noop,
          once: noop,
          off: noop,
          addListener: noop,
          removeListener: noop
        };
        const stdoutShim = {
          isTTY: false,
          write: noop,
          on: noop,
          once: noop,
          off: noop,
          addListener: noop,
          removeListener: noop
        };
        const base =
          (typeof globalThis.process === "object" && globalThis.process) || {};
        const next = {
          ...base,
          browser: true,
          env: typeof base.env === "object" && base.env ? base.env : {},
          argv: Array.isArray(base.argv) ? base.argv : [],
          stdin: typeof base.stdin === "object" && base.stdin ? { ...stdinShim, ...base.stdin } : stdinShim,
          stdout: typeof base.stdout === "object" && base.stdout ? { ...stdoutShim, ...base.stdout } : stdoutShim,
          stderr: typeof base.stderr === "object" && base.stderr ? { ...stdoutShim, ...base.stderr } : stdoutShim,
          nextTick: typeof base.nextTick === "function" ? base.nextTick.bind(base) : (fn, ...args) => queueMicrotask(() => fn(...args))
        };
        globalThis.process = next;
        window.process = next;
      }

      ensureProcessShim();
      try {
        document.body.tabIndex = 0;
        window.addEventListener("load", () => {
          try { window.focus(); } catch {}
          try { document.body.focus(); } catch {}
          try { rootEl?.focus?.(); } catch {}
        });
      } catch {
        // ignore
      }

      // Some embeds probe gamepad support on startup and crash if blocked by Permissions Policy.
      // Best-effort shim: make getGamepads() return an empty list instead of throwing.
      try {
        const probe = navigator.getGamepads?.bind(navigator);
        if (probe) {
          try {
            probe();
          } catch {
            const fallback = () => [];
            try {
              Object.defineProperty(navigator, "getGamepads", {
                configurable: true,
                writable: true,
                value: fallback
              });
            } catch {
              try {
                const proto = Object.getPrototypeOf(navigator);
                if (proto) {
                  Object.defineProperty(proto, "getGamepads", {
                    configurable: true,
                    writable: true,
                    value: fallback
                  });
                }
              } catch {
                // ignore: not all runtimes allow overriding navigator methods
              }
            }
          }
        }
      } catch {
        // ignore
      }

      function unversionedSpec(spec) {
        if (!spec) return spec;
        if (spec.startsWith("@")) {
          const secondAt = spec.indexOf("@", 1);
          return secondAt > 0 ? spec.slice(0, secondAt) : spec;
        }
        const at = spec.indexOf("@");
        return at > 0 ? spec.slice(0, at) : spec;
      }

      async function importWidget(spec) {
        const urls = [
          "https://esm.sh/" + spec + "?target=es2022&external=react,react-dom",
          "https://esm.sh/" + spec + "?external=react,react-dom",
          "https://esm.sh/" + spec + "?target=es2022",
          "https://esm.sh/" + spec,
          "https://esm.sh/" + spec + "?bundle&target=es2022&external=react,react-dom",
          "https://esm.sh/" + spec + "?bundle&target=es2022&deps=react@18.3.1,react-dom@18.3.1",
          "https://cdn.jsdelivr.net/npm/" + spec + "/+esm"
        ];
        let lastError = null;
        for (const url of urls) {
          try {
            return await import(url);
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      }

      function fail(message) {
        if (!errorEl || !rootEl) return;
        rootEl.style.display = "none";
        errorEl.style.display = "block";
        errorEl.textContent = message;
        postHeight();
      }

      function postHeight() {
        try {
          const rootHeight = rootEl ? Math.ceil(rootEl.scrollHeight || 0) : 0;
          const errorHeight = errorEl ? Math.ceil(errorEl.scrollHeight || 0) : 0;
          const bodyHeight = Math.ceil(document.body?.scrollHeight || 0);
          const docHeight = Math.ceil(document.documentElement?.scrollHeight || 0);
          const height = Math.max(rootHeight, errorHeight, bodyHeight, docHeight, 80);
          parent.postMessage({ type: "oc-widget-height", id: frameId, height }, "*");
        } catch {
          // ignore
        }
      }

      function describeValue(value) {
        if (value === null) return "null";
        if (value === undefined) return "undefined";
        if (Array.isArray(value)) return "array";
        const type = typeof value;
        if (type !== "object") return type;
        const keys = Object.keys(value);
        return keys.length ? "object{" + keys.slice(0, 8).join(",") + "}" : "object{}";
      }

      function isElement(value) {
        return (
          Boolean(value) &&
          typeof value === "object" &&
          "$$typeof" in value &&
          "props" in value
        );
      }

      function isRenderableType(value) {
        if (!value) return false;
        if (typeof value === "function" || typeof value === "string") return true;
        return typeof value === "object" && "$$typeof" in value;
      }

      function isClassConstructor(value) {
        if (typeof value !== "function") return false;
        try {
          const source = Function.prototype.toString.call(value);
          if (/^class\s/.test(source)) return true;
        } catch {
          // ignore
        }
        try {
          const proto = value.prototype;
          if (!proto || typeof proto !== "object") return false;
          const names = Object.getOwnPropertyNames(proto).filter((name) => name !== "constructor");
          return names.length > 0;
        } catch {
          return false;
        }
      }

      function hasMeaningfulUi(root) {
        if (!root) return false;
        const text = (root.textContent || "").replace(/\\s+/g, " ").trim();
        if (text.length > 0) return true;
        if (
          root.querySelector(
            "img,svg,canvas,iframe,video,table,ul,ol,p,h1,h2,h3,h4,h5,h6,button,input,select,textarea"
          )
        ) {
          return true;
        }
        const nodes = root.querySelectorAll("*");
        for (const node of nodes) {
          const style = window.getComputedStyle(node);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity || "1") <= 0.02
          ) {
            continue;
          }
          const rect = node.getBoundingClientRect();
          if (rect.width > 2 && rect.height > 2) return true;
        }
        return false;
      }

      function findRenderableExport(widgetMod, exportNameInput) {
        const exportNameTrimmed = typeof exportNameInput === "string" ? exportNameInput.trim() : "";
        if (
          exportNameTrimmed &&
          Object.prototype.hasOwnProperty.call(widgetMod, exportNameTrimmed)
        ) {
          return {
            value: widgetMod[exportNameTrimmed],
            source: "named:" + exportNameTrimmed
          };
        }

        const candidates = [
          ["default", widgetMod.default],
          ["module", widgetMod],
          ["default.default", widgetMod.default?.default]
        ];

        for (const [name, value] of Object.entries(widgetMod)) {
          candidates.push(["named:" + name, value]);
        }
        if (widgetMod.default && typeof widgetMod.default === "object") {
          for (const [name, value] of Object.entries(widgetMod.default)) {
            candidates.push(["default." + name, value]);
          }
        }

        for (const [source, value] of candidates) {
          if (isRenderableType(value) || isElement(value)) {
            return { value, source };
          }
        }

        return null;
      }

      function buildRenderPropFallback(React) {
        return (ctx) => {
          if (!ctx || typeof ctx !== "object") {
            return React.createElement("div", null, "Widget loaded.");
          }
          const row = ctx;
          const children = [];
          if (typeof row.HeldPiece === "function") {
            children.push(React.createElement(row.HeldPiece, { key: "held" }));
          }
          if (typeof row.Gameboard === "function") {
            children.push(React.createElement(row.Gameboard, { key: "board" }));
          }
          if (typeof row.PieceQueue === "function") {
            children.push(React.createElement(row.PieceQueue, { key: "queue" }));
          }
          if (typeof row.points === "number") {
            children.push(
              React.createElement("div", { key: "points" }, "Points: " + String(row.points))
            );
          }
          if (typeof row.linesCleared === "number") {
            children.push(
              React.createElement(
                "div",
                { key: "lines" },
                "Lines Cleared: " + String(row.linesCleared)
              )
            );
          }
          if (children.length === 0) {
            return React.createElement("div", null, "Widget loaded.");
          }
          return React.createElement(
            "div",
            { style: { display: "grid", gap: "8px", justifyItems: "start" } },
            ...children
          );
        };
      }

      function renderNonReactTarget(target, props, rootEl, React, root) {
        if (!rootEl) return false;

        const writeNode = (value) => {
          if (!value) return false;
          if (
            React &&
            root &&
            typeof React.isValidElement === "function" &&
            React.isValidElement(value)
          ) {
            root.render(value);
            return true;
          }
          if (typeof HTMLElement !== "undefined" && value instanceof HTMLElement) {
            rootEl.innerHTML = "";
            rootEl.appendChild(value);
            return true;
          }
          if (typeof value === "string" || typeof value === "number") {
            rootEl.textContent = String(value);
            return true;
          }
          if (value && typeof value === "object" && "nodeType" in value) {
            rootEl.innerHTML = "";
            rootEl.appendChild(value);
            return true;
          }
          return false;
        };

        if (target && typeof target === "object") {
          if (typeof target.mount === "function") {
            target.mount(rootEl, props);
            return true;
          }
          if (typeof target.attach === "function") {
            target.attach(rootEl, props);
            return true;
          }
          if (typeof target.init === "function") {
            target.init(rootEl, props);
            return true;
          }
          if (typeof target.start === "function") {
            target.start(rootEl, props);
            return true;
          }
          if (typeof target.render === "function") {
            return writeNode(target.render(props));
          }
        }

        if (typeof target === "function") {
          if (typeof target.mount === "function") {
            target.mount(rootEl, props);
            return true;
          }
          if (typeof target.attach === "function") {
            target.attach(rootEl, props);
            return true;
          }
          if (typeof target.init === "function") {
            target.init(rootEl, props);
            return true;
          }
          if (typeof target.start === "function") {
            target.start(rootEl, props);
            return true;
          }
          if (
            isClassConstructor(target) &&
            !(target.prototype && target.prototype.isReactComponent)
          ) {
            const instance = new target(props);
            if (instance && typeof instance.mount === "function") {
              instance.mount(rootEl, props);
              return true;
            }
            if (instance && typeof instance.render === "function") {
              return writeNode(instance.render(props));
            }
            if (instance && typeof instance.mount === "function") {
              instance.mount(rootEl, props);
              return true;
            }
            if (instance && typeof instance.attach === "function") {
              instance.attach(rootEl, props);
              return true;
            }
            if (instance && typeof instance.init === "function") {
              instance.init(rootEl, props);
              return true;
            }
            if (instance && typeof instance.start === "function") {
              instance.start(rootEl, props);
              return true;
            }
          } else {
            return writeNode(target(props));
          }
        }

        return false;
      }

      window.addEventListener("error", (event) => {
        const message = String(event.message || event.error || "unknown");
        if (
          !attemptedRenderPropFallback &&
          resolvedTarget &&
          reactRoot &&
          reactRuntime &&
          message.includes("children is not a function")
        ) {
          attemptedRenderPropFallback = true;
          try {
            reactRoot.render(
              reactRuntime.createElement(
                resolvedTarget,
                props,
                buildRenderPropFallback(reactRuntime)
              )
            );
            if (errorEl) errorEl.style.display = "none";
            if (rootEl) rootEl.style.display = "block";
            setTimeout(postHeight, 0);
            setTimeout(postHeight, 150);
            return;
          } catch {
            // fall through to fail
          }
        }
        if (
          !attemptedClassFallback &&
          resolvedTarget &&
          message.includes("Class constructor") &&
          message.includes("cannot be invoked without 'new'")
        ) {
          attemptedClassFallback = true;
          const rendered = renderNonReactTarget(resolvedTarget, props, rootEl, null, null);
          if (rendered) {
            if (errorEl) errorEl.style.display = "none";
            if (rootEl) rootEl.style.display = "block";
            setTimeout(postHeight, 0);
            setTimeout(postHeight, 150);
            return;
          }
        }
        fail("Widget runtime error: " + message);
      });
      window.addEventListener("unhandledrejection", (event) => {
        fail(
          "Widget promise rejection: " +
            String(event.reason instanceof Error ? event.reason.message : event.reason)
        );
      });
      window.addEventListener("load", postHeight);
      if (typeof ResizeObserver !== "undefined") {
        const resizeObserver = new ResizeObserver(() => postHeight());
        if (rootEl) resizeObserver.observe(rootEl);
        if (document.body) resizeObserver.observe(document.body);
      } else {
        setInterval(postHeight, 500);
      }

      try {
        const ReactMod = await import("react");
        const ReactDomMod = await import("react-dom/client");
        let widgetMod = null;
        const attempts = [packageSpec];
        const plain = unversionedSpec(packageSpec);
        if (plain && plain !== packageSpec) attempts.push(plain);
        let widgetError = null;
        for (const candidate of attempts) {
          try {
            widgetMod = await importWidget(candidate);
            break;
          } catch (error) {
            widgetError = error;
          }
        }
        if (!widgetMod) {
          throw widgetError instanceof Error ? widgetError : new Error(String(widgetError));
        }
        const React = ReactMod.default ?? ReactMod;
        const createRoot = ReactDomMod.createRoot;
        reactRuntime = React;
        const resolved = findRenderableExport(widgetMod, exportName);
        const target = resolved?.value;
        resolvedTarget = target ?? null;
        if (!target) {
          const keys = Object.keys(widgetMod);
          fail(
            "Widget export not found. Available exports: " +
              (keys.length ? keys.join(", ") : "(none)") +
              ". Set exportName to a component export."
          );
        } else if (rootEl && createRoot) {
          try {
            const root = createRoot(rootEl);
            reactRoot = root;
            if (isElement(target)) {
              root.render(target);
            } else if (isRenderableType(target)) {
              if (
                typeof target === "function" &&
                isClassConstructor(target) &&
                !(target.prototype && target.prototype.isReactComponent)
              ) {
                const rendered = renderNonReactTarget(target, props, rootEl, React, root);
                if (!rendered) {
                  fail(
                    "Widget export is a class-style module and could not be rendered in this sandbox."
                  );
                }
              } else {
                try {
                  root.render(React.createElement(target, props));
                } catch (primaryRenderError) {
                  const message = String(
                    primaryRenderError instanceof Error
                      ? primaryRenderError.message
                      : primaryRenderError
                  );
                  if (message.includes("children is not a function")) {
                    root.render(
                      React.createElement(target, props, buildRenderPropFallback(React))
                    );
                    attemptedRenderPropFallback = true;
                  } else {
                    throw primaryRenderError;
                  }
                }
              }
            } else {
              const rendered = renderNonReactTarget(target, props, rootEl, React, root);
              if (!rendered) {
                fail(
                  "Widget export is not renderable (" +
                    describeValue(target) +
                    "). Resolved from " +
                    String(resolved?.source ?? "unknown") +
                    "."
                );
              }
            }
            setTimeout(postHeight, 0);
            setTimeout(postHeight, 150);
            setTimeout(postHeight, 800);
            setTimeout(postHeight, 2000);
            if (isElement(target) || isRenderableType(target)) {
              setTimeout(() => {
                const hasUi = hasMeaningfulUi(rootEl);
                if (
                  !hasUi &&
                  !attemptedRenderPropFallback &&
                  typeof target === "function"
                ) {
                  try {
                    root.render(
                      React.createElement(target, props, buildRenderPropFallback(React))
                    );
                    attemptedRenderPropFallback = true;
                    setTimeout(() => {
                      const hasUiAfterFallback = hasMeaningfulUi(rootEl);
                      if (
                        !hasUiAfterFallback &&
                        errorEl &&
                        errorEl.style.display !== "block"
                      ) {
                        fail(
                          "Widget rendered no visible UI. This package may require different props/usage. Try another component export or package."
                        );
                      }
                      postHeight();
                    }, 1200);
                    return;
                  } catch {
                    // ignore and continue to generic error
                  }
                }
                if (!hasUi && errorEl && errorEl.style.display !== "block") {
                  fail(
                    "Widget rendered no visible UI. This package may require different props/usage. Try another component export or package."
                  );
                }
                postHeight();
              }, 6000);
            }
          } catch (renderError) {
            fail(
              "Widget export could not be rendered as a React component. " +
                String(renderError instanceof Error ? renderError.message : renderError)
            );
            const rendered = renderNonReactTarget(target, props, rootEl, React, root);
            if (rendered) {
              setTimeout(postHeight, 0);
              setTimeout(postHeight, 150);
              setTimeout(postHeight, 800);
            }
          }
        } else {
          fail("React runtime unavailable in widget sandbox.");
        }
      } catch (error) {
        fail(String(error instanceof Error ? error.message : error));
      }
    </script>
  </body>
</html>`;
}

function hasWidgetSecretPlaceholder(value: unknown, depth = 0): boolean {
  if (depth > 12 || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((item) => hasWidgetSecretPlaceholder(item, depth + 1));
  if (typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length === 1 && typeof row.$secret === "string") return true;
  return Object.values(row).some((nested) => hasWidgetSecretPlaceholder(nested, depth + 1));
}

function BaseBlock({ block }: { block: UiBaseBlock }) {
  const state = useOpenCorpo();
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [resolvedWidgetProps, setResolvedWidgetProps] = useState<Record<string, unknown> | undefined>(
    undefined
  );
  const widgetFrameIdRef = useRef(`oc-widget-${Math.random().toString(36).slice(2)}`);
  const [widgetHeightPx, setWidgetHeightPx] = useState(420);
  const [widgetPropsLoading, setWidgetPropsLoading] = useState(false);
  const [widgetPropsError, setWidgetPropsError] = useState<string | null>(null);
  const [widgetResolveTick, setWidgetResolveTick] = useState(0);
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(null);
  const [terminalEvents, setTerminalEvents] = useState<TerminalUiEvent[]>([]);
  const [terminalClosed, setTerminalClosed] = useState(false);
  const [terminalExitCode, setTerminalExitCode] = useState<number | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalInputBusy, setTerminalInputBusy] = useState(false);
  const [terminalRetryTick, setTerminalRetryTick] = useState(0);
  const terminalNextCursorRef = useRef(0);
  const terminalOutputRef = useRef<HTMLDivElement | null>(null);
  const terminalCommand = block.type === "terminal_widget" ? block.command : "";
  const terminalCwd = block.type === "terminal_widget" ? block.cwd ?? "" : "";
  const terminalAllowInput = block.type === "terminal_widget" ? block.allowInput === true : false;

  const rawWidgetProps = useMemo(
    () =>
      block.type === "react_widget" && block.props && typeof block.props === "object"
        ? (block.props as Record<string, unknown>)
        : undefined,
    [block]
  );

  useEffect(() => {
    let cancelled = false;
    if (block.type !== "react_widget") {
      setResolvedWidgetProps(undefined);
      setWidgetPropsLoading(false);
      setWidgetPropsError(null);
      return () => {
        cancelled = true;
      };
    }
    if (!rawWidgetProps) {
      setResolvedWidgetProps(undefined);
      setWidgetPropsLoading(false);
      setWidgetPropsError(null);
      return () => {
        cancelled = true;
      };
    }
    if (!hasWidgetSecretPlaceholder(rawWidgetProps)) {
      setResolvedWidgetProps(rawWidgetProps);
      setWidgetPropsLoading(false);
      setWidgetPropsError(null);
      return () => {
        cancelled = true;
      };
    }
    if (!state.api) {
      setResolvedWidgetProps(rawWidgetProps);
      setWidgetPropsLoading(false);
      setWidgetPropsError("Widget secret resolution is unavailable. Reconnect to daemon.");
      return () => {
        cancelled = true;
      };
    }
    setWidgetPropsLoading(true);
    setWidgetPropsError(null);
    void state.api
      .resolveWidgetProps({ props: rawWidgetProps })
      .then((response) => {
        if (cancelled) return;
        if (!response.ok) {
          setResolvedWidgetProps(rawWidgetProps);
          setWidgetPropsLoading(false);
          if (response.error.includes("(404)")) {
            setWidgetPropsError(
              "secure widget resolver is temporarily unavailable. Retrying..."
            );
            setTimeout(() => {
              if (!cancelled) setWidgetResolveTick((current) => current + 1);
            }, 2000);
          } else {
            setWidgetPropsError(response.error);
          }
          return;
        }
        setResolvedWidgetProps(response.data.props ?? rawWidgetProps);
        setWidgetPropsLoading(false);
        setWidgetPropsError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setResolvedWidgetProps(rawWidgetProps);
        setWidgetPropsLoading(false);
        setWidgetPropsError(error instanceof Error ? error.message : "Failed to resolve widget secrets.");
        setTimeout(() => {
          if (!cancelled) setWidgetResolveTick((current) => current + 1);
        }, 3000);
      });
    return () => {
      cancelled = true;
    };
  }, [block, rawWidgetProps, state.api, state.scriptSecrets, widgetResolveTick]);

  useEffect(() => {
    if (block.type !== "react_widget") return;
    const initial = Math.max(80, Math.min(2400, block.height ?? 420));
    setWidgetHeightPx(initial);
  }, [block]);

  useEffect(() => {
    if (block.type !== "react_widget") return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const row = data as Record<string, unknown>;
      if (row.type !== "oc-widget-height") return;
      if (row.id !== widgetFrameIdRef.current) return;
      const next = Number(row.height);
      if (!Number.isFinite(next)) return;
      setWidgetHeightPx((current) => {
        const clamped = Math.max(80, Math.min(2400, Math.ceil(next)));
        return Math.abs(clamped - current) > 1 ? clamped : current;
      });
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [block]);

  useEffect(() => {
    let cancelled = false;
    if (block.type !== "terminal_widget") {
      setTerminalSessionId(null);
      setTerminalEvents([]);
      setTerminalClosed(false);
      setTerminalExitCode(null);
      setTerminalError(null);
      setTerminalRetryTick(0);
      terminalNextCursorRef.current = 0;
      return () => {
        cancelled = true;
      };
    }
    if (!state.api) {
      setTerminalError("Terminal session unavailable. Reconnect to daemon.");
      return () => {
        cancelled = true;
      };
    }
    setTerminalSessionId(null);
    setTerminalEvents([]);
    setTerminalClosed(false);
    setTerminalExitCode(null);
    setTerminalError(null);
    terminalNextCursorRef.current = 0;
    void state.api
      .createTerminalSession({
        command: terminalCommand,
        cwd: terminalCwd || undefined,
        allowInput: terminalAllowInput
      })
      .then((response) => {
        if (cancelled) return;
        if (!response.ok) {
          setTerminalError(response.error || "Failed to start terminal session.");
          return;
        }
        setTerminalSessionId(response.data.sessionId);
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Failed to start terminal session.";
        if (message.includes("(404)")) {
          setTerminalError(
            "Terminal backend route unavailable (404). Restart daemon/app to load latest backend. Retrying..."
          );
          window.setTimeout(() => {
            if (!cancelled) setTerminalRetryTick((current) => current + 1);
          }, 2500);
          return;
        }
        setTerminalError(message);
      });
    return () => {
      cancelled = true;
    };
  }, [
    block.type,
    terminalCommand,
    terminalCwd,
    terminalAllowInput,
    state.api,
    terminalRetryTick
  ]);

  useEffect(() => {
    if (block.type !== "terminal_widget" || !state.api || !terminalSessionId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await state.api!.getTerminalSessionEvents(
          terminalSessionId,
          terminalNextCursorRef.current
        );
        if (cancelled) return;
        if (!response.ok) {
          if ((response.error || "").includes("(404)")) {
            setTerminalError(
              "Terminal backend route unavailable (404). Restart daemon/app to load latest backend."
            );
          } else {
            setTerminalError(response.error || "Failed to read terminal output.");
          }
          return;
        }
        const data = response.data;
        if (Array.isArray(data.events) && data.events.length > 0) {
          setTerminalEvents((current) => {
            const seen = new Set(current.map((event) => event.cursor));
            const merged = [...current];
            for (const event of data.events) {
              if (seen.has(event.cursor)) continue;
              merged.push(event);
              seen.add(event.cursor);
            }
            return merged.slice(-3000);
          });
        }
        terminalNextCursorRef.current = data.nextCursor;
        setTerminalClosed(Boolean(data.closed));
        setTerminalExitCode(data.exitCode ?? null);
        setTerminalError(null);
      } catch (error) {
        if (cancelled) return;
        setTerminalError(error instanceof Error ? error.message : "Failed to read terminal output.");
      }
    };

    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, 700);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [block.type, state.api, terminalSessionId]);

  useEffect(() => {
    if (block.type !== "terminal_widget") return;
    const el = terminalOutputRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [block.type, terminalEvents, terminalError]);

  if (block.type === "markdown") {
    return (
      <Card>
        <CardContent className="pt-4">
          <div className="oc-markdown text-sm text-[var(--oc-ink)]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.markdown}</ReactMarkdown>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (block.type === "stats") {
    return (
      <Card>
        <CardContent className="grid gap-2 pt-4 sm:grid-cols-2 lg:grid-cols-3">
          {block.items.map((item) => (
            <div
              key={`${item.label}:${item.value}`}
              className="rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 py-2"
            >
              <div className="text-xs text-[var(--oc-ink-muted)]">{item.label}</div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-[var(--oc-ink)]">{item.value}</div>
                <Badge tone={toneToBadgeTone(item.tone)}>{item.tone ?? "default"}</Badge>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  if (block.type === "list") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{block.title || "List"}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-[var(--oc-ink-muted)]">
            {block.items.map((item) => (
              <li key={item} className="rounded-lg bg-[var(--oc-bg)] px-3 py-2">
                {item}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    );
  }

  if (block.type === "note") {
    return (
      <div className={`rounded-lg border px-4 py-3 text-sm ${toneToNoteClass(block.tone)}`}>
        {block.text}
      </div>
    );
  }

  if (block.type === "job_results") {
    const maxItems = Math.max(1, Math.min(25, block.maxItems ?? 5));
    const job = state.jobs.find((row) => row.name === block.jobName);
    const latestCompleted = job
      ? state.jobRuns.find((run) => run.job_id === job.id && run.status === "completed")
      : undefined;
    const output = latestCompleted?.output ?? null;
    const source = resolveJobSource(output, block.source);
    const lines: string[] = [];
    collectLines(source, lines, maxItems);

    return (
      <Card>
        <CardHeader>
          <CardTitle>{block.title || "Latest Results"}</CardTitle>
        </CardHeader>
        <CardContent>
          {lines.length > 0 ? (
            <ul className="space-y-2 text-sm text-[var(--oc-ink-muted)]">
              {lines.map((line) => (
                <li key={line} className="rounded-lg bg-[var(--oc-bg)] px-3 py-2">
                  {line}
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-lg bg-[var(--oc-bg)] px-3 py-2 text-sm text-[var(--oc-ink-muted)]">
              {block.emptyText || "No results yet. Run the job to populate this section."}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  if (block.type === "job_table") {
    const maxRows = Math.max(1, Math.min(50, block.maxRows ?? 10));
    const job = state.jobs.find((row) => row.name === block.jobName);
    const latestCompleted = job
      ? state.jobRuns.find((run) => run.job_id === job.id && run.status === "completed")
      : undefined;
    const output = latestCompleted?.output ?? null;
    const source = resolveJobSource(output, block.source);
    const records: Array<Record<string, string>> = [];
    collectRecords(source, records, maxRows);

    const columns =
      Array.isArray(block.columns) && block.columns.length > 0
        ? block.columns
        : Array.from(new Set(records.flatMap((row) => Object.keys(row)))).slice(0, 8);

    return (
      <Card>
        <CardHeader>
          <CardTitle>{block.title || "Latest Table"}</CardTitle>
        </CardHeader>
        <CardContent>
          {records.length > 0 && columns.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--oc-border)]">
                    {columns.map((column) => (
                      <th
                        key={column}
                        className="px-2 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--oc-ink-muted)]"
                      >
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {records.map((row, index) => (
                    <tr key={`${index}:${columns.map((column) => row[column] ?? "").join("|")}`} className="border-b border-[var(--oc-border)]/60">
                      {columns.map((column) => (
                        <td key={column} className="px-2 py-2 align-top text-[var(--oc-ink)]">
                          {row[column] || "-"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-lg bg-[var(--oc-bg)] px-3 py-2 text-sm text-[var(--oc-ink-muted)]">
              {block.emptyText || "No table rows yet. Run the job to populate this section."}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  if (block.type === "actions") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{block.title || "Actions"}</CardTitle>
          {block.description && (
            <p className="text-sm text-[var(--oc-ink-muted)]">{block.description}</p>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {block.buttons.map((button, index) => {
              const key = `${button.label}:${index}`;
              return (
                <Button
                  key={key}
                  variant={buttonVariantFromStyle(button.style)}
                  disabled={runningAction === key}
                  onClick={async () => {
                    setActionMessage(null);
                    if (button.action.type === "run_job") {
                      if (button.action.confirm && !window.confirm(button.action.confirm)) return;
                      const job = state.jobs.find((row) => row.name === button.action.jobName);
                      if (!job) {
                        setActionMessage(`Job not found: ${button.action.jobName}`);
                        return;
                      }
                      setRunningAction(key);
                      try {
                        await state.runJob(job.id);
                        setActionMessage(`Started job: ${job.name}`);
                      } catch (error) {
                        setActionMessage(
                          error instanceof Error ? error.message : "Failed to start job."
                        );
                      } finally {
                        setRunningAction(null);
                      }
                      return;
                    }

                    if (!/^https?:\/\//i.test(button.action.url)) {
                      setActionMessage("Only http(s) URLs are allowed.");
                      return;
                    }
                    window.open(button.action.url, "_blank", "noopener,noreferrer");
                  }}
                >
                  {runningAction === key ? "Working..." : button.label}
                </Button>
              );
            })}
          </div>
          {actionMessage && (
            <div className="rounded-lg bg-[var(--oc-bg)] px-3 py-2 text-sm text-[var(--oc-ink-muted)]">
              {actionMessage}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  if (block.type === "terminal_widget") {
    const terminalHeight = Math.max(120, Math.min(1200, block.height ?? 320));
    const allowInput = block.allowInput === true;
    return (
      <Card>
        <CardHeader>
          <CardTitle>{block.title || "Terminal"}</CardTitle>
          {block.description && (
            <p className="text-sm text-[var(--oc-ink-muted)]">{block.description}</p>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          <div
            ref={terminalOutputRef}
            className="w-full overflow-auto rounded-lg border border-[var(--oc-border)] bg-black/90 p-3 font-mono text-xs"
            style={{ height: `${terminalHeight}px` }}
          >
            {terminalEvents.length === 0 && !terminalError && (
              <div className="text-zinc-400">Starting terminal session...</div>
            )}
            {terminalEvents.map((event) => {
              const tone =
                event.stream === "stderr"
                  ? "text-red-400"
                  : event.stream === "status"
                    ? "text-zinc-400"
                    : "text-zinc-100";
              return (
                <pre
                  key={event.cursor}
                  className={`whitespace-pre-wrap break-words leading-5 ${tone}`}
                >
                  {event.data}
                </pre>
              );
            })}
            {terminalError && (
              <pre className="whitespace-pre-wrap break-words text-red-400">{terminalError}</pre>
            )}
          </div>
          <div className="text-xs text-[var(--oc-ink-muted)]">
            {terminalSessionId == null
              ? "Connecting terminal..."
              : terminalClosed
                ? `Terminal exited${terminalExitCode == null ? "" : ` (code ${terminalExitCode})`}.`
                : "Terminal running..."}
          </div>
          {allowInput && terminalSessionId && !terminalClosed && (
            <form
              className="flex items-center gap-2"
              onSubmit={async (event) => {
                event.preventDefault();
                const text = terminalInput;
                if (!text.trim() || !state.api) return;
                setTerminalInputBusy(true);
                setTerminalError(null);
                try {
                  const response = await state.api.sendTerminalSessionInput(
                    terminalSessionId,
                    text.endsWith("\n") ? text : `${text}\n`
                  );
                  if (!response.ok) {
                    setTerminalError(response.error || "Failed to send input.");
                    return;
                  }
                  setTerminalInput("");
                } catch (error) {
                  setTerminalError(
                    error instanceof Error ? error.message : "Failed to send input."
                  );
                } finally {
                  setTerminalInputBusy(false);
                }
              }}
            >
              <input
                value={terminalInput}
                onChange={(event) => setTerminalInput(event.target.value)}
                placeholder="Type command input and press Enter"
                className="h-10 flex-1 rounded-md border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 text-sm text-[var(--oc-ink)]"
              />
              <Button type="submit" disabled={terminalInputBusy || !terminalInput.trim()}>
                {terminalInputBusy ? "Sending..." : "Send"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    );
  }

  if (block.type === "web_embed") {
    const embedHeight = Math.max(200, Math.min(1800, block.height ?? 700));
    const url = typeof block.url === "string" ? block.url.trim() : "";
    if (!/^https?:\/\//i.test(url)) {
      return (
        <div className="rounded-lg border border-[var(--oc-warning)]/50 bg-[var(--oc-warning-bg)] px-4 py-3 text-sm text-[var(--oc-warning)]">
          Invalid embed URL: <code>{block.url}</code>
        </div>
      );
    }
    return (
      <Card>
        <CardHeader>
          <CardTitle>{block.title || "Embedded App"}</CardTitle>
          {block.description && (
            <p className="text-sm text-[var(--oc-ink-muted)]">{block.description}</p>
          )}
        </CardHeader>
        <CardContent>
          <iframe
            title={block.title || "embedded-app"}
            src={url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups"
            allow="fullscreen; gamepad; autoplay"
            referrerPolicy="no-referrer"
            className="w-full rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)]"
            style={{ height: `${embedHeight}px` }}
          />
        </CardContent>
      </Card>
    );
  }

  if (block.type === "react_widget") {
    const widgetHeight = Math.max(80, Math.min(2400, widgetHeightPx));
    const packageSpec = block.package.trim();
    const packageName = unversionWidgetPackageSpec(packageSpec);
    const exportName = typeof block.exportName === "string" ? block.exportName.trim() : "";
    const normalizedExportName = exportName || undefined;
    const widgetProps = resolvedWidgetProps ?? rawWidgetProps;
    if (!isSafeWidgetPackageSpec(packageSpec)) {
      return (
        <div className="rounded-lg border border-[var(--oc-warning)]/50 bg-[var(--oc-warning-bg)] px-4 py-3 text-sm text-[var(--oc-warning)]">
          Invalid widget package spec: <code>{block.package}</code>
        </div>
      );
    }
    if (widgetPropsLoading) {
      return (
        <Card>
          <CardHeader>
            <CardTitle>{block.title || "Widget"}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg bg-[var(--oc-bg)] px-3 py-2 text-sm text-[var(--oc-ink-muted)]">
              Resolving widget secrets...
            </div>
          </CardContent>
        </Card>
      );
    }
    if (widgetPropsError) {
      return (
        <Card>
          <CardHeader>
            <CardTitle>{block.title || "Widget"}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border border-[var(--oc-danger)]/50 bg-[var(--oc-danger-bg)] px-3 py-2 text-sm text-[var(--oc-danger)]">
              Failed to resolve widget secrets: {widgetPropsError}
            </div>
          </CardContent>
        </Card>
      );
    }

    if (
      packageName === "react-ts-tradingview-widgets" &&
      normalizedExportName === "AdvancedRealTimeChart"
    ) {
      const tradingViewUrl = buildTradingViewAdvancedChartUrl(widgetProps);
      return (
        <Card>
          <CardHeader>
            <CardTitle>{block.title || "Widget"}</CardTitle>
            {block.description && (
              <p className="text-sm text-[var(--oc-ink-muted)]">{block.description}</p>
            )}
          </CardHeader>
          <CardContent>
            <iframe
              title={block.title || "TradingView AdvancedRealTimeChart"}
              src={tradingViewUrl}
              sandbox="allow-scripts allow-same-origin allow-popups"
              referrerPolicy="no-referrer"
              className="w-full rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)]"
              style={{ height: `${widgetHeight}px` }}
            />
          </CardContent>
        </Card>
      );
    }

    const srcDoc = buildReactWidgetSrcDoc(
      packageSpec,
      normalizedExportName,
      widgetProps,
      widgetFrameIdRef.current
    );

    return (
      <Card>
        <CardHeader>
          <CardTitle>{block.title || "Widget"}</CardTitle>
          {block.description && (
            <p className="text-sm text-[var(--oc-ink-muted)]">{block.description}</p>
          )}
        </CardHeader>
        <CardContent>
          <iframe
            title={block.title || `widget:${packageSpec}`}
            srcDoc={srcDoc}
            sandbox="allow-scripts allow-popups allow-pointer-lock"
            allow="gamepad; fullscreen; pointer-lock; clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
            className="w-full rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)]"
            style={{ height: `${widgetHeight}px` }}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{block.title || "Details"}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {block.rows.map((row) => (
          <div
            key={`${row.label}:${row.value}`}
            className="flex items-center justify-between rounded-lg bg-[var(--oc-bg)] px-3 py-2"
          >
            <span className="text-[var(--oc-ink-muted)]">{row.label}</span>
            <span className="font-medium text-[var(--oc-ink)]">{row.value}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function BaseUiPageView({ page }: { page: UiBasePage }) {
  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-[var(--oc-ink)]">{page.title}</h1>
        {page.description && (
          <p className="mt-1 text-sm text-[var(--oc-ink-muted)]">{page.description}</p>
        )}
      </div>
      {page.blocks.map((block, index) => (
        <BaseBlock key={`${block.type}:${index}`} block={block} />
      ))}
    </div>
  );
}
