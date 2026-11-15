import jsQR from "jsqr";
import { LoginReport } from "../../src/lib/login-browser/report";

const visible = (element: Element): boolean => {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
};

const imageFrom = async (source: HTMLImageElement | SVGSVGElement): Promise<HTMLImageElement> => {
  const image = new Image();
  if (source instanceof HTMLImageElement) {
    image.crossOrigin = "anonymous";
    image.src = source.currentSrc || source.src;
  } else {
    const clone = source.cloneNode(true);
    if (!(clone instanceof SVGSVGElement)) throw new Error("QR source was not an SVG.");
    // Discord can style SVG paths through CSS. Keep computed colors when rasterizing.
    const original = [source, ...source.querySelectorAll("*")];
    const copied = [clone, ...clone.querySelectorAll("*")];
    for (const [index, element] of copied.entries()) {
      const from = original[index];
      if (from === undefined) continue;
      const style = getComputedStyle(from);
      element.setAttribute("fill", style.fill);
      element.setAttribute("stroke", style.stroke);
      element.setAttribute("color", style.color);
    }
    // Omit external logo overlays when rasterizing the QR modules.
    for (const overlay of clone.querySelectorAll("image, foreignObject")) overlay.remove();
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", "512");
    clone.setAttribute("height", "512");
    image.src = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
  }
  await image.decode();
  return image;
};

/** Decode pixels only. No Discord markup ever leaves the extension. */
const read = async (): Promise<string | null> => {
  for (const element of document.querySelectorAll("canvas, svg, img")) {
    if (!(element instanceof HTMLCanvasElement || element instanceof SVGSVGElement || element instanceof HTMLImageElement) || !visible(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 100 || rect.width > 1024 || Math.abs(rect.width - rect.height) > rect.width * 0.15) continue;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 512;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) continue;
      context.fillStyle = "#fff";
      context.fillRect(0, 0, 512, 512);
      context.drawImage(element instanceof HTMLCanvasElement ? element : await imageFrom(element), 0, 0, 512, 512);
      const pixels = context.getImageData(0, 0, 512, 512);
      const decoded = jsQR(pixels.data, pixels.width, pixels.height);
      const parsed = LoginReport.QrUrlSchema.safeParse(decoded?.data);
      if (parsed.success) return parsed.data;
    } catch {
      // Cross-origin pixels or an incomplete image cannot be decoded. The server
      // shows the real browser if no known state arrives within five seconds.
    }
  }
  return null;
};
export const LoginQr = { read, visible } as const;
