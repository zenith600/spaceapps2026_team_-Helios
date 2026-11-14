"""Real/bogus classifier: a small CNN trained from scratch on our own injection stamps. No third-party weights.

Input  [N, 3, 32, 32]: ch0 stacked SNR stamp, ch1 static-sky stamp (normalised), ch2 best single-epoch stamp.
Output [N, 1]: probability of a real distant mover.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

from deepfield.contracts import MODEL_INPUT_CHANNELS, STAMP_SIZE


class StampNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(MODEL_INPUT_CHANNELS, 16, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),   # 16
            nn.Conv2d(16, 32, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),                     # 8
            nn.Conv2d(32, 64, 3, padding=1), nn.ReLU(), nn.AdaptiveAvgPool2d(1),
        )
        self.head = nn.Sequential(nn.Flatten(), nn.Dropout(0.2), nn.Linear(64, 32), nn.ReLU(), nn.Linear(32, 1))

    def forward(self, x):
        return torch.sigmoid(self.head(self.features(x)))


def normalise_stamp(stack: np.ndarray, static: np.ndarray, single: np.ndarray) -> np.ndarray:
    def z(a):
        a = np.nan_to_num(a.astype(np.float32))
        s = np.std(a) if np.std(a) > 0 else 1.0
        return np.clip((a - np.median(a)) / s, -6, 12)
    return np.stack([z(stack), z(static), z(single)])


def load_stamp_set(stamp_dir: Path) -> np.ndarray:
    d = np.load(Path(stamp_dir) / "stamps.npz")
    singles = d["singles"]
    best = singles[np.argmax(singles.reshape(len(singles), -1).max(1))] if len(singles) else np.zeros_like(d["stack"])
    return normalise_stamp(d["stack"], d["static"], best)


def train(X: np.ndarray, y: np.ndarray, epochs: int = 40, seed: int = 0, lr: float = 2e-3) -> tuple[StampNet, dict]:
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    idx = rng.permutation(len(X))
    n_val = max(8, len(X) // 5)
    val, tr = idx[:n_val], idx[n_val:]
    Xt, yt = torch.tensor(X[tr]), torch.tensor(y[tr], dtype=torch.float32)
    Xv, yv = torch.tensor(X[val]), torch.tensor(y[val], dtype=torch.float32)
    model = StampNet()
    opt = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=1e-4)
    lossf = nn.BCELoss()
    hist = []
    for ep in range(epochs):
        model.train()
        perm = torch.randperm(len(Xt))
        for i in range(0, len(Xt), 32):
            b = perm[i:i + 32]
            xb = Xt[b]
            # augmentation: random flips / 90-degree rotations (stamps are isotropic)
            if rng.random() < 0.5:
                xb = xb.flip(-1)
            if rng.random() < 0.5:
                xb = xb.flip(-2)
            if rng.random() < 0.5:
                xb = xb.transpose(-1, -2)
            opt.zero_grad()
            loss = lossf(model(xb)[:, 0], yt[b])
            loss.backward()
            opt.step()
        model.eval()
        with torch.no_grad():
            pv = model(Xv)[:, 0].numpy()
            acc = float(((pv > 0.5) == (yv.numpy() > 0.5)).mean())
            auc = _auc(yv.numpy(), pv)
        hist.append({"epoch": ep, "val_acc": acc, "val_auc": auc})
    return model, {"n_train": int(len(tr)), "n_val": int(len(val)), "history": hist, "val_acc": hist[-1]["val_acc"],
                   "val_auc": hist[-1]["val_auc"]}


def _auc(y: np.ndarray, p: np.ndarray) -> float:
    pos, neg = p[y > 0.5], p[y <= 0.5]
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    return float((pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean())


def export_onnx(model: StampNet, path: Path, meta: dict) -> Path:
    import onnx
    import onnxruntime as ort
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    model.eval()
    dummy = torch.zeros(1, MODEL_INPUT_CHANNELS, STAMP_SIZE, STAMP_SIZE)
    torch.onnx.export(model, dummy, str(path), input_names=["stamps"], output_names=["prob"],
                      dynamic_axes={"stamps": {0: "n"}, "prob": {0: "n"}}, opset_version=17, dynamo=False)
    onnx.checker.check_model(onnx.load(str(path)))
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    x = np.random.default_rng(0).normal(size=(3, MODEL_INPUT_CHANNELS, STAMP_SIZE, STAMP_SIZE)).astype(np.float32)
    with torch.no_grad():
        ref = model(torch.tensor(x))[:, 0].numpy()
    out = sess.run(["prob"], {"stamps": x})[0][:, 0]
    assert np.allclose(ref, out, atol=1e-4), "ONNX output differs from PyTorch"
    path.with_suffix(".json").write_text(json.dumps({**meta, "input": "stamps float32 [n,3,32,32]", "output": "prob float32 [n,1]",
                                                     "trained_from_scratch": True, "pretrained_weights": None,
                                                     "onnx_roundtrip_max_abs_diff": float(np.abs(ref - out).max())}, indent=1))
    return path


def predict(model_path: Path, X: np.ndarray) -> np.ndarray:
    import onnxruntime as ort
    sess = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    return sess.run(["prob"], {"stamps": X.astype(np.float32)})[0][:, 0]
