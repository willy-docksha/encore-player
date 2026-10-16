"""export the analysis models to onnx for the browser build.

run with the dev venv:  .venv/bin/python tools/export_models.py <out_dir>
demucs: only the network core is exported (stft / istft / masking run in js, see web/dsp).
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import torch
from torch import nn

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "models")
torch.backends.mha.set_fastpath_enabled(False)  # fused attention has no onnx export


class DemucsCore(nn.Module):
    """htdemucs forward without _spec / _mask / _ispec: takes the mix and its cac spectrogram,
    returns the freq-branch spectrogram (cac) and the time-branch waveform per source."""

    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, mix, mag):
        m = self.m
        x = mag
        B, C, Fq, T = x.shape
        mean = x.mean(dim=(1, 2, 3), keepdim=True)
        std = x.std(dim=(1, 2, 3), keepdim=True)
        x = (x - mean) / (1e-5 + std)
        xt = mix
        meant = xt.mean(dim=(1, 2), keepdim=True)
        stdt = xt.std(dim=(1, 2), keepdim=True)
        xt = (xt - meant) / (1e-5 + stdt)
        saved, saved_t, lengths, lengths_t = [], [], [], []
        for idx, encode in enumerate(m.encoder):
            lengths.append(x.shape[-1])
            inject = None
            if idx < len(m.tencoder):
                lengths_t.append(xt.shape[-1])
                tenc = m.tencoder[idx]
                xt = tenc(xt)
                if not tenc.empty:
                    saved_t.append(xt)
                else:
                    inject = xt
            x = encode(x, inject)
            if idx == 0 and m.freq_emb is not None:
                frs = torch.arange(x.shape[-2], device=x.device)
                emb = m.freq_emb(frs).t()[None, :, :, None].expand_as(x)
                x = x + m.freq_emb_scale * emb
            saved.append(x)
        if m.crosstransformer:
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_upsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_upsampler_t(xt)
            x, xt = m.crosstransformer(x, xt)
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_downsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_downsampler_t(xt)
        for idx, decode in enumerate(m.decoder):
            skip = saved.pop(-1)
            x, pre = decode(x, skip, lengths.pop(-1))
            offset = m.depth - len(m.tdecoder)
            if idx >= offset:
                tdec = m.tdecoder[idx - offset]
                length_t = lengths_t.pop(-1)
                if tdec.empty:
                    pre = pre[:, :, 0]
                    xt, _ = tdec(pre, None, length_t)
                else:
                    skip = saved_t.pop(-1)
                    xt, _ = tdec(xt, skip, length_t)
        S = len(m.sources)
        x = x.view(B, S, -1, Fq, T)
        x = x * std[:, None] + mean[:, None]
        xt = xt.view(B, S, -1, mix.shape[-1])
        xt = xt * stdt[:, None] + meant[:, None]
        return x, xt


def export_demucs(name: str, pick: str | None = None) -> dict:
    from demucs.pretrained import get_model

    bag = get_model(name)
    if pick:  # one specialist out of the fine-tuned bag
        bi = bag.sources.index(pick)
        k = next(i for i, w in enumerate(bag.weights) if w[bi] > 0 and sum(w) == w[bi])
        model = bag.models[k]
    else:
        model = bag.models[0]
    model.eval()
    length = int(model.segment * model.samplerate)
    le = math.ceil(length / model.hop_length)
    mix = torch.randn(1, model.audio_channels, length)
    mag = torch.randn(1, model.audio_channels * 2, model.nfft // 2, le)
    core = DemucsCore(model).eval()
    out = OUT / f"{name}{'_' + pick if pick else ''}.onnx"
    with torch.no_grad():
        torch.onnx.export(core, (mix, mag), str(out), input_names=["mix", "mag"], output_names=["spec", "wave"],
                          opset_version=17, dynamo=False)
    info = {"file": out.name, "sources": list(model.sources), "samplerate": model.samplerate,
            "segment": length, "nfft": model.nfft, "hop": model.hop_length, "frames": le}
    print(name, info, f"{out.stat().st_size / 1e6:.1f} MB")
    return info


def check_demucs(info: dict, name: str, pick: str | None) -> None:
    """compare the onnx core + numpy stft against the torch model on random audio."""
    import onnxruntime as ort
    from demucs.pretrained import get_model

    bag = get_model(name)
    model = bag.models[0] if not pick else next(
        bag.models[i] for i, w in enumerate(bag.weights) if w[bag.sources.index(pick)] > 0 and sum(w) == w[bag.sources.index(pick)])
    model.eval()
    mix = torch.randn(1, 2, info["segment"]) * 0.1
    with torch.no_grad():
        ref = model(mix).numpy()
        z = model._spec(mix)
        mag = model._magnitude(z)
        core = DemucsCore(model)
        spec, wave = core(mix, mag)
        zout = model._mask(z, spec)
        full = (model._ispec(zout, info["segment"]) + wave).numpy()
    sess = ort.InferenceSession(str(OUT / info["file"]))
    o_spec, o_wave = sess.run(None, {"mix": mix.numpy(), "mag": mag.numpy()})
    print("  core vs torch model:", float(np.abs(full - ref).max()),
          " onnx spec err:", float(np.abs(o_spec - spec.numpy()).max()),
          " onnx wave err:", float(np.abs(o_wave - wave.numpy()).max()))


class BeatCore(nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, spect):
        out = self.m(spect)
        return out["beat"], out["downbeat"]


def export_beats() -> dict:
    """beat_this final0 on fixed 1500-frame (30 s) log-mel chunks; mel + peak picking run in js."""
    import onnxruntime as ort
    from beat_this.inference import load_model

    model = load_model("final0", "cpu")
    core = BeatCore(model).eval()
    x = torch.randn(1, 1500, 128)
    out = OUT / "beat_this.onnx"
    with torch.no_grad():
        torch.onnx.export(core, (x,), str(out), input_names=["spect"], output_names=["beat", "downbeat"],
                          opset_version=17, dynamo=False)
        ref_b, ref_d = core(x)
    b, d = ort.InferenceSession(str(out)).run(None, {"spect": x.numpy()})
    print("beat_this", f"{out.stat().st_size / 1e6:.1f} MB", " err:",
          float(np.abs(b - ref_b.numpy()).max()), float(np.abs(d - ref_d.numpy()).max()))
    return {"file": out.name, "frames": 1500, "fps": 50, "border": 6}


def split_weights(path: Path) -> None:
    """move float weights out of the graph into <stem>.weights.f16 (half precision, ~half the download).
    the graph keeps fp32 external-data offsets; the browser expands the halves back to fp32 before
    handing them to onnxruntime, so inference stays fp32 on every backend."""
    import onnx
    from onnx import numpy_helper

    model = onnx.load(str(path))
    loc = f"{path.stem}.weights"
    chunks, off16, lossy = [], 0, 0
    for t in model.graph.initializer:
        if t.data_type != onnx.TensorProto.FLOAT or np.prod(t.dims) < 1024:
            continue
        a = numpy_helper.to_array(t).astype(np.float32)
        h = a.astype(np.float16)
        lossy += int(np.count_nonzero(h.astype(np.float32) != a))
        raw = h.tobytes()
        chunks.append(raw)
        t.ClearField("raw_data")
        t.ClearField("float_data")
        t.data_location = onnx.TensorProto.EXTERNAL
        del t.external_data[:]
        for k, v in (("location", loc), ("offset", str(off16 * 2)), ("length", str(len(raw) * 2))):
            e = t.external_data.add()
            e.key, e.value = k, v
        off16 += len(raw)
    onnx.save(model, str(path))
    (path.parent / f"{loc}.f16").write_bytes(b"".join(chunks))
    print(f"  graph {path.stat().st_size / 1e6:.1f} MB + weights {off16 / 1e6:.1f} MB (f16), "
          f"{lossy} values not exact in f16")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for name, pick in (("htdemucs", None), ("htdemucs_ft", "bass"), ("htdemucs_6s", None)):
        info = export_demucs(name, pick)
        check_demucs(info, name, pick)
        split_weights(OUT / info["file"])
        manifest[f"{name}{'_' + pick if pick else ''}"] = {**info, "weights": f"{Path(info['file']).stem}.weights"}
    info = export_beats()
    split_weights(OUT / info["file"])
    manifest["beat_this"] = {**info, "weights": "beat_this.weights"}
    # basic pitch ships an onnx model already (tiny, no weight split)
    import shutil
    import basic_pitch
    shutil.copy(Path(basic_pitch.__file__).parent / "saved_models/icassp_2022/nmp.onnx", OUT / "basic_pitch.onnx")
    manifest["basic_pitch"] = {"file": "basic_pitch.onnx"}
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
