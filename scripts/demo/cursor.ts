/**
 * A visible mouse cursor for the demo recording (screencasts have none), and
 * natural mouse motion. Ported from openrcs's scripts/demo/cursor.ts, without
 * its replay of footage recorded on another page.
 */
import type { Page } from "playwright-core";

/**
 * Init script for every page of the recording context (top frame only):
 * draws a macOS-like cursor that follows mouse events and shrinks a little
 * while pressed. Self-contained: Playwright serializes it.
 */
export function installCursor(): void {
  if (window.top !== window) return;
  const shapes: Record<string, { svg: string; hotspot: [number, number] }> = {
    arrow: {
      hotspot: [3, 2],
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="26" viewBox="0 0 20 26"><path d="M3 2v18.5l4.6-4.4 3.2 7.3 3.1-1.4-3.1-7.1h6.4z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    },
    text: {
      hotspot: [6, 11],
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="22" viewBox="0 0 12 22"><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 2h2.2L6 3.2 7.3 2h2.2M6 3.2v15.6M2.5 20h2.2L6 18.8 7.3 20h2.2" stroke="#fff" stroke-width="3.4"/><path d="M2.5 2h2.2L6 3.2 7.3 2h2.2M6 3.2v15.6M2.5 20h2.2L6 18.8 7.3 20h2.2" stroke="#111" stroke-width="1.3"/></g></svg>',
    },
    pointer: {
      hotspot: [8, 2],
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="25" viewBox="0 0 22 25"><path d="M6.6 2.6c0-.9.7-1.6 1.6-1.6s1.6.7 1.6 1.6v7.2h.5V7.9c0-.9.7-1.6 1.6-1.6s1.6.7 1.6 1.6v2.4h.4V9c0-.9.7-1.6 1.6-1.6s1.6.7 1.6 1.6v1.8h.3c0-.8.7-1.5 1.5-1.5s1.5.7 1.5 1.5v5.9c0 4.1-2.7 7.3-6.7 7.3h-2c-2.2 0-3.7-.9-5-2.7L1.8 15.1c-.6-.8-.4-1.9.4-2.4.8-.5 1.8-.3 2.4.4l2 2.5z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    },
  };

  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText =
    "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform-origin:0 0;transition:scale 90ms ease-out;filter:drop-shadow(0 1px 1.5px rgb(0 0 0 / 0.35));";
  let kind = "";
  const setKind = (next: string) => {
    if (next === kind) return;
    kind = next;
    const shape = shapes[next] ?? shapes.arrow;
    el.innerHTML = shape.svg;
    el.style.marginLeft = `${-shape.hotspot[0]}px`;
    el.style.marginTop = `${-shape.hotspot[1]}px`;
  };

  const kindAt = (x: number, y: number): string => {
    const target = document.elementFromPoint(x, y);
    if (target === null) return "arrow";
    const css = getComputedStyle(target).cursor;
    if (css === "pointer") return "pointer";
    const typed = target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(target.type);
    if (css === "text" || typed || target instanceof HTMLTextAreaElement) return "text";
    return "arrow";
  };

  const place = (x: number, y: number) => {
    // React owns <body>; re-attach to <html> if anything removed the cursor.
    if (!el.isConnected) document.documentElement.appendChild(el);
    setKind(kindAt(x, y));
    el.style.translate = `${x}px ${y}px`;
    try {
      sessionStorage.setItem("demo-cursor", JSON.stringify([x, y]));
    } catch {
      /* Only a convenience: the next page then shows the cursor at its first move. */
    }
  };

  // A full page load (sign-in, the consent page) keeps the cursor where it was.
  document.addEventListener("DOMContentLoaded", () => {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem("demo-cursor") ?? "null");
      if (Array.isArray(saved) && typeof saved[0] === "number" && typeof saved[1] === "number") place(saved[0], saved[1]);
    } catch {
      /* No saved position yet. */
    }
  });
  window.addEventListener("mousemove", (event) => place(event.clientX, event.clientY), true);
  window.addEventListener("mousedown", () => (el.style.scale = "0.86"), true);
  window.addEventListener("mouseup", () => (el.style.scale = "1"), true);
}

export type Point = { x: number; y: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Drives `page.mouse` along eased, slightly curved paths at ~60 Hz. */
export class Pointer {
  private position: Point;

  constructor(
    private readonly page: Page,
    start: Point,
  ) {
    this.position = start;
  }

  get at(): Point {
    return this.position;
  }

  /** Puts the cursor at `to` without motion (also redraws it after a page load). */
  async jump(to: Point): Promise<void> {
    this.position = to;
    await this.page.mouse.move(to.x, to.y);
  }

  async move(to: Point, durationMs: number): Promise<void> {
    const from = this.position;
    // A gentle arc: the control point sits off the straight line.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const control = { x: from.x + dx * 0.5 - dy * 0.12, y: from.y + dy * 0.5 + dx * 0.12 };
    const started = Date.now();
    for (;;) {
      const linear = Math.min(1, (Date.now() - started) / durationMs);
      const t = easeInOut(linear);
      const x = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * control.x + t * t * to.x;
      const y = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * control.y + t * t * to.y;
      await this.page.mouse.move(x, y);
      if (linear >= 1) break;
      await sleep(16);
    }
    this.position = to;
  }

  async click(holdMs = 90): Promise<void> {
    await this.page.mouse.down();
    await sleep(holdMs);
    await this.page.mouse.up();
  }
}
