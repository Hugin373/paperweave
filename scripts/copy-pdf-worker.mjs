// Copies the pdf.js worker that matches the installed react-pdf version into /public,
// so the browser can load it from the app's own origin.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
try {
  const reactPdfDir = path.dirname(require.resolve("react-pdf/package.json"));
  const workerPath = require.resolve("pdfjs-dist/build/pdf.worker.min.mjs", { paths: [reactPdfDir] });
  mkdirSync("public", { recursive: true });
  copyFileSync(workerPath, path.join("public", "pdf.worker.min.mjs"));
} catch (err) {
  if (existsSync("node_modules/react-pdf")) throw err;
}
