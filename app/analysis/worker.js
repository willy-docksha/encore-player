// analysis worker: runs the whole pipeline off the main thread, on this device (webgpu when available)
import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs";
import { Mp3Encoder } from "https://cdn.jsdelivr.net/npm/@breezystack/lamejs@1.2.7/+esm";
import { ModelStore } from "./models.js";
import { analyze } from "./pipeline.js";
import { encodeMp3 } from "./mp3.js";

ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
ort.env.logLevel = "error";

let models = null;

self.onmessage = async ({ data }) => {
  if (data.type !== "run") return;
  const post = (msg, transfer) => self.postMessage({ id: data.id, ...msg }, transfer || []);
  try {
    const providers = (await webgpuOk()) ? ["webgpu", "wasm"] : ["wasm"];
    if (!models || models.base !== data.modelBase.replace(/\/$/, "")) {
      models = new ModelStore(ort, data.modelBase, { providers });
    }
    models.onDownload = ({ name, part, got, total, cached }) => {
      if (!cached && part === "weights") post({ type: "download", name, got, total });
    };
    post({ type: "backend", backend: providers[0] });
    const t0 = performance.now();
    const { result, files } = await analyze([data.left, data.right], data.title, {
      ort,
      models,
      encodeMp3: async (l, r) => encodeMp3(Mp3Encoder, l, r),
      progress: (stage, p) => post({ type: "progress", stage, p }),
    });
    const bytes = Object.values(files).map((b) => b.buffer);
    post({ type: "done", result, files, computeSec: (performance.now() - t0) / 1000 }, bytes);
  } catch (err) {
    console.error(err);
    post({ type: "error", message: err?.message || String(err) });
  }
};

async function webgpuOk() {
  try {
    if (!("gpu" in navigator)) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}
