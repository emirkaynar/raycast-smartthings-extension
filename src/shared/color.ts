import { clamp } from "./number";

export function rgbToHex(r: number, g: number, b: number): string {
  const rr = clamp(Math.round(r), 0, 255).toString(16).padStart(2, "0");
  const gg = clamp(Math.round(g), 0, 255).toString(16).padStart(2, "0");
  const bb = clamp(Math.round(b), 0, 255).toString(16).padStart(2, "0");
  return `#${rr}${gg}${bb}`;
}

export function hsvToHex(hueDeg: number, saturation01: number, value01: number): string {
  const h = ((hueDeg % 360) + 360) % 360;
  const s = clamp(saturation01, 0, 1);
  const v = clamp(value01, 0, 1);
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (h < 60) {
    r1 = c;
    g1 = x;
  } else if (h < 120) {
    r1 = x;
    g1 = c;
  } else if (h < 180) {
    g1 = c;
    b1 = x;
  } else if (h < 240) {
    g1 = x;
    b1 = c;
  } else if (h < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  return rgbToHex((r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255);
}

export function kelvinToHex(kelvin: number): string {
  const temp = clamp(kelvin, 1000, 40000) / 100;

  let red: number;
  let green: number;
  let blue: number;

  if (temp <= 66) {
    red = 255;
    green = 99.4708025861 * Math.log(temp) - 161.1195681661;
    blue = temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
  } else {
    red = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
    green = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
    blue = 255;
  }

  return rgbToHex(red, green, blue);
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } | undefined {
  const cleaned = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return undefined;
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  return { r, g, b };
}

export function rgbToHsv(r: number, g: number, b: number): { hueDeg: number; saturation01: number; value01: number } {
  const rr = clamp(r / 255, 0, 1);
  const gg = clamp(g / 255, 0, 1);
  const bb = clamp(b / 255, 0, 1);

  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const delta = max - min;

  let hueDeg = 0;
  if (delta !== 0) {
    if (max === rr) {
      hueDeg = 60 * (((gg - bb) / delta) % 6);
    } else if (max === gg) {
      hueDeg = 60 * ((bb - rr) / delta + 2);
    } else {
      hueDeg = 60 * ((rr - gg) / delta + 4);
    }
  }
  if (hueDeg < 0) hueDeg += 360;

  const saturation01 = max === 0 ? 0 : delta / max;
  const value01 = max;

  return { hueDeg, saturation01, value01 };
}

export function hexToHsv(hex: string): { hueDeg: number; saturation01: number; value01: number } | undefined {
  const rgb = hexToRgb(hex);
  if (!rgb) return undefined;
  return rgbToHsv(rgb.r, rgb.g, rgb.b);
}
